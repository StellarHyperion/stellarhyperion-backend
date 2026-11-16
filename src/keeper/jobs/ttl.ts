import { isStellarDeployment, ROUTE_KINDS, ROUTE_SLUGS } from "@hyperion/protocol";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { bigintOf } from "../../db/rows.js";
import {
  discoverAdapterTargets,
  planAndExecuteAdapterMaintenance,
  resolveResourceBounds,
  validateMeasuredResources,
  verifyRouterMaintenanceMethod,
} from "../adapters.js";
import { submitStellar } from "../stellar.js";
import type {
  KeeperContext,
  MeasuredSorobanResources,
  TtlBumpPayload,
  TtlBumpResult,
} from "../types.js";

export async function processTtlBump(
  ctx: KeeperContext,
  payload: TtlBumpPayload = {},
): Promise<TtlBumpResult> {
  const chain = ctx.config.indexer.stellar;
  if (!chain)
    return {
      bumpedTokens: 0,
      bumpedClaims: 0,
      bumpedTransfers: 0,
      dryRun: true,
      detail: "No Stellar deployment configured.",
      routerCoverage: {
        contractId: null,
        tokens: [],
        routes: [],
        bumpedTokens: 0,
        bumpedClaims: 0,
        bumpedTransfers: 0,
        footprintKeys: null,
        measuredResources: null,
        txHash: null,
      },
      adapterCoverage: {
        configuredCount: 0,
        maintainedCount: 0,
        uncoveredCount: 0,
        maintainedAdapters: [],
        uncoveredAdapters: [],
        plannedAdapters: [],
      },
    };
  const deployment = ctx.config.deployments.networks[chain.chain];
  const tokens =
    deployment && isStellarDeployment(deployment)
      ? Object.values(deployment.tokens).map((token) => token.sacId)
      : [];
  const routeSlugs = ROUTE_KINDS.map((route) => ROUTE_SLUGS[route]);
  const claimRows = await ctx.db.query(
    "SELECT claim_id FROM pending_claim WHERE chain = $1 AND NOT settled ORDER BY claim_id DESC LIMIT $2",
    [chain.chain, payload.maxClaims ?? 50],
  );
  const transferRows = await ctx.db.query(
    "SELECT nonce FROM outbound_transfer WHERE origin_chain = $1 ORDER BY id DESC LIMIT $2",
    [chain.chain, payload.maxTransfers ?? 50],
  );
  const claims = claimRows.rows.map((row) => bigintOf(row, "claim_id"));
  const transfers = transferRows.rows.map((row) => bigintOf(row, "nonce"));
  const bounds = resolveResourceBounds(payload.resourceBounds);
  const vector = (values: xdr.ScVal[]) => xdr.ScVal.scvVec(values);
  const buildRouterArgs = () => [
    vector(tokens.map((token) => new Address(token).toScVal())),
    vector(ROUTE_KINDS.map((route) => nativeToScVal(route, { type: "u32" }))),
    vector(claims.map((id) => nativeToScVal(id, { type: "u64" }))),
    vector(transfers.map((id) => nativeToScVal(id, { type: "u64" }))),
  ];

  let routerMeasured: MeasuredSorobanResources | null = null;
  if (ctx.maintenanceInspector) {
    const routerMethods = await ctx.maintenanceInspector.getContractMethods(chain.routerContractId);
    if (!verifyRouterMaintenanceMethod(routerMethods)) {
      throw new Error(
        `Router contract ${chain.routerContractId} does not expose a compatible keep_alive entrypoint.`,
      );
    }
    routerMeasured = await ctx.maintenanceInspector.measureCall(
      chain.routerContractId,
      "keep_alive",
      buildRouterArgs,
    );
    const routerValidation = validateMeasuredResources(routerMeasured, bounds);
    if (!routerValidation.ok) {
      throw new Error(`Router keep_alive rejected: ${routerValidation.detail}`);
    }
  }

  const adapterTargets = discoverAdapterTargets(ctx.config);
  const dryRun = ctx.config.keeper.stellarSecret === null;
  if (dryRun) {
    const adapterCoverage = await planAndExecuteAdapterMaintenance({
      targets: adapterTargets,
      inspector: ctx.maintenanceInspector,
      bounds,
      dryRun: true,
      includeAdapters: payload.includeAdapters ?? true,
      logger: ctx.logger,
      submitAdapterCall: () => Promise.reject(new Error("Dry run never submits adapter upkeep.")),
    });
    return {
      bumpedTokens: 0,
      bumpedClaims: 0,
      bumpedTransfers: 0,
      dryRun: true,
      detail: `No signer: ${tokens.length} tokens, ${claims.length} claims, ${transfers.length} transfers need maintenance; adapters planned=${adapterCoverage.plannedAdapters.length}, uncovered=${adapterCoverage.uncoveredCount}.`,
      routerCoverage: {
        contractId: chain.routerContractId,
        tokens,
        routes: routeSlugs,
        bumpedTokens: 0,
        bumpedClaims: 0,
        bumpedTransfers: 0,
        footprintKeys: routerMeasured?.footprintKeys ?? null,
        measuredResources: routerMeasured,
        txHash: null,
      },
      adapterCoverage,
    };
  }

  const hash = await submitStellar(
    ctx.config,
    chain.routerContractId,
    "keep_alive",
    buildRouterArgs,
    {
      resourceBounds: payload.resourceBounds,
      requireCallableMethod: true,
    },
  );
  ctx.logger.info({ hash }, "router keep_alive confirmed");

  const adapterCoverage = await planAndExecuteAdapterMaintenance({
    targets: adapterTargets,
    inspector: ctx.maintenanceInspector,
    bounds,
    dryRun: false,
    includeAdapters: payload.includeAdapters ?? true,
    logger: ctx.logger,
    submitAdapterCall: (contractId, method, args) =>
      submitStellar(ctx.config, contractId, method, args, {
        resourceBounds: payload.resourceBounds,
        requireCallableMethod: true,
      }),
  });

  return {
    bumpedTokens: tokens.length,
    bumpedClaims: claims.length,
    bumpedTransfers: transfers.length,
    dryRun: false,
    detail: `Confirmed router maintenance: ${hash}; adapters maintained=${adapterCoverage.maintainedCount}, uncovered=${adapterCoverage.uncoveredCount}`,
    routerCoverage: {
      contractId: chain.routerContractId,
      tokens,
      routes: routeSlugs,
      bumpedTokens: tokens.length,
      bumpedClaims: claims.length,
      bumpedTransfers: transfers.length,
      footprintKeys: routerMeasured?.footprintKeys ?? null,
      measuredResources: routerMeasured,
      txHash: hash,
    },
    adapterCoverage,
  };
}
