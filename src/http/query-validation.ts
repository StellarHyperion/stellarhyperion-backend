/**
 * Pre-SQL validation and canonicalization for transfer, claim, and route health query filters.
 *
 * Rejects malformed parameters and impossible cross-parameter compositions before any database
 * query executes, normalizes canonical Stellar and EVM identities, and escapes SQL LIKE wildcards
 * so search terms are matched literally via parameterized queries.
 */
import {
  ASSETS,
  AddressKind,
  CHAINS,
  ROUTE_SLUGS,
  RouteKind,
  assetOn,
  carriesPayload,
  isChainKey,
  isEvmChain,
  isEvmDeployment,
  isRouteKind,
  isStellarChain,
  isStellarDeployment,
  toEvmAddress,
  toWord,
  tryParseStellarAddress,
  tryRouteFromSlug,
  type ChainFamily,
  type ChainKey,
  type Hex,
} from "@hyperion/protocol";

import type { AppConfig } from "../config/config.js";

export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_OFFSET = 100_000;
export const MAX_SEARCH_LENGTH = 128;
const MAX_U64 = (1n << 64n) - 1n;

export interface ValidationIssue {
  readonly field: string;
  readonly reason: string;
}

export type ValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly issues: readonly ValidationIssue[];
    };

export interface CanonicalAddressFilter {
  readonly family: ChainFamily;
  readonly canonical: string;
  /** Candidate representations stored in `outbound_transfer.destination` (20-byte and 32-byte). */
  readonly destinationMatches: readonly string[];
  readonly isMuxedStellar: boolean;
}

export interface CanonicalTokenFilter {
  /** Candidate lowercase token strings to match against the target table column. */
  readonly matchValuesLower: readonly string[];
  readonly family: ChainFamily | null;
  readonly symbol: string | null;
}

export interface ValidatedTransferListQuery {
  readonly originChain: ChainKey | null;
  readonly destinationChain: ChainKey | null;
  readonly route: RouteKind | null;
  readonly sender: CanonicalAddressFilter | null;
  readonly recipient: CanonicalAddressFilter | null;
  readonly token: CanonicalTokenFilter | null;
  readonly searchLikePattern: string | null;
  readonly limit: number;
  readonly offset: number;
}

export interface ValidatedClaimListQuery {
  readonly chain: ChainKey | null;
  readonly recipient: CanonicalAddressFilter | null;
  readonly token: CanonicalTokenFilter | null;
  readonly route: RouteKind | null;
  readonly settled: boolean | null;
  readonly limit: number;
  readonly offset: number;
}

export interface ValidatedRouteHealthQuery {
  readonly originChain: ChainKey | null;
  readonly destinationChain: ChainKey | null;
  readonly route: RouteKind | null;
  readonly token: CanonicalTokenFilter | null;
}

function fail<T>(issues: readonly ValidationIssue[]): ValidationResult<T> {
  const summary = issues.map((item) => `${item.field}: ${item.reason}`).join("; ");
  return {
    ok: false,
    message: `invalid query parameters (${summary})`,
    issues,
  };
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function escapeSqlLikeLiteral(raw: string): string {
  return raw.replace(/[\\%_]/g, "\\$&");
}

export function validateUnsignedBigIntParam(field: string, raw: string): ValidationResult<string> {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return fail([{ field, reason: "must be a non-negative base-10 integer" }]);
  }
  const parsed = BigInt(trimmed);
  if (parsed > MAX_U64) {
    return fail([{ field, reason: "exceeds maximum 64-bit unsigned integer" }]);
  }
  return { ok: true, value: parsed.toString(10) };
}

export function validateTxHashParam(raw: string): ValidationResult<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SEARCH_LENGTH || hasControlChars(trimmed)) {
    return fail([{ field: "txHash", reason: "must be a non-empty transaction identifier" }]);
  }
  if (/\s/.test(trimmed)) {
    return fail([{ field: "txHash", reason: "must not contain whitespace" }]);
  }
  return { ok: true, value: trimmed };
}

