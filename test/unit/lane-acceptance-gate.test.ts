import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, RouteKind, encodeStellarAddress, toWord } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";

import { buildIndexer, evaluateConfiguredCandidateLanes } from "../../src/chains/runner.js";
import { writeAttestation, writeInbound, writeOutbound } from "../../src/chains/writers.js";
import { discoverCandidateLanes, loadConfig } from "../../src/config/config.js";
import type { Queryable, QueryResultRows } from "../../src/db/pool.js";
import {
  candidateLaneKey,
  evaluateIndexedLaneAcceptance,
  evaluateLaneAcceptance,
} from "../../src/rails/acceptance.js";
import { RailPass } from "../../src/rails/pass.js";
import type { CandidateLane, LaneAcceptanceEvidence, RailClient } from "../../src/rails/types.js";
import { completeEnv, TESTNET_DEPLOYMENTS } from "../helpers.js";
import { RecordingDb, capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECKED_IN_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");
const INITIAL_SCHEMA_SQL =
  readFileSync(join(REPO_ROOT, "migrations", "1790900000000_initial-schema.sql"), "utf8").split(
    "-- Down Migration",
  )[0] ?? "";

const SENDER_STRKEY = encodeStellarAddress(AddressKind.Account, new Uint8Array(32).fill(0x11));
const EVM_RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const STELLAR_USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function checkedInConfig() {
  return loadConfig({
    env: completeEnv({
      HYPERION_DEPLOYMENTS_FILE: CHECKED_IN_TESTNET_DEPLOYMENTS,
      KEEPER_ENABLED: "false",
    }),
  });
}

function validCctpEvidence(): LaneAcceptanceEvidence {
  return {
    environment: "live",
    source: {
      originChain: "stellar-testnet",
      destinationChain: "sepolia",
      route: RouteKind.Cctp,
      nonce: "18446744073709551610",
      sender: SENDER_STRKEY,
      token: STELLAR_USDC_SAC,
      grossAmount: "1000000000",
      fee: "3000000",
      netAmount: "997000000",
      destination: toWord(EVM_RECIPIENT),
      originBlock: "5433900",
      originTx: "d2d112fdef5b381534eb10e92806bd0025f307ffb0b2da0d0d3194d3f7892ca2",
    },
    provider: {
      rail: "cctp",
      status: "attested",
      railStatus: "complete",
      reference: `0x${"ab".repeat(32)}`,
      candidateTxHash: "0xb8a185a1e723443ab0b787225006fe56db80009fe796c69e8c4f6b8bf31db555",
    },
    destination: {
      destinationChain: "sepolia",
      sourceChain: "stellar-testnet",
      route: RouteKind.Cctp,
      sourceNonce: "18446744073709551610",
      railMessageId: `0x${"ab".repeat(32)}`,
      recipient: EVM_RECIPIENT,
      token: SEPOLIA_USDC,
      amount: "99600000",
      protocolFeeAmount: "100000",
      delivered: true,
      claimId: null,
      destinationBlock: "9512900",
      destinationTx: "0xb8a185a1e723443ab0b787225006fe56db80009fe796c69e8c4f6b8bf31db555",
      confirmations: 3,
      canonicalBlockVerified: true,
      paymentEventVerified: true,
    },
  };
}

function pgliteQueryable(pg: PGlite): Queryable {
  return {
    async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
      const result = await pg.query<Record<string, unknown>>(sql, [...params]);
      return {
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rows.length,
      };
    },
  };
}

