import type { FastifyRequest } from "fastify";

import type { Queryable, QueryResultRows } from "../db/pool.js";

/** Public reads must finish promptly even when an upstream client keeps its socket open. */
export const PUBLIC_READ_BUDGET_MS = 10_000;

export class RequestBudgetExceededError extends Error {
  readonly statusCode = 504;

  constructor() {
    super("public read exceeded its request budget");
    this.name = "RequestBudgetExceededError";
  }
}

/**
 * Couples a database query to both the HTTP connection and a bounded read budget.
 * Database owns server-side cancellation and waits for it before releasing its client.
 */
export async function requestQuery(
  request: FastifyRequest,
  db: Queryable,
  sql: string,
  params: readonly unknown[] = [],
  budgetMs = PUBLIC_READ_BUDGET_MS,
): Promise<QueryResultRows> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new RequestBudgetExceededError());
  }, budgetMs);

  const abort = () => {
    controller.abort(new Error("request connection closed"));
  };
  request.raw.once("aborted", abort);
  request.raw.socket.once("close", abort);
  if (request.raw.socket.destroyed) abort();

  try {
    return await db.query(sql, params, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    request.raw.off("aborted", abort);
    request.raw.socket.off("close", abort);
  }
}
