import { stdSerializers } from "pino";

export const REDACTED_CENSOR = "[redacted]";

const SENSITIVE_OBJECT_KEYS = new Set([
  "databaseurl",
  "redisurl",
  "connectionstring",
  "password",
  "passwd",
  "pwd",
  "secret",
  "stellarsecret",
  "secretseed",
  "secretkey",
  "clientsecret",
  "webhooksecret",
  "signersecret",
  "keepersecret",
  "privatekey",
  "signingkey",
  "mnemonic",
  "seedphrase",
  "rawseed",
  "apikey",
  "xapikey",
  "apitoken",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "idtoken",
  "sessiontoken",
  "securitytoken",
  "xamzsecuritytoken",
  "xamzsignature",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
]);

const SAFE_OBJECT_KEYS = new Set([
  "networkpassphrase",
  "publickey",
  "token",
  "tokenid",
  "tokenaddress",
  "origintoken",
  "destinationtoken",
  "sourcetoken",
  "receivedtoken",
]);

const SENSITIVE_QUERY_KEYS = new Set([
  "apikey",
  "xapikey",
  "key",
  "token",
  "apitoken",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "idtoken",
  "sessiontoken",
  "session",
  "sessionid",
  "auth",
  "authorization",
  "secret",
  "clientsecret",
  "stellarsecret",
  "secretseed",
  "privatekey",
  "signingkey",
  "mnemonic",
  "seed",
  "password",
  "passwd",
  "pwd",
  "sig",
  "signature",
  "jwt",
  "credential",
  "credentials",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
]);

const KNOWN_PUBLIC_ROUTE_SEGMENTS = new Set([
  "api",
  "v1",
  "v2",
  "v3",
  "transfers",
  "by-tx",
  "stream",
  "claims",
  "routes",
  "health",
  "ready",
  "metrics",
  "messages",
  "attestations",
  "tx",
  "blocks",
  "ledgers",
  "status",
  "searchgmp",
]);

const SECRET_PATH_PREFIXES = new Set([
  "v1",
  "v2",
  "v3",
  "apikey",
  "api-key",
  "api_key",
  "key",
  "token",
  "secret",
]);

const URL_IN_TEXT_PATTERN = /\b(?:https?|wss?|postgres(?:ql)?|rediss?):\/\/[^\s"'<>`]+/gi;

const STELLAR_SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;

const JWT_TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const AUTH_SCHEME_IN_TEXT_PATTERN =
  /\b(Bearer|Basic|Apikey|ApiKey|Token)\s+([A-Za-z0-9._~+/=-]{6,})/g;

const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const INLINE_SECRET_ASSIGNMENT_PATTERN =
  /\b(password|passwd|pwd|api[-_]?key|x[-_]?api[-_]?key|key|access[-_]?token|refresh[-_]?token|auth[-_]?token|bearer[-_]?token|client[-_]?secret|stellar[-_]?secret|secret[-_]?seed|private[-_]?key|signing[-_]?key|secret[-_]?key|signer[-_]?secret|connection[-_]?string)(\s*[:=]\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s,;)\]}]+)/gi;

const INLINE_MNEMONIC_PATTERN =
  /\b(mnemonic|seed[-_ ]?phrase)(\s*[:=]\s*)(?:"[^"]+"|'[^']+'|(?:[a-z]{3,10}\s+){5,23}[a-z]{3,10})/gi;

const TRAILING_PROSE_PUNCTUATION = new Set([")", "]", "}", ",", ";", ".", ":", "!", "?"]);

export function isPublicChainIdentifier(value: string): boolean {
  return (
    /^0x[0-9a-fA-F]{40}$/.test(value) ||
    /^0x[0-9a-fA-F]{64}$/.test(value) ||
    /^[0-9a-fA-F]{64}$/.test(value) ||
    /^[GC][A-Z2-7]{55}$/.test(value) ||
    /^M[A-Z2-7]{68}$/.test(value)
  );
}

export function isSensitiveFieldName(fieldName: string): boolean {
  const compact = fieldName.toLowerCase().replace(/[-_\s]/g, "");
  if (SAFE_OBJECT_KEYS.has(compact)) {
    return false;
  }
  if (SENSITIVE_OBJECT_KEYS.has(compact)) {
    return true;
  }
  return (
    compact.endsWith("password") ||
    compact.endsWith("passwd") ||
    compact.endsWith("secret") ||
    compact.endsWith("secretkey") ||
    compact.endsWith("secretseed") ||
    compact.endsWith("privatekey") ||
    compact.endsWith("signingkey") ||
    compact.endsWith("apikey") ||
    compact.endsWith("accesstoken") ||
    compact.endsWith("refreshtoken") ||
    compact.endsWith("authtoken") ||
    compact.endsWith("bearertoken") ||
    compact.endsWith("sessiontoken") ||
    compact.endsWith("mnemonic") ||
    compact.endsWith("connectionstring")
  );
}

