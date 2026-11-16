/**
 * Per-request deadlines and client-disconnect query cancellation for public API reads.
 *
 * Propagates request budgets and TCP disconnect notifications down to PostgreSQL statement
 * timeouts and backend cancellation across all transfer, claim, and route health endpoints.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  QueryBudgetExceededError,
  QueryCancelledError,
  executeBoundedRead,
  type QueryResultRows,
  type Queryable,
} from "../db/pool.js";

export const REQUEST_TIMEOUT_HEADER = "x-request-timeout-ms";
const MAX_SERVER_BUDGET_MS = 60_000;

export interface RequestBudgetConfig {
  readonly defaultBudgetMs: number;
  readonly now?: () => number;
}

declare module "fastify" {
  interface FastifyRequest {
    readBudget: RequestReadBudget;
  }
}

function parseClientBudgetHeader(
  rawHeader: string | string[] | undefined,
  serverCeilingMs: number,
):
  | { readonly ok: true; readonly budgetMs: number }
  | { readonly ok: false; readonly message: string } {
  if (rawHeader === undefined) {
    return { ok: true, budgetMs: serverCeilingMs };
  }

  let rawValue: string;
  if (Array.isArray(rawHeader)) {
    const distinct = [
      ...new Set(rawHeader.map((item) => item.trim()).filter((item) => item.length > 0)),
    ];
    if (distinct.length !== 1) {
      return {
        ok: false,
        message: "x-request-timeout-ms must specify a single positive integer in milliseconds",
      };
    }
    rawValue = distinct[0] ?? "";
  } else {
    rawValue = rawHeader.trim();
  }

  if (!/^[1-9]\d{0,6}$/.test(rawValue)) {
    return {
      ok: false,
      message: "x-request-timeout-ms must be a positive integer in milliseconds",
    };
  }

  const requestedMs = Number(rawValue);
  if (!Number.isSafeInteger(requestedMs) || requestedMs < 1) {
    return {
      ok: false,
      message: "x-request-timeout-ms must be a positive integer in milliseconds",
    };
  }

  return {
    ok: true,
    budgetMs: Math.min(requestedMs, serverCeilingMs),
  };
}

function isPublicReadPath(url: string): boolean {
  const pathOnly = url.split("?")[0] ?? url;
  return (
    pathOnly.startsWith("/v1/transfers") ||
    pathOnly.startsWith("/api/v1/transfers") ||
    pathOnly.startsWith("/v1/claims") ||
    pathOnly.startsWith("/v1/routes")
  );
}

export class RequestReadBudget {
  readonly budgetMs: number;
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private streamingMode = false;
  private clientDisconnected = false;
  private disposed = false;
  private detachListeners: (() => void) | null = null;

  constructor(budgetMs: number, now: () => number = () => Date.now()) {
    this.budgetMs = Math.max(1, Math.min(Math.floor(budgetMs), MAX_SERVER_BUDGET_MS));
    this.now = now;
    this.startedAtMs = this.now();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  isClientDisconnected(): boolean {
    return this.clientDisconnected;
  }

  remainingMs(): number {
    if (this.streamingMode) {
      return this.budgetMs;
    }
    const elapsed = Math.max(0, this.now() - this.startedAtMs);
    return Math.max(0, this.budgetMs - elapsed);
  }

  attachHttpLifecycle(requestRaw: IncomingMessage, replyRaw: ServerResponse): void {
    this.deadlineTimer = setTimeout(() => {
      if (!this.streamingMode && !this.disposed && !this.controller.signal.aborted) {
        this.controller.abort(new QueryBudgetExceededError());
      }
    }, this.budgetMs);
    this.deadlineTimer.unref();

    const markClientDisconnected = (): void => {
      if (this.disposed) return;
      if (replyRaw.writableEnded || replyRaw.writableFinished) return;
      this.clientDisconnected = true;
      if (!this.controller.signal.aborted) {
        this.controller.abort(new QueryCancelledError());
      }
    };

    const handleFinish = (): void => {
      this.dispose();
    };

    requestRaw.on("aborted", markClientDisconnected);
    replyRaw.on("close", markClientDisconnected);
    replyRaw.on("finish", handleFinish);
    const socket = requestRaw.socket as {
      on?: (event: string, listener: () => void) => void;
      off?: (event: string, listener: () => void) => void;
    } | null;
    socket?.on?.("close", markClientDisconnected);

    this.detachListeners = () => {
      requestRaw.off("aborted", markClientDisconnected);
      replyRaw.off("close", markClientDisconnected);
      replyRaw.off("finish", handleFinish);
      socket?.off?.("close", markClientDisconnected);
    };
  }

  /**
   * Disarm the initial HTTP response deadline once a request upgrades into a long-lived SSE
   * stream while retaining live client-disconnect cancellation and bounded per-poll query budgets.
   */
  enterStreamingMode(): void {
    this.streamingMode = true;
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  async query(
    db: Queryable,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResultRows> {
    const remaining = this.remainingMs();
    if (this.controller.signal.aborted) {
      const reason: unknown = this.controller.signal.reason;
      if (reason instanceof QueryBudgetExceededError) {
        throw reason;
      }
      throw new QueryCancelledError();
    }
    if (remaining <= 0) {
      throw new QueryBudgetExceededError();
    }
    return executeBoundedRead(db, sql, params, {
      signal: this.controller.signal,
      timeoutMs: remaining,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    if (this.detachListeners !== null) {
      this.detachListeners();
      this.detachListeners = null;
    }
  }
}

export function registerRequestBudgets(app: FastifyInstance, config: RequestBudgetConfig): void {
  const defaultBudgetMs = Math.max(1, Math.min(config.defaultBudgetMs, MAX_SERVER_BUDGET_MS));
  const now = config.now ?? (() => Date.now());

  app.decorateRequest("readBudget", {
    getter() {
      return new RequestReadBudget(defaultBudgetMs, now);
    },
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "OPTIONS" || !isPublicReadPath(request.url)) {
      return;
    }

    const parsedHeader = parseClientBudgetHeader(
      request.headers[REQUEST_TIMEOUT_HEADER],
      defaultBudgetMs,
    );
    if (!parsedHeader.ok) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsedHeader.message,
        requestId: request.id,
      });
    }

    const budget = new RequestReadBudget(parsedHeader.budgetMs, now);
    budget.attachHttpLifecycle(request.raw, reply.raw);
    Object.defineProperty(request, "readBudget", {
      value: budget,
      writable: true,
      configurable: true,
    });

    const headerValue = String(budget.budgetMs);
    reply.header("X-Request-Budget-Ms", headerValue);
    if (!reply.raw.headersSent) {
      reply.raw.setHeader("X-Request-Budget-Ms", headerValue);
    }
  });

  app.addHook("onResponse", (request: FastifyRequest, _reply: FastifyReply, done) => {
    const maybeBudget = (request as { readBudget?: RequestReadBudget }).readBudget;
    maybeBudget?.dispose();
    done();
  });
}
