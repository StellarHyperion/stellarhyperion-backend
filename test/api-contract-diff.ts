import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AddressKind, tryParseStellarAddress } from "@hyperion/protocol";
import pino from "pino";

import { loadConfig } from "../src/config/config.js";
import type { Database } from "../src/db/pool.js";
import { buildServer } from "../src/http/server.js";

const U64_MAX = (1n << 64n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

const CREDENTIAL_LEAK_PATTERN =
  /(?:postgres(?:ql)?:\/\/[^\s"']+|redis(?:s)?:\/\/[^\s"']+|Bearer\s+[A-Za-z0-9._~+/-]+=*|[?&](?:api[-_]?key|token|secret|password)=[^&\s"']+)/i;

export type SemanticFieldKind =
  "uint256_string" | "u64_string" | "token_identifier" | "chain_address" | "iso8601_timestamp";

export interface SchemaNode {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly oneOf?: readonly SchemaNode[];
  readonly enum?: readonly unknown[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly "x-semantic"?: SemanticFieldKind;
}

export interface PublishedApiSchema {
  readonly title: string;
  readonly version: string;
  readonly definitions: Readonly<Record<string, SchemaNode>>;
  readonly endpoints: Readonly<Record<string, Readonly<Record<string, SchemaNode>>>>;
}

export interface ApiResponseFixture {
  readonly id: string;
  readonly endpoint: string;
  readonly requestPath: string;
  readonly statusCode: number;
  readonly body: unknown;
}

export interface ApiFixtureBundle {
  readonly version: string;
  readonly responses: readonly ApiResponseFixture[];
}

export type TokenOrAddressRepresentation =
  | "stellar_account_strkey"
  | "stellar_contract_strkey"
  | "stellar_muxed_strkey"
  | "evm_address_20"
  | "evm_word_32"
  | "ticker_symbol"
  | "invalid_or_other";

export type ContractChangeCategory =
  | "additive_field"
  | "removed_field"
  | "type_changed"
  | "status_code_changed"
  | "enum_violation"
  | "wide_integer_representation"
  | "token_or_address_representation"
  | "credential_exposure"
  | "missing_endpoint_fixture";

export interface ContractChange {
  readonly severity: "breaking" | "additive";
  readonly category: ContractChangeCategory;
  readonly fixtureId: string;
  readonly endpoint: string;
  readonly path: string;
  readonly detail: string;
}

export interface SchemaViolation {
  readonly fixtureId: string;
  readonly endpoint: string;
  readonly statusCode: number;
  readonly path: string;
  readonly reason: string;
}

export interface ContractDiffReport {
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly compatible: boolean;
  readonly breakingChanges: readonly ContractChange[];
  readonly additiveChanges: readonly ContractChange[];
  readonly schemaViolations: readonly SchemaViolation[];
}

export function loadPublishedApiSchema(): PublishedApiSchema {
  const fullPath = fileURLToPath(
    new URL("./fixtures/api-contract-v1.schema.json", import.meta.url),
  );
  return JSON.parse(readFileSync(fullPath, "utf8")) as PublishedApiSchema;
}

export function loadBaselineApiFixtures(): ApiFixtureBundle {
  const fullPath = fileURLToPath(
    new URL("./fixtures/api-responses-v1-baseline.json", import.meta.url),
  );
  return JSON.parse(readFileSync(fullPath, "utf8")) as ApiFixtureBundle;
}

export function classifyTokenOrAddressRepresentation(value: string): TokenOrAddressRepresentation {
  const stellar = tryParseStellarAddress(value);
  if (stellar.ok) {
    if (stellar.parts.kind === AddressKind.Account) return "stellar_account_strkey";
    if (stellar.parts.kind === AddressKind.Contract) return "stellar_contract_strkey";
    return "stellar_muxed_strkey";
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return "evm_address_20";
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return "evm_word_32";
  if (/^[A-Z0-9]{2,12}$/.test(value)) return "ticker_symbol";
  return "invalid_or_other";
}

function isExactUnsignedDecimalInRange(value: string, maxInclusive: bigint): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= maxInclusive;
  } catch {
    return false;
  }
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesAllowedType(value: unknown, expected: string): boolean {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expected;
}

function resolveNode(node: SchemaNode, schema: PublishedApiSchema): SchemaNode {
  if (node.$ref !== undefined) {
    const prefix = "#/definitions/";
    if (node.$ref.startsWith(prefix)) {
      const defName = node.$ref.slice(prefix.length);
      const found = schema.definitions[defName];
      if (found !== undefined) return resolveNode(found, schema);
    }
  }
  return node;
}

function checkSemanticRule(
  semantic: SemanticFieldKind,
  value: unknown,
  path: string,
  fixtureId: string,
  endpoint: string,
  statusCode: number,
  violations: SchemaViolation[],
): void {
  if (value === null) return;
  if (typeof value !== "string") {
    violations.push({
      fixtureId,
      endpoint,
      statusCode,
      path,
      reason: `Expected string for ${semantic}, got ${jsonTypeOf(value)}`,
    });
    return;
  }
  if (semantic === "uint256_string" && !isExactUnsignedDecimalInRange(value, U256_MAX)) {
    violations.push({
      fixtureId,
      endpoint,
      statusCode,
      path,
      reason: `Invalid uint256 decimal string '${value}'`,
    });
  } else if (semantic === "u64_string" && !isExactUnsignedDecimalInRange(value, U64_MAX)) {
    violations.push({
      fixtureId,
      endpoint,
      statusCode,
      path,
      reason: `Invalid u64 decimal string '${value}'`,
    });
  } else if (semantic === "token_identifier" || semantic === "chain_address") {
    const repr = classifyTokenOrAddressRepresentation(value);
    if (
      repr !== "stellar_account_strkey" &&
      repr !== "stellar_contract_strkey" &&
      repr !== "stellar_muxed_strkey" &&
      repr !== "evm_address_20"
    ) {
      violations.push({
        fixtureId,
        endpoint,
        statusCode,
        path,
        reason: `Expected canonical Stellar strkey or 20-byte EVM address for ${semantic}, got ${repr} ('${value}')`,
      });
    }
  } else if (semantic === "iso8601_timestamp") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
      violations.push({
        fixtureId,
        endpoint,
        statusCode,
        path,
        reason: `Expected ISO-8601 UTC timestamp, got '${value}'`,
      });
    }
  }
}

