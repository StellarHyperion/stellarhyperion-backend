import {
  CHAINS,
  MAX_DECIMALS,
  RAIL_CONTRACTS,
  ROUTE_SLUGS,
  RouteKind,
  assetOn,
  convertDecimals,
  isChainKey,
  isEvmAsset,
  isEvmChain,
  isEvmDeployment,
  isRouteKind,
  isStellarAddress,
  isStellarAsset,
  isStellarChain,
  isStellarDeployment,
  parseStellarAddress,
  toEvmAddress,
  type Chain,
  type ChainKey,
  type DeploymentSet,
  type EvmAsset,
  type EvmDeployment,
  type Hex,
  type StellarAsset,
  type StellarDeployment,
} from "@hyperion/protocol";

import type { Queryable } from "../db/pool.js";
import { bigintOf, boolean, integer, maybeOne, text, textOrNull } from "../db/rows.js";
import type {
  AttestationStatus,
  CandidateLane,
  EvidenceEnvironment,
  LaneAcceptanceEvidence,
  LaneAcceptanceReport,
  LaneDestinationEvidence,
  LanePrerequisite,
  LaneProviderEvidence,
  LaneSourceEvidence,
} from "./types.js";

const MAX_U64 = (1n << 64n) - 1n;
const MAX_NUMERIC_78 = 10n ** 78n - 1n;

export interface EvaluateLaneAcceptanceInput {
  readonly lane: CandidateLane;
  readonly deployments: DeploymentSet;
  readonly evidence?: LaneAcceptanceEvidence | null;
}

export interface IndexedLaneVerificationContext {
  readonly environment: EvidenceEnvironment;
  readonly confirmations: number;
  readonly canonicalBlockVerified: boolean;
  readonly paymentEventVerified: boolean;
  readonly protocolFeeAmount?: string;
}

export function candidateLaneKey(lane: CandidateLane): string {
  const routeSlug = isRouteKind(lane.route)
    ? ROUTE_SLUGS[lane.route]
    : `route-${String(lane.route)}`;
  return `${lane.network}:${lane.originChain}->${lane.destinationChain}:${routeSlug}:${lane.symbol}`;
}

/**
 * Evaluate whether a candidate lane has complete deployment prerequisites and live end-to-end
 * evidence across source indexing, provider discovery and confirmed destination payment.
 *
 * Read-only by construction: evaluating a report never modifies configuration, deployment sets,
 * route health or active workers. Even an accepted report remains `pending_manual_activation`
 * until the owning contract and deployment changes are reviewed and enabled explicitly.
 */
