import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  settleClaim,
  writeAttestation,
  writeClaim,
  writeInbound,
  writeOutbound,
} from "../../src/chains/writers.js";
import {
  auditTransferAndClaimInvariants,
  redactAuditConnectionText,
  runInvariantAuditCli,
} from "../../src/db/invariants.js";
import type { Queryable, QueryResultRows, Transactional } from "../../src/db/pool.js";

const STELLAR_CHAIN = "stellar-testnet";
const BASE_CHAIN = "base-sepolia";
const ARBITRUM_CHAIN = "arbitrum-sepolia";

// Validated CRC16 Stellar strkeys from test/fixtures/deployments-testnet.json
const STELLAR_SENDER = "GC4FD5G3CZJ57VPYTVNWU4FRDLLV37EYDGT3OVZA35WKHBWDI6PKTYTN";
const STELLAR_RECIPIENT = "GD4IEL76RCF2CULJZAKDTEZOQIIUTH3JDKY52W7SR6GBI42PZFIZGWIB";
const STELLAR_SETTLER = "GCK4I7AM6GVA5XORMZ6SZHJUNNSDYBBXWNYUQHHQLAMGAMZUNG3PJWI6";
const STELLAR_USDC = "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA";

const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_RECIPIENT_WORD = `0x000000000000000000000000${"22".repeat(20)}`;
const BASE_RECIPIENT = `0x${"22".repeat(20)}`;
const BASE_SENDER = `0x${"33".repeat(20)}`;

class PgliteAuditDb implements Transactional {
  readonly statements: string[] = [];