function validateNode(
  rawNode: SchemaNode,
  value: unknown,
  path: string,
  fixtureId: string,
  endpoint: string,
  statusCode: number,
  schema: PublishedApiSchema,
  violations: SchemaViolation[],
): void {
  const node = resolveNode(rawNode, schema);

  if (typeof value === "string" && CREDENTIAL_LEAK_PATTERN.test(value)) {
    violations.push({
      fixtureId,
      endpoint,
      statusCode,
      path,
      reason: "Public response contains credential-bearing URL or token material",
    });
  }

  if (node.oneOf !== undefined) {
    const branchErrors: SchemaViolation[][] = [];
    for (const option of node.oneOf) {
      const local: SchemaViolation[] = [];
      validateNode(option, value, path, fixtureId, endpoint, statusCode, schema, local);
      if (local.length === 0) return;
      branchErrors.push(local);
    }
    violations.push(
      branchErrors[0]?.[0] ?? {
        fixtureId,
        endpoint,
        statusCode,
        path,
        reason: "Value did not match any allowed oneOf schema branch",
      },
    );
    return;
  }

  if (node.type !== undefined) {
    const allowed = typeof node.type === "string" ? [node.type] : node.type;
    if (!allowed.some((t) => matchesAllowedType(value, t))) {
      violations.push({
        fixtureId,
        endpoint,
        statusCode,
        path,
        reason: `Expected type [${allowed.join(" | ")}], got ${jsonTypeOf(value)}`,
      });
      return;
    }
  }

  if (node.enum !== undefined && !node.enum.includes(value)) {
    violations.push({
      fixtureId,
      endpoint,
      statusCode,
      path,
      reason: `Value is not in published enum [${node.enum.map((v) => JSON.stringify(v)).join(", ")}]`,
    });
  }

  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) {
      violations.push({
        fixtureId,
        endpoint,
        statusCode,
        path,
        reason: `Value ${String(value)} is below minimum ${String(node.minimum)}`,
      });
    }
    if (node.maximum !== undefined && value > node.maximum) {
      violations.push({
        fixtureId,
        endpoint,
        statusCode,
        path,
        reason: `Value ${String(value)} exceeds maximum ${String(node.maximum)}`,
      });
    }
  }

  if (node["x-semantic"] !== undefined) {
    checkSemanticRule(node["x-semantic"], value, path, fixtureId, endpoint, statusCode, violations);
  }

  if (Array.isArray(value) && node.items !== undefined) {
    for (let i = 0; i < value.length; i += 1) {
      validateNode(
        node.items,
        value[i],
        `${path}[${String(i)}]`,
        fixtureId,
        endpoint,
        statusCode,
        schema,
        violations,
      );
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (node.required !== undefined) {
      for (const reqKey of node.required) {
        if (!(reqKey in record)) {
          violations.push({
            fixtureId,
            endpoint,
            statusCode,
            path: `${path}.${reqKey}`,
            reason: `Missing required property '${reqKey}'`,
          });
        }
      }
    }
    if (node.properties !== undefined) {
      for (const [propKey, propSchema] of Object.entries(node.properties)) {
        if (propKey in record) {
          validateNode(
            propSchema,
            record[propKey],
            `${path}.${propKey}`,
            fixtureId,
            endpoint,
            statusCode,
            schema,
            violations,
          );
        }
      }
    }
  }
}

