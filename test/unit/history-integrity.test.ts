import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  computeAdminActionRangeDigest,
  computeHistoryRangeDigest,
  computeInboundRangeDigest,
  computeOutboundRangeDigest,
  computePendingClaimRangeDigest,
  recordHistoryRangeDigest,
  settleAction,
  settleClaim,
  verifyHistoryRangeDigest,
  writeAction,
  writeAttestation,
  writeClaim,
  writeInbound,
  writeOutbound,
} from "../../src/chains/writers.js";
import type { AppConfig } from "../../src/config/config.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database, QueryResultRows, Queryable } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const U64_MAX = 18446744073709551615n;
const U256_MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;

function wrapPglite(pg: PGlite): Queryable {
  return {
    async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
      const normalized = params.map((param) =>
        typeof param === "bigint" ? param.toString() : param,
      );
      const result = await pg.query(sql, normalized);
      const int8Columns = result.fields
        .filter((field) => field.dataTypeID === 20)
        .map((field) => field.name);
      const rows = result.rows.map((raw) => {
        const copy = { ...(raw as Record<string, unknown>) };
        for (const column of int8Columns) {
          const value = copy[column];
          if (typeof value === "number" || typeof value === "bigint") {
            copy[column] = String(value);
          }
        }
        return copy;
      });
      return { rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
}

async function applyAllMigrations(pg: PGlite): Promise<void> {
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of names) {
    const content = readFileSync(
      fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)),
      "utf8",
    );
    await pg.exec(content.split("-- Down Migration")[0]!);
  }
}

