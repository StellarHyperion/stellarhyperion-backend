import { isChainKey } from "@hyperion/protocol";

import type { AppConfig } from "../config/config.js";
import type { Database, Queryable, Transactional } from "../db/pool.js";
import { text } from "../db/rows.js";
import type { ReadinessSource } from "../runtime/readiness.js";
import type { FormattedTransfer } from "./routes/transfers.js";

export const DEFAULT_MAX_BULK_LOOKUP_ITEMS = 50;
export const DEFAULT_BULK_LOOKUP_TIMEOUT_MS = 3_000;

export type CanonicalBulkTransferKey =
  | {
      readonly kind: "origin_nonce";
      readonly originChain: string;
      readonly nonce: string;
    }
  | {
      readonly kind: "tx_hash";
      readonly chain: string;
      readonly txHash: string;
    }
  | {
      readonly kind: "id";
      readonly id: string;
      readonly originChain?: string;
    };

export type BulkLookupUnavailableReason =
  "unindexed_deployment" | "cursor_unavailable" | "indexer_unavailable";

export type BulkTransferLookupResultItem =
  | {
      readonly index: number;
      readonly key: CanonicalBulkTransferKey;
      readonly status: "found";
      readonly transfer: FormattedTransfer;
    }
  | {
      readonly index: number;
      readonly key: CanonicalBulkTransferKey;
      readonly status: "missing";
    }
  | {
      readonly index: number;
      readonly key: CanonicalBulkTransferKey;
      readonly status: "unavailable";
      readonly reason: BulkLookupUnavailableReason;
      readonly detail: string;
    };

export interface BulkTransferLookupResponse {
  readonly items: readonly BulkTransferLookupResultItem[];
  readonly summary: {
    readonly requested: number;
    readonly found: number;
    readonly missing: number;
    readonly unavailable: number;
  };
  readonly limits: {
    readonly maxItems: number;
    readonly timeoutMs: number;
  };
}

export class BulkLookupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkLookupValidationError";
  }
}

export class BulkLookupTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`bulk transfer lookup exceeded ${String(timeoutMs)}ms time budget`);
    this.name = "BulkLookupTimeoutError";
  }
}

const UINT_PATTERN = /^[0-9]{1,20}$/;

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BulkLookupValidationError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseChainField(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !isChainKey(raw.trim())) {
    throw new BulkLookupValidationError(`${label} must be a supported canonical chain key`);
  }
  return raw.trim();
}

function parseUintField(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !UINT_PATTERN.test(raw.trim())) {
    throw new BulkLookupValidationError(`${label} must be a base-10 unsigned integer string`);
  }
  return raw.trim();
}