export function validateAgainstPublishedSchema(
  fixture: ApiResponseFixture,
  schema: PublishedApiSchema = loadPublishedApiSchema(),
): readonly SchemaViolation[] {
  const endpointSpec = schema.endpoints[fixture.endpoint];
  if (endpointSpec === undefined) {
    return [
      {
        fixtureId: fixture.id,
        endpoint: fixture.endpoint,
        statusCode: fixture.statusCode,
        path: "$",
        reason: `Endpoint '${fixture.endpoint}' is not declared in published contract schema`,
      },
    ];
  }
  const statusSchema = endpointSpec[String(fixture.statusCode)];
  if (statusSchema === undefined) {
    return [
      {
        fixtureId: fixture.id,
        endpoint: fixture.endpoint,
        statusCode: fixture.statusCode,
        path: "$",
        reason: `Status ${String(fixture.statusCode)} is not declared for '${fixture.endpoint}'`,
      },
    ];
  }

  const violations: SchemaViolation[] = [];
  validateNode(
    statusSchema,
    fixture.body,
    "$",
    fixture.id,
    fixture.endpoint,
    fixture.statusCode,
    schema,
    violations,
  );
  return violations;
}

function resolveChildSchemaNode(
  parentRaw: SchemaNode | undefined,
  keyOrIndex: string | number,
  schema: PublishedApiSchema,
): SchemaNode | undefined {
  if (parentRaw === undefined) return undefined;
  const parent = resolveNode(parentRaw, schema);
  if (parent.oneOf !== undefined) {
    for (const opt of parent.oneOf) {
      const resolved = resolveNode(opt, schema);
      if (resolved.type !== "null") {
        return resolveChildSchemaNode(resolved, keyOrIndex, schema);
      }
    }
    return undefined;
  }
  if (typeof keyOrIndex === "number") {
    return parent.items !== undefined ? resolveNode(parent.items, schema) : undefined;
  }
  return parent.properties?.[keyOrIndex] !== undefined
    ? resolveNode(parent.properties[keyOrIndex], schema)
    : undefined;
}

