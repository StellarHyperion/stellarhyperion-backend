import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import type { Queryable, QueryResultRows, Transactional } from "../src/db/pool.js";

const MIGRATIONS = [
  "1790900000000_initial-schema.sql",
  "1791000000000_cursor-block-hash.sql",
  "1791100000000_cursor-autovacuum-tuning.sql",
  "1791200000000_rail-cooldown.sql",
] as const;

export type SimulatedRailAction =
  | {
      readonly kind: "rate_limit";
      readonly retryAfterSeconds?: number;
      readonly retryAfterHttpDate?: string;
    }
  | {
      readonly kind: "timeout";
      readonly message?: string;
    }
  | {
      readonly kind: "malformed_json";
      readonly rawBody?: string;
      readonly status?: number;
    }
  | {
      readonly kind: "invalid_schema";
      readonly body?: unknown;
    }
  | {
      readonly kind: "http_error";
      readonly status: number;
      readonly body?: unknown;
    }
  | {
      readonly kind: "iris_attested";
      readonly eventNonce?: string;
      readonly status?: string;
      readonly forwardTxHash?: string;
    }
  | {
      readonly kind: "iris_missing";
    }
  | {
      readonly kind: "axelar_attested";
      readonly messageId?: string;
      readonly status?: string;
      readonly executedTxHash?: string;
      readonly commandId?: string;
    }
  | {
      readonly kind: "axelar_missing";
    };

export interface SimulatedRequestRecord {
  readonly rail: "cctp" | "axelar";
  readonly url: string;
  readonly txHash: string | null;
  readonly timestampMs: number;
  readonly actionKind: SimulatedRailAction["kind"];
}

export interface RailProviderSimulator {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly SimulatedRequestRecord[];
  enqueue(rail: "cctp" | "axelar", ...actions: readonly SimulatedRailAction[]): void;
  setDefault(rail: "cctp" | "axelar", action: SimulatedRailAction): void;
  requestCount(rail: "cctp" | "axelar"): number;
}