function parseTxHashField(raw: unknown, label: string): string {
  if (typeof raw !== "string") {
    throw new BulkLookupValidationError(`${label} must be a non-empty string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 256 || /[\x00-\x1f\x7f\s]/.test(trimmed)) {
    throw new BulkLookupValidationError(
      `${label} must be a printable transaction hash up to 256 characters`,
    );
  }
  return trimmed;
}

export function parseBulkLookupRequest(
  body: unknown,
  maxItems = DEFAULT_MAX_BULK_LOOKUP_ITEMS,
): readonly CanonicalBulkTransferKey[] {
  const root = assertPlainObject(body, "request body");
  const rawItems = root.items;

  if (!Array.isArray(rawItems)) {
    throw new BulkLookupValidationError("items must be an array of canonical transfer keys");
  }
  if (rawItems.length === 0) {
    throw new BulkLookupValidationError("items must contain at least 1 lookup key");
  }
  if (rawItems.length > maxItems) {
    throw new BulkLookupValidationError(
      `items length (${String(rawItems.length)}) exceeds maximum batch size of ${String(maxItems)}`,
    );
  }

  return rawItems.map((entry, idx) => {
    const label = `items[${String(idx)}]`;
    const obj = assertPlainObject(entry, label);
    const kind = obj.kind;

    const hasNonce = obj.nonce !== undefined;
    const hasTxHash = obj.txHash !== undefined;
    const hasId = obj.id !== undefined;

    if (kind !== undefined && kind !== "origin_nonce" && kind !== "tx_hash" && kind !== "id") {
      throw new BulkLookupValidationError(
        `${label}.kind must be 'origin_nonce', 'tx_hash', or 'id'`,
      );
    }

    // Disallow ambiguous multi-identity items.
    const variantCount = Number(hasNonce) + Number(hasTxHash) + Number(hasId);
    if (variantCount !== 1) {
      throw new BulkLookupValidationError(
        `${label} must specify exactly one canonical key shape (originChain+nonce, chain+txHash, or id)`,
      );
    }

    if (hasNonce || kind === "origin_nonce") {
      if (kind !== undefined && kind !== "origin_nonce") {
        throw new BulkLookupValidationError(`${label} kind does not match nonce field`);
      }
      if (obj.originChain === undefined) {
        throw new BulkLookupValidationError(
          `${label}.originChain is required with nonce so mixed deployments cannot collide`,
        );
      }
      return {
        kind: "origin_nonce",
        originChain: parseChainField(obj.originChain, `${label}.originChain`),
        nonce: parseUintField(obj.nonce, `${label}.nonce`),
      };
    }

    if (hasTxHash || kind === "tx_hash") {
      if (kind !== undefined && kind !== "tx_hash") {
        throw new BulkLookupValidationError(`${label} kind does not match txHash field`);
      }
      if (obj.chain === undefined) {
        throw new BulkLookupValidationError(
          `${label}.chain is required with txHash for canonical chain-scoped lookup`,
        );
      }
      return {
        kind: "tx_hash",
        chain: parseChainField(obj.chain, `${label}.chain`),
        txHash: parseTxHashField(obj.txHash, `${label}.txHash`),
      };
    }

    const id = parseUintField(obj.id, `${label}.id`);
    const originChain =
      obj.originChain !== undefined
        ? parseChainField(obj.originChain, `${label}.originChain`)
        : undefined;

    return originChain !== undefined ? { kind: "id", id, originChain } : { kind: "id", id };
  });
}

function hasTransaction(db: Database): db is Database & Transactional {
  return typeof (db as Partial<Transactional>).transaction === "function";
}

async function runWithTimeBudget<T>(
  db: Database,
  timeoutMs: number,
  work: (q: Queryable) => Promise<T>,
): Promise<T> {
  const safeTimeoutMs = Math.max(1, Math.floor(timeoutMs));

  const execute = async (): Promise<T> => {
    if (hasTransaction(db)) {
      return db.transaction(async (tx) => {
        await tx.query("SET LOCAL transaction_read_only = on");
        await tx.query(`SET LOCAL statement_timeout = '${String(safeTimeoutMs)}ms'`);
        return work(tx);
      });
    }
    return work(db);
  };

  const timerState: { handle: ReturnType<typeof setTimeout> | null } = { handle: null };
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new BulkLookupTimeoutError(safeTimeoutMs));
    }, safeTimeoutMs);
    handle.unref();
    timerState.handle = handle;
  });

  try {
    return await Promise.race([execute(), timeoutPromise]);
  } catch (error) {
    if (error instanceof BulkLookupTimeoutError) {
      throw error;
    }
    const code =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (code === "57014" || message.includes("statement timeout")) {
      throw new BulkLookupTimeoutError(safeTimeoutMs);
    }
    throw error;
  } finally {
    if (timerState.handle !== null) {
      clearTimeout(timerState.handle);
    }
  }
}

async function collectDownReadinessNames(
  sources: readonly ReadinessSource[],
): Promise<ReadonlySet<string>> {
  const down = new Set<string>();
  for (const source of sources) {
    try {
      const report = await source.readiness();
      if (report.state === "down") {
        down.add(report.name);
      }
    } catch {
      down.add("*");
    }
  }
  return down;
}

function isChainReadinessDown(
  chain: string,
  family: string | undefined,
  downNames: ReadonlySet<string>,
): boolean {
  if (downNames.has("*")) {
    return true;
  }
  if (downNames.has(chain) || downNames.has(`chain:${chain}`)) {
    return true;
  }
  if (family !== undefined && downNames.has(family)) {
    return true;
  }
  return false;
}

export interface ExecuteBulkLookupOptions {
  readonly db: Database;
  readonly config: AppConfig;
  readonly readiness: readonly ReadinessSource[];
  readonly transferQuery: string;
  readonly formatTransfer: (row: Record<string, unknown>, config: AppConfig) => FormattedTransfer;
  readonly keys: readonly CanonicalBulkTransferKey[];
  readonly maxItems: number;
  readonly timeoutMs: number;
}

export async function executeBulkTransferLookup(
  options: ExecuteBulkLookupOptions,
): Promise<BulkTransferLookupResponse> {
  const { db, config, readiness, transferQuery, formatTransfer, keys, maxItems, timeoutMs } =
    options;

  const downNames = await collectDownReadinessNames(readiness);

  const { transferRows, indexedChains } = await runWithTimeBudget(db, timeoutMs, async (q) => {
    const clauses: string[] = [];
    const params: unknown[] = [];

    for (const key of keys) {
      if (key.kind === "origin_nonce") {
        params.push(key.originChain);
        const chainParam = `$${String(params.length)}`;
        params.push(key.nonce);
        const nonceParam = `$${String(params.length)}`;
        clauses.push(`(t.origin_chain = ${chainParam} AND t.nonce = ${nonceParam})`);
      } else if (key.kind === "tx_hash") {
        params.push(key.chain);
        const chainParam = `$${String(params.length)}`;
        params.push(key.txHash);
        const hashParam = `$${String(params.length)}`;
        clauses.push(
          `((t.origin_chain = ${chainParam} AND t.origin_tx = ${hashParam}) OR (d.destination_chain = ${chainParam} AND d.destination_tx = ${hashParam}))`,
        );
      } else if (key.originChain !== undefined) {
        params.push(key.id);
        const idParam = `$${String(params.length)}`;
        params.push(key.originChain);
        const chainParam = `$${String(params.length)}`;
        clauses.push(`(t.id = ${idParam} AND t.origin_chain = ${chainParam})`);
      } else {
        params.push(key.id);
        const idParam = `$${String(params.length)}`;
        clauses.push(`(t.id = ${idParam})`);
      }
    }

    const whereSql = clauses.join(" OR ");
    const transfersResult = await q.query(`${transferQuery} WHERE ${whereSql}`, params);

    const requestedChains = new Set<string>();
    for (const key of keys) {
      if (key.kind === "origin_nonce") {
        requestedChains.add(key.originChain);
      } else if (key.kind === "tx_hash") {
        requestedChains.add(key.chain);
      } else if (key.originChain !== undefined) {
        requestedChains.add(key.originChain);
      }
    }
    for (const configuredChain of Object.keys(config.deployments.networks)) {
      requestedChains.add(configuredChain);
    }

    const chainList = [...requestedChains];
    const cursorChains = new Set<string>();
    if (chainList.length > 0) {
      const placeholders = chainList.map((_, idx) => `$${String(idx + 1)}`).join(", ");
      const cursorResult = await q.query(
        `SELECT chain_key FROM indexer_cursor WHERE chain_key IN (${placeholders})`,
        chainList,
      );
      for (const cursorRow of cursorResult.rows) {
        cursorChains.add(text(cursorRow, "chain_key"));
      }
    }

    return {
      transferRows: transfersResult.rows,
      indexedChains: cursorChains,
    };
  });

  const byOriginNonce = new Map<string, FormattedTransfer>();
  const byId = new Map<string, FormattedTransfer>();
  const byScopedTxHash = new Map<string, FormattedTransfer>();

  for (const row of transferRows) {
    const formatted = formatTransfer(row, config);
    byOriginNonce.set(`${formatted.origin.chain}:${formatted.origin.nonce}`, formatted);
    byId.set(formatted.id, formatted);
    byScopedTxHash.set(
      `${formatted.origin.chain}:${formatted.origin.txHash.toLowerCase()}`,
      formatted,
    );
    if (formatted.destination.txHash !== null) {
      byScopedTxHash.set(
        `${formatted.destination.chain}:${formatted.destination.txHash.toLowerCase()}`,
        formatted,
      );
    }
  }

  let foundCount = 0;
  let missingCount = 0;
  let unavailableCount = 0;

  const evaluateChainAvailability = (
    chain: string,
  ):
    | { readonly available: true }
    | {
        readonly available: false;
        readonly reason: BulkLookupUnavailableReason;
        readonly detail: string;
      } => {
    const deployment = isChainKey(chain) ? config.deployments.networks[chain] : undefined;
    if (deployment === undefined) {
      return {
        available: false,
        reason: "unindexed_deployment",
        detail: `no Hyperion router deployment is configured for chain ${chain}`,
      };
    }
    if (isChainReadinessDown(chain, deployment.family, downNames)) {
      return {
        available: false,
        reason: "indexer_unavailable",
        detail: `watcher for chain ${chain} is currently down`,
      };
    }
    if (!indexedChains.has(chain)) {
      return {
        available: false,
        reason: "cursor_unavailable",
        detail: `no indexer cursor has been recorded yet for chain ${chain}`,
      };
    }
    return { available: true };
  };

  const items: BulkTransferLookupResultItem[] = keys.map((key, index) => {
    let matched: FormattedTransfer | undefined;

    if (key.kind === "origin_nonce") {
      matched = byOriginNonce.get(`${key.originChain}:${key.nonce}`);
    } else if (key.kind === "tx_hash") {
      matched = byScopedTxHash.get(`${key.chain}:${key.txHash.toLowerCase()}`);
    } else {
      const candidate = byId.get(key.id);
      if (
        candidate !== undefined &&
        (key.originChain === undefined || candidate.origin.chain === key.originChain)
      ) {
        matched = candidate;
      }
    }

    if (matched !== undefined) {
      foundCount += 1;
      return {
        index,
        key,
        status: "found",
        transfer: matched,
      };
    }

    if (key.kind === "origin_nonce") {
      const availability = evaluateChainAvailability(key.originChain);
      if (!availability.available) {
        unavailableCount += 1;
        return {
          index,
          key,
          status: "unavailable",
          reason: availability.reason,
          detail: availability.detail,
        };
      }
    } else if (key.kind === "tx_hash") {
      const availability = evaluateChainAvailability(key.chain);
      if (!availability.available) {
        unavailableCount += 1;
        return {
          index,
          key,
          status: "unavailable",
          reason: availability.reason,
          detail: availability.detail,
        };
      }
    } else if (key.originChain !== undefined) {
      const availability = evaluateChainAvailability(key.originChain);
      if (!availability.available) {
        unavailableCount += 1;
        return {
          index,
          key,
          status: "unavailable",
          reason: availability.reason,
          detail: availability.detail,
        };
      }
    } else {
      const configuredChains = Object.keys(config.deployments.networks);
      const anyAvailable = configuredChains.some(
        (chain) => evaluateChainAvailability(chain).available,
      );
      if (!anyAvailable) {
        unavailableCount += 1;
        return {
          index,
          key,
          status: "unavailable",
          reason: configuredChains.length === 0 ? "unindexed_deployment" : "cursor_unavailable",
          detail: "no active indexed deployment cursor is available to confirm absence by id",
        };
      }
    }

    missingCount += 1;
    return {
      index,
      key,
      status: "missing",
    };
  });

  return {
    items,
    summary: {
      requested: keys.length,
      found: foundCount,
      missing: missingCount,
      unavailable: unavailableCount,
    },
    limits: {
      maxItems,
      timeoutMs,
    },
  };
}