function diffValues(
  baseVal: unknown,
  candVal: unknown,
  schemaNode: SchemaNode | undefined,
  path: string,
  fixtureId: string,
  endpoint: string,
  schema: PublishedApiSchema,
  changes: ContractChange[],
): void {
  const resolved = schemaNode !== undefined ? resolveNode(schemaNode, schema) : undefined;
  const semantic = resolved?.["x-semantic"];

  if (typeof candVal === "string" && CREDENTIAL_LEAK_PATTERN.test(candVal)) {
    changes.push({
      severity: "breaking",
      category: "credential_exposure",
      fixtureId,
      endpoint,
      path,
      detail: "Candidate response exposes credential-bearing connection string or secret token",
    });
  }

  // 1. Wide-integer semantic checks (before generic type comparison so string->number is categorized accurately).
  if (semantic === "uint256_string" || semantic === "u64_string") {
    const maxBound = semantic === "uint256_string" ? U256_MAX : U64_MAX;
    if (baseVal !== null && candVal !== null) {
      if (typeof candVal !== "string") {
        changes.push({
          severity: "breaking",
          category: "wide_integer_representation",
          fixtureId,
          endpoint,
          path,
          detail: `Wide integer field (${semantic}) changed from decimal string to ${jsonTypeOf(candVal)}, risking IEEE-754 precision loss`,
        });
        return;
      }
      if (!isExactUnsignedDecimalInRange(candVal, maxBound)) {
        changes.push({
          severity: "breaking",
          category: "wide_integer_representation",
          fixtureId,
          endpoint,
          path,
          detail: `Wide integer field (${semantic}) changed to non-canonical format '${candVal}'`,
        });
        return;
      }
      if (typeof baseVal === "string" && isExactUnsignedDecimalInRange(baseVal, maxBound)) {
        const baseBig = BigInt(baseVal);
        const candBig = BigInt(candVal);
        if (baseBig > BigInt(Number.MAX_SAFE_INTEGER) && baseBig !== candBig) {
          // Catch float-roundtrip truncation such as BigInt(Number(u256))!
          const floatRounded = BigInt(Math.trunc(Number(baseVal)));
          if (candBig === floatRounded || candVal !== baseVal) {
            changes.push({
              severity: "breaking",
              category: "wide_integer_representation",
              fixtureId,
              endpoint,
              path,
              detail: `Wide integer precision changed from '${baseVal}' to '${candVal}'`,
            });
            return;
          }
        }
      }
    }
  }

  // 2. Token & chain-address representation checks.
  if (semantic === "token_identifier" || semantic === "chain_address") {
    if (typeof baseVal === "string" && typeof candVal === "string") {
      const baseRepr = classifyTokenOrAddressRepresentation(baseVal);
      const candRepr = classifyTokenOrAddressRepresentation(candVal);
      if (baseRepr !== candRepr) {
        changes.push({
          severity: "breaking",
          category: "token_or_address_representation",
          fixtureId,
          endpoint,
          path,
          detail: `${semantic} representation changed from ${baseRepr} ('${baseVal}') to ${candRepr} ('${candVal}')`,
        });
        return;
      }
    }
  }

  // 3. Enum checks on closed protocol enums (such as transfer lifecycle stage or rail status).
  if (resolved?.enum !== undefined && !resolved.enum.includes(candVal)) {
    changes.push({
      severity: "breaking",
      category: "enum_violation",
      fixtureId,
      endpoint,
      path,
      detail: `Candidate value ${JSON.stringify(candVal)} is outside published enum [${resolved.enum.map((v) => JSON.stringify(v)).join(", ")}]`,
    });
    return;
  }

  // 4. Structural type compatibility.
  const baseType = jsonTypeOf(baseVal);
  const candType = jsonTypeOf(candVal);
  if (baseType !== candType) {
    // Allow null <-> allowed type only when published schema explicitly permits null.
    const allowedTypes =
      resolved?.type !== undefined
        ? typeof resolved.type === "string"
          ? [resolved.type]
          : resolved.type
        : [];
    const schemaAllowsBoth =
      (allowedTypes.includes(baseType) && allowedTypes.includes(candType)) ||
      resolved?.oneOf?.some((o) => resolveNode(o, schema).type === "null") === true;

    if (!schemaAllowsBoth) {
      changes.push({
        severity: "breaking",
        category: "type_changed",
        fixtureId,
        endpoint,
        path,
        detail: `Field type changed from ${baseType} to ${candType}`,
      });
      return;
    }
  }

  // 5. Recurse into arrays and objects.
  if (Array.isArray(baseVal) && Array.isArray(candVal)) {
    const len = Math.min(baseVal.length, candVal.length);
    for (let i = 0; i < len; i += 1) {
      diffValues(
        baseVal[i],
        candVal[i],
        resolveChildSchemaNode(resolved, i, schema),
        `${path}[${String(i)}]`,
        fixtureId,
        endpoint,
        schema,
        changes,
      );
    }
    return;
  }

  if (
    typeof baseVal === "object" &&
    baseVal !== null &&
    !Array.isArray(baseVal) &&
    typeof candVal === "object" &&
    candVal !== null &&
    !Array.isArray(candVal)
  ) {
    const baseObj = baseVal as Record<string, unknown>;
    const candObj = candVal as Record<string, unknown>;

    for (const key of Object.keys(baseObj)) {
      if (!(key in candObj)) {
        changes.push({
          severity: "breaking",
          category: "removed_field",
          fixtureId,
          endpoint,
          path: `${path}.${key}`,
          detail: `Existing public field '${key}' was removed`,
        });
      } else {
        diffValues(
          baseObj[key],
          candObj[key],
          resolveChildSchemaNode(resolved, key, schema),
          `${path}.${key}`,
          fixtureId,
          endpoint,
          schema,
          changes,
        );
      }
    }

    for (const key of Object.keys(candObj)) {
      if (!(key in baseObj)) {
        const addedVal = candObj[key];
        if (typeof addedVal === "string" && CREDENTIAL_LEAK_PATTERN.test(addedVal)) {
          changes.push({
            severity: "breaking",
            category: "credential_exposure",
            fixtureId,
            endpoint,
            path: `${path}.${key}`,
            detail: `Added field '${key}' exposes credential material`,
          });
        } else {
          changes.push({
            severity: "additive",
            category: "additive_field",
            fixtureId,
            endpoint,
            path: `${path}.${key}`,
            detail: `Optional metadata field '${key}' (${jsonTypeOf(addedVal)}) added compatibly`,
          });
        }
      }
    }
  }
}

