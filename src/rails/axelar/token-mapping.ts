/**
 * ITS token mapping change detection and proof assumption archiving.
 *
 * Compares expected token identity and decimal precision against live destination
 * InterchainTokenService, TokenManager, and ERC-20 state before allowing a new delivery proof to
 * settle. Archived `verified` rows remain immutable so historical proof assumptions stay auditable,
 * and symbol equality with the protocol asset registry never bypasses contract or tokenId checks.
 */
import type { Hex } from "@hyperion/protocol";

import type { Queryable } from "../../db/pool.js";
import {
  bigintOf,
  integer,
  integerOrNull,
  json,
  maybeOne,
  text,
  textOrNull,
  timestamp,
  type Row,
} from "../../db/rows.js";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

export type ItsTokenMappingDriftReason =
  | "token_id_changed"
  | "token_manager_changed"
  | "destination_token_changed"
  | "manager_token_disagreement"
  | "invalid_manager_or_token_address"
  | "decimals_precision_changed";

export interface ExpectedItsTokenMapping {
  readonly tokenId: Hex;
  readonly tokenManager?: Hex | undefined;
  readonly destinationToken?: Hex | undefined;
  readonly decimals?: number | undefined;
  readonly registrySymbol?: string | null | undefined;
}

export interface ObservedItsDestinationTokenState {
  readonly tokenId: Hex;
  readonly tokenManager: Hex;
  readonly registeredTokenAddress: Hex;
  readonly managerTokenAddress: Hex;
  readonly decimals: number;
  readonly symbol: string | null;
}

export interface ItsTokenMappingOperatorDiagnostic {
  readonly transferId: string;
  readonly originChain: string;
  readonly sourceToken: string;
  readonly destinationChain: string;
  readonly destinationBlock: string;
  readonly destinationTx: string;
  readonly driftReasons: readonly ItsTokenMappingDriftReason[];
  readonly expected: {
    readonly tokenId: string;
    readonly tokenManager: string | null;
    readonly destinationToken: string | null;
    readonly decimals: number | null;
  };
  readonly observed: {
    readonly tokenId: string;
    readonly tokenManager: string;
    readonly destinationToken: string;
    readonly managerReportedToken: string;
    readonly decimals: number;
    readonly symbol: string | null;
    readonly registrySymbol: string | null;
  };
  readonly detail: string;
}

export interface ItsTokenMappingAuditRecord {
  readonly id: bigint;
  readonly transferId: bigint;
  readonly originChain: string;
  readonly sourceToken: string;
  readonly destinationChain: string;
  readonly destinationBlock: bigint;
  readonly destinationTx: string;
  readonly expectedTokenId: string;
  readonly observedTokenId: string;
  readonly expectedTokenManager: string | null;
  readonly observedTokenManager: string;
  readonly expectedDestinationToken: string | null;
  readonly observedDestinationToken: string;
  readonly managerReportedToken: string;
  readonly expectedDecimals: number | null;
  readonly observedDecimals: number;
  readonly observedSymbol: string | null;
  readonly registrySymbol: string | null;
  readonly status: "verified" | "drift_detected";
  readonly driftReasons: readonly ItsTokenMappingDriftReason[];
  readonly diagnosticDetail: string | null;
  readonly observedAt: Date;
}

export type ItsTokenMappingEvaluation =
  | {
      readonly ok: true;
      readonly status: "verified";
      readonly record: ItsTokenMappingAuditRecord;
    }
  | {
      readonly ok: false;
      readonly status: "drift_detected";
      readonly driftReasons: readonly ItsTokenMappingDriftReason[];
      readonly diagnostic: ItsTokenMappingOperatorDiagnostic;
      readonly record: ItsTokenMappingAuditRecord;
    };

export interface EvaluateItsTokenMappingInput {
  readonly transferId: bigint;
  readonly originChain: string;
  readonly sourceToken: string;
  readonly destinationChain: string;
  readonly destinationBlock: bigint;
  readonly destinationTx: Hex;
  readonly expected: ExpectedItsTokenMapping;
  readonly observed: ObservedItsDestinationTokenState;
  readonly observedAt?: Date | undefined;
  readonly onDiagnostic?: ((diagnostic: ItsTokenMappingOperatorDiagnostic) => void) | undefined;
}

function isValidNonZeroEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

/**
 * Pure comparison between expected lane mapping and observed destination manager state.
 *
 * Symbol equality (`observed.symbol === expected.registrySymbol`) is deliberately ignored for
 * identity verification so a spoofed or redeployed token sharing the same ticker symbol cannot
 * satisfy a proof when its contract address, token manager, tokenId, or decimals changed.
 */
