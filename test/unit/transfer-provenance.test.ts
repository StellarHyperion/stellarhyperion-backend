import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  settleClaim,
  writeAttestation,
  writeClaim,
  writeInbound,
  writeOutbound,
} from "../../src/chains/writers.js";
import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import { sanitizeProvenanceText } from "../../src/http/provenance.js";
import type { FormattedClaim } from "../../src/http/routes/claims.js";
import type { FormattedTransfer } from "../../src/http/routes/transfers.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_TESTNET_DEPLOYMENTS = join(REPO_ROOT, "deployments", "testnet.json");

describe("Sanitized transfer proof provenance", () => {
  const config = loadConfig({
    env: completeEnv({
      KEEPER_ENABLED: "false",
      HYPERION_DEPLOYMENTS_FILE: ACTIVE_TESTNET_DEPLOYMENTS,
    }),
  });
  const { logger } = capturingLogger();

  const pg = new PGlite();
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      const result = await pg.query(sql, [...params]);
      const int8 = result.fields
        .filter((field) => field.dataTypeID === 20)
        .map((field) => field.name);
      const rows = result.rows.map((raw) => {
        const row = { ...(raw as Record<string, unknown>) };
        for (const column of int8) {
          const value = row[column];
          if (typeof value === "number" || typeof value === "bigint") {
            row[column] = String(value);
          }
        }
        return row;
      });
      return { rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    ping: async () => {
      await pg.query("SELECT 1");
    },
  };

  const app = buildServer({
    config,
    logger,
    db: db as unknown as Database,
    readiness: [],
  });

  beforeAll(async () => {
    for (const name of [
      "1790900000000_initial-schema.sql",
      "1791000000000_cursor-block-hash.sql",
      "1791100000000_cursor-autovacuum-tuning.sql",
    ]) {
      const migrationPath = join(REPO_ROOT, "migrations", name);
      const sql = readFileSync(migrationPath, "utf8").split("-- Down Migration")[0] ?? "";
      await pg.exec(sql);
    }
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await pg.close();
  });

  it("keeps provider-reported hashes as explicitly unverified candidates until canonical destination receipt exists", async () => {
    const stellarDeployment = config.deployments.networks["stellar-testnet"];
    if (stellarDeployment?.family !== "stellar" || !stellarDeployment.tokens.USDC) {
      throw new Error("Expected active Stellar testnet deployment");
    }

    const fullOriginTx = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809";
    const candidateForwardHash =
      "0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0";

    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 5434100n,
        txHash: fullOriginTx,
        logIndex: null,
        observedAt: new Date("2026-11-01T10:00:00Z"),
      },
      {
        route: 0,
        nonce: 101n,
        sender: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
        token: stellarDeployment.tokens.USDC.sacId,
        grossAmount: 10000000n,
        fee: 30000n,
        netAmount: 9970000n,
        destinationChain: "sepolia",
        destination: "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
        railRef: "cctp-nonce-101",
      },
    );

    const lookupBeforeDelivery = await app.inject("/v1/transfers/stellar-testnet/101");
    expect(lookupBeforeDelivery.statusCode).toBe(200);
    const initialBody = lookupBeforeDelivery.json<FormattedTransfer>();

    await writeAttestation(db, {
      transferId: BigInt(initialBody.id),
      route: 0,
      status: "attested",
      railStatus: "complete",
      railReference: candidateForwardHash,
      attestedAt: new Date("2026-11-01T10:01:00Z"),
      checkedAt: new Date("2026-11-01T10:01:00Z"),
      checkFailures: 0,
      lastError: null,
    });

    const attestedRes = await app.inject("/v1/transfers/stellar-testnet/101");
    expect(attestedRes.statusCode).toBe(200);
    const attestedTransfer = attestedRes.json<FormattedTransfer>();

    // Provider status alone never establishes destination delivery or confirmed destination proof.
    expect(attestedTransfer.stage).toBe("delivering");
    expect(attestedTransfer.destination.delivered).toBe(false);
    expect(attestedTransfer.provenance.source).toEqual({
      verification: "confirmed_on_chain",
      verified: true,
      role: "source_event",
      chain: "stellar-testnet",
      txHash: fullOriginTx,
      block: "5434100",
      logIndex: null,
      observedAt: "2026-11-01T10:00:00.000Z",
    });
    expect(attestedTransfer.provenance.destination).toBeNull();
    expect(attestedTransfer.provenance.settlement).toBeNull();
    expect(attestedTransfer.provenance.candidates).toEqual([
      {
        verification: "unverified_candidate",
        verified: false,
        source: "origin_rail_ref",
        reference: "cctp-nonce-101",
        providerStatus: null,
        attestedAt: null,
        note: "Unverified candidate reference only; destination delivery requires a confirmed canonical receipt.",
      },
      {
        verification: "unverified_candidate",
        verified: false,
        source: "rail_provider",
        reference: candidateForwardHash,
        providerStatus: "complete",
        attestedAt: "2026-11-01T10:01:00.000Z",
        note: "Unverified candidate reference only; destination delivery requires a confirmed canonical receipt.",
      },
    ]);

    // Once canonical destination receipt is verified on-chain, confirmed proof includes chain, tx, block, logIndex, and full-width messageId.
    const fullMessageId = "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const confirmedDestTx = "0x777788889999aaaabbbbccccddddeeeeffff0000111122223333444455556666";

    await writeInbound(
      db,
      {
        chainKey: "sepolia",
        block: 7123456n,
        txHash: confirmedDestTx,
        logIndex: 14,
        observedAt: new Date("2026-11-01T10:03:00Z"),
      },
      {
        route: 0,
        sourceChain: "stellar-testnet",
        sourceNonce: 101n,
        railMessageId: fullMessageId,
        recipient: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        amount: 9950000n,
        delivered: true,
        claimId: null,
      },
    );

    const deliveredRes = await app.inject("/v1/transfers/stellar-testnet/101");
    expect(deliveredRes.statusCode).toBe(200);
    const deliveredTransfer = deliveredRes.json<FormattedTransfer>();
    expect(deliveredTransfer.destination.delivered).toBe(true);
    expect(deliveredTransfer.provenance.destination).toEqual({
      verification: "confirmed_on_chain",
      verified: true,
      role: "destination_delivery",
      chain: "sepolia",
      txHash: confirmedDestTx,
      block: "7123456",
      logIndex: 14,
      railMessageId: fullMessageId,
      claimId: null,
      observedAt: "2026-11-01T10:03:00.000Z",
    });
  });

  it("projects parked claim and subsequent on-chain claim settlement proofs accurately", async () => {
    await writeOutbound(
      db,
      {
        chainKey: "sepolia",
        block: 8000100n,
        txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
        logIndex: 3,
        observedAt: new Date("2026-11-02T08:00:00Z"),
      },
      {
        route: 1,
        nonce: 55n,
        sender: "0x6ef8032ffe4943f27388172549f6700f18bb8b38",
        token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        grossAmount: 5000000n,
        fee: 15000n,
        netAmount: 4985000n,
        destinationChain: "stellar-testnet",
        destination: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
        railRef: null,
      },
    );

    await writeInbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 5435000n,
        txHash: "parked-arrival-tx-hash-001",
        logIndex: null,
        observedAt: new Date("2026-11-02T08:02:00Z"),
      },
      {
        route: 1,
        sourceChain: "sepolia",
        sourceNonce: 55n,
        railMessageId: null,
        recipient: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
        token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        amount: 4985000n,
        delivered: false,
        claimId: 12n,
      },
    );

    await writeClaim(
      db,
      {
        chainKey: "stellar-testnet",
        block: 5435000n,
        txHash: "parked-arrival-tx-hash-001",
        logIndex: null,
        observedAt: new Date("2026-11-02T08:02:00Z"),
      },
      {
        claimId: 12n,
        recipient: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
        token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        amount: 4985000n,
        route: 1,
        sourceChain: "sepolia",
        sourceNonce: 55n,
        createdAt: new Date("2026-11-02T08:02:00Z"),
      },
    );

    await settleClaim(
      db,
      {
        chainKey: "stellar-testnet",
        block: 5435099n,
        txHash: "settled-claim-tx-hash-002",
        logIndex: null,
        observedAt: new Date("2026-11-02T08:05:00Z"),
      },
      12n,
      "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
    );

    const transferRes = await app.inject("/v1/transfers/sepolia/55");
    expect(transferRes.statusCode).toBe(200);
    const settledTransfer = transferRes.json<FormattedTransfer>();
    expect(settledTransfer.stage).toBe("settled");
    expect(settledTransfer.provenance.destination?.role).toBe("parked_claim");
    expect(settledTransfer.provenance.destination?.claimId).toBe("12");
    expect(settledTransfer.provenance.settlement).toEqual({
      verification: "confirmed_on_chain",
      verified: true,
      role: "claim_settlement",
      chain: "stellar-testnet",
      claimId: "12",
      txHash: "settled-claim-tx-hash-002",
      settledBy: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
      settledAt: "2026-11-02T08:05:00.000Z",
    });

    const claimRes = await app.inject("/v1/claims/stellar-testnet/12");
    expect(claimRes.statusCode).toBe(200);
    const claimBody = claimRes.json<FormattedClaim>();
    expect(claimBody.settlement?.txHash).toBe("settled-claim-tx-hash-002");
  });

  it("strips raw provider credentials, RPC path keys, auth headers, and signing material from responses", async () => {
    const stellarSecretSeed = `S${"B".repeat(55)}`;
    const circleKey = ["TEST_API_KEY", "id123", "secretvalue987"].join(":");
    const syntheticJwt = [`eyJ${"a".repeat(12)}`, `eyJ${"b".repeat(12)}`, "sigtokenvalue123"].join(
      ".",
    );
    const bearerHeader = ["Bearer", syntheticJwt].join(" ");
    const rpcSecretSegment = "A1b2C3d4E5f6G7h8I9j0K1l2";
    const providerUrlWithSecrets = [
      "https://",
      "user",
      ":",
      "pass",
      `@sepolia.provider.example/v2/${rpcSecretSegment}?apiKey=raw-query-key&ref=msg-900#frag`,
    ].join("");
    const signingKeyLeak = ["private_key", "0x" + "ef".repeat(32)].join("=");

    await writeOutbound(
      db,
      {
        chainKey: "stellar-testnet",
        block: 5436000n,
        txHash: "origin-clean-hash-900",
        logIndex: null,
        observedAt: new Date("2026-11-03T12:00:00Z"),
      },
      {
        route: 0,
        nonce: 900n,
        sender: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
        token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        grossAmount: 2000000n,
        fee: 6000n,
        netAmount: 1994000n,
        destinationChain: "sepolia",
        destination: "0x0000000000000000000000006ef8032ffe4943f27388172549f6700f18bb8b38",
        railRef: `ref=msg-900 ${signingKeyLeak} seed=${stellarSecretSeed}`,
      },
    );

    const createdRes = await app.inject("/v1/transfers/stellar-testnet/900");
    const createdId = createdRes.json<FormattedTransfer>().id;

    await writeAttestation(db, {
      transferId: BigInt(createdId),
      route: 0,
      status: "pending",
      railStatus: `pending (${circleKey})`,
      railReference: providerUrlWithSecrets,
      attestedAt: null,
      checkedAt: new Date("2026-11-03T12:01:00Z"),
      checkFailures: 1,
      lastError: `upstream 401 with ${bearerHeader} and ${circleKey} using ${stellarSecretSeed}`,
    });

    const sanitizedRes = await app.inject("/v1/transfers/stellar-testnet/900");
    expect(sanitizedRes.statusCode).toBe(200);
    const payload = sanitizedRes.payload;

    expect(payload).not.toContain(stellarSecretSeed);
    expect(payload).not.toContain("secretvalue987");
    expect(payload).not.toContain("raw-query-key");
    expect(payload).not.toContain("user:pass");
    expect(payload).not.toContain(rpcSecretSegment);
    expect(payload).not.toContain("ef".repeat(32));
    expect(payload).not.toContain("sigtokenvalue123");
    expect(payload).toContain("ref=msg-900");

    // Also verify PEM private key block redaction directly.
    const pemHeader = ["-----BEGIN", "EC PRIVATE KEY-----"].join(" ");
    const pemFooter = ["-----END", "EC PRIVATE KEY-----"].join(" ");
    const pemRedacted = sanitizeProvenanceText(`${pemHeader}\nMIIB...\n${pemFooter}`);
    expect(pemRedacted).toBe("[redacted-private-key]");
  });
});