export function evaluateLaneAcceptance(input: EvaluateLaneAcceptanceInput): LaneAcceptanceReport {
  const { lane, deployments, evidence = null } = input;
  const prerequisites: LanePrerequisite[] = [];

  const networkCheck = checkNetworkIdentity(lane);
  prerequisites.push({
    id: "network-identity",
    requiredForActivation: true,
    satisfied: networkCheck.ok,
    summary: "Origin, destination and route belong to one supported live network mode",
    detail: networkCheck.detail,
  });

  const deploymentCheck = networkCheck.ok
    ? checkDeploymentSupport(
        networkCheck.originKey,
        networkCheck.destinationKey,
        networkCheck.route,
        deployments,
      )
    : {
        ok: false as const,
        detail: "Skipped until network and route identity are valid",
      };
  prerequisites.push({
    id: "validated-deployment-metadata",
    requiredForActivation: true,
    satisfied: deploymentCheck.ok,
    summary: "Validated deployment metadata wires the source router and required rail contracts",
    detail: deploymentCheck.detail,
  });

  const tokenCheck =
    networkCheck.ok && deploymentCheck.ok
      ? checkTokenAndPrecision(
          networkCheck.originKey,
          networkCheck.destinationKey,
          networkCheck.route,
          lane.symbol,
          deploymentCheck.originDeployment,
          deploymentCheck.destinationDeployment,
        )
      : {
          ok: false as const,
          detail: "Skipped until network identity and deployment metadata are valid",
        };
  prerequisites.push({
    id: "token-representation-and-precision",
    requiredForActivation: true,
    satisfied: tokenCheck.ok,
    summary: "Token representation, issuer or contract address, and decimal precision agree",
    detail: tokenCheck.detail,
  });

  const provenanceCheck = checkEvidenceProvenance(evidence);
  prerequisites.push({
    id: "live-evidence-provenance",
    requiredForActivation: true,
    satisfied: provenanceCheck.ok,
    summary: "Acceptance evidence comes from live chain and provider execution, never mocks",
    detail: provenanceCheck.detail,
  });

  const sourceCheck =
    networkCheck.ok && deploymentCheck.ok && tokenCheck.ok && provenanceCheck.ok
      ? checkSourceEvidence(
          provenanceCheck.evidence.source,
          networkCheck.originChain,
          networkCheck.destinationChain,
          networkCheck.route,
          deploymentCheck.originDeployment,
          tokenCheck.originTokenId,
          tokenCheck.sourceDecimals,
          tokenCheck.destinationDecimals,
        )
      : {
          ok: false as const,
          detail:
            evidence?.source === null || evidence === null
              ? "No indexed source transfer evidence supplied"
              : "Source transfer check blocked by unmet lane or provenance prerequisites",
        };
  prerequisites.push({
    id: "source-indexing-verified",
    requiredForActivation: true,
    satisfied: sourceCheck.ok,
    summary: "Source router departure is indexed with full-width identifiers and integer amounts",
    detail: sourceCheck.detail,
  });

  const providerCheck =
    networkCheck.ok && provenanceCheck.ok && sourceCheck.ok
      ? checkProviderEvidence(provenanceCheck.evidence.provider, networkCheck.route)
      : {
          ok: false as const,
          detail:
            evidence?.provider === null || evidence === null
              ? "No rail provider discovery evidence supplied"
              : "Provider discovery check blocked by unmet source or provenance prerequisites",
        };
  prerequisites.push({
    id: "provider-discovery-verified",
    requiredForActivation: true,
    satisfied: providerCheck.ok,
    summary: "Rail provider discovered and attested the source departure without claiming delivery",
    detail: providerCheck.detail,
  });

  const destinationCheck =
    networkCheck.ok && tokenCheck.ok && provenanceCheck.ok && sourceCheck.ok && providerCheck.ok
      ? checkDestinationEvidence(
          provenanceCheck.evidence.destination,
          sourceCheck.parsed,
          providerCheck.provider,
          networkCheck.originChain,
          networkCheck.destinationChain,
          networkCheck.route,
          tokenCheck.destinationTokenId,
        )
      : {
          ok: false as const,
          detail:
            evidence?.destination === null || evidence === null
              ? "No independently confirmed destination payment evidence supplied"
              : "Destination payment check blocked by earlier unmet prerequisites",
        };
  prerequisites.push({
    id: "independent-destination-payment",
    requiredForActivation: true,
    satisfied: destinationCheck.ok,
    summary: "Destination receipt, canonical block hash and token payment are confirmed on chain",
    detail: destinationCheck.detail,
  });

  const accepted = prerequisites.every((item) => item.satisfied);
  const reasons = prerequisites.filter((item) => !item.satisfied).map((item) => item.detail);

  return {
    laneKey: candidateLaneKey(lane),
    lane,
    accepted,
    autoActivated: false,
    activationState: accepted ? "pending_manual_activation" : "blocked",
    prerequisites,
    reasons,
  };
}

/**
 * Evaluate a stored transfer directly from indexed PostgreSQL tables combined with explicit
 * chain-verification flags, preserving NUMERIC(78,0) and NUMERIC(20,0) integer strings.
 */
export async function evaluateIndexedLaneAcceptance(
  db: Queryable,
  input: {
    readonly lane: CandidateLane;
    readonly deployments: DeploymentSet;
    readonly transferId: bigint;
    readonly verification: IndexedLaneVerificationContext;
  },
): Promise<LaneAcceptanceReport> {
  const { rows: outboundRows } = await db.query(
    `SELECT origin_chain, destination_chain, route, nonce, sender, token,
            gross_amount, fee, net_amount, destination, origin_block, origin_tx
       FROM outbound_transfer
      WHERE id = $1`,
    [input.transferId.toString()],
  );
  const outbound = maybeOne(outboundRows, `outbound_transfer ${input.transferId.toString()}`);

  let source: LaneSourceEvidence | null = null;
  let provider: LaneProviderEvidence | null = null;
  let destination: LaneDestinationEvidence | null = null;

  if (outbound !== null) {
    const originChain = text(outbound, "origin_chain");
    const destinationChain = text(outbound, "destination_chain");
    const route = integer(outbound, "route");
    const nonce = bigintOf(outbound, "nonce");

    source = {
      originChain,
      destinationChain,
      route,
      nonce: nonce.toString(),
      sender: text(outbound, "sender"),
      token: text(outbound, "token"),
      grossAmount: bigintOf(outbound, "gross_amount").toString(),
      fee: bigintOf(outbound, "fee").toString(),
      netAmount: bigintOf(outbound, "net_amount").toString(),
      destination: text(outbound, "destination"),
      originBlock: bigintOf(outbound, "origin_block").toString(),
      originTx: text(outbound, "origin_tx"),
    };

    const { rows: attestationRows } = await db.query(
      `SELECT route, status, rail_status, rail_reference
         FROM rail_attestation
        WHERE transfer_id = $1`,
      [input.transferId.toString()],
    );
    const attestation = maybeOne(
      attestationRows,
      `rail_attestation ${input.transferId.toString()}`,
    );
    if (attestation !== null) {
      const attRoute = integer(attestation, "route");
      const rawStatus = text(attestation, "status") as AttestationStatus;
      provider = {
        rail: isRouteKind(attRoute) ? ROUTE_SLUGS[attRoute] : `route-${String(attRoute)}`,
        status: rawStatus === "delivered" ? "attested" : rawStatus,
        railStatus: textOrNull(attestation, "rail_status") ?? "",
        reference: textOrNull(attestation, "rail_reference"),
      };
    }

    const { rows: inboundRows } = await db.query(
      `SELECT destination_chain, route, source_chain, source_nonce, rail_message_id,
              recipient, token, amount, delivered, claim_id, destination_block, destination_tx
         FROM inbound_delivery
        WHERE destination_chain = $1
          AND route = $2
          AND source_chain = $3
          AND source_nonce = $4`,
      [destinationChain, route, originChain, nonce.toString()],
    );
    const inbound = maybeOne(inboundRows, `inbound_delivery for ${input.transferId.toString()}`);
    if (inbound !== null) {
      const claimVal = inbound.claim_id;
      destination = {
        destinationChain: text(inbound, "destination_chain"),
        sourceChain: text(inbound, "source_chain"),
        route: integer(inbound, "route"),
        sourceNonce: bigintOf(inbound, "source_nonce").toString(),
        railMessageId: textOrNull(inbound, "rail_message_id"),
        recipient: text(inbound, "recipient"),
        token: text(inbound, "token"),
        amount: bigintOf(inbound, "amount").toString(),
        ...(input.verification.protocolFeeAmount !== undefined
          ? { protocolFeeAmount: input.verification.protocolFeeAmount }
          : {}),
        delivered: boolean(inbound, "delivered"),
        claimId:
          claimVal === null || claimVal === undefined
            ? null
            : bigintOf(inbound, "claim_id").toString(),
        destinationBlock: bigintOf(inbound, "destination_block").toString(),
        destinationTx: text(inbound, "destination_tx"),
        confirmations: input.verification.confirmations,
        canonicalBlockVerified: input.verification.canonicalBlockVerified,
        paymentEventVerified: input.verification.paymentEventVerified,
      };
    }
  }

  return evaluateLaneAcceptance({
    lane: input.lane,
    deployments: input.deployments,
    evidence: {
      environment: input.verification.environment,
      source,
      provider,
      destination,
    },
  });
}