function isSensitiveQueryKey(paramName: string): boolean {
  const compact = paramName.toLowerCase().replace(/[-_\s]/g, "");
  if (SENSITIVE_QUERY_KEYS.has(compact)) {
    return true;
  }
  return (
    compact.includes("secret") ||
    compact.includes("password") ||
    compact.includes("passwd") ||
    compact.includes("apikey") ||
    compact.includes("privatekey") ||
    compact.includes("mnemonic") ||
    compact.endsWith("token")
  );
}

function splitTrailingPunctuation(candidate: string): {
  readonly core: string;
  readonly suffix: string;
} {
  let end = candidate.length;
  while (end > 0) {
    const ch = candidate[end - 1];
    if (ch === undefined || !TRAILING_PROSE_PUNCTUATION.has(ch)) {
      break;
    }
    const slice = candidate.slice(0, end);
    if (ch === ")") {
      const opens = (slice.match(/\(/g) ?? []).length;
      const closes = (slice.match(/\)/g) ?? []).length;
      if (closes <= opens) break;
    }
    if (ch === "]") {
      const opens = (slice.match(/\[/g) ?? []).length;
      const closes = (slice.match(/\]/g) ?? []).length;
      if (closes <= opens) break;
    }
    if (ch === "}") {
      const opens = (slice.match(/\{/g) ?? []).length;
      const closes = (slice.match(/\}/g) ?? []).length;
      if (closes <= opens) break;
    }
    end -= 1;
  }
  return {
    core: candidate.slice(0, end),
    suffix: candidate.slice(end),
  };
}

