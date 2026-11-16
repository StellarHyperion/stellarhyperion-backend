import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { createServerlessRuntime } from "../../api/index.js";
import {
  TESTNET_DEPLOYMENTS,
  compareServerlessAndContinuousEntrypoints,
  createSeededParityDatabase,
} from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

describe("Serverless-versus-continuous behavior parity checks (#144)", () => {
  it("returns identical indexed transfer, claim, route-health, and metrics semantics across both entrypoints while omitting active-worker claims in API-only mode", async () => {
    const { handle, ids } = await createSeededParityDatabase();
    try {
      const { report, runtime } = await compareServerlessAndContinuousEntrypoints({
        dbHandle: handle,
        ids,
      });

      expect(report.transferListMatches).toBe(true);
      expect(report.transferByNonceMatches).toBe(true);
      expect(report.transferByTxMatches).toBe(true);
      expect(report.notFoundEnvelopeMatches).toBe(true);
      expect(report.claimsListMatches).toBe(true);
      expect(report.claimByIdMatches).toBe(true);
      expect(report.routeHealthMatches).toBe(true);
      expect(report.metricsDataCountsMatch).toBe(true);

      // Verify wide integer and recipient normalization directly through the serverless app.
      const slsApp = await runtime.getApp();
      const wideTransferRes = await slsApp.inject({
        method: "GET",
        url: `/v1/transfers/stellar-testnet/${ids.wideNonce}`,
      });
      expect(wideTransferRes.statusCode).toBe(200);
      const wideTransfer = wideTransferRes.json<{
        stage: string;
        origin: { nonce: string; netAmount: string };
        destination: { recipient: string; amount: string; delivered: boolean };
      }>();
      expect(wideTransfer.stage).toBe("delivered");
      expect(wideTransfer.origin.nonce).toBe(ids.wideNonce);
      expect(wideTransfer.origin.netAmount).toBe(ids.wideNetAmount);
      expect(wideTransfer.destination.recipient).toBe(ids.evmRecipientAddress);
      expect(wideTransfer.destination.amount).toBe(ids.wideNetAmount);
      expect(wideTransfer.destination.delivered).toBe(true);

      // Criterion 2: API-only mode explicitly omits active-worker readiness claims.
      const slsChecks = report.serverlessReadyBody.checks as { name: string; state: string }[];
      const slsCheckNames = slsChecks.map((c) => c.name);
      expect(report.serverlessReadyBody.mode).toBe("api-only");
      expect(report.serverlessReadyBody.indexer).toBe("disabled");
      expect(report.serverlessReadyBody.rails).toBe("disabled");
      expect(report.serverlessReadyBody.keeper).toBe("disabled");
      expect(String(report.serverlessReadyBody.meaning)).toContain("no chain watchers");
      expect(String(report.serverlessReadyBody.meaning)).not.toContain("every watcher is current");
      expect(slsCheckNames).toEqual(["postgres", "redis"]);

      // Continuous mode includes active watcher / rail readiness checks.
      const contChecks = report.continuousReadyBody.checks as { name: string; state: string }[];
      const contCheckNames = contChecks.map((c) => c.name);
      expect(report.continuousReadyBody.mode).toBe("continuous");
      expect(report.continuousReadyBody.indexer).toBe("enabled");
      expect(contCheckNames).toContain("stellar-testnet");
      expect(contCheckNames.some((n) => n.startsWith("rail:"))).toBe(true);

      await runtime.close();
      expect(runtime.stats()).toEqual({
        initializedCount: 1,
        activeInstances: 0,
        activeDatabases: 0,
      });
    } finally {
      await handle.disposeEngine();
    }
  }, 30_000);

  it("bounds database pools and Fastify instances across concurrent cold-start bursts and repeated init/close cycles", async () => {
    const { handle, ids } = await createSeededParityDatabase();
    try {
      const { logger } = capturingLogger();
      const runtime = createServerlessRuntime({
        env: {
          NODE_ENV: "test",
          DATABASE_URL: "postgres://hyperion:unused@127.0.0.1:5433/hyperion",
          HYPERION_NETWORK: "testnet",
          HYPERION_DEPLOYMENTS_FILE: TESTNET_DEPLOYMENTS,
        },
        createLoggerFn: () => logger,
        openDatabase: () => {
          handle.stats.openCalls += 1;
          return handle.db;
        },
      });

      const httpServer = createServer((req, res) => {
        void runtime.handler(req, res);
      });
      await new Promise<void>((resolve) => {
        httpServer.listen(0, "127.0.0.1", () => {
          resolve();
        });
      });

      try {
        const port = (httpServer.address() as AddressInfo).port;
        // Fire 20 concurrent HTTP requests + OPTIONS preflight during cold start.
        const responses = await Promise.all([
          fetch(`http://127.0.0.1:${String(port)}/v1/transfers`, { method: "OPTIONS" }),
          ...Array.from({ length: 20 }, (_, idx) =>
            fetch(
              idx % 2 === 0
                ? `http://127.0.0.1:${String(port)}/v1/transfers/sepolia/${ids.parkedNonce}`
                : `http://127.0.0.1:${String(port)}/health`,
            ),
          ),
        ]);

        expect(responses[0].status).toBe(204);
        for (const r of responses.slice(1)) {
          expect(r.status).toBe(200);
        }

        // Only ONE database pool and ONE Fastify instance were created despite 20 parallel cold-start requests!
        expect(handle.stats.openCalls).toBe(1);
        expect(runtime.stats()).toEqual({
          initializedCount: 1,
          activeInstances: 1,
          activeDatabases: 1,
        });

        // Repeated warm getApp() calls do not allocate new pools or servers.
        for (let i = 0; i < 10; i += 1) {
          await runtime.getApp();
        }
        expect(handle.stats.openCalls).toBe(1);
        expect(runtime.stats().activeDatabases).toBe(1);

        // Close and re-initialize across 3 lifecycles, verifying zero leaked resources at every boundary.
        for (let cycle = 0; cycle < 3; cycle += 1) {
          await runtime.close();
          expect(runtime.stats().activeDatabases).toBe(0);
          expect(runtime.stats().activeInstances).toBe(0);
          expect(handle.stats.closeCalls).toBe(handle.stats.openCalls);

          await runtime.getApp();
          expect(runtime.stats().activeDatabases).toBe(1);
          expect(runtime.stats().activeInstances).toBe(1);
        }

        await runtime.close();
        expect(handle.stats.openCalls).toBe(4);
        expect(handle.stats.closeCalls).toBe(4);
        expect(runtime.stats()).toEqual({
          initializedCount: 4,
          activeInstances: 0,
          activeDatabases: 0,
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }
    } finally {
      await handle.disposeEngine();
    }
  }, 30_000);
});
