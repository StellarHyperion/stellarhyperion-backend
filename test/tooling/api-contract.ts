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

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveOpenApiReference(document: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) throw new Error(`Unsupported OpenAPI reference: ${reference}`);
  let value = document;
  for (const segment of reference.slice(2).split("/")) {
    if (!isJsonObject(value) || !Object.hasOwn(value, segment))
      throw new Error(`Unresolved OpenAPI reference: ${reference}`);
    value = value[segment];
  }
  return value;
}

function validateJsonSchema(
  body: unknown,
  schema: unknown,
  document: unknown,
  path: string,
): string[] {
  if (!isJsonObject(schema)) return [];
  if (typeof schema.$ref === "string")
    return validateJsonSchema(body, resolveOpenApiReference(document, schema.$ref), document, path);

  const errors: string[] = [];
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) errors.push(...validateJsonSchema(body, part, document, path));
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some(
      (part) => validateJsonSchema(body, part, document, path).length === 0,
    );
    if (!matches) errors.push(`${path}: did not match any allowed schema`);
  }

  const types = Array.isArray(schema.type)
    ? schema.type
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  if (types.length > 0) {
    const valid = types.some((type) =>
      type === "null"
        ? body === null
        : type === "array"
          ? Array.isArray(body)
          : type === "object"
            ? isJsonObject(body)
            : type === "integer"
              ? typeof body === "number" && Number.isInteger(body)
              : type === "number"
                ? typeof body === "number" && Number.isFinite(body)
                : type === "string"
                  ? typeof body === "string"
                  : type === "boolean"
                    ? typeof body === "boolean"
                    : true,
    );
    if (!valid) return [`${path}: expected ${types.join(" or ")}`];
  }
  if (Object.hasOwn(schema, "const") && !Object.is(body, schema.const))
    errors.push(`${path}: expected constant ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((value) => Object.is(value, body)))
    errors.push(`${path}: value is not in the allowed enum`);
  if (typeof body === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(body))
      errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(body)))
      errors.push(`${path}: expected date-time`);
  }
  if (isJsonObject(body)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(body, key))
          errors.push(`${path}.${key}: required`);
      }
    }
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(body, key))
        errors.push(...validateJsonSchema(body[key], propertySchema, document, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(body)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key}: unknown property`);
      }
    }
  }
  if (Array.isArray(body) && isJsonObject(schema.items)) {
    body.forEach((value, index) =>
      errors.push(...validateJsonSchema(value, schema.items, document, `${path}[${index}]`)),
    );
  }
  return errors;
}

/** Validate an actual handler payload against the schema referenced by its OpenAPI operation. */
export function validateOpenApiOperationResponse(
  document: unknown,
  path: string,
  method: string,
  statusCode: number,
  body: unknown,
): string[] {
  if (!isJsonObject(document) || !isJsonObject(document.paths))
    throw new Error("OpenAPI document has no paths object.");
  const pathItem = document.paths[path];
  if (!isJsonObject(pathItem) || !isJsonObject(pathItem[method]))
    throw new Error(`OpenAPI operation not found: ${method.toUpperCase()} ${path}`);
  const operation = pathItem[method];
  if (!isJsonObject(operation)) throw new Error(`OpenAPI operation is invalid: ${method} ${path}`);
  const responses = operation.responses;
  const rawResponse = isJsonObject(responses) ? responses[String(statusCode)] : undefined;
  if (rawResponse === undefined) throw new Error(`OpenAPI response ${statusCode} is not defined.`);
  const response =
    isJsonObject(rawResponse) && typeof rawResponse.$ref === "string"
      ? resolveOpenApiReference(document, rawResponse.$ref)
      : rawResponse;
  if (!isJsonObject(response)) throw new Error(`OpenAPI response ${statusCode} is invalid.`);
  const content = response.content;
  const jsonContent = isJsonObject(content) ? content["application/json"] : undefined;
  const schema = isJsonObject(jsonContent) ? jsonContent.schema : undefined;
  return schema === undefined ? [] : validateJsonSchema(body, schema, document, "$");
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