export function validateNetworkChain(
  field: string,
  raw: string,
  config: AppConfig,
): ValidationResult<ChainKey> {
  const trimmed = raw.trim();
  if (!isChainKey(trimmed)) {
    return fail([{ field, reason: `unknown chain '${trimmed.slice(0, 48)}'` }]);
  }
  const chainMeta = CHAINS[trimmed];
  if (chainMeta.network !== config.network) {
    return fail([
      {
        field,
        reason: `chain '${trimmed}' belongs to ${chainMeta.network}, active network is ${config.network}`,
      },
    ]);
  }
  return { ok: true, value: trimmed };
}

function parseRouteParam(field: string, raw: string): ValidationResult<RouteKind> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return fail([{ field, reason: "route must not be empty" }]);
  }
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (isRouteKind(num)) {
      return { ok: true, value: num };
    }
    return fail([{ field, reason: `unsupported route tag '${trimmed}'` }]);
  }
  const bySlug = tryRouteFromSlug(trimmed.toLowerCase());
  if (bySlug !== null) {
    return { ok: true, value: bySlug };
  }
  return fail([
    {
      field,
      reason: `unsupported route '${trimmed.slice(0, 32)}'; expected 0..3 or ${Object.values(ROUTE_SLUGS).join(", ")}`,
    },
  ]);
}

function parseAddressParam(
  field: string,
  raw: string,
  allowMuxed: boolean,
): ValidationResult<CanonicalAddressFilter> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return fail([{ field, reason: "address must not be empty" }]);
  }

  if (/^0x/i.test(trimmed)) {
    if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      const lower20 = trimmed.toLowerCase() as Hex;
      const word32 = toWord(lower20).toLowerCase();
      return {
        ok: true,
        value: {
          family: "evm",
          canonical: lower20,
          destinationMatches: [lower20, word32],
          isMuxedStellar: false,
        },
      };
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
      try {
        const lower20 = toEvmAddress(trimmed.toLowerCase() as Hex).toLowerCase() as Hex;
        const word32 = toWord(lower20).toLowerCase();
        return {
          ok: true,
          value: {
            family: "evm",
            canonical: lower20,
            destinationMatches: [lower20, word32],
            isMuxedStellar: false,
          },
        };
      } catch {
        return fail([
          {
            field,
            reason: "32-byte EVM word must have twelve zero high bytes",
          },
        ]);
      }
    }
    return fail([
      {
        field,
        reason: "invalid EVM hex address; expected 20-byte address or zero-padded 32-byte word",
      },
    ]);
  }

  const parsedStellar = tryParseStellarAddress(trimmed);
  if (!parsedStellar.ok) {
    return fail([
      {
        field,
        reason: `invalid canonical Stellar or EVM address (${parsedStellar.reason})`,
      },
    ]);
  }
  const isMuxed = parsedStellar.parts.kind === AddressKind.MuxedAccount;
  if (isMuxed && !allowMuxed) {
    return fail([{ field, reason: "muxed M-address cannot be a transfer sender" }]);
  }

  return {
    ok: true,
    value: {
      family: "stellar",
      canonical: trimmed,
      destinationMatches: [trimmed],
      isMuxedStellar: isMuxed,
    },
  };
}

function resolveDeployedTokenOnChain(
  chainKey: ChainKey,
  symbol: string,
  config: AppConfig,
): { readonly addressOrSac: string; readonly routes: readonly RouteKind[] } | null {
  const deployment = config.deployments.networks[chainKey];
  if (deployment === undefined) {
    return null;
  }
  if (isStellarDeployment(deployment)) {
    const match = Object.entries(deployment.tokens).find(
      ([sym]) => sym.toUpperCase() === symbol.toUpperCase(),
    )?.[1];
    return match !== undefined ? { addressOrSac: match.sacId, routes: match.routes } : null;
  }
  if (isEvmDeployment(deployment)) {
    const match = Object.entries(deployment.tokens).find(
      ([sym]) => sym.toUpperCase() === symbol.toUpperCase(),
    )?.[1];
    return match !== undefined ? { addressOrSac: match.address, routes: match.routes } : null;
  }
  return null;
}