function sanitizeQueryString(rawSearch: string): string {
  const body = rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch;
  if (body === "") return "";
  const params = new URLSearchParams(body);
  const parts: string[] = [];
  for (const [key, val] of params.entries()) {
    const safeKey = encodeURIComponent(key);
    if (isSensitiveQueryKey(key) && !isPublicChainIdentifier(val)) {
      parts.push(`${safeKey}=${REDACTED_CENSOR}`);
    } else {
      const scrubbedVal = redactInlineNonUrlSecrets(val);
      parts.push(
        scrubbedVal === REDACTED_CENSOR || scrubbedVal.includes(REDACTED_CENSOR)
          ? `${safeKey}=${scrubbedVal}`
          : `${safeKey}=${encodeURIComponent(scrubbedVal)}`,
      );
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function sanitizeHashFragment(rawHash: string): string {
  const body = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  if (body === "") return "";
  if (body.includes("=")) {
    const params = new URLSearchParams(body);
    let redactedAny = false;
    const parts: string[] = [];
    for (const [key, val] of params.entries()) {
      if (isSensitiveQueryKey(key) && !isPublicChainIdentifier(val)) {
        redactedAny = true;
        parts.push(`${encodeURIComponent(key)}=${REDACTED_CENSOR}`);
      } else {
        const scrubbedVal = redactInlineNonUrlSecrets(val);
        if (scrubbedVal !== val) redactedAny = true;
        parts.push(
          scrubbedVal.includes(REDACTED_CENSOR)
            ? `${encodeURIComponent(key)}=${scrubbedVal}`
            : `${encodeURIComponent(key)}=${encodeURIComponent(scrubbedVal)}`,
        );
      }
    }
    if (redactedAny) {
      return `#${parts.join("&")}`;
    }
  }
  const scrubbed = redactInlineNonUrlSecrets(body);
  return `#${scrubbed}`;
}

function sanitizePathname(pathname: string): string {
  const segments = pathname.split("/");
  for (let i = 1; i < segments.length; i += 1) {
    const current = segments[i];
    if (current === undefined || current === "" || current === REDACTED_CENSOR) continue;
    let decoded = current;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      /* keep raw segment when percent-encoding is malformed */
    }
    if (decoded === REDACTED_CENSOR) {
      segments[i] = REDACTED_CENSOR;
      continue;
    }
    if (isPublicChainIdentifier(decoded)) continue;
    if (KNOWN_PUBLIC_ROUTE_SEGMENTS.has(decoded.toLowerCase())) continue;

    const prev = segments[i - 1]?.toLowerCase() ?? "";
    if (SECRET_PATH_PREFIXES.has(prev)) {
      segments[i] = REDACTED_CENSOR;
      continue;
    }
    const scrubbed = redactInlineNonUrlSecrets(decoded);
    if (scrubbed !== decoded) {
      segments[i] = scrubbed;
    }
  }
  return segments.join("/");
}

function fallbackRedactMalformedUrl(rawUrl: string): string {
  const withAuth = rawUrl.replace(
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s?#@]+)@/,
    (full, scheme: string, userInfo: string) =>
      userInfo === REDACTED_CENSOR ? full : `${scheme}${REDACTED_CENSOR}@`,
  );
  const parts = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)(\/[^?#]*)?([?#].*)?$/.exec(withAuth);
  const rebuilt =
    parts !== null
      ? `${parts[1] ?? ""}${parts[2] !== undefined ? sanitizePathname(parts[2]) : ""}${parts[3] ?? ""}`
      : withAuth;
  return rebuilt.replace(
    /([?&;#])([^=&#;\s]+)=([^&#;\s]*)/g,
    (full, sep: string, rawKey: string, rawVal: string) => {
      if (rawVal === REDACTED_CENSOR) {
        return full;
      }
      let decodedKey = rawKey;
      try {
        decodedKey = decodeURIComponent(rawKey);
      } catch {
        /* ignore malformed encoding */
      }
      if (isSensitiveQueryKey(decodedKey) && !isPublicChainIdentifier(rawVal)) {
        return `${sep}${rawKey}=${REDACTED_CENSOR}`;
      }
      return full;
    },
  );
}

export function redactUrlSecrets(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return fallbackRedactMalformedUrl(rawUrl);
  }

  const hadUserInfo = parsed.username !== "" || parsed.password !== "";
  const safePath = sanitizePathname(parsed.pathname);
  const safeSearch = parsed.search !== "" ? sanitizeQueryString(parsed.search) : "";
  const safeHash = parsed.hash !== "" ? sanitizeHashFragment(parsed.hash) : "";

  parsed.username = "";
  parsed.password = "";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";

  const originWithSlash = parsed.toString();
  const baseOrigin = originWithSlash.endsWith("/") ? originWithSlash.slice(0, -1) : originWithSlash;
  const withAuth = hadUserInfo ? baseOrigin.replace("://", `://${REDACTED_CENSOR}@`) : baseOrigin;

  return `${withAuth}${safePath}${safeSearch}${safeHash}`;
}

function redactInlineNonUrlSecrets(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY_PATTERN, REDACTED_CENSOR)
    .replace(STELLAR_SECRET_SEED_PATTERN, REDACTED_CENSOR)
    .replace(JWT_TOKEN_PATTERN, REDACTED_CENSOR)
    .replace(INLINE_MNEMONIC_PATTERN, `$1$2${REDACTED_CENSOR}`)
    .replace(INLINE_SECRET_ASSIGNMENT_PATTERN, (full, k: string, sep: string, rawVal: string) => {
      if (rawVal === REDACTED_CENSOR) {
        return full;
      }
      const unquoted = rawVal.replace(/^['"]|['"]$/g, "");
      if (/^key$/i.test(k) && isPublicChainIdentifier(unquoted)) {
        return full;
      }
      return `${k}${sep}${REDACTED_CENSOR}`;
    })
    .replace(AUTH_SCHEME_IN_TEXT_PATTERN, (full, scheme: string, token: string) =>
      isPublicChainIdentifier(token) ? full : `${scheme} ${REDACTED_CENSOR}`,
    );
}

export function redactSensitiveText(text: string): string {
  if (text === "") return text;
  const withScrubbedUrls = text.replace(URL_IN_TEXT_PATTERN, (matched) => {
    const { core, suffix } = splitTrailingPunctuation(matched);
    return `${redactUrlSecrets(core)}${suffix}`;
  });
  return redactInlineNonUrlSecrets(withScrubbedUrls);
}

function serializeErrorForRedaction(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  const base = stdSerializers.err(error) as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const key of Object.keys(base)) {
    if (isSensitiveFieldName(key)) {
      output[key] = REDACTED_CENSOR;
    } else {
      output[key] = sanitizeLogValue(base[key], key, seen);
    }
  }

  if (error.cause !== undefined && output.cause === undefined) {
    output.cause = sanitizeLogValue(error.cause, "cause", seen);
  }

  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    output.errors = error.errors.map((entry: unknown) => sanitizeLogValue(entry, "errors", seen));
  }

  return output;
}

export function sanitizeLogValue(
  value: unknown,
  fieldName?: string,
  seen = new WeakSet<object>(),
): unknown {
  if (fieldName !== undefined && isSensitiveFieldName(fieldName)) {
    return REDACTED_CENSOR;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  try {
    if (value instanceof Error) {
      return serializeErrorForRedaction(value, seen);
    }

    if (Array.isArray(value)) {
      return value.map((item: unknown) => sanitizeLogValue(item, undefined, seen));
    }

    if (value instanceof Uint8Array) {
      return value;
    }

    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (isSensitiveFieldName(key)) {
        out[key] = REDACTED_CENSOR;
      } else {
        out[key] = sanitizeLogValue(record[key], key, seen);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
