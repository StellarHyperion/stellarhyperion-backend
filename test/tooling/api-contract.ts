import type { FastifyInstance } from "fastify";

export interface ResponseFixture {
  readonly version: string;
  readonly body: unknown;
  readonly statusCode: number;
}
export interface DifferentialReport {
  readonly breaking: string[];
  readonly additive: string[];
  readonly wideIntegerChanges: string[];
  readonly tokenRepresentationChanges: string[];
}

/** Compare the same recorded response across versions, including nested/removal/type changes. */
export function differentialReport(
  previous: ResponseFixture,
  current: ResponseFixture,
): DifferentialReport {
  const report: DifferentialReport = {
    breaking: [],
    additive: [],
    wideIntegerChanges: [],
    tokenRepresentationChanges: [],
  };
  if (previous.statusCode !== current.statusCode) report.breaking.push("$statusCode");
  const visit = (before: unknown, after: unknown, path: string): void => {
    if (Object.is(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) report.breaking.push(path + ".length");
      before.forEach((entry, index) => {
        visit(entry, after[index], `${path}[${index}]`);
      });
      return;
    }
    if (
      before !== null &&
      after !== null &&
      typeof before === "object" &&
      typeof after === "object" &&
      !Array.isArray(before) &&
      !Array.isArray(after)
    ) {
      const old = before as Record<string, unknown>,
        next = after as Record<string, unknown>;
      for (const key of Object.keys(old)) visit(old[key], next[key], `${path}.${key}`);
      for (const key of Object.keys(next))
        if (!Object.hasOwn(old, key)) report.additive.push(`${path}.${key}`);
      return;
    }
    report.breaking.push(path);
    if (
      /\.(?:amount|grossAmount|netAmount|fee|nonce|sourceNonce|claimId|block)$/i.test(path) ||
      [before, after].some((value) => typeof value === "string" && /^\d{16,}$/.test(value))
    )
      report.wideIntegerChanges.push(path);
    if (/\.(?:token|tokenId|asset|issuer|sacId|symbol|decimals)$/i.test(path))
      report.tokenRepresentationChanges.push(path);
  };
  visit(previous.body, current.body, "$");
  return report;
}

export type ResponseShape =
  | "string"
  | "integer-string"
  | "number"
  | "boolean"
  | { readonly nullable: ResponseShape }
  | { readonly fields: Readonly<Record<string, ResponseShape>> };
export function validateResponse(body: unknown, shape: ResponseShape, path = "$"): string[] {
  if (typeof shape === "string") {
    const valid =
      shape === "integer-string"
        ? typeof body === "string" && /^\d+$/.test(body)
        : typeof body === shape;
    return valid ? [] : [`${path}: expected ${shape}`];
  }
  if ("nullable" in shape) return body === null ? [] : validateResponse(body, shape.nullable, path);
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return [`${path}: expected object`];
  return Object.entries(shape.fields).flatMap(([key, field]) =>
    validateResponse((body as Record<string, unknown>)[key], field, `${path}.${key}`),
  );
}

/** Inject actual HTTP handlers; the caller supplies the independent published response contract. */
export async function captureResponse(
  app: FastifyInstance,
  url: string,
  version: string,
  shape: ResponseShape,
): Promise<ResponseFixture> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: { "x-api-schema-version": version },
  });
  const body: unknown = response.json();
  const errors = validateResponse(body, shape);
  if (response.statusCode !== 200 || errors.length)
    throw new Error(
      `Public response contract failed (${response.statusCode}): ${errors.join("; ")}`,
    );
  return { version, body, statusCode: response.statusCode };
}