export function diffApiFixtureBundles(
  baseline: ApiFixtureBundle,
  candidate: ApiFixtureBundle,
  schema: PublishedApiSchema = loadPublishedApiSchema(),
): ContractDiffReport {
  const changes: ContractChange[] = [];
  const schemaViolations: SchemaViolation[] = [];

  const candidateById = new Map<string, ApiResponseFixture>();
  for (const item of candidate.responses) {
    candidateById.set(item.id, item);
  }

  for (const baseItem of baseline.responses) {
    const candItem = candidateById.get(baseItem.id);
    if (candItem === undefined) {
      changes.push({
        severity: "breaking",
        category: "missing_endpoint_fixture",
        fixtureId: baseItem.id,
        endpoint: baseItem.endpoint,
        path: "$",
        detail: `Baseline endpoint fixture '${baseItem.id}' (${baseItem.endpoint}) missing from candidate bundle`,
      });
      continue;
    }

    if (baseItem.statusCode !== candItem.statusCode) {
      changes.push({
        severity: "breaking",
        category: "status_code_changed",
        fixtureId: baseItem.id,
        endpoint: baseItem.endpoint,
        path: "$",
        detail: `HTTP status code changed from ${String(baseItem.statusCode)} to ${String(candItem.statusCode)}`,
      });
      continue;
    }

    const endpointSchema = schema.endpoints[baseItem.endpoint]?.[String(baseItem.statusCode)];
    diffValues(
      baseItem.body,
      candItem.body,
      endpointSchema,
      "$",
      baseItem.id,
      baseItem.endpoint,
      schema,
      changes,
    );

    const violations = validateAgainstPublishedSchema(candItem, schema);
    schemaViolations.push(...violations);
  }

  const breakingChanges = changes.filter((c) => c.severity === "breaking");
  const additiveChanges = changes.filter((c) => c.severity === "additive");

  return {
    baselineVersion: baseline.version,
    candidateVersion: candidate.version,
    compatible: breakingChanges.length === 0 && schemaViolations.length === 0,
    breakingChanges,
    additiveChanges,
    schemaViolations,
  };
}