function parseTokenParam(
  field: string,
  raw: string,
  scopedChain: ChainKey | null,
  route: RouteKind | null,
  config: AppConfig,
): ValidationResult<CanonicalTokenFilter> {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 80 || hasControlChars(trimmed)) {
    return fail([{ field, reason: "must be a valid token address, SAC id, or asset symbol" }]);
  }

  // 1. Explicit EVM token contract address
  if (/^0x/i.test(trimmed)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      return fail([{ field, reason: "invalid EVM token contract address" }]);
    }
    if (scopedChain !== null && isStellarChain(CHAINS[scopedChain])) {
      return fail([
        {
          field,
          reason: `EVM token address cannot be combined with Stellar chain '${scopedChain}'`,
        },
      ]);
    }
    return {
      ok: true,
      value: {
        matchValuesLower: [trimmed.toLowerCase()],
        family: "evm",
        symbol: null,
      },
    };
  }

  // 2. Explicit Soroban SAC contract strkey (`C...`, 56 chars)
  if (trimmed.length === 56 && trimmed.startsWith("C")) {
    const parsed = tryParseStellarAddress(trimmed);
    if (!parsed.ok || parsed.parts.kind !== AddressKind.Contract) {
      return fail([{ field, reason: "invalid Soroban token contract strkey" }]);
    }
    if (scopedChain !== null && isEvmChain(CHAINS[scopedChain])) {
      return fail([
        {
          field,
          reason: `Soroban SAC token cannot be combined with EVM chain '${scopedChain}'`,
        },
      ]);
    }
    return {
      ok: true,
      value: {
        matchValuesLower: [trimmed.toLowerCase()],
        family: "stellar",
        symbol: null,
      },
    };
  }

  // 3. Canonical asset symbol (e.g. USDC, EURC)
  if (!/^[A-Za-z0-9]{2,12}$/.test(trimmed)) {
    return fail([{ field, reason: `unrecognized token identifier '${trimmed}'` }]);
  }

  const upperSymbol = trimmed.toUpperCase();
  if (scopedChain !== null) {
    const deployed = resolveDeployedTokenOnChain(scopedChain, upperSymbol, config);
    const registryAsset = assetOn(scopedChain, upperSymbol);
    if (deployed === null && registryAsset === null) {
      return fail([
        {
          field,
          reason: `asset '${upperSymbol}' is not supported on chain '${scopedChain}'`,
        },
      ]);
    }

    if (route !== null) {
      const routeSlug = ROUTE_SLUGS[route];
      const supportedOnDeployment = deployed?.routes.includes(route) ?? false;
      const supportedInRegistry = registryAsset?.routes.includes(route) ?? false;
      if (!supportedOnDeployment && !supportedInRegistry) {
        return fail([
          {
            field,
            reason: `asset '${upperSymbol}' on '${scopedChain}' does not support route '${routeSlug}'`,
          },
        ]);
      }
    }

    const candidates = new Set<string>();
    if (deployed !== null) {
      candidates.add(deployed.addressOrSac.toLowerCase());
    } else if (registryAsset !== null) {
      if (registryAsset.family === "evm") {
        candidates.add(registryAsset.address.toLowerCase());
      } else if (registryAsset.sacId !== null) {
        candidates.add(registryAsset.sacId.toLowerCase());
      }
    }

    if (candidates.size === 0) {
      return fail([
        {
          field,
          reason: `no canonical contract address configured for '${upperSymbol}' on '${scopedChain}'`,
        },
      ]);
    }

    return {
      ok: true,
      value: {
        matchValuesLower: [...candidates],
        family: CHAINS[scopedChain].family,
        symbol: upperSymbol,
      },
    };
  }

  // Unscoped symbol across the active network: collect deployed SAC/addresses + registry EVM addresses.
  const candidates = new Set<string>();
  for (const chainKey of Object.keys(config.deployments.networks)) {
    if (!isChainKey(chainKey) || CHAINS[chainKey].network !== config.network) continue;
    const resolved = resolveDeployedTokenOnChain(chainKey, upperSymbol, config);
    if (resolved !== null) {
      candidates.add(resolved.addressOrSac.toLowerCase());
    }
  }
  for (const asset of ASSETS) {
    if (CHAINS[asset.chain].network !== config.network) continue;
    if (asset.symbol.toUpperCase() !== upperSymbol) continue;
    if (route !== null && !asset.routes.includes(route)) continue;
    if (asset.family === "evm") {
      candidates.add(asset.address.toLowerCase());
    } else if (asset.sacId !== null) {
      candidates.add(asset.sacId.toLowerCase());
    }
  }

  const symbolExistsInNetwork = ASSETS.some(
    (asset) =>
      CHAINS[asset.chain].network === config.network && asset.symbol.toUpperCase() === upperSymbol,
  );
  if (!symbolExistsInNetwork && candidates.size === 0) {
    return fail([
      {
        field,
        reason: `unknown asset symbol '${upperSymbol}' for ${config.network}`,
      },
    ]);
  }
  if (candidates.size === 0 && route !== null) {
    return fail([
      {
        field,
        reason: `asset '${upperSymbol}' is not supported on route '${ROUTE_SLUGS[route]}'`,
      },
    ]);
  }

  return {
    ok: true,
    value: {
      matchValuesLower: [...candidates],
      family: null,
      symbol: upperSymbol,
    },
  };
}

