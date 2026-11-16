/**
 * Sanitized public projection of cross-chain transfer proof provenance.
 *
 * Separates confirmed canonical on-chain event/receipt proofs from unverified candidate references
 * supplied by origin router hints or third-party rail APIs, while scrubbing any provider API keys,
 * URL credentials, bearer headers, or signing material before serialization.
 */

export interface ConfirmedSourceProof {
  readonly verification: "confirmed_on_chain";
  readonly verified: true;
  readonly role: "source_event";
  readonly chain: string;
  readonly txHash: string;
  readonly block: string;
  readonly logIndex: number | null;
  readonly observedAt: string;
}

export interface ConfirmedDestinationProof {
  readonly verification: "confirmed_on_chain";
  readonly verified: true;
  readonly role: "destination_delivery" | "parked_claim";
  readonly chain: string;
  readonly txHash: string;
  readonly block: string;
  readonly logIndex: number | null;
  readonly railMessageId: string | null;
  readonly claimId: string | null;
  readonly observedAt: string | null;
}

export interface ConfirmedClaimSettlementProof {
  readonly verification: "confirmed_on_chain";
  readonly verified: true;
  readonly role: "claim_settlement";
  readonly chain: string;
  readonly claimId: string;
  readonly txHash: string;
  readonly settledBy: string | null;
  readonly settledAt: string | null;
}

export interface UnverifiedCandidateReference {
  readonly verification: "unverified_candidate";
  readonly verified: false;
  readonly source: "origin_rail_ref" | "rail_provider";
  readonly reference: string;
  readonly providerStatus: string | null;
  readonly attestedAt: string | null;
  readonly note: string;
}

export interface TransferProofProvenance {
  readonly source: ConfirmedSourceProof;
  readonly destination: ConfirmedDestinationProof | null;
  readonly settlement: ConfirmedClaimSettlementProof | null;
  readonly candidates: readonly UnverifiedCandidateReference[];
}

const CANDIDATE_NOTE =
  "Unverified candidate reference only; destination delivery requires a confirmed canonical receipt.";

const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE|SECRET) KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*(?:PRIVATE|SECRET) KEY-----|$)/gi;
const STELLAR_SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const CIRCLE_KEY_PATTERN = /\b(?:TEST|LIVE|SAND(?:BOX)?)_API_KEY:[A-Za-z0-9:_-]+/gi;
const STRIPE_STYLE_SECRET_PATTERN = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g;
const JWT_TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const LABELED_SIGNING_MATERIAL_PATTERN =
  /\b(private[_-]?key|signing[_-]?key|signer[_-]?secret|secret[_-]?key|keeper[_-]?stellar[_-]?secret|mnemonic|seed)\s*(?:=|:|\s)\s*(?:"[^"]+"|'[^']+'|[^\s,&;]+)/gi;
const LABELED_CREDENTIAL_PATTERN =
  /\b(api[_-]?key|x-api-key|circle-api-key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|secret|token|authorization)\s*(?:=|:)\s*(?:"[^"]+"|'[^']+'|[^\s,&;]+)/gi;
const NON_HTTP_CONNECTION_URI_PATTERN =
  /\b(?:postgres(?:ql)?|redis(?:s)?|mongodb(?:\+srv)?|amqp(?:s)?):\/\/[^\s"'`]+/gi;
const URL_CANDIDATE_PATTERN = /\bhttps?:\/\/[^\s"'`<>]+/gi;

const SENSITIVE_QUERY_KEYS = new Set([
  "key",
  "apikey",
  "api_key",
  "api-key",
  "token",
  "access_token",
  "auth",
  "auth_token",
  "authorization",
  "secret",
  "client_secret",
  "private_key",
  "signing_key",
  "seed",
  "signature",
  "sig",
  "password",
  "pwd",
]);

const RPC_PROVIDER_PATH_SEGMENT_PATTERN =
  /^(\/(?:v1|v2|v3|rpc|api|eth|stellar))(?:\/[A-Za-z0-9_-]{16,})(\/.*)?$/i;

function sanitizeEmbeddedUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username !== "" || parsed.password !== "") {
      parsed.username = "";
      parsed.password = "";
    }

    for (const key of [...parsed.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase();
      if (
        SENSITIVE_QUERY_KEYS.has(normalizedKey) ||
        normalizedKey.includes("secret") ||
        normalizedKey.includes("token") ||
        normalizedKey.includes("apikey") ||
        normalizedKey.includes("api_key") ||
        normalizedKey.includes("private")
      ) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }

    if (parsed.hash.length > 1) {
      parsed.hash = "";
    }

    const rpcPathMatch = RPC_PROVIDER_PATH_SEGMENT_PATTERN.exec(parsed.pathname);
    if (rpcPathMatch !== null) {
      const prefix = rpcPathMatch[1] ?? "";
      const suffix = rpcPathMatch[2] ?? "";
      parsed.pathname = `${prefix}/[redacted-key]${suffix}`;
    }

    return parsed.toString();
  } catch {
    return "[redacted-url]";
  }
}