export function compareItsTokenMapping(
  expected: ExpectedItsTokenMapping,
  observed: ObservedItsDestinationTokenState,
): readonly ItsTokenMappingDriftReason[] {
  const reasons: ItsTokenMappingDriftReason[] = [];

  if (observed.tokenId.toLowerCase() !== expected.tokenId.toLowerCase()) {
    reasons.push("token_id_changed");
  }

  if (
    !isValidNonZeroEvmAddress(observed.tokenManager) ||
    !isValidNonZeroEvmAddress(observed.registeredTokenAddress) ||
    !isValidNonZeroEvmAddress(observed.managerTokenAddress)
  ) {
    reasons.push("invalid_manager_or_token_address");
  }

  if (
    observed.registeredTokenAddress.toLowerCase() !== observed.managerTokenAddress.toLowerCase()
  ) {
    reasons.push("manager_token_disagreement");
  }

  if (
    expected.tokenManager !== undefined &&
    observed.tokenManager.toLowerCase() !== expected.tokenManager.toLowerCase()
  ) {
    reasons.push("token_manager_changed");
  }

  if (
    expected.destinationToken !== undefined &&
    observed.registeredTokenAddress.toLowerCase() !== expected.destinationToken.toLowerCase()
  ) {
    reasons.push("destination_token_changed");
  }

  if (
    expected.decimals !== undefined &&
    (!Number.isInteger(observed.decimals) || observed.decimals !== expected.decimals)
  ) {
    reasons.push("decimals_precision_changed");
  }

  return reasons;
}

/**
 * Loads the earliest archived `verified` mapping snapshot for a lane so subsequent proofs compare
 * against the established on-chain baseline without rewriting historical rows.
 */
export async function loadBaselineTokenMapping(
  db: Queryable,
  lane: {
    readonly originChain: string;
    readonly sourceToken: string;
    readonly destinationChain: string;
  },
): Promise<ItsTokenMappingAuditRecord | null> {
  const { rows } = await db.query(
    `SELECT *
       FROM its_token_mapping_audit
      WHERE origin_chain = $1
        AND LOWER(source_token) = LOWER($2)
        AND destination_chain = $3
        AND status = 'verified'
      ORDER BY id ASC
      LIMIT 1`,
    [lane.originChain, lane.sourceToken, lane.destinationChain],
  );
  const row = maybeOne(rows, "loadBaselineTokenMapping");
  return row === null ? null : mapAuditRow(row);
}

