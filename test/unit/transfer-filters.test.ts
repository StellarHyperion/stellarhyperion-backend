import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const config = loadConfig({ env: completeEnv() });
const sender = config.deployments.networks["stellar-testnet"]!.treasury;
const recipient = `0x${"11".repeat(20)}`;
describe("canonical composed transfer filters", () => {
  it.each([
    "originChain=unknown",
    "destinationChain=ethereum",
    "originChain=stellar-testnet&destinationChain=stellar-testnet",
    "route=2&originChain=stellar-testnet",
    "route=99",
    "sender=not-a-strkey&originChain=stellar-testnet",
    "recipient=not-an-address&destinationChain=sepolia",
    "search=%00",
  ])("rejects %s before SQL", async (filters) => {
    let queries = 0;
    const db = {
      query() {
        queries++;
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as unknown as Database;
    const app = buildServer({ config, logger: capturingLogger().logger, db, readiness: [] });
    try {
      expect(
        (await app.inject({ method: "GET", url: `/v1/transfers?${filters}` })).statusCode,
      ).toBe(400);
      expect(queries).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("supports direct canonical CCTP destination identities without a Hyperion EVM deployment and parameterizes search", async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      query(sql: string, params: readonly unknown[]) {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as unknown as Database;
    const direct = {
      ...config,
      deployments: {
        ...config.deployments,
        networks: { "stellar-testnet": config.deployments.networks["stellar-testnet"]! },
      },
    };
    const app = buildServer({
      config: direct,
      logger: capturingLogger().logger,
      db,
      readiness: [],
    });
    const search = "'); DROP TABLE outbound_transfer; --";
    try {
      const query = new URLSearchParams({
        originChain: "stellar-testnet",
        destinationChain: "sepolia",
        route: "0",
        sender,
        recipient,
        search,
      });
      expect(
        (await app.inject({ method: "GET", url: `/v1/transfers?${query.toString()}` })).statusCode,
      ).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.sql).not.toContain(search);
      expect(calls[0]!.params).toContain(`%${search}%`);
      expect(calls[0]!.params).toContain(`0x${"11".repeat(20).padStart(64, "0")}`);
    } finally {
      await app.close();
    }
  });
});