function extractTxHash(rail: "cctp" | "axelar", url: string, init?: RequestInit): string | null {
  if (rail === "cctp") {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get("transactionHash");
    } catch {
      return null;
    }
  }
  if (typeof init?.body === "string") {
    try {
      const parsed = JSON.parse(init.body) as { txHash?: unknown };
      return typeof parsed.txHash === "string" ? parsed.txHash : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function createRailProviderSimulator(
  options: {
    readonly now?: () => Date;
    readonly cctpBaseHost?: string;
    readonly axelarBaseHost?: string;
  } = {},
): RailProviderSimulator {
  const getNow = options.now ?? (() => new Date());
  const cctpHost = options.cctpBaseHost ?? "iris-sim.example.invalid";
  const axelarHost = options.axelarBaseHost ?? "axelar-sim.example.invalid";

  const queues: Record<"cctp" | "axelar", SimulatedRailAction[]> = {
    cctp: [],
    axelar: [],
  };

  const defaults: Record<"cctp" | "axelar", SimulatedRailAction> = {
    cctp: { kind: "iris_missing" },
    axelar: { kind: "axelar_missing" },
  };

  const history: SimulatedRequestRecord[] = [];

  const simFetch: typeof globalThis.fetch = (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    const rail: "cctp" | "axelar" = url.includes(cctpHost)
      ? "cctp"
      : url.includes(axelarHost)
        ? "axelar"
        : url.includes("/v2/messages/")
          ? "cctp"
          : "axelar";

    const txHash = extractTxHash(rail, url, init);
    const nextAction = queues[rail].shift() ?? defaults[rail];
    const timestampMs = getNow().getTime();

    history.push({
      rail,
      url,
      txHash,
      timestampMs,
      actionKind: nextAction.kind,
    });

    switch (nextAction.kind) {
      case "rate_limit": {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (nextAction.retryAfterSeconds !== undefined) {
          headers["retry-after"] = String(nextAction.retryAfterSeconds);
        } else if (nextAction.retryAfterHttpDate !== undefined) {
          headers["retry-after"] = nextAction.retryAfterHttpDate;
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: "Too Many Requests" }), {
            status: 429,
            headers,
          }),
        );
      }

      case "timeout": {
        const err = new DOMException(
          nextAction.message ?? "The operation was aborted due to timeout",
          "TimeoutError",
        );
        return Promise.reject(err);
      }

      case "malformed_json": {
        return Promise.resolve(
          new Response(nextAction.rawBody ?? '{"truncated_json": [', {
            status: nextAction.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }

      case "invalid_schema": {
        return Promise.resolve(
          new Response(JSON.stringify(nextAction.body ?? { unexpected_envelope: 42 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }

      case "http_error": {
        return Promise.resolve(
          new Response(JSON.stringify(nextAction.body ?? { error: "upstream error" }), {
            status: nextAction.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }

      case "iris_missing": {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "Message not found for provided parameters" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );
      }

      case "iris_attested": {
        const messageObj: Record<string, unknown> = {
          status: nextAction.status ?? "complete",
          eventNonce: nextAction.eventNonce ?? "101",
          attestation: "0xdeadbeef",
          attestationTimestamp: new Date(timestampMs).toISOString(),
        };
        if (nextAction.forwardTxHash !== undefined) {
          messageObj.forwardTxHash = nextAction.forwardTxHash;
        }
        return Promise.resolve(
          new Response(JSON.stringify({ messages: [messageObj] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }

      case "axelar_missing": {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }

      case "axelar_attested": {
        const row: Record<string, unknown> = {
          id: nextAction.messageId ?? `${txHash ?? "0x0"}-0`,
          call: { transactionHash: txHash },
          status: nextAction.status ?? "executed",
        };
        if (nextAction.commandId !== undefined) {
          row.command_id = nextAction.commandId;
        }
        if (nextAction.executedTxHash !== undefined) {
          row.executed = {
            transactionHash: nextAction.executedTxHash,
            block_timestamp: Math.floor(timestampMs / 1000),
          };
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: [row] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
  };

  return {
    fetch: simFetch,
    requests: history,
    enqueue(rail, ...actions) {
      queues[rail].push(...actions);
    },
    setDefault(rail, action) {
      defaults[rail] = action;
    },
    requestCount(rail) {
      return history.filter((r) => r.rail === rail).length;
    },
  };
}

export interface SimulatorDb extends Transactional {
  close(): Promise<void>;
}

export async function applyRailSimulatorMigrations(db: Queryable): Promise<void> {
  for (const name of MIGRATIONS) {
    const fullPath = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
    const upSql = readFileSync(fullPath, "utf8").split(/^--\s*Down Migration\b/m)[0] ?? "";
    await db.query(upSql);
  }
}

export async function createSimulatorPGliteDb(): Promise<SimulatorDb> {
  const pg = new PGlite();
  let txLock: Promise<void> = Promise.resolve();

  const runQuery = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> => {
    const normalized = params.map((p) => (p instanceof Date ? p.toISOString() : p));
    const result =
      normalized.length === 0 && sql.includes(";")
        ? await (async () => {
            await pg.exec(sql);
            return { rows: [], fields: [], affectedRows: 0 };
          })()
        : await pg.query(sql, normalized);

    const int8Cols = result.fields.filter((f) => f.dataTypeID === 20).map((f) => f.name);
    const rows = result.rows.map((raw) => {
      const copy = { ...(raw as Record<string, unknown>) };
      for (const col of int8Cols) {
        const v = copy[col];
        if (typeof v === "number" || typeof v === "bigint") {
          copy[col] = String(v);
        }
      }
      return copy;
    });
    return { rows, rowCount: result.affectedRows ?? rows.length };
  };

  const db: SimulatorDb = {
    query: runQuery,
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      // Serialize BEGIN/COMMIT on single-connection PGlite so concurrent Promise.all workers never interleave BEGINs.
      const prev = txLock;
      let release!: () => void;
      txLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prev;
      await pg.exec("BEGIN");
      try {
        const res = await work({ query: runQuery });
        await pg.exec("COMMIT");
        return res;
      } catch (err) {
        await pg.exec("ROLLBACK");
        throw err;
      } finally {
        release();
      }
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };

  await applyRailSimulatorMigrations(db);
  return db;
}