function parseLimitOffset(
  rawLimit: string | undefined,
  rawOffset: string | undefined,
  issues: ValidationIssue[],
): { readonly limit: number; readonly offset: number } {
  let limit = DEFAULT_PAGE_LIMIT;
  let offset = 0;

  if (rawLimit !== undefined) {
    const trimmed = rawLimit.trim();
    if (!/^\d+$/.test(trimmed)) {
      issues.push({
        field: "limit",
        reason: `must be an integer between 1 and ${String(MAX_PAGE_LIMIT)}`,
      });
    } else {
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
        issues.push({
          field: "limit",
          reason: `must be between 1 and ${String(MAX_PAGE_LIMIT)}`,
        });
      } else {
        limit = parsed;
      }
    }
  }

  if (rawOffset !== undefined) {
    const trimmed = rawOffset.trim();
    if (!/^\d+$/.test(trimmed)) {
      issues.push({
        field: "offset",
        reason: `must be an integer between 0 and ${String(MAX_PAGE_OFFSET)}`,
      });
    } else {
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_PAGE_OFFSET) {
        issues.push({
          field: "offset",
          reason: `must be between 0 and ${String(MAX_PAGE_OFFSET)}`,
        });
      } else {
        offset = parsed;
      }
    }
  }

  return { limit, offset };
}

function validateChainPairAndRoute(
  originChain: ChainKey | null,
  destinationChain: ChainKey | null,
  route: RouteKind | null,
  issues: ValidationIssue[],
): void {
  if (originChain !== null && destinationChain !== null) {
    if (originChain === destinationChain) {
      issues.push({
        field: "destinationChain",
        reason: "originChain and destinationChain cannot be identical",
      });
    } else if (CHAINS[originChain].family === CHAINS[destinationChain].family) {
      issues.push({
        field: "destinationChain",
        reason: `unsupported ${CHAINS[originChain].family}-to-${CHAINS[destinationChain].family} hop; Stellar must be one end of every transfer`,
      });
    }
  }

  if (route === RouteKind.Cctp) {
    if (originChain !== null && CHAINS[originChain].cctpDomain === null) {
      issues.push({
        field: "route",
        reason: `CCTP is not supported on originChain '${originChain}'`,
      });
    }
    if (destinationChain !== null && CHAINS[destinationChain].cctpDomain === null) {
      issues.push({
        field: "route",
        reason: `CCTP is not supported on destinationChain '${destinationChain}'`,
      });
    }
  }
}