export async function listArchivedTokenMappingAssumptions(
  db: Queryable,
  filter?: {
    readonly transferId?: bigint | undefined;
    readonly originChain?: string | undefined;
    readonly sourceToken?: string | undefined;
    readonly destinationChain?: string | undefined;
    readonly status?: "verified" | "drift_detected" | undefined;
  },
): Promise<readonly ItsTokenMappingAuditRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.transferId !== undefined) {
    params.push(filter.transferId.toString());
    conditions.push(`transfer_id = $${String(params.length)}`);
  }
  if (filter?.originChain !== undefined) {
    params.push(filter.originChain);
    conditions.push(`origin_chain = $${String(params.length)}`);
  }
  if (filter?.sourceToken !== undefined) {
    params.push(filter.sourceToken);
    conditions.push(`LOWER(source_token) = LOWER($${String(params.length)})`);
  }
  if (filter?.destinationChain !== undefined) {
    params.push(filter.destinationChain);
    conditions.push(`destination_chain = $${String(params.length)}`);
  }
  if (filter?.status !== undefined) {
    params.push(filter.status);
    conditions.push(`status = $${String(params.length)}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await db.query(
    `SELECT * FROM its_token_mapping_audit ${where} ORDER BY id ASC`,
    params,
  );
  return rows.map((row) => mapAuditRow(row));
}

export async function evaluateAndRecordItsTokenMapping(
  db: Queryable,
  input: EvaluateItsTokenMappingInput,
): Promise<ItsTokenMappingEvaluation> {
  const archivedBaseline = await loadBaselineTokenMapping(db, {
    originChain: input.originChain,
    sourceToken: input.sourceToken,
    destinationChain: input.destinationChain,
  });

  const resolvedExpectedTokenId = (
    archivedBaseline?.observedTokenId ?? input.expected.tokenId
  ).toLowerCase() as Hex;
  const resolvedExpectedManager =
    input.expected.tokenManager ??
    (archivedBaseline ? (archivedBaseline.observedTokenManager as Hex) : undefined);
  const resolvedExpectedToken =
    input.expected.destinationToken ??
    (archivedBaseline ? (archivedBaseline.observedDestinationToken as Hex) : undefined);
  const resolvedExpectedDecimals =
    input.expected.decimals ?? (archivedBaseline ? archivedBaseline.observedDecimals : undefined);
  const registrySymbol = input.expected.registrySymbol ?? archivedBaseline?.registrySymbol ?? null;

  const effectiveExpected: ExpectedItsTokenMapping = {
    tokenId: resolvedExpectedTokenId,
    ...(resolvedExpectedManager !== undefined ? { tokenManager: resolvedExpectedManager } : {}),
    ...(resolvedExpectedToken !== undefined ? { destinationToken: resolvedExpectedToken } : {}),
    ...(resolvedExpectedDecimals !== undefined ? { decimals: resolvedExpectedDecimals } : {}),
    registrySymbol,
  };

  const driftReasons = compareItsTokenMapping(effectiveExpected, input.observed);
  const status: "verified" | "drift_detected" =
    driftReasons.length === 0 ? "verified" : "drift_detected";

  const detail =
    status === "verified"
      ? null
      : `ITS token mapping drift on ${input.originChain}->${input.destinationChain}: ${driftReasons.join(", ")}`;

  const observedAt = input.observedAt ?? new Date();
  const normalizedObservedSymbol =
    input.observed.symbol !== null ? input.observed.symbol.slice(0, 64) : null;

  const { rows } = await db.query(
    `INSERT INTO its_token_mapping_audit
       (transfer_id, origin_chain, source_token, destination_chain, destination_block,
        destination_tx, expected_token_id, observed_token_id, expected_token_manager,
        observed_token_manager, expected_destination_token, observed_destination_token,
        manager_reported_token, expected_decimals, observed_decimals, observed_symbol,
        registry_symbol, status, drift_reasons, diagnostic_detail, observed_at)
     VALUES
       ($1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, $19::jsonb, $20, $21)
     ON CONFLICT (transfer_id, destination_chain, destination_tx, destination_block, status)
     DO UPDATE SET observed_at = its_token_mapping_audit.observed_at
     RETURNING *`,
    [
      input.transferId.toString(),
      input.originChain,
      input.sourceToken,
      input.destinationChain,
      input.destinationBlock.toString(),
      input.destinationTx.toLowerCase(),
      resolvedExpectedTokenId,
      input.observed.tokenId.toLowerCase(),
      resolvedExpectedManager?.toLowerCase() ?? null,
      input.observed.tokenManager.toLowerCase(),
      resolvedExpectedToken?.toLowerCase() ?? null,
      input.observed.registeredTokenAddress.toLowerCase(),
      input.observed.managerTokenAddress.toLowerCase(),
      resolvedExpectedDecimals ?? null,
      input.observed.decimals,
      normalizedObservedSymbol,
      registrySymbol,
      status,
      JSON.stringify(driftReasons),
      detail,
      observedAt,
    ],
  );

  const inserted = rows[0];
  if (inserted === undefined) {
    throw new Error("failed to persist its_token_mapping_audit row");
  }
  const record = mapAuditRow(inserted);

  if (status === "verified") {
    return { ok: true, status: "verified", record };
  }

  const diagnostic: ItsTokenMappingOperatorDiagnostic = {
    transferId: input.transferId.toString(),
    originChain: input.originChain,
    sourceToken: input.sourceToken,
    destinationChain: input.destinationChain,
    destinationBlock: input.destinationBlock.toString(),
    destinationTx: input.destinationTx.toLowerCase(),
    driftReasons,
    expected: {
      tokenId: resolvedExpectedTokenId,
      tokenManager: resolvedExpectedManager?.toLowerCase() ?? null,
      destinationToken: resolvedExpectedToken?.toLowerCase() ?? null,
      decimals: resolvedExpectedDecimals ?? null,
    },
    observed: {
      tokenId: input.observed.tokenId.toLowerCase(),
      tokenManager: input.observed.tokenManager.toLowerCase(),
      destinationToken: input.observed.registeredTokenAddress.toLowerCase(),
      managerReportedToken: input.observed.managerTokenAddress.toLowerCase(),
      decimals: input.observed.decimals,
      symbol: normalizedObservedSymbol,
      registrySymbol,
    },
    detail: detail ?? "ITS token mapping drift detected",
  };

  input.onDiagnostic?.(diagnostic);

  return {
    ok: false,
    status: "drift_detected",
    driftReasons,
    diagnostic,
    record,
  };
}

function mapAuditRow(row: Row): ItsTokenMappingAuditRecord {
  const rawReasons = json(row, "drift_reasons");
  const driftReasons = Array.isArray(rawReasons)
    ? rawReasons.filter((item): item is ItsTokenMappingDriftReason => typeof item === "string")
    : [];
  const rawStatus = text(row, "status");
  if (rawStatus !== "verified" && rawStatus !== "drift_detected") {
    throw new Error(`unexpected its_token_mapping_audit.status: ${rawStatus}`);
  }

  return {
    id: bigintOf(row, "id"),
    transferId: bigintOf(row, "transfer_id"),
    originChain: text(row, "origin_chain"),
    sourceToken: text(row, "source_token"),
    destinationChain: text(row, "destination_chain"),
    destinationBlock: bigintOf(row, "destination_block"),
    destinationTx: text(row, "destination_tx"),
    expectedTokenId: text(row, "expected_token_id"),
    observedTokenId: text(row, "observed_token_id"),
    expectedTokenManager: textOrNull(row, "expected_token_manager"),
    observedTokenManager: text(row, "observed_token_manager"),
    expectedDestinationToken: textOrNull(row, "expected_destination_token"),
    observedDestinationToken: text(row, "observed_destination_token"),
    managerReportedToken: text(row, "manager_reported_token"),
    expectedDecimals: integerOrNull(row, "expected_decimals"),
    observedDecimals: integer(row, "observed_decimals"),
    observedSymbol: textOrNull(row, "observed_symbol"),
    registrySymbol: textOrNull(row, "registry_symbol"),
    status: rawStatus,
    driftReasons,
    diagnosticDetail: textOrNull(row, "diagnostic_detail"),
    observedAt: timestamp(row, "observed_at"),
  };
}