describe("new-lane backend acceptance evidence gate", () => {
  const candidateLane: CandidateLane = {
    network: "testnet",
    originChain: "stellar-testnet",
    destinationChain: "sepolia",
    route: RouteKind.Cctp,
    symbol: "USDC",
  };

  it("accepts a candidate lane only with live source, provider and confirmed payment evidence, without auto-activating", () => {
    const config = checkedInConfig();
    const report = evaluateLaneAcceptance({
      lane: candidateLane,
      deployments: config.deployments,
      evidence: validCctpEvidence(),
    });

    expect(report.accepted).toBe(true);
    expect(report.autoActivated).toBe(false);
    expect(report.activationState).toBe("pending_manual_activation");
    expect(report.reasons).toEqual([]);
    expect(report.prerequisites.length).toBe(7);
    for (const item of report.prerequisites) {
      expect(item.requiredForActivation).toBe(true);
    }
    expect(report.prerequisites.every((item) => item.satisfied)).toBe(true);
  });

  it("rejects source-only, provider-only and synthetic provider-delivered claims", () => {
    const config = checkedInConfig();
    const base = validCctpEvidence();

    const sourceOnly = evaluateLaneAcceptance({
      lane: candidateLane,
      deployments: config.deployments,
      evidence: { ...base, provider: null, destination: null },
    });
    expect(sourceOnly.accepted).toBe(false);
    expect(sourceOnly.activationState).toBe("blocked");
    expect(
      sourceOnly.prerequisites.find((p) => p.id === "provider-discovery-verified")?.satisfied,
    ).toBe(false);
    expect(
      sourceOnly.prerequisites.find((p) => p.id === "independent-destination-payment")?.satisfied,
    ).toBe(false);

    const providerOnly = evaluateLaneAcceptance({
      lane: candidateLane,
      deployments: config.deployments,
      evidence: { ...base, destination: null },
    });
    expect(providerOnly.accepted).toBe(false);
    expect(providerOnly.reasons.join(" ")).toMatch(/destination payment evidence is missing/i);

    const syntheticProviderDelivered = evaluateLaneAcceptance({
      lane: candidateLane,
      deployments: config.deployments,
      evidence: {
        ...base,
        provider: {
          rail: "cctp",
          status: "delivered",
          railStatus: "complete",
          reference: `0x${"ab".repeat(32)}`,
        },
      },
    });
    expect(syntheticProviderDelivered.accepted).toBe(false);
    expect(syntheticProviderDelivered.reasons.join(" ")).toMatch(
      /must never report status=delivered/i,
    );
  });

  it.each(["mock", "synthetic", "rehearsal"] as const)(
    "rejects %s evidence even when transfer numbers line up",
    (environment) => {
      const config = checkedInConfig();
      const report = evaluateLaneAcceptance({
        lane: candidateLane,
        deployments: config.deployments,
        evidence: { ...validCctpEvidence(), environment },
      });

      expect(report.accepted).toBe(false);
      expect(report.activationState).toBe("blocked");
      expect(report.prerequisites.find((p) => p.id === "live-evidence-provenance")?.satisfied).toBe(
        false,
      );
    },
  );

  it("enforces token representation, decimal precision and network identity", () => {
    const config = checkedInConfig();
    const fixtureConfig = loadConfig({
      env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: TESTNET_DEPLOYMENTS, KEEPER_ENABLED: "false" }),
    });

    // Fixture deployment uses a synthetic Stellar USDC issuer that disagrees with @hyperion/protocol ASSETS
    const wrongIssuer = evaluateLaneAcceptance({
      lane: candidateLane,
      deployments: fixtureConfig.deployments,
      evidence: validCctpEvidence(),
    });
    expect(wrongIssuer.accepted).toBe(false);
    expect(
      wrongIssuer.prerequisites.find((p) => p.id === "token-representation-and-precision")
        ?.satisfied,
    ).toBe(false);

    // Unrepresentable precision dust across 7 -> 6 decimals (5 stroops cannot cross into 6-decimal USDC)
    const base = validCctpEvidence();
    const dusty = evaluateLaneAcceptance({
      lane: candidateLane,
      deployments: config.deployments,
      evidence: {
        ...base,
        source: base.source
          ? {
              ...base.source,
              grossAmount: "1000000005",
              fee: "3000000",
              netAmount: "997000005",
            }
          : null,
      },
    });
    expect(dusty.accepted).toBe(false);
    expect(dusty.reasons.join(" ")).toMatch(/precision dust/i);

    // Wrong network identity (mainnet mode with testnet chains, or local rehearsal chain)
    const wrongNetwork = evaluateLaneAcceptance({
      lane: { ...candidateLane, network: "mainnet" },
      deployments: config.deployments,
      evidence: base,
    });
    expect(wrongNetwork.accepted).toBe(false);
    expect(wrongNetwork.prerequisites.find((p) => p.id === "network-identity")?.satisfied).toBe(
      false,
    );

    const localChain = evaluateLaneAcceptance({
      lane: { ...candidateLane, destinationChain: "local" },
      deployments: config.deployments,
      evidence: base,
    });
    expect(localChain.accepted).toBe(false);

    // Checked-in deployment has no EVM Hyperion router, so EVM-origin candidate lanes stay blocked
    const reverseCandidate = evaluateLaneAcceptance({
      lane: {
        network: "testnet",
        originChain: "sepolia",
        destinationChain: "stellar-testnet",
        route: RouteKind.Cctp,
        symbol: "USDC",
      },
      deployments: config.deployments,
      evidence: null,
    });
    expect(reverseCandidate.accepted).toBe(false);
    expect(reverseCandidate.reasons.join(" ")).toMatch(
      /no active Hyperion router for origin chain sepolia/i,
    );
  });

  it("rejects parked claims, unconfirmed blocks and receipt-only deliveries without token payment", () => {
    const config = checkedInConfig();
    const base = validCctpEvidence();
    if (!base.destination) throw new Error("expected destination fixture");

    const parked = evaluateLaneAcceptance({
      lane: candidateLane,
      deployments: config.deployments,
      evidence: {
        ...base,
        destination: { ...base.destination, delivered: false, claimId: "9" },
      },
    });
    expect(parked.accepted).toBe(false);

    const receiptOnly = evaluateLaneAcceptance({
      lane: candidateLane,
      deployments: config.deployments,
      evidence: {
        ...base,
        destination: { ...base.destination, paymentEventVerified: false },
      },
    });
    expect(receiptOnly.accepted).toBe(false);

    const unconfirmed = evaluateLaneAcceptance({
      lane: candidateLane,
      deployments: config.deployments,
      evidence: {
        ...base,
        destination: { ...base.destination, confirmations: 1 },
      },
    });
    expect(unconfirmed.accepted).toBe(false);
  });

  it("discovers candidate lanes and evaluates them without mutating runtime workers or activating lanes", () => {
    const config = checkedInConfig();
    const { logger } = capturingLogger();
    const db = new RecordingDb();

    const discovered = discoverCandidateLanes(config);
    expect(discovered.length).toBeGreaterThanOrEqual(6);

    const key = candidateLaneKey(candidateLane);
    const reports = evaluateConfiguredCandidateLanes(config, new Map([[key, validCctpEvidence()]]));
    const accepted = reports.find((r) => r.laneKey === key);
    expect(accepted?.accepted).toBe(true);
    expect(accepted?.autoActivated).toBe(false);
    expect(accepted?.activationState).toBe("pending_manual_activation");

    const unverified = reports.filter((r) => r.laneKey !== key);
    expect(unverified.every((r) => !r.accepted && r.activationState === "blocked")).toBe(true);

    // Runner still builds only the Stellar watcher from deployments/testnet.json and zero EVM watchers
    const indexer = buildIndexer({ config, logger, db });
    const watchedChains = indexer.workers
      .map((w) => w.name)
      .filter((name) => !name.startsWith("rail:"));
    expect(watchedChains).toEqual(["stellar-testnet"]);

    const stubClient: RailClient = {
      rail: "cctp",
      look: () => Promise.resolve({ kind: "missing" }),
    };
    const pass = new RailPass({
      route: RouteKind.Cctp,
      config,
      client: stubClient,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 1_000,
      maxCheckFailures: 3,
    });
    const passReport = pass.evaluateCandidateLane(candidateLane, validCctpEvidence());
    expect(passReport.accepted).toBe(true);
    expect(passReport.autoActivated).toBe(false);
  });

  it("evaluates indexed PostgreSQL rows while preserving NUMERIC(78,0) and NUMERIC(20,0) integer identities", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(INITIAL_SCHEMA_SQL);
      const db = pgliteQueryable(pg);
      const config = checkedInConfig();
      const observedAt = new Date("2026-10-29T10:00:00.000Z");

      await writeOutbound(
        db,
        {
          chainKey: "stellar-testnet",
          block: 5_433_900n,
          txHash: "d2d112fdef5b381534eb10e92806bd0025f307ffb0b2da0d0d3194d3f7892ca2",
          logIndex: null,
          observedAt,
        },
        {
          route: RouteKind.Cctp,
          nonce: 18_446_744_073_709_551_610n,
          sender: SENDER_STRKEY,
          token: STELLAR_USDC_SAC,
          grossAmount: 1_000_000_000n,
          fee: 3_000_000n,
          netAmount: 997_000_000n,
          destinationChain: "sepolia",
          destination: toWord(EVM_RECIPIENT),
          railRef: null,
        },
      );

      const { rows } = await db.query("SELECT id FROM outbound_transfer LIMIT 1");
      const transferId = BigInt(String(rows[0]?.id));

      await writeAttestation(db, {
        transferId,
        route: RouteKind.Cctp,
        status: "attested",
        railStatus: "complete",
        railReference: `0x${"ab".repeat(32)}`,
        attestedAt: observedAt,
        checkedAt: observedAt,
        checkFailures: 0,
        lastError: null,
      });

      // Before inbound_delivery lands: source + provider attestation alone must be rejected
      const beforeArrival = await evaluateIndexedLaneAcceptance(db, {
        lane: candidateLane,
        deployments: config.deployments,
        transferId,
        verification: {
          environment: "live",
          confirmations: 3,
          canonicalBlockVerified: true,
          paymentEventVerified: true,
          protocolFeeAmount: "100000",
        },
      });
      expect(beforeArrival.accepted).toBe(false);

      await writeInbound(
        db,
        {
          chainKey: "sepolia",
          block: 9_512_900n,
          txHash: "0xb8a185a1e723443ab0b787225006fe56db80009fe796c69e8c4f6b8bf31db555",
          logIndex: 3,
          observedAt,
        },
        {
          route: RouteKind.Cctp,
          sourceChain: "stellar-testnet",
          sourceNonce: 18_446_744_073_709_551_610n,
          railMessageId: `0x${"ab".repeat(32)}`,
          recipient: EVM_RECIPIENT,
          token: SEPOLIA_USDC,
          amount: 99_600_000n,
          delivered: true,
          claimId: null,
        },
      );

      const afterArrival = await evaluateIndexedLaneAcceptance(db, {
        lane: candidateLane,
        deployments: config.deployments,
        transferId,
        verification: {
          environment: "live",
          confirmations: 3,
          canonicalBlockVerified: true,
          paymentEventVerified: true,
          protocolFeeAmount: "100000",
        },
      });
      expect(afterArrival.accepted).toBe(true);
      expect(afterArrival.autoActivated).toBe(false);
      expect(afterArrival.activationState).toBe("pending_manual_activation");
    } finally {
      await pg.close();
    }
  });
});