function checkNetworkIdentity(lane: CandidateLane):
  | {
      readonly ok: true;
      readonly originKey: ChainKey;
      readonly destinationKey: ChainKey;
      readonly originChain: Chain;
      readonly destinationChain: Chain;
      readonly route: RouteKind;
      readonly detail: string;
    }
  | { readonly ok: false; readonly detail: string } {
  if (!isRouteKind(lane.route)) {
    return { ok: false, detail: `Route ${String(lane.route)} is not a supported RouteKind` };
  }
  if (!isChainKey(lane.originChain)) {
    return { ok: false, detail: `Origin chain ${lane.originChain} is not in the chain registry` };
  }
  if (!isChainKey(lane.destinationChain)) {
    return {
      ok: false,
      detail: `Destination chain ${lane.destinationChain} is not in the chain registry`,
    };
  }
  if (lane.originChain === "local" || lane.destinationChain === "local") {
    return {
      ok: false,
      detail: "Local rehearsal nodes cannot satisfy live network lane acceptance",
    };
  }
  if (lane.originChain === lane.destinationChain) {
    return {
      ok: false,
      detail: `Origin and destination chains must differ (${lane.originChain})`,
    };
  }
  const originChain = CHAINS[lane.originChain];
  const destinationChain = CHAINS[lane.destinationChain];
  if (originChain.network !== lane.network) {
    return {
      ok: false,
      detail: `Origin chain ${lane.originChain} belongs to ${originChain.network}, expected ${lane.network}`,
    };
  }
  if (destinationChain.network !== lane.network) {
    return {
      ok: false,
      detail: `Destination chain ${lane.destinationChain} belongs to ${destinationChain.network}, expected ${lane.network}`,
    };
  }
  if (originChain.family === destinationChain.family) {
    return {
      ok: false,
      detail: `Hyperion lanes bridge between Stellar and EVM, found ${originChain.family} to ${destinationChain.family}`,
    };
  }
  return {
    ok: true,
    originKey: lane.originChain,
    destinationKey: lane.destinationChain,
    originChain,
    destinationChain,
    route: lane.route,
    detail: `Verified ${lane.network} hop ${lane.originChain} (${originChain.family}) to ${lane.destinationChain} (${destinationChain.family}) over ${ROUTE_SLUGS[lane.route]}`,
  };
}