describe("indexed-history integrity digests", () => {
  let primaryPg: PGlite;
  let restorePg: PGlite;
  let primaryDb: Queryable;
  let restoreDb: Queryable;

  beforeEach(async () => {
    primaryPg = new PGlite();
    restorePg = new PGlite();
    primaryDb = wrapPglite(primaryPg);
    restoreDb = wrapPglite(restorePg);
    await applyAllMigrations(primaryPg);
    await applyAllMigrations(restorePg);
  });

  afterEach(async () => {
    await primaryPg.close();
    await restorePg.close();
  });

  it("produces identical digests across independent backfills regardless of insertion order or surrogate IDs", async () => {
    const chainTimeA = new Date("2026-05-01T10:00:00.000Z");
    const chainTimeB = new Date("2026-05-01T10:05:00.000Z");
    const backfillIngestionTime = new Date("2026-08-15T22:30:00.000Z");

    // Advance BIGSERIAL surrogate sequences on restorePg so every auto-increment id differs.
    await restoreDb.query("SELECT setval('outbound_transfer_id_seq', 50000, true)");
    await restoreDb.query("SELECT setval('inbound_delivery_id_seq', 90000, true)");

    const departure1 = {
      at: {
        chainKey: "stellar-testnet",
        block: 1_000n,
        txHash: "tx-stellar-1000",
        logIndex: null,
        observedAt: chainTimeA,
      },
      row: {
        route: 0,
        nonce: U64_MAX - 1n,
        sender: "Gsender1",
        token: "CUSDC_SAC",
        grossAmount: U256_MAX,
        fee: 1_000_000_000_000_000_000n,
        netAmount: U256_MAX - 1_000_000_000_000_000_000n,
        destinationChain: "sepolia",
        destination: "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
        railRef: "0xcctp-msg-1",
      },
    } as const;

    const departure2 = {
      at: {
        chainKey: "stellar-testnet",
        block: 1_005n,
        txHash: "tx-stellar-1005",
        logIndex: null,
        observedAt: chainTimeB,
      },
      row: {
        route: 1,
        nonce: U64_MAX,
        sender: "Gsender2",
        token: "CEURC_SAC",
        grossAmount: 50_000_000n,
        fee: 50_000n,
        netAmount: 49_950_000n,
        destinationChain: "base-sepolia",
        destination: "0x0000000000000000000000001111111111111111111111111111111111111111",
        railRef: null,
      },
    } as const;

    const arrivalParked = {
      at: {
        chainKey: "stellar-testnet",
        block: 1_002n,
        txHash: "tx-inbound-parked",
        logIndex: null,
        observedAt: chainTimeA,
      },
      row: {
        route: 1,
        sourceChain: "sepolia",
        sourceNonce: 88n,
        railMessageId: null,
        recipient: "GrecipientParked",
        token: "CUSDC_SAC",
        amount: 99_700_000n,
        delivered: false,
        claimId: 401n,
      },
    } as const;

    const arrivalDelivered = {
      at: {
        chainKey: "stellar-testnet",
        block: 1_004n,
        txHash: "tx-inbound-landed",
        logIndex: null,
        observedAt: chainTimeB,
      },
      row: {
        route: 0,
        sourceChain: "base-sepolia",
        sourceNonce: 19n,
        railMessageId: "0x" + "ab".repeat(32),
        recipient: "GrecipientLanded",
        token: "CUSDC_SAC",
        amount: U256_MAX,
        delivered: true,
        claimId: null,
      },
    } as const;

    // Live DB writes in chronological order.
    await writeOutbound(primaryDb, departure1.at, departure1.row);
    await writeOutbound(primaryDb, departure2.at, departure2.row);
    await writeInbound(primaryDb, arrivalParked.at, arrivalParked.row);
    await writeClaim(
      primaryDb,
      { ...arrivalParked.at, observedAt: chainTimeA },
      {
        claimId: 401n,
        recipient: "GrecipientParked",
        token: "CUSDC_SAC",
        amount: 99_700_000n,
        route: 1,
        sourceChain: "sepolia",
        sourceNonce: 88n,
        createdAt: chainTimeA,
      },
    );
    await settleClaim(
      primaryDb,
      {
        chainKey: "stellar-testnet",
        block: 1_006n,
        txHash: "tx-claim-settle-401",
        logIndex: null,
        observedAt: chainTimeB,
      },
      401n,
      "Gkeeper",
    );
    await writeInbound(primaryDb, arrivalDelivered.at, arrivalDelivered.row);
    await writeAction(
      primaryDb,
      {
        chainKey: "stellar-testnet",
        block: 1_001n,
        txHash: "tx-gov-1",
        logIndex: null,
        observedAt: chainTimeA,
      },
      {
        actionId: 9n,
        kind: 2,
        payload: { feeBps: 30, targets: ["sepolia", "base-sepolia"], active: true },
        eta: chainTimeB,
        expiresAt: null,
      },
    );
    await settleAction(
      primaryDb,
      {
        chainKey: "stellar-testnet",
        block: 1_007n,
        txHash: "tx-gov-exec-1",
        logIndex: null,
        observedAt: chainTimeB,
      },
      9n,
      "executed",
      "Gadmin",
    );

    // Backfill/restore DB writes in REVERSE order, with different ingestion observedAt and different JSON key order!
    await writeOutbound(
      restoreDb,
      { ...departure2.at, observedAt: backfillIngestionTime },
      departure2.row,
    );
    await writeOutbound(
      restoreDb,
      { ...departure1.at, observedAt: backfillIngestionTime },
      departure1.row,
    );
    await writeInbound(
      restoreDb,
      { ...arrivalDelivered.at, observedAt: backfillIngestionTime },
      arrivalDelivered.row,
    );
    await writeInbound(
      restoreDb,
      { ...arrivalParked.at, observedAt: backfillIngestionTime },
      arrivalParked.row,
    );
    await writeClaim(
      restoreDb,
      { ...arrivalParked.at, observedAt: backfillIngestionTime },
      {
        claimId: 401n,
        recipient: "GrecipientParked",
        token: "CUSDC_SAC",
        amount: 99_700_000n,
        route: 1,
        sourceChain: "sepolia",
        sourceNonce: 88n,
        createdAt: chainTimeA,
      },
    );
    await settleClaim(
      restoreDb,
      {
        chainKey: "stellar-testnet",
        block: 1_006n,
        txHash: "tx-claim-settle-401",
        logIndex: null,
        observedAt: chainTimeB,
      },
      401n,
      "Gkeeper",
    );
    await writeAction(
      restoreDb,
      {
        chainKey: "stellar-testnet",
        block: 1_001n,
        txHash: "tx-gov-1",
        logIndex: null,
        observedAt: chainTimeA,
      },
      {
        actionId: 9n,
        kind: 2,
        // Reordered keys in JSON payload must hash identically via canonicalJson.
        payload: { active: true, targets: ["sepolia", "base-sepolia"], feeBps: 30 },
        eta: chainTimeB,
        expiresAt: null,
      },
    );
    await settleAction(
      restoreDb,
      {
        chainKey: "stellar-testnet",
        block: 1_007n,
        txHash: "tx-gov-exec-1",
        logIndex: null,
        observedAt: chainTimeB,
      },
      9n,
      "executed",
      "Gadmin",
    );

    const primaryOutbound = await computeOutboundRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      fromBlock: 1_000n,
      toBlock: 1_010n,
    });
    const restoreOutbound = await computeOutboundRangeDigest(restoreDb, {
      chainKey: "stellar-testnet",
      fromBlock: 1_000n,
      toBlock: 1_010n,
    });
    expect(restoreOutbound).toEqual(primaryOutbound);

    const primaryInbound = await computeInboundRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      fromBlock: 1_000n,
      toBlock: 1_010n,
    });
    const restoreInbound = await computeInboundRangeDigest(restoreDb, {
      chainKey: "stellar-testnet",
      fromBlock: 1_000n,
      toBlock: 1_010n,
    });
    expect(restoreInbound).toEqual(primaryInbound);

    const primaryClaims = await computePendingClaimRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      fromClaimId: 400n,
      toClaimId: 410n,
    });
    const restoreClaims = await computePendingClaimRangeDigest(restoreDb, {
      chainKey: "stellar-testnet",
      fromClaimId: 400n,
      toClaimId: 410n,
    });
    expect(restoreClaims).toEqual(primaryClaims);

    const primaryActions = await computeAdminActionRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      fromActionId: 1n,
      toActionId: 20n,
    });
    const restoreActions = await computeAdminActionRangeDigest(restoreDb, {
      chainKey: "stellar-testnet",
      fromActionId: 1n,
      toActionId: 20n,
    });
    expect(restoreActions).toEqual(primaryActions);

    const primaryRollup = await computeHistoryRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      recordKind: "chain_range",
      rangeStart: 1_000n,
      rangeEnd: 1_010n,
    });
    const verificationOnRestore = await verifyHistoryRangeDigest(restoreDb, {
      chainKey: "stellar-testnet",
      recordKind: "chain_range",
      rangeStart: 1_000n,
      rangeEnd: 1_010n,
      expectedDigestHex: primaryRollup.digestHex,
      expectedRowCount: primaryRollup.rowCount,
    });
    expect(verificationOnRestore.matches).toBe(true);
    expect(verificationOnRestore.reason).toBe("matched");
    expect(verificationOnRestore.actualRowCount).toBe(5n);
  });

  it("detects 1-unit monetary mutations, altered fields, and missing records in a range", async () => {
    const observedAt = new Date("2026-05-02T00:00:00.000Z");
    for (const nonce of [10n, 11n, 12n]) {
      await writeOutbound(
        primaryDb,
        {
          chainKey: "stellar-testnet",
          block: 200n + nonce,
          txHash: `tx-${nonce.toString()}`,
          logIndex: null,
          observedAt,
        },
        {
          route: 0,
          nonce,
          sender: "Gsender",
          token: "USDC",
          grossAmount: U256_MAX - 10n + nonce,
          fee: 5n,
          netAmount: U256_MAX - 15n + nonce,
          destinationChain: "sepolia",
          destination: "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
          railRef: `ref-${nonce.toString()}`,
        },
      );
    }

    const checkpoint = await recordHistoryRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      recordKind: "outbound_transfer",
      rangeStart: 200n,
      rangeEnd: 250n,
    });
    expect(checkpoint.rowCount).toBe(3n);

    // Mutate fee by +1 stroop/wei and net_amount by -1 stroop/wei (preserving gross = fee + net constraint!).
    await primaryDb.query(
      `UPDATE outbound_transfer
          SET fee = fee + 1,
              net_amount = net_amount - 1
        WHERE origin_chain = 'stellar-testnet' AND nonce = 11`,
    );

    const afterAmountTamper = await verifyHistoryRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      recordKind: "outbound_transfer",
      rangeStart: 200n,
      rangeEnd: 250n,
    });
    expect(afterAmountTamper.matches).toBe(false);
    expect(afterAmountTamper.reason).toBe("digest_mismatch");
    expect(afterAmountTamper.actualDigestHex).not.toBe(checkpoint.digestHex);

    // Restore original monetary split -> digest matches checkpoint again!
    await primaryDb.query(
      `UPDATE outbound_transfer
          SET fee = fee - 1,
              net_amount = net_amount + 1
        WHERE origin_chain = 'stellar-testnet' AND nonce = 11`,
    );
    const restoredVerify = await verifyHistoryRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      recordKind: "outbound_transfer",
      rangeStart: 200n,
      rangeEnd: 250n,
    });
    expect(restoredVerify.matches).toBe(true);

    // Delete 1 record -> detected as row_count_mismatch and altered digest!
    await primaryDb.query(
      "DELETE FROM outbound_transfer WHERE origin_chain = 'stellar-testnet' AND nonce = 12",
    );
    const afterMissingRow = await verifyHistoryRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      recordKind: "outbound_transfer",
      rangeStart: 200n,
      rangeEnd: 250n,
    });
    expect(afterMissingRow.matches).toBe(false);
    expect(afterMissingRow.reason).toBe("row_count_mismatch");
    expect(afterMissingRow.expectedRowCount).toBe(3n);
    expect(afterMissingRow.actualRowCount).toBe(2n);
    expect(afterMissingRow.actualDigestHex).not.toBe(checkpoint.digestHex);
  });

  it("keeps underlying fact digests invariant when HTTP API formatting or attestation presentation changes", async () => {
    const baseConfig = loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) });
    const stellarDeployment = baseConfig.deployments.networks["stellar-testnet"];
    if (stellarDeployment?.family !== "stellar" || !stellarDeployment.tokens.USDC) {
      throw new Error("Expected stellar-testnet USDC deployment in test config");
    }
    const sacToken = stellarDeployment.tokens.USDC.sacId;
    const rawWireRecipient = "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38";

    await writeOutbound(
      primaryDb,
      {
        chainKey: "stellar-testnet",
        block: 777n,
        txHash: "presentation-source-tx",
        logIndex: null,
        observedAt: new Date("2026-05-03T12:00:00.000Z"),
      },
      {
        route: 1,
        nonce: 55n,
        sender: "GsenderPresentation",
        token: sacToken,
        grossAmount: 10_000_000n,
        fee: 30_000n,
        netAmount: 9_970_000n,
        destinationChain: "sepolia",
        destination: rawWireRecipient,
        railRef: "axelar-ref-55",
      },
    );

    const baselineOutboundDigest = await computeOutboundRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      fromBlock: 700n,
      toBlock: 800n,
    });
    const baselineRollupDigest = await computeHistoryRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      recordKind: "chain_range",
      rangeStart: 700n,
      rangeEnd: 800n,
    });

    const { logger } = capturingLogger();
    const serverWithDefaultFormatting = buildServer({
      config: baseConfig,
      logger,
      db: primaryDb as unknown as Database,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
    });
    await serverWithDefaultFormatting.ready();

    const firstHttp = await serverWithDefaultFormatting.inject(
      "/v1/transfers/by-tx/presentation-source-tx",
    );
    expect(firstHttp.statusCode).toBe(200);
    // HTTP API normalizes the 32-byte wire word into a 20-byte EVM address and attaches symbol/decimals.
    expect(firstHttp.json().destination.recipient).toBe(
      "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
    );
    expect(firstHttp.json().origin.symbol).toBe("USDC");
    expect(firstHttp.json().origin.decimals).toBe(7);
    expect(firstHttp.json().stage).toBe("initiated");
    await serverWithDefaultFormatting.close();

    // Mutate off-chain rail_attestation state and launch HTTP server with altered token symbol/decimals config.
    const { rows: idRows } = await primaryDb.query(
      "SELECT id FROM outbound_transfer WHERE origin_tx = 'presentation-source-tx'",
    );
    await writeAttestation(primaryDb, {
      transferId: BigInt(String(idRows[0]?.id)),
      route: 1,
      status: "attested",
      railStatus: "approved",
      railReference: "gmp-call-55",
      attestedAt: new Date("2026-05-03T12:02:00.000Z"),
      checkedAt: new Date("2026-05-03T12:02:00.000Z"),
      checkFailures: 0,
      lastError: null,
    });

    const renamedTokenConfig: AppConfig = {
      ...baseConfig,
      deployments: {
        ...baseConfig.deployments,
        networks: {
          ...baseConfig.deployments.networks,
          "stellar-testnet": {
            ...stellarDeployment,
            tokens: {
              BRIDGED_USD: {
                ...stellarDeployment.tokens.USDC,
                decimals: 18,
              },
            },
          },
        },
      },
    };

    const serverWithRenamedFormatting = buildServer({
      config: renamedTokenConfig,
      logger,
      db: primaryDb as unknown as Database,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
    });
    await serverWithRenamedFormatting.ready();

    const secondHttp = await serverWithRenamedFormatting.inject(
      "/v1/transfers/by-tx/presentation-source-tx",
    );
    expect(secondHttp.statusCode).toBe(200);
    // API output changed visibly across symbol, decimals, stage, and rail block.
    expect(secondHttp.json().origin.symbol).toBe("BRIDGED_USD");
    expect(secondHttp.json().origin.decimals).toBe(18);
    expect(secondHttp.json().stage).toBe("delivering");
    await serverWithRenamedFormatting.close();

    // Underlying chain fact digests remain 100% identical!
    const afterFormattingOutbound = await computeOutboundRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      fromBlock: 700n,
      toBlock: 800n,
    });
    const afterFormattingRollup = await computeHistoryRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      recordKind: "chain_range",
      rangeStart: 700n,
      rangeEnd: 800n,
    });
    expect(afterFormattingOutbound).toEqual(baselineOutboundDigest);
    expect(afterFormattingRollup).toEqual(baselineRollupDigest);
  });

  it("canonicalizes nested JSON payloads and domain-separates empty ranges across chains and kinds", async () => {
    expect(canonicalJson({ z: 1, a: { d: [3, 2], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [3, 2] }, z: 1 }),
    );

    const emptyOutbound = await computeHistoryRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      recordKind: "outbound_transfer",
      rangeStart: 0n,
      rangeEnd: 100n,
    });
    const emptyInbound = await computeHistoryRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      recordKind: "inbound_delivery",
      rangeStart: 0n,
      rangeEnd: 100n,
    });
    const emptyOtherChain = await computeHistoryRangeDigest(primaryDb, {
      chainKey: "sepolia",
      recordKind: "outbound_transfer",
      rangeStart: 0n,
      rangeEnd: 100n,
    });
    expect(emptyOutbound.digestHex).not.toBe(emptyInbound.digestHex);
    expect(emptyOutbound.digestHex).not.toBe(emptyOtherChain.digestHex);

    const missingCheckpoint = await verifyHistoryRangeDigest(primaryDb, {
      chainKey: "stellar-testnet",
      recordKind: "outbound_transfer",
      rangeStart: 0n,
      rangeEnd: 100n,
    });
    expect(missingCheckpoint.matches).toBe(false);
    expect(missingCheckpoint.reason).toBe("missing_checkpoint");
  });
});
