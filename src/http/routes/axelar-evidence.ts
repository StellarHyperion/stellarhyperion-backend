import { bounded, safeString } from "../../rails/axelar/gmp.js";
import { RouteKind } from "@hyperion/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Database } from "../../db/pool.js";
import { bigintOf, integer, text, textOrNull } from "../../db/rows.js";
import { negotiateSchemaVersion, withSchemaMetadata } from "../schema-version.js";
import type { ServerDeps } from "../server.js";

const EVIDENCE_QUERY = `
  SELECT id, status, command_id, execution_tx_hash, receipt_status, receipt_block,
         receipt_block_hash, destination_chain, its_address, token_id, registered_token,
         token_manager, token_manager_block, token_manager_block_hash, payment_log_index,
         payment_recipient, payment_amount, verified_at, last_revalidated_at
    FROM axelar_delivery_evidence
   WHERE transfer_id = $1
   ORDER BY verified_at DESC, id DESC
   LIMIT 5
`;

const QUARANTINE_QUERY = `
  SELECT provider_reference, schema, payload, first_seen_at, last_seen_at, replay_count
    FROM axelar_status_quarantine
   WHERE transfer_id = $1
   ORDER BY last_seen_at DESC, id DESC
   LIMIT 10
`;

export function registerAxelarEvidenceRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const db: Database = deps.db;
  const getEvidence = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const version = negotiateSchemaVersion(request, reply);
    if (version === null) return;
    const transferId = request.params.id;
    if (!/^[1-9][0-9]{0,18}$/.test(transferId) || BigInt(transferId) > 9223372036854775807n)
      return reply.code(400).send({
        error: "invalid_transfer_id",
        message: "transfer id must be a positive database identifier",
      });
    const { rows: transfers } = await db.query(
      `SELECT id, route, origin_chain, nonce, destination_chain
         FROM outbound_transfer WHERE id = $1 LIMIT 1`,
      [transferId],
    );
    const transfer = transfers[0];
    if (transfer === undefined)
      return reply.code(404).send({
        error: "not_found",
        message: `no transfer found with id ${transferId}`,
      });

    if (integer(transfer, "route") !== RouteKind.AxelarIts) {
      const payload = {
        transferId: text(transfer, "id"),
        evidenceStatus: "not_applicable",
        providerExecutionSufficient: false,
        verificationChecklist: checklist(false, false),
        command: null,
        destinationReceipt: null,
        tokenManagerMapping: null,
        tokenPayment: null,
        history: [],
        quarantined: [],
      };
      return reply.send(withSchemaMetadata(payload, version));
    }

    const { rows: evidenceRows } = await db.query(EVIDENCE_QUERY, [transferId]);
    const { rows: quarantineRows } = await db.query(QUARANTINE_QUERY, [transferId]);
    const latest = evidenceRows[0];
    const verified = latest !== undefined && text(latest, "status") === "canonical";
    const payload = {
      transferId: text(transfer, "id"),
      evidenceStatus: latest === undefined ? "unavailable" : text(latest, "status"),
      providerExecutionSufficient: false,
      providerStatus: null,
      verificationChecklist: checklist(verified, latest !== undefined),
      command:
        latest === undefined
          ? null
          : {
              id: text(latest, "command_id"),
              executionTransaction: text(latest, "execution_tx_hash"),
            },
      destinationReceipt:
        latest === undefined
          ? null
          : {
              transactionHash: text(latest, "execution_tx_hash"),
              status: text(latest, "receipt_status"),
              blockNumber: bigintOf(latest, "receipt_block").toString(),
              blockHash: text(latest, "receipt_block_hash"),
              canonical: verified,
              lastRevalidatedAt: timestampOrNull(latest, "last_revalidated_at"),
            },
      tokenManagerMapping:
        latest === undefined
          ? null
          : {
              destinationChain: text(latest, "destination_chain"),
              interchainTokenService: text(latest, "its_address"),
              tokenId: text(latest, "token_id"),
              registeredToken: text(latest, "registered_token"),
              tokenManager: text(latest, "token_manager"),
              proofBlockNumber: bigintOf(latest, "token_manager_block").toString(),
              proofBlockHash: text(latest, "token_manager_block_hash"),
              verified,
            },
      tokenPayment:
        latest === undefined
          ? null
          : {
              token: text(latest, "registered_token"),
              recipient: text(latest, "payment_recipient"),
              amount: bigintOf(latest, "payment_amount").toString(),
              transactionHash: text(latest, "execution_tx_hash"),
              logIndex: integer(latest, "payment_log_index"),
              exactMatch: verified,
            },
      history: evidenceRows.slice(1).map((row) => ({
        status: text(row, "status"),
        commandId: text(row, "command_id"),
        executionTransaction: text(row, "execution_tx_hash"),
        receiptBlockNumber: bigintOf(row, "receipt_block").toString(),
        receiptBlockHash: text(row, "receipt_block_hash"),
        verifiedAt: timestamp(row, "verified_at"),
        lastRevalidatedAt: timestampOrNull(row, "last_revalidated_at"),
      })),
      quarantined: quarantineRows.map((row) => ({
        providerReference:
          textOrNull(row, "provider_reference") === null
            ? null
            : safeString(text(row, "provider_reference")),
        schema: safeString(text(row, "schema")),
        payload: bounded(row.payload),
        firstSeenAt: timestamp(row, "first_seen_at"),
        lastSeenAt: timestamp(row, "last_seen_at"),
        replayCount: integer(row, "replay_count"),
      })),
    };
    return reply.send(withSchemaMetadata(payload, version));
  };

  app.get("/v1/transfers/:id/evidence", getEvidence);
  app.get("/api/v1/transfers/:id/evidence", getEvidence);
}

function checklist(verified: boolean, hasStoredProof: boolean) {
  return {
    providerExecutedStatus: {
      passed: false,
      sufficient: false,
      note: "Axelar status is candidate discovery only.",
    },
    commandIdentityMatched: { passed: verified },
    successfulDestinationReceipt: { passed: verified },
    receiptCanonical: { passed: verified, historicalProofAvailable: hasStoredProof },
    tokenManagerScopedToProofBlock: { passed: verified },
    exactErc20PaymentMatched: { passed: verified },
  };
}

function timestamp(row: Record<string, unknown>, column: string): string {
  return new Date(row[column] as string | number | Date).toISOString();
}

function timestampOrNull(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined
    ? null
    : new Date(value as string | number | Date).toISOString();
}