function checkDeploymentSupport(
  originKey: ChainKey,
  destinationKey: ChainKey,
  route: RouteKind,
  deployments: DeploymentSet,
):
  | {
      readonly ok: true;
      readonly originDeployment: EvmDeployment | StellarDeployment;
      readonly destinationDeployment: EvmDeployment | StellarDeployment | null;
      readonly detail: string;
    }
  | { readonly ok: false; readonly detail: string } {
  const originChain = CHAINS[originKey];
  const destinationChain = CHAINS[destinationKey];
  const originDeployment = deployments.networks[originKey];
  if (originDeployment === undefined) {
    return {
      ok: false,
      detail: `Deployment set has no active Hyperion router for origin chain ${originKey}`,
    };
  }

  if (isStellarChain(originChain)) {
    if (!isStellarDeployment(originDeployment)) {
      return {
        ok: false,
        detail: `Origin deployment for ${originKey} has family ${originDeployment.family}, expected stellar`,
      };
    }
    if (originDeployment.networkPassphrase !== originChain.networkPassphrase) {
      return {
        ok: false,
        detail: `Origin deployment passphrase for ${originKey} mismatches the chain registry`,
      };
    }
  } else if (isEvmChain(originChain)) {
    if (!isEvmDeployment(originDeployment)) {
      return {
        ok: false,
        detail: `Origin deployment for ${originKey} has family ${originDeployment.family}, expected evm`,
      };
    }
    if (originDeployment.chainId !== originChain.chainId) {
      return {
        ok: false,
        detail: `Origin deployment chainId ${String(originDeployment.chainId)} for ${originKey} mismatches registry ${String(originChain.chainId)}`,
      };
    }
  }

  const originAdapter = originDeployment.adapters[route];
  if (originAdapter === undefined || originAdapter.length === 0) {
    return {
      ok: false,
      detail: `Origin deployment on ${originKey} has no adapter configured for ${ROUTE_SLUGS[route]}`,
    };
  }

  const destinationDeployment = deployments.networks[destinationKey] ?? null;
  if (destinationDeployment !== null) {
    if (isStellarChain(destinationChain)) {
      if (
        !isStellarDeployment(destinationDeployment) ||
        destinationDeployment.networkPassphrase !== destinationChain.networkPassphrase
      ) {
        return {
          ok: false,
          detail: `Destination deployment metadata for ${destinationKey} mismatches registry identity`,
        };
      }
    } else if (
      !isEvmDeployment(destinationDeployment) ||
      destinationDeployment.chainId !== destinationChain.chainId
    ) {
      return {
        ok: false,
        detail: `Destination deployment metadata for ${destinationKey} mismatches registry identity`,
      };
    }
  }

  if (route === RouteKind.Cctp) {
    if (
      originChain.cctpDomain === null ||
      destinationChain.cctpDomain === null ||
      originChain.cctpDomain === destinationChain.cctpDomain
    ) {
      return {
        ok: false,
        detail: `CCTP domains are not distinct and configured for ${originKey} and ${destinationKey}`,
      };
    }
    const evmKey = isEvmChain(originChain) ? originKey : destinationKey;
    const cctpContracts = RAIL_CONTRACTS[evmKey]?.cctp ?? null;
    if (cctpContracts === null) {
      return {
        ok: false,
        detail: `Chain registry has no CCTP V2 contract set for ${evmKey}`,
      };
    }
    if (isStellarChain(destinationChain)) {
      if (destinationDeployment?.adapters[RouteKind.Cctp] === undefined) {
        return {
          ok: false,
          detail: `Destination Stellar deployment on ${destinationKey} lacks inbound CCTP adapter metadata`,
        };
      }
    }
  } else if (route === RouteKind.AxelarIts) {
    if (originChain.axelarName === null || destinationChain.axelarName === null) {
      return {
        ok: false,
        detail: `Axelar chain names are required on both ${originKey} and ${destinationKey}`,
      };
    }
    const originIts = RAIL_CONTRACTS[originKey]?.axelar?.interchainTokenService ?? null;
    const destIts = RAIL_CONTRACTS[destinationKey]?.axelar?.interchainTokenService ?? null;
    if (originIts === null || destIts === null) {
      return {
        ok: false,
        detail: `InterchainTokenService registry addresses are required on ${originKey} and ${destinationKey}`,
      };
    }
    if (isStellarChain(destinationChain)) {
      if (destinationDeployment?.adapters[RouteKind.AxelarIts] === undefined) {
        return {
          ok: false,
          detail: `Destination Stellar deployment on ${destinationKey} lacks inbound Axelar ITS adapter metadata`,
        };
      }
    }
  } else if (route === RouteKind.AxelarGmp) {
    const originGateway = RAIL_CONTRACTS[originKey]?.axelar?.gateway ?? null;
    const destGateway = RAIL_CONTRACTS[destinationKey]?.axelar?.gateway ?? null;
    if (originGateway === null || destGateway === null) {
      return {
        ok: false,
        detail: `Axelar gateway contracts are required on both ${originKey} and ${destinationKey}`,
      };
    }
    if (destinationDeployment?.adapters[RouteKind.AxelarGmp] === undefined) {
      return {
        ok: false,
        detail: `Destination deployment on ${destinationKey} lacks authenticated GMP receiver adapter metadata`,
      };
    }
  } else {
    if (destinationDeployment?.adapters[RouteKind.Allbridge] === undefined) {
      return {
        ok: false,
        detail: `Destination deployment on ${destinationKey} lacks Allbridge adapter metadata`,
      };
    }
  }

  return {
    ok: true,
    originDeployment,
    destinationDeployment,
    detail: `Validated router ${originDeployment.router} and ${ROUTE_SLUGS[route]} adapter ${originAdapter} on ${originKey}`,
  };
}