  constructor(private readonly pg: PGlite) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<QueryResultRows> {
    this.statements.push(sql.trim());
    const result = await this.pg.query(sql, [...params]);
    const int8 = result.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name);
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
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    await this.query("BEGIN");
    try {
      const out = await work({
        query: (sql, params) => this.query(sql, params),
      });
      await this.query("COMMIT");
      return out;
    } catch (error) {
      await this.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}

async function applyBaselineMigrations(pg: PGlite): Promise<void> {
  for (const name of [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
  ]) {
    const fullSql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
    const upSql = fullSql.split("-- Down Migration")[0] ?? fullSql;
    await pg.exec(upSql);
  }
}

async function snapshotAllRows(db: Queryable): Promise<Record<string, unknown>> {
  const outbound = (
    await db.query(
      `SELECT id::text AS id, origin_chain, route, nonce::text AS nonce, gross_amount::text AS gross_amount,
              fee::text AS fee, net_amount::text AS net_amount, destination_chain, origin_tx
       FROM outbound_transfer ORDER BY id ASC`,
    )
  ).rows;
  const inbound = (
    await db.query(
      `SELECT id::text AS id, destination_chain, route, source_chain, source_nonce::text AS source_nonce,
              amount::text AS amount, delivered, claim_id::text AS claim_id, destination_tx
       FROM inbound_delivery ORDER BY id ASC`,
    )
  ).rows;
  const claims = (
    await db.query(
      `SELECT chain, claim_id::text AS claim_id, recipient, token, amount::text AS amount,
              route, source_chain, source_nonce::text AS source_nonce, settled, settled_by, settled_tx
       FROM pending_claim ORDER BY chain ASC, claim_id ASC`,
    )
  ).rows;
  const attestations = (
    await db.query(
      `SELECT transfer_id::text AS transfer_id, route, status, rail_status, rail_reference
       FROM rail_attestation ORDER BY transfer_id ASC`,
    )
  ).rows;
  return { outbound, inbound, claims, attestations };
}

describe("transfer and claim invariant auditor (#59)", () => {
  let pg: PGlite;
  let db: PgliteAuditDb;

  beforeEach(async () => {
    pg = new PGlite();
    await applyBaselineMigrations(pg);
    db = new PgliteAuditDb(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("passes cleanly on freshly migrated empty schema and realistic replay fixtures", async () => {
    const emptyReport = await auditTransferAndClaimInvariants(db);
    expect(emptyReport.ok).toBe(true);
    expect(emptyReport.readOnlyEnforced).toBe(true);
    expect(emptyReport.violations).toEqual([]);
    expect(emptyReport.summary.outboundCount).toBe(0);
    expect(db.statements).toContain("SET TRANSACTION READ ONLY");

    // Seed realistic multi-hop replay fixtures using canonical repository writers:
    // Hop 1: Stellar (7 decimals: 100.0000000 USDC -> 99.7000000 net) -> Base Sepolia (6 decimals: 99.700000 delivered)
    await writeOutbound(
      db,
      {
        chainKey: STELLAR_CHAIN,
        block: 500_001n,
        txHash: "aa".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-20T10:00:00.000Z"),
      },
      {
        route: 0,
        nonce: 1n,
        sender: STELLAR_SENDER,
        token: STELLAR_USDC,
        grossAmount: 1_000_000_000n,
        fee: 3_000_000n,
        netAmount: 997_000_000n,
        destinationChain: BASE_CHAIN,
        destination: BASE_RECIPIENT_WORD,
        railRef: `0x${"11".repeat(32)}`,
      },
    );
    // Replay same departure idempotently
    await writeOutbound(
      db,
      {
        chainKey: STELLAR_CHAIN,
        block: 500_001n,
        txHash: "aa".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-20T10:00:00.000Z"),
      },
      {
        route: 0,
        nonce: 1n,
        sender: STELLAR_SENDER,
        token: STELLAR_USDC,
        grossAmount: 1_000_000_000n,
        fee: 3_000_000n,
        netAmount: 997_000_000n,
        destinationChain: BASE_CHAIN,
        destination: BASE_RECIPIENT_WORD,
        railRef: `0x${"11".repeat(32)}`,
      },
    );
    await writeInbound(
      db,
      {
        chainKey: BASE_CHAIN,
        block: 9_100_010n,
        txHash: `0x${"bb".repeat(32)}`,
        logIndex: 0,
        observedAt: new Date("2026-10-20T10:02:00.000Z"),
      },
      {
        route: 0,
        sourceChain: STELLAR_CHAIN,
        sourceNonce: 1n,
        railMessageId: `0x${"11".repeat(32)}`,
        recipient: BASE_RECIPIENT,
        token: BASE_USDC,
        amount: 99_700_000n,
        delivered: true,
        claimId: null,
      },
    );

    // Hop 2: Base Sepolia -> Stellar parked as claim 77 (u64-safe), still unsettled
    const u64Nonce = 18_446_744_073_709_551_610n;
    await writeOutbound(
      db,
      {
        chainKey: BASE_CHAIN,
        block: 9_100_050n,
        txHash: `0x${"cc".repeat(32)}`,
        logIndex: 2,
        observedAt: new Date("2026-10-20T10:05:00.000Z"),
      },
      {
        route: 1,
        nonce: u64Nonce,
        sender: BASE_SENDER,
        token: BASE_USDC,
        grossAmount: 50_000_000n,
        fee: 150_000n,
        netAmount: 49_850_000n,
        destinationChain: STELLAR_CHAIN,
        destination: STELLAR_RECIPIENT,
        railRef: `0x${"44".repeat(32)}`,
      },
    );
    await writeClaim(
      db,
      {
        chainKey: STELLAR_CHAIN,
        block: 500_090n,
        txHash: "dd".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-20T10:07:00.000Z"),
      },
      {
        claimId: 77n,
        recipient: STELLAR_RECIPIENT,
        token: STELLAR_USDC,
        amount: 498_500_000n,
        route: 1,
        sourceChain: BASE_CHAIN,
        sourceNonce: u64Nonce,
        createdAt: new Date("2026-10-20T10:07:00.000Z"),
      },
    );
    await writeInbound(
      db,
      {
        chainKey: STELLAR_CHAIN,
        block: 500_090n,
        txHash: "dd".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-20T10:07:00.000Z"),
      },
      {
        route: 1,
        sourceChain: BASE_CHAIN,
        sourceNonce: u64Nonce,
        railMessageId: null,
        recipient: STELLAR_RECIPIENT,
        token: STELLAR_USDC,
        amount: 498_500_000n,
        delivered: false,
        claimId: 77n,
      },
    );

    // Hop 3: Parked and canonically settled claim 88 on Stellar
    await writeClaim(
      db,
      {
        chainKey: STELLAR_CHAIN,
        block: 500_100n,
        txHash: "ee".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-20T10:10:00.000Z"),
      },
      {
        claimId: 88n,
        recipient: STELLAR_RECIPIENT,
        token: STELLAR_USDC,
        amount: 25_000_000n,
        route: 1,
        sourceChain: BASE_CHAIN,
        sourceNonce: 99n,
        createdAt: new Date("2026-10-20T10:10:00.000Z"),
      },
    );
    await writeInbound(
      db,
      {
        chainKey: STELLAR_CHAIN,
        block: 500_100n,
        txHash: "ee".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-20T10:10:00.000Z"),
      },
      {
        route: 1,
        sourceChain: BASE_CHAIN,
        sourceNonce: 99n,
        railMessageId: null,
        recipient: STELLAR_RECIPIENT,
        token: STELLAR_USDC,
        amount: 25_000_000n,
        delivered: false,
        claimId: 88n,
      },
    );
    await settleClaim(
      db,
      {
        chainKey: STELLAR_CHAIN,
        block: 500_120n,
        txHash: "ff".repeat(32),
        logIndex: null,
        observedAt: new Date("2026-10-20T10:15:00.000Z"),
      },
      88n,
      STELLAR_SETTLER,
    );

    const outboundRows = (
      await db.query("SELECT id::text AS id FROM outbound_transfer ORDER BY id ASC")
    ).rows;
    const hop1Id = BigInt(String(outboundRows[0]?.id));
    const hop2Id = BigInt(String(outboundRows[1]?.id));

    await writeAttestation(db, {
      transferId: hop1Id,
      route: 0,
      status: "delivered",
      railStatus: "complete",
      railReference: `0x${"11".repeat(32)}`,
      attestedAt: new Date("2026-10-20T10:01:00.000Z"),
      checkedAt: new Date("2026-10-20T10:02:10.000Z"),
      checkFailures: 0,
      lastError: null,
    });
    await writeAttestation(db, {
      transferId: hop2Id,
      route: 1,
      status: "attested",
      railStatus: "approved",
      railReference: `0x${"44".repeat(32)}`,
      attestedAt: new Date("2026-10-20T10:06:00.000Z"),
      checkedAt: new Date("2026-10-20T10:07:10.000Z"),
      checkFailures: 0,
      lastError: null,
    });

    // 1. Without tokenMetadata: tolerates 7-decimal <-> 6-decimal hops without inventing decimals!
    const withoutMetadata = await auditTransferAndClaimInvariants(db);
    expect(withoutMetadata.ok).toBe(true);
    expect(withoutMetadata.violations).toEqual([]);
    expect(withoutMetadata.summary.unscaledCrossChainHops).toBe(2);
    expect(withoutMetadata.summary.verifiedHopScaleChecks).toBe(0);
    expect(withoutMetadata.summary.claimLiabilities).toEqual([
      {
        chain: STELLAR_CHAIN,
        token: STELLAR_USDC,
        unsettledCount: 1,
        unsettledAmount: "498500000",
        settledCount: 1,
        settledAmount: "25000000",
      },
    ]);

    // 2. With verified tokenMetadata (Stellar USDC = 7 decimals, Base USDC = 6 decimals): scales cleanly!
    const withMetadata = await auditTransferAndClaimInvariants(db, {
      tokenMetadata: [
        { chain: STELLAR_CHAIN, token: STELLAR_USDC, decimals: 7 },
        { chain: BASE_CHAIN, token: BASE_USDC.toUpperCase(), decimals: 6 },
      ],
    });
    expect(withMetadata.ok).toBe(true);
    expect(withMetadata.violations).toEqual([]);
    expect(withMetadata.summary.unscaledCrossChainHops).toBe(0);
    expect(withMetadata.summary.verifiedHopScaleChecks).toBe(2);
  });

  it("reports exact row identities across conservation, claim liability, and settlement violations without mutating rows", async () => {
    // Relax outbound split CHECK solely to simulate a corrupted dump / disabled constraint row
    await db.query("ALTER TABLE outbound_transfer DROP CONSTRAINT outbound_transfer_amounts");

    // 1. Corrupt outbound split: gross (1000) != fee (10) + net (995)
    await db.query(
      `INSERT INTO outbound_transfer
         (id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES (10, $1, 0, 10, $2, $3, 1000, 10, 995, $4, $5, 100, 'tx-split-bad')`,
      [STELLAR_CHAIN, STELLAR_SENDER, STELLAR_USDC, BASE_CHAIN, BASE_RECIPIENT_WORD],
    );

    // 2. Over-delivered cross-chain hop + duplicate arrival + wrong destination_chain
    await db.query(
      `INSERT INTO outbound_transfer
         (id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES (20, $1, 0, 20, $2, $3, 10000000, 100000, 9900000, $4, $5, 101, 'tx-hop-20')`,
      [STELLAR_CHAIN, STELLAR_SENDER, STELLAR_USDC, BASE_CHAIN, BASE_RECIPIENT_WORD],
    );
    // Arrival A on Base Sepolia: 1_000_000 (1.0 USDC at 6 dec) > 9_900_000 (0.99 USDC at 7 dec)
    await db.query(
      `INSERT INTO inbound_delivery
         (id, destination_chain, route, source_chain, source_nonce, rail_message_id, recipient,
          token, amount, delivered, claim_id, destination_block, destination_tx)
       VALUES (201, $1, 0, $2, 20, '0xmsg201', $3, $4, 1000000, true, NULL, 900, '0xdest201')`,
      [BASE_CHAIN, STELLAR_CHAIN, BASE_RECIPIENT, BASE_USDC],
    );
    // Arrival B on Arbitrum Sepolia claiming the exact same departure (duplicate + chain mismatch)
    await db.query(
      `INSERT INTO inbound_delivery
         (id, destination_chain, route, source_chain, source_nonce, rail_message_id, recipient,
          token, amount, delivered, claim_id, destination_block, destination_tx)
       VALUES (202, $1, 2, $2, 20, '0xmsg202', $3, $4, 500000, true, NULL, 901, '0xdest202')`,
      [ARBITRUM_CHAIN, STELLAR_CHAIN, BASE_RECIPIENT, BASE_USDC],
    );

    // 3. Parked delivery missing pending_claim
    await db.query(
      `INSERT INTO inbound_delivery
         (id, destination_chain, route, source_chain, source_nonce, rail_message_id, recipient,
          token, amount, delivered, claim_id, destination_block, destination_tx)
       VALUES (301, $1, 1, $2, 30, NULL, $3, $4, 7000000, false, 3001, 510, 'tx-park-missing')`,
      [STELLAR_CHAIN, BASE_CHAIN, STELLAR_RECIPIENT, STELLAR_USDC],
    );

    // 4. Orphan pending_claim + settled without settled_tx
    await db.query(
      `INSERT INTO pending_claim
         (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
          created_at, settled, settled_at, settled_by, settled_tx)
       VALUES ($1, 4001, $2, $3, 8000000, 1, $4, 40,
               '2026-10-20T12:00:00Z', true, '2026-10-20T12:05:00Z', $5, NULL)`,
      [STELLAR_CHAIN, STELLAR_RECIPIENT, STELLAR_USDC, BASE_CHAIN, STELLAR_SETTLER],
    );

    // 5. Parked delivery paired with mismatched pending_claim amount
    await db.query(
      `INSERT INTO inbound_delivery
         (id, destination_chain, route, source_chain, source_nonce, rail_message_id, recipient,
          token, amount, delivered, claim_id, destination_block, destination_tx)
       VALUES (501, $1, 1, $2, 50, NULL, $3, $4, 9000000, false, 5001, 520, 'tx-park-mismatch')`,
      [STELLAR_CHAIN, BASE_CHAIN, STELLAR_RECIPIENT, STELLAR_USDC],
    );
    await db.query(
      `INSERT INTO pending_claim
         (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
          created_at, settled)
       VALUES ($1, 5001, $2, $3, 9500000, 1, $4, 50, '2026-10-20T12:10:00Z', false)`,
      [STELLAR_CHAIN, STELLAR_RECIPIENT, STELLAR_USDC, BASE_CHAIN],
    );

    // 6. Provider-only 'delivered' rail_attestation with no canonical inbound_delivery + route mismatch
    await db.query(
      `INSERT INTO outbound_transfer
         (id, origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
          destination_chain, destination, origin_block, origin_tx)
       VALUES (60, $1, 0, 60, $2, $3, 5000000, 0, 5000000, $4, $5, 105, 'tx-unbacked-60')`,
      [STELLAR_CHAIN, STELLAR_SENDER, STELLAR_USDC, BASE_CHAIN, BASE_RECIPIENT_WORD],
    );
    await db.query(
      `INSERT INTO rail_attestation (transfer_id, route, status, rail_status, rail_reference)
       VALUES (60, 1, 'delivered', 'provider_says_done', '0xprovider-ref')`,
    );

    const beforeSnapshot = await snapshotAllRows(db);

    const report = await auditTransferAndClaimInvariants(db, {
      tokenMetadata: [
        { chain: STELLAR_CHAIN, token: STELLAR_USDC, decimals: 7 },
        { chain: BASE_CHAIN, token: BASE_USDC, decimals: 6 },
      ],
    });

    const afterSnapshot = await snapshotAllRows(db);
    expect(afterSnapshot).toEqual(beforeSnapshot);

    expect(report.ok).toBe(false);
    const codes = report.violations.map((v) => v.code);
    expect(codes).toContain("outbound_amount_split_mismatch");
    expect(codes).toContain("duplicate_inbound_for_outbound");
    expect(codes).toContain("hop_route_or_chain_mismatch");
    expect(codes).toContain("hop_amount_exceeds_net");
    expect(codes).toContain("parked_delivery_missing_claim");
    expect(codes).toContain("orphan_pending_claim");
    expect(codes).toContain("claim_liability_mismatch");
    expect(codes).toContain("attestation_delivered_without_canonical_inbound");
    expect(codes).toContain("attestation_route_mismatch");
    expect(codes).toContain("settled_claim_incomplete_provenance");

    const unbacked = report.violations.find(
      (v) => v.code === "attestation_delivered_without_canonical_inbound",
    );
    expect(unbacked?.rows).toEqual([
      {
        table: "rail_attestation",
        transferId: "60",
        route: 1,
        status: "delivered",
      },
      {
        table: "outbound_transfer",
        id: "60",
        originChain: STELLAR_CHAIN,
        route: 0,
        nonce: "60",
        originTx: "tx-unbacked-60",
      },
    ]);

    const mismatch = report.violations.find((v) => v.code === "claim_liability_mismatch");
    expect(mismatch?.details.inboundAmount).toBe("9000000");
    expect(mismatch?.details.claimAmount).toBe("9500000");
    expect(mismatch?.rows).toEqual([
      {
        table: "inbound_delivery",
        id: "501",
        destinationChain: STELLAR_CHAIN,
        route: 1,
        sourceChain: BASE_CHAIN,
        sourceNonce: "50",
        destinationTx: "tx-park-mismatch",
      },
      {
        table: "pending_claim",
        chain: STELLAR_CHAIN,
        claimId: "5001",
        route: 1,
        sourceChain: BASE_CHAIN,
        sourceNonce: "50",
      },
    ]);
  });

  it("redacts credentials from CLI errors and rejects invalid token precision configuration", async () => {
    const secret = ["audit", "pw", "778899"].join("_");
    const rawMsg = `connection to postgres://auditor:${secret}@db.example.internal:5432/hyperion failed`;
    const scrubbed = redactAuditConnectionText(rawMsg);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain("postgres://auditor:[REDACTED]@db.example.internal:5432/hyperion");

    const stderrLines: string[] = [];
    const exitMissing = await runInvariantAuditCli(
      {},
      () => undefined,
      (line) => stderrLines.push(line),
    );
    expect(exitMissing).toBe(2);
    expect(stderrLines[0]).toContain("DATABASE_URL is required");

    await expect(
      auditTransferAndClaimInvariants(db, {
        tokenMetadata: [{ chain: STELLAR_CHAIN, token: STELLAR_USDC, decimals: -1 }],
      }),
    ).rejects.toThrow(/invalid token decimals/);
  });
});