export async function runLiveFastifyContractCheck(
  options: {
    readonly candidateVersion?: string;
  } = {},
): Promise<{
  readonly liveBundle: ApiFixtureBundle;
  readonly report: ContractDiffReport;
}> {
  const baseline = loadBaselineApiFixtures();
  const schema = loadPublishedApiSchema();
  const pg = new PGlite();

  const migrations = [
    "1790900000000_initial-schema.sql",
    "1791000000000_cursor-block-hash.sql",
    "1791100000000_cursor-autovacuum-tuning.sql",
  ] as const;

  for (const name of migrations) {
    const fullPath = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
    const upSql = readFileSync(fullPath, "utf8").split(/^--\s*Down Migration\b/m)[0] ?? "";
    await pg.exec(upSql);
  }

  // Seed representative cross-chain records matching the v1 baseline dataset:
  // 1) Stellar -> Sepolia CCTP transfer with 128-bit wide uint256, high u64 nonce, 32-byte destination word
  //    (rendered by Fastify as a 20-byte EVM address), verified inbound_delivery + 'delivered' attestation.
  // 2) Sepolia -> Stellar Axelar ITS transfer that parked as claim #77 with 'attested' rail row.
  await pg.exec(`
    INSERT INTO outbound_transfer
      (origin_chain, route, nonce, sender, token, gross_amount, fee, net_amount,
       destination_chain, destination, origin_block, origin_tx, observed_at)
    VALUES
      ('stellar-testnet', 0, 18446744073709551600,
       'GC4FD5G3CZJ57VPYTVNWU4FRDLLV37EYDGT3OVZA35WKHBWDI6PKTYTN',
       'CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA',
       340282366920938463463374607431768211455,
       1000000000000000000000000000000000000,
       339282366920938463463374607431768211455,
       'sepolia',
       '0x0000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc',
       5001200, 'stellar-cctp-tx-1001', '2026-10-16T10:00:00.000Z'),
      ('sepolia', 1, 42,
       '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
       '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
       10000000, 30000, 9970000,
       'stellar-testnet',
       'GD4IEL76RCF2CULJZAKDTEZOQIIUTH3JDKY52W7SR6GBI42PZFIZGWIB',
       9413100, 'evm-axelar-tx-1002', '2026-10-16T10:05:00.000Z');

    INSERT INTO inbound_delivery
      (destination_chain, route, source_chain, source_nonce, rail_message_id, recipient, token,
       amount, delivered, claim_id, destination_block, destination_tx, observed_at)
    VALUES
      ('sepolia', 0, 'stellar-testnet', 18446744073709551600, 'cctp-msg-1001',
       '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
       '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
       33928236692093846346337460743176821145,
       true, NULL, 9413000, 'evm-cctp-mint-1001', '2026-10-16T10:01:00.000Z'),
      ('stellar-testnet', 1, 'sepolia', 42, NULL,
       'GD4IEL76RCF2CULJZAKDTEZOQIIUTH3JDKY52W7SR6GBI42PZFIZGWIB',
       'CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA',
       99700000,
       false, 77, 5001300, 'stellar-parked-tx-1002', '2026-10-16T10:06:00.000Z');

    INSERT INTO pending_claim
      (chain, claim_id, recipient, token, amount, route, source_chain, source_nonce,
       created_at, settled, observed_at)
    VALUES
      ('stellar-testnet', 77,
       'GD4IEL76RCF2CULJZAKDTEZOQIIUTH3JDKY52W7SR6GBI42PZFIZGWIB',
       'CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA',
       99700000, 1, 'sepolia', 42,
       '2026-10-16T10:06:00.000Z', false, '2026-10-16T10:06:00.000Z');

    INSERT INTO rail_attestation
      (transfer_id, route, status, rail_status, rail_reference, attested_at, last_checked_at, check_failures)
    VALUES
      (1, 0, 'delivered', 'complete', 'cctp-nonce-9001', '2026-10-16T10:00:30.000Z', '2026-10-16T10:01:00.000Z', 0),
      (2, 1, 'attested', 'executed', 'axelar-msg-1002', '2026-10-16T10:05:30.000Z', '2026-10-16T10:05:35.000Z', 0);

    INSERT INTO route_health
      (sampled_at, origin_chain, destination_chain, route, token, available, blocker, flow_available)
    VALUES
      ('2026-10-16T10:07:00.000Z', 'stellar-testnet', 'sepolia', 0,
       'CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA',
       true, 0, 10000000000000);

    INSERT INTO indexer_cursor
      (chain_key, family, contract, last_processed, last_processed_hash, updated_at)
    VALUES
      ('stellar-testnet', 'stellar',
       'CDVDU67TASWDY7ECUQWGPIIAYVLFYTGULAQVLMUEYRIBILVHKJHBCPSI',
       5001300, NULL, '2026-10-16T10:08:00.000Z');
  `);

  const dbAdapter = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      const result = await pg.query(sql, [...params]);
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
    },
    ping: async () => {
      await pg.query("SELECT 1");
    },
  };

  const deploymentsPath = fileURLToPath(
    new URL("./fixtures/deployments-testnet.json", import.meta.url),
  );
  const config = loadConfig({
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://hyperion:not-a-real-password@127.0.0.1:5433/hyperion",
      REDIS_URL: "redis://127.0.0.1:6380",
      HYPERION_NETWORK: "testnet",
      HYPERION_DEPLOYMENTS_FILE: deploymentsPath,
      KEEPER_ENABLED: "false",
    },
  });

  const app = buildServer({
    config,
    logger: pino({ level: "silent" }),
    db: dbAdapter as unknown as Database,
    readiness: [],
    redis: { ping: () => Promise.resolve("PONG") },
    startedAt: new Date(),
  });

  try {
    await app.ready();

    const liveResponses: ApiResponseFixture[] = [];
    for (const baseFixture of baseline.responses) {
      const injected = await app.inject({
        method: "GET",
        url: baseFixture.requestPath,
      });
      liveResponses.push({
        id: baseFixture.id,
        endpoint: baseFixture.endpoint,
        requestPath: baseFixture.requestPath,
        statusCode: injected.statusCode,
        body: injected.json(),
      });
    }

    const liveBundle: ApiFixtureBundle = {
      version: options.candidateVersion ?? "1.0.0-live",
      responses: liveResponses,
    };

    const report = diffApiFixtureBundles(baseline, liveBundle, schema);
    return { liveBundle, report };
  } finally {
    await app.close();
    await pg.close();
  }
}