function checkTokenAndPrecision(
  originKey: ChainKey,
  destinationKey: ChainKey,
  route: RouteKind,
  symbol: string,
  originDeployment: EvmDeployment | StellarDeployment,
  destinationDeployment: EvmDeployment | StellarDeployment | null,
):
  | {
      readonly ok: true;
      readonly originTokenId: string;
      readonly destinationTokenId: string;
      readonly sourceDecimals: number;
      readonly destinationDecimals: number;
      readonly detail: string;
    }
  | { readonly ok: false; readonly detail: string } {
  const sourceAsset = assetOn(originKey, symbol);
  if (sourceAsset === null) {
    return {
      ok: false,
      detail: `Asset ${symbol} is not registered for origin chain ${originKey}`,
    };
  }
  const destAsset = assetOn(destinationKey, symbol);
  if (destAsset === null) {
    return {
      ok: false,
      detail: `Asset ${symbol} is not registered for destination chain ${destinationKey}`,
    };
  }

  if (
    sourceAsset.decimals < 0 ||
    sourceAsset.decimals > MAX_DECIMALS ||
    destAsset.decimals < 0 ||
    destAsset.decimals > MAX_DECIMALS
  ) {
    return {
      ok: false,
      detail: `Asset ${symbol} decimals fall outside supported protocol precision bounds`,
    };
  }

  const deployedOriginToken = originDeployment.tokens[symbol];
  if (deployedOriginToken === undefined) {
    return {
      ok: false,
      detail: `Origin deployment on ${originKey} does not register token ${symbol}`,
    };
  }
  if (!deployedOriginToken.routes.includes(route)) {
    return {
      ok: false,
      detail: `Origin token ${symbol} on ${originKey} does not enable route ${ROUTE_SLUGS[route]}`,
    };
  }

  const originMatch = matchTokenIdentity(originDeployment, symbol, sourceAsset);
  if (!originMatch.ok) {
    return originMatch;
  }

  let destinationTokenId: string;
  if (destinationDeployment !== null) {
    const destMatch = matchTokenIdentity(destinationDeployment, symbol, destAsset);
    if (!destMatch.ok) {
      return destMatch;
    }
    destinationTokenId = destMatch.tokenId;
  } else if (isEvmAsset(destAsset)) {
    destinationTokenId = destAsset.address.toLowerCase();
  } else {
    if (destAsset.sacId === null) {
      return {
        ok: false,
        detail: `Destination Stellar asset ${symbol} on ${destinationKey} requires a deployed SAC id`,
      };
    }
    destinationTokenId = destAsset.sacId;
  }

  return {
    ok: true,
    originTokenId: originMatch.tokenId,
    destinationTokenId,
    sourceDecimals: sourceAsset.decimals,
    destinationDecimals: destAsset.decimals,
    detail: `Verified ${symbol} precision ${String(sourceAsset.decimals)} -> ${String(destAsset.decimals)} (${originMatch.tokenId} -> ${destinationTokenId})`,
  };
}

function matchTokenIdentity(
  deployment: EvmDeployment | StellarDeployment,
  symbol: string,
  asset: EvmAsset | StellarAsset,
):
  | { readonly ok: true; readonly tokenId: string }
  | { readonly ok: false; readonly detail: string } {
  if (isStellarDeployment(deployment)) {
    const token = deployment.tokens[symbol];
    if (token === undefined) {
      return {
        ok: false,
        detail: `Deployment on ${deployment.chain} does not register token ${symbol}`,
      };
    }
    if (!isStellarAsset(asset)) {
      return {
        ok: false,
        detail: `Registry asset ${symbol} on ${deployment.chain} is not a Stellar asset`,
      };
    }
    if (!token.sacId.startsWith("C") || !isStellarAddress(token.sacId)) {
      return {
        ok: false,
        detail: `Stellar token ${symbol} SAC id ${token.sacId} is not a valid contract strkey`,
      };
    }
    if (token.code !== asset.code || token.issuer !== asset.issuer) {
      return {
        ok: false,
        detail: `Stellar token ${symbol} code/issuer (${token.code}:${token.issuer}) mismatches registry (${asset.code}:${asset.issuer})`,
      };
    }
    if (asset.sacId !== null && token.sacId !== asset.sacId) {
      return {
        ok: false,
        detail: `Stellar token ${symbol} SAC id ${token.sacId} mismatches registry ${asset.sacId}`,
      };
    }
    if (token.decimals !== asset.decimals) {
      return {
        ok: false,
        detail: `Stellar token ${symbol} decimals ${String(token.decimals)} mismatches registry ${String(asset.decimals)}`,
      };
    }
    return { ok: true, tokenId: token.sacId };
  }

  const token = deployment.tokens[symbol];
  if (token === undefined) {
    return {
      ok: false,
      detail: `Deployment on ${deployment.chain} does not register token ${symbol}`,
    };
  }
  if (!isEvmAsset(asset)) {
    return {
      ok: false,
      detail: `Registry asset ${symbol} on ${deployment.chain} is not an EVM asset`,
    };
  }
  if (token.address.toLowerCase() !== asset.address.toLowerCase()) {
    return {
      ok: false,
      detail: `EVM token ${symbol} address ${token.address} mismatches registry ${asset.address}`,
    };
  }
  if (token.decimals !== asset.decimals) {
    return {
      ok: false,
      detail: `EVM token ${symbol} decimals ${String(token.decimals)} mismatches registry ${String(asset.decimals)}`,
    };
  }
  return { ok: true, tokenId: token.address.toLowerCase() };
}