export function validateTransferListQuery(
  query: {
    readonly originChain?: string;
    readonly destinationChain?: string;
    readonly route?: string;
    readonly sender?: string;
    readonly recipient?: string;
    readonly token?: string;
    readonly search?: string;
    readonly limit?: string;
    readonly offset?: string;
  },
  config: AppConfig,
): ValidationResult<ValidatedTransferListQuery> {
  const issues: ValidationIssue[] = [];

  let originChain: ChainKey | null = null;
  if (query.originChain !== undefined) {
    const res = validateNetworkChain("originChain", query.originChain, config);
    if (!res.ok) issues.push(...res.issues);
    else originChain = res.value;
  }

  let destinationChain: ChainKey | null = null;
  if (query.destinationChain !== undefined) {
    const res = validateNetworkChain("destinationChain", query.destinationChain, config);
    if (!res.ok) issues.push(...res.issues);
    else destinationChain = res.value;
  }

  let route: RouteKind | null = null;
  if (query.route !== undefined) {
    const res = parseRouteParam("route", query.route);
    if (!res.ok) issues.push(...res.issues);
    else route = res.value;
  }

  validateChainPairAndRoute(originChain, destinationChain, route, issues);

  let sender: CanonicalAddressFilter | null = null;
  if (query.sender !== undefined) {
    const res = parseAddressParam("sender", query.sender, false);
    if (!res.ok) {
      issues.push(...res.issues);
    } else {
      sender = res.value;
      if (originChain !== null && CHAINS[originChain].family !== sender.family) {
        issues.push({
          field: "sender",
          reason: `${sender.family} sender address does not match ${CHAINS[originChain].family} originChain '${originChain}'`,
        });
      }
      if (destinationChain !== null && CHAINS[destinationChain].family === sender.family) {
        issues.push({
          field: "sender",
          reason: `${sender.family} sender address conflicts with ${CHAINS[destinationChain].family} destinationChain '${destinationChain}'`,
        });
      }
    }
  }

  let recipient: CanonicalAddressFilter | null = null;
  if (query.recipient !== undefined) {
    const res = parseAddressParam("recipient", query.recipient, true);
    if (!res.ok) {
      issues.push(...res.issues);
    } else {
      recipient = res.value;
      if (destinationChain !== null && CHAINS[destinationChain].family !== recipient.family) {
        issues.push({
          field: "recipient",
          reason: `${recipient.family} recipient address does not match ${CHAINS[destinationChain].family} destinationChain '${destinationChain}'`,
        });
      }
      if (originChain !== null && CHAINS[originChain].family === recipient.family) {
        issues.push({
          field: "recipient",
          reason: `${recipient.family} recipient address conflicts with ${CHAINS[originChain].family} originChain '${originChain}'`,
        });
      }
      if (recipient.isMuxedStellar && route !== null && !carriesPayload(route)) {
        issues.push({
          field: "recipient",
          reason: `muxed Stellar recipient is incompatible with route '${ROUTE_SLUGS[route]}'`,
        });
      }
    }
  }

  if (sender !== null && recipient !== null && sender.family === recipient.family) {
    issues.push({
      field: "recipient",
      reason: `sender and recipient cannot both belong to family '${sender.family}' on a cross-chain transfer`,
    });
  }

  let token: CanonicalTokenFilter | null = null;
  if (query.token !== undefined) {
    const res = parseTokenParam("token", query.token, originChain, route, config);
    if (!res.ok) {
      issues.push(...res.issues);
    } else {
      token = res.value;
      if (token.family !== null && sender !== null && token.family !== sender.family) {
        issues.push({
          field: "token",
          reason: `${token.family} origin token conflicts with ${sender.family} sender`,
        });
      }
    }
  }

  let searchLikePattern: string | null = null;
  if (query.search !== undefined) {
    if (query.search.length > MAX_SEARCH_LENGTH) {
      issues.push({
        field: "search",
        reason: `must not exceed ${String(MAX_SEARCH_LENGTH)} characters`,
      });
    } else if (hasControlChars(query.search)) {
      issues.push({
        field: "search",
        reason: "must not contain control characters",
      });
    } else {
      const trimmed = query.search.trim();
      if (trimmed.length > 0) {
        searchLikePattern = `%${escapeSqlLikeLiteral(trimmed)}%`;
      }
    }
  }

  const { limit, offset } = parseLimitOffset(query.limit, query.offset, issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return {
    ok: true,
    value: {
      originChain,
      destinationChain,
      route,
      sender,
      recipient,
      token,
      searchLikePattern,
      limit,
      offset,
    },
  };
}

export function validateClaimListQuery(
  query: {
    readonly chain?: string;
    readonly recipient?: string;
    readonly token?: string;
    readonly route?: string;
    readonly settled?: string;
    readonly limit?: string;
    readonly offset?: string;
  },
  config: AppConfig,
): ValidationResult<ValidatedClaimListQuery> {
  const issues: ValidationIssue[] = [];

  let chain: ChainKey | null = null;
  if (query.chain !== undefined) {
    const res = validateNetworkChain("chain", query.chain, config);
    if (!res.ok) issues.push(...res.issues);
    else chain = res.value;
  }

  let route: RouteKind | null = null;
  if (query.route !== undefined) {
    const res = parseRouteParam("route", query.route);
    if (!res.ok) issues.push(...res.issues);
    else route = res.value;
  }

  let recipient: CanonicalAddressFilter | null = null;
  if (query.recipient !== undefined) {
    const res = parseAddressParam("recipient", query.recipient, true);
    if (!res.ok) {
      issues.push(...res.issues);
    } else {
      recipient = res.value;
      if (chain !== null && CHAINS[chain].family !== recipient.family) {
        issues.push({
          field: "recipient",
          reason: `${recipient.family} recipient does not match ${CHAINS[chain].family} chain '${chain}'`,
        });
      }
    }
  }

  let token: CanonicalTokenFilter | null = null;
  if (query.token !== undefined) {
    const res = parseTokenParam("token", query.token, chain, route, config);
    if (!res.ok) issues.push(...res.issues);
    else token = res.value;
  }

  let settled: boolean | null = null;
  if (query.settled !== undefined) {
    const normalized = query.settled.trim().toLowerCase();
    if (normalized === "true") {
      settled = true;
    } else if (normalized === "false") {
      settled = false;
    } else {
      issues.push({ field: "settled", reason: "must be 'true' or 'false'" });
    }
  }

  const { limit, offset } = parseLimitOffset(query.limit, query.offset, issues);

  if (issues.length > 0) {
    return fail(issues);
  }

  return {
    ok: true,
    value: {
      chain,
      recipient,
      token,
      route,
      settled,
      limit,
      offset,
    },
  };
}

export function validateRouteHealthQuery(
  query: {
    readonly originChain?: string;
    readonly destinationChain?: string;
    readonly route?: string;
    readonly token?: string;
  },
  config: AppConfig,
): ValidationResult<ValidatedRouteHealthQuery> {
  const issues: ValidationIssue[] = [];

  let originChain: ChainKey | null = null;
  if (query.originChain !== undefined) {
    const res = validateNetworkChain("originChain", query.originChain, config);
    if (!res.ok) issues.push(...res.issues);
    else originChain = res.value;
  }

  let destinationChain: ChainKey | null = null;
  if (query.destinationChain !== undefined) {
    const res = validateNetworkChain("destinationChain", query.destinationChain, config);
    if (!res.ok) issues.push(...res.issues);
    else destinationChain = res.value;
  }

  let route: RouteKind | null = null;
  if (query.route !== undefined) {
    const res = parseRouteParam("route", query.route);
    if (!res.ok) issues.push(...res.issues);
    else route = res.value;
  }

  validateChainPairAndRoute(originChain, destinationChain, route, issues);

  let token: CanonicalTokenFilter | null = null;
  if (query.token !== undefined) {
    const res = parseTokenParam("token", query.token, originChain, route, config);
    if (!res.ok) issues.push(...res.issues);
    else token = res.value;
  }

  if (issues.length > 0) {
    return fail(issues);
  }

  return {
    ok: true,
    value: {
      originChain,
      destinationChain,
      route,
      token,
    },
  };
}