/**
 * Scrubs raw provider credentials, URL secrets, auth headers, and cryptographic signing material
 * while preserving full-width public identifiers (such as 32-byte hex hashes, Stellar G/C/M
 * strkeys, and provider support IDs).
 */
export function sanitizeProvenanceText(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }

  const trimmed = raw.replace(/[\r\n\t]+/g, " ").trim();
  if (trimmed.length === 0) {
    return null;
  }

  const sanitized = trimmed
    .replace(PEM_PRIVATE_KEY_PATTERN, "[redacted-private-key]")
    .replace(NON_HTTP_CONNECTION_URI_PATTERN, "[redacted-uri]")
    .replace(URL_CANDIDATE_PATTERN, (url) => sanitizeEmbeddedUrl(url))
    .replace(CIRCLE_KEY_PATTERN, "[redacted-api-key]")
    .replace(STRIPE_STYLE_SECRET_PATTERN, "[redacted-api-key]")
    .replace(JWT_TOKEN_PATTERN, "[redacted-token]")
    .replace(STELLAR_SECRET_SEED_PATTERN, "[redacted-signing-seed]")
    .replace(AUTH_SCHEME_PATTERN, "$1 [redacted]")
    .replace(LABELED_SIGNING_MATERIAL_PATTERN, "$1=[redacted-signing-material]")
    .replace(LABELED_CREDENTIAL_PATTERN, "$1=[redacted-credential]");

  return sanitized.length > 512 ? `${sanitized.slice(0, 509)}...` : sanitized;
}

export interface BuildTransferProvenanceInput {
  readonly originChain: string;
  readonly originTxHash: string;
  readonly originBlock: string;
  readonly originLogIndex: number | null;
  readonly originObservedAt: string;
  readonly originRailRef: string | null;

  readonly destinationChain: string;
  readonly inboundDelivered: boolean;
  readonly destinationTxHash: string | null;
  readonly destinationBlock: string | null;
  readonly destinationLogIndex: number | null;
  readonly railMessageId: string | null;
  readonly inboundClaimId: string | null;
  readonly deliveredAt: string | null;

  readonly claimId: string | null;
  readonly claimSettled: boolean;
  readonly claimSettledTx: string | null;
  readonly claimSettledBy: string | null;
  readonly claimSettledAt: string | null;

  readonly railProviderReference: string | null;
  readonly railProviderStatus: string | null;
  readonly railAttestedAt: string | null;
}

export function buildTransferProvenance(
  input: BuildTransferProvenanceInput,
): TransferProofProvenance {
  const source: ConfirmedSourceProof = {
    verification: "confirmed_on_chain",
    verified: true,
    role: "source_event",
    chain: input.originChain,
    txHash: sanitizeProvenanceText(input.originTxHash) ?? input.originTxHash,
    block: input.originBlock,
    logIndex: input.originLogIndex,
    observedAt: input.originObservedAt,
  };

  // Destination proof is populated ONLY when canonical on-chain receipt block + transaction exist.
  // Provider status or candidate hashes alone never produce a confirmed destination proof.
  const destination: ConfirmedDestinationProof | null =
    input.destinationTxHash !== null && input.destinationBlock !== null
      ? {
          verification: "confirmed_on_chain",
          verified: true,
          role: input.inboundDelivered ? "destination_delivery" : "parked_claim",
          chain: input.destinationChain,
          txHash: sanitizeProvenanceText(input.destinationTxHash) ?? input.destinationTxHash,
          block: input.destinationBlock,
          logIndex: input.destinationLogIndex,
          railMessageId: sanitizeProvenanceText(input.railMessageId),
          claimId: input.inboundClaimId ?? input.claimId,
          observedAt: input.deliveredAt,
        }
      : null;

  const settlement: ConfirmedClaimSettlementProof | null =
    input.claimId !== null && input.claimSettled && input.claimSettledTx !== null
      ? {
          verification: "confirmed_on_chain",
          verified: true,
          role: "claim_settlement",
          chain: input.destinationChain,
          claimId: input.claimId,
          txHash: sanitizeProvenanceText(input.claimSettledTx) ?? input.claimSettledTx,
          settledBy: sanitizeProvenanceText(input.claimSettledBy),
          settledAt: input.claimSettledAt,
        }
      : null;

  const candidates: UnverifiedCandidateReference[] = [];

  const sanitizedOriginRef = sanitizeProvenanceText(input.originRailRef);
  if (sanitizedOriginRef !== null) {
    candidates.push({
      verification: "unverified_candidate",
      verified: false,
      source: "origin_rail_ref",
      reference: sanitizedOriginRef,
      providerStatus: null,
      attestedAt: null,
      note: CANDIDATE_NOTE,
    });
  }

  const sanitizedProviderRef = sanitizeProvenanceText(input.railProviderReference);
  if (sanitizedProviderRef !== null) {
    candidates.push({
      verification: "unverified_candidate",
      verified: false,
      source: "rail_provider",
      reference: sanitizedProviderRef,
      providerStatus: sanitizeProvenanceText(input.railProviderStatus),
      attestedAt: input.railAttestedAt,
      note: CANDIDATE_NOTE,
    });
  }

  return {
    source,
    destination,
    settlement,
    candidates,
  };
}