function checkEvidenceProvenance(
  evidence: LaneAcceptanceEvidence | null,
):
  | { readonly ok: true; readonly evidence: LaneAcceptanceEvidence; readonly detail: string }
  | { readonly ok: false; readonly detail: string } {
  if (evidence === null) {
    return {
      ok: false,
      detail: "Candidate lane has no acceptance evidence bundle attached",
    };
  }
  if (evidence.environment !== "live") {
    return {
      ok: false,
      detail: `Evidence environment "${evidence.environment}" cannot produce an accepted lane; live network execution is required`,
    };
  }
  return {
    ok: true,
    evidence,
    detail: "Evidence bundle declares live execution provenance",
  };
}

interface ParsedSourceFacts {
  readonly nonce: bigint;
  readonly netAmount: bigint;
  readonly convertedNetAmount: bigint;
  readonly expectedRecipient: string;
  readonly originTx: string;
}

function checkSourceEvidence(
  source: LaneSourceEvidence | null,
  originChain: Chain,
  destinationChain: Chain,
  route: RouteKind,
  originDeployment: EvmDeployment | StellarDeployment,
  originTokenId: string,
  sourceDecimals: number,
  destinationDecimals: number,
):
  | { readonly ok: true; readonly parsed: ParsedSourceFacts; readonly detail: string }
  | { readonly ok: false; readonly detail: string } {
  if (source === null) {
    return { ok: false, detail: "Source indexing evidence is missing" };
  }
  if (source.originChain !== originChain.key) {
    return {
      ok: false,
      detail: `Source evidence originChain ${source.originChain} mismatches candidate ${originChain.key}`,
    };
  }
  if (source.destinationChain !== destinationChain.key) {
    return {
      ok: false,
      detail: `Source evidence destinationChain ${source.destinationChain} mismatches candidate ${destinationChain.key}`,
    };
  }
  if (source.route !== route) {
    return {
      ok: false,
      detail: `Source evidence route ${String(source.route)} mismatches candidate ${String(route)}`,
    };
  }

  const nonce = parseUnsignedInteger(source.nonce, MAX_U64);
  if (nonce === null) {
    return {
      ok: false,
      detail: `Source nonce "${source.nonce}" is not a valid u64 integer string`,
    };
  }

  const grossAmount = parseUnsignedInteger(source.grossAmount, MAX_NUMERIC_78);
  const fee = parseUnsignedInteger(source.fee, MAX_NUMERIC_78);
  const netAmount = parseUnsignedInteger(source.netAmount, MAX_NUMERIC_78);
  if (grossAmount === null || fee === null || netAmount === null || netAmount <= 0n) {
    return {
      ok: false,
      detail:
        "Source grossAmount, fee and netAmount must be valid integer strings with netAmount > 0",
    };
  }
  if (grossAmount !== fee + netAmount) {
    return {
      ok: false,
      detail: `Source amounts violate grossAmount = fee + netAmount (${grossAmount.toString()} != ${fee.toString()} + ${netAmount.toString()})`,
    };
  }

  const conversion = convertDecimals(netAmount, sourceDecimals, destinationDecimals);
  if (conversion.dust !== 0n || conversion.converted <= 0n) {
    return {
      ok: false,
      detail: `Source netAmount ${netAmount.toString()} leaves unrepresentable precision dust (${conversion.dust.toString()}) converting ${String(sourceDecimals)} -> ${String(destinationDecimals)} decimals`,
    };
  }

  const originBlock = parseUnsignedInteger(source.originBlock, MAX_U64);
  const minBlock = isStellarDeployment(originDeployment)
    ? BigInt(originDeployment.deployedAt.ledger)
    : BigInt(originDeployment.deployedAt.blockNumber);
  if (originBlock === null || originBlock < minBlock) {
    return {
      ok: false,
      detail: `Source originBlock "${source.originBlock}" precedes router deployment height ${minBlock.toString()}`,
    };
  }

  if (isStellarChain(originChain)) {
    if (!isStellarAddress(source.sender) || source.sender.length < 56) {
      return {
        ok: false,
        detail: `Source sender "${source.sender}" is not a valid full-width Stellar strkey`,
      };
    }
    if (source.token !== originTokenId) {
      return {
        ok: false,
        detail: `Source Stellar token "${source.token}" mismatches deployed SAC ${originTokenId}`,
      };
    }
    if (!/^[0-9a-fA-F]{64}$/.test(source.originTx)) {
      return {
        ok: false,
        detail: `Source Stellar tx hash "${source.originTx}" is not a 64-char hex digest`,
      };
    }
  } else {
    if (!isValidEvmAddress(source.sender)) {
      return {
        ok: false,
        detail: `Source EVM sender "${source.sender}" is not a full-width non-zero 20-byte address`,
      };
    }
    if (source.token.toLowerCase() !== originTokenId.toLowerCase()) {
      return {
        ok: false,
        detail: `Source EVM token "${source.token}" mismatches deployed token ${originTokenId}`,
      };
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(source.originTx)) {
      return {
        ok: false,
        detail: `Source EVM tx hash "${source.originTx}" is not a 0x-prefixed 32-byte digest`,
      };
    }
  }

  let expectedRecipient: string;
  if (isEvmChain(destinationChain)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(source.destination)) {
      return {
        ok: false,
        detail: `Stellar outbound destination "${source.destination}" must be a full-width 32-byte hex word`,
      };
    }
    try {
      expectedRecipient = toEvmAddress(source.destination as Hex).toLowerCase();
    } catch (error) {
      return {
        ok: false,
        detail: `Outbound destination word "${source.destination}" is not a valid EVM recipient: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    try {
      parseStellarAddress(source.destination);
      expectedRecipient = source.destination;
    } catch (error) {
      return {
        ok: false,
        detail: `Outbound destination "${source.destination}" is not a valid Stellar strkey: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    ok: true,
    parsed: {
      nonce,
      netAmount,
      convertedNetAmount: conversion.converted,
      expectedRecipient,
      originTx: source.originTx,
    },
    detail: `Indexed source transfer nonce ${nonce.toString()} at height ${originBlock.toString()}`,
  };
}

function checkProviderEvidence(
  provider: LaneProviderEvidence | null,
  route: RouteKind,
):
  | { readonly ok: true; readonly provider: LaneProviderEvidence; readonly detail: string }
  | { readonly ok: false; readonly detail: string } {
  if (provider === null) {
    return {
      ok: false,
      detail: `Provider discovery evidence is required for ${ROUTE_SLUGS[route]}`,
    };
  }
  if (provider.rail.trim().length === 0 || provider.railStatus.trim().length === 0) {
    return {
      ok: false,
      detail: "Provider discovery evidence must record the rail name and verbatim railStatus",
    };
  }
  if (provider.status === "delivered") {
    return {
      ok: false,
      detail:
        "Provider evidence must never report status=delivered; destination delivery comes only from chain events",
    };
  }
  if (provider.status !== "attested") {
    return {
      ok: false,
      detail: `Provider status is "${provider.status}", expected "attested" before acceptance`,
    };
  }
  if (provider.reference === null || provider.reference.trim().length === 0) {
    return {
      ok: false,
      detail: "Provider discovery evidence must carry a non-empty message or attestation reference",
    };
  }
  return {
    ok: true,
    provider,
    detail: `Provider ${provider.rail} reported ${provider.railStatus} with reference ${provider.reference}`,
  };
}

function checkDestinationEvidence(
  destination: LaneDestinationEvidence | null,
  source: ParsedSourceFacts,
  provider: LaneProviderEvidence,
  originChain: Chain,
  destinationChain: Chain,
  route: RouteKind,
  destinationTokenId: string,
):
  { readonly ok: true; readonly detail: string } | { readonly ok: false; readonly detail: string } {
  if (destination === null) {
    return {
      ok: false,
      detail:
        "Independent destination payment evidence is missing; source indexing and provider status cannot accept a lane",
    };
  }
  if (destination.destinationChain !== destinationChain.key) {
    return {
      ok: false,
      detail: `Destination evidence chain ${destination.destinationChain} mismatches candidate ${destinationChain.key}`,
    };
  }
  if (destination.sourceChain !== originChain.key) {
    return {
      ok: false,
      detail: `Destination evidence sourceChain ${destination.sourceChain} mismatches ${originChain.key}`,
    };
  }
  if (destination.route !== route) {
    return {
      ok: false,
      detail: `Destination evidence route ${String(destination.route)} mismatches ${String(route)}`,
    };
  }

  const sourceNonce = parseUnsignedInteger(destination.sourceNonce, MAX_U64);
  if (sourceNonce === null || sourceNonce !== source.nonce) {
    return {
      ok: false,
      detail: `Destination sourceNonce "${destination.sourceNonce}" mismatches source nonce ${source.nonce.toString()}`,
    };
  }

  if (!destination.delivered || destination.claimId !== null) {
    return {
      ok: false,
      detail:
        "Destination transfer was parked as a claim or not delivered; lane acceptance requires completed recipient payment",
    };
  }
  if (!destination.canonicalBlockVerified || !destination.paymentEventVerified) {
    return {
      ok: false,
      detail:
        "Destination evidence requires both canonical block verification and an independently matched token payment event",
    };
  }

  const destinationBlock = parseUnsignedInteger(destination.destinationBlock, MAX_U64);
  if (destinationBlock === null || destinationBlock <= 0n) {
    return {
      ok: false,
      detail: `Destination block "${destination.destinationBlock}" is not a positive integer string`,
    };
  }

  const requiredConfirmations = isEvmChain(destinationChain) ? destinationChain.confirmations : 1;
  if (
    !Number.isInteger(destination.confirmations) ||
    destination.confirmations < requiredConfirmations
  ) {
    return {
      ok: false,
      detail: `Destination confirmations ${String(destination.confirmations)} below required finality ${String(requiredConfirmations)} on ${destinationChain.key}`,
    };
  }

  if (isEvmChain(destinationChain)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(destination.destinationTx)) {
      return {
        ok: false,
        detail: `Destination EVM tx hash "${destination.destinationTx}" is not a 0x-prefixed 32-byte digest`,
      };
    }
    if (
      destination.railMessageId === null ||
      !/^0x[0-9a-fA-F]{64}$/.test(destination.railMessageId)
    ) {
      return {
        ok: false,
        detail: "Destination EVM arrival must record a full-width 32-byte railMessageId",
      };
    }
    if (
      provider.candidateTxHash !== undefined &&
      provider.candidateTxHash !== null &&
      provider.candidateTxHash.toLowerCase() !== destination.destinationTx.toLowerCase()
    ) {
      return {
        ok: false,
        detail: `Destination tx ${destination.destinationTx} disagrees with candidate execution tx ${provider.candidateTxHash}`,
      };
    }
    if (destination.recipient.toLowerCase() !== source.expectedRecipient.toLowerCase()) {
      return {
        ok: false,
        detail: `Destination recipient ${destination.recipient} mismatches source target ${source.expectedRecipient}`,
      };
    }
    if (destination.token.toLowerCase() !== destinationTokenId.toLowerCase()) {
      return {
        ok: false,
        detail: `Destination token ${destination.token} mismatches expected token ${destinationTokenId}`,
      };
    }
  } else {
    if (!/^[0-9a-fA-F]{64}$/.test(destination.destinationTx)) {
      return {
        ok: false,
        detail: `Destination Stellar tx hash "${destination.destinationTx}" is not a 64-char hex digest`,
      };
    }
    if (destination.recipient !== source.expectedRecipient) {
      return {
        ok: false,
        detail: `Destination Stellar recipient ${destination.recipient} mismatches source target ${source.expectedRecipient}`,
      };
    }
    if (destination.token !== destinationTokenId) {
      return {
        ok: false,
        detail: `Destination Stellar token ${destination.token} mismatches expected SAC ${destinationTokenId}`,
      };
    }
  }

  const normalizedOriginTx = source.originTx.toLowerCase().replace(/^0x/, "");
  const normalizedDestTx = destination.destinationTx.toLowerCase().replace(/^0x/, "");
  if (normalizedOriginTx === normalizedDestTx) {
    return {
      ok: false,
      detail: "Destination transaction hash cannot duplicate the source transaction hash",
    };
  }

  const paidAmount = parseUnsignedInteger(destination.amount, MAX_NUMERIC_78);
  if (paidAmount === null || paidAmount <= 0n) {
    return {
      ok: false,
      detail: `Destination amount "${destination.amount}" must be a positive integer string`,
    };
  }

  let protocolFee = 0n;
  if (destination.protocolFeeAmount !== undefined) {
    const parsedFee = parseUnsignedInteger(destination.protocolFeeAmount, MAX_NUMERIC_78);
    if (parsedFee === null) {
      return {
        ok: false,
        detail: `Destination protocolFeeAmount "${destination.protocolFeeAmount}" is not a valid integer string`,
      };
    }
    if (parsedFee > 0n && route !== RouteKind.Cctp && route !== RouteKind.Allbridge) {
      return {
        ok: false,
        detail: `Route ${ROUTE_SLUGS[route]} does not permit destination protocol fee deduction`,
      };
    }
    protocolFee = parsedFee;
  }

  if (protocolFee >= source.convertedNetAmount) {
    return {
      ok: false,
      detail: `Protocol fee ${protocolFee.toString()} cannot equal or exceed converted net amount ${source.convertedNetAmount.toString()}`,
    };
  }

  const expectedPayout = source.convertedNetAmount - protocolFee;
  if (paidAmount !== expectedPayout) {
    return {
      ok: false,
      detail: `Destination paid amount ${paidAmount.toString()} mismatches precision-converted payout ${expectedPayout.toString()}`,
    };
  }

  return {
    ok: true,
    detail: `Confirmed destination payment of ${paidAmount.toString()} ${destinationTokenId} to ${destination.recipient} in tx ${destination.destinationTx}`,
  };
}

function parseUnsignedInteger(value: string, max: bigint): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > max) return null;
  return parsed;
}

function isValidEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);
}
