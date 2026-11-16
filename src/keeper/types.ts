import type { ChainKey, RouteSlug } from "@hyperion/protocol";
import type { rpc, xdr } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import type { Transactional } from "../db/pool.js";

export type KeeperJobName = "ttl-bump" | "claim-settlement";

export interface MeasuredSorobanResources {
  readonly cpuInstructions: number;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly minResourceFeeStroops: string;
  readonly readOnlyKeys: number;
  readonly readWriteKeys: number;
  readonly footprintKeys: number;
}

export interface MaintenanceResourceBounds {
  readonly maxCpuInstructions: number;
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxResourceFeeStroops: bigint;
  readonly maxFootprintKeys: number;
}

export type UncoveredAdapterReason =
  | "unverified_contract_interface"
  | "contract_inspection_failed"
  | "unsupported_maintenance_entrypoint"
  | "simulation_failed"
  | "unmeasured_resources"
  | "resource_bounds_exceeded"
  | "submission_failed";

export interface RouterTtlCoverage {
  readonly contractId: string | null;
  readonly tokens: readonly string[];
  readonly routes: readonly RouteSlug[];
  readonly bumpedTokens: number;
  readonly bumpedClaims: number;
  readonly bumpedTransfers: number;
  readonly footprintKeys: number | null;
  readonly measuredResources: MeasuredSorobanResources | null;
  readonly txHash: string | null;
}

export interface MaintainedAdapterRecord {
  readonly route: RouteSlug;
  readonly contractId: string;
  readonly method: string;
  readonly tokens: readonly string[];
  readonly peers: readonly ChainKey[];
  readonly footprintKeys: number;
  readonly readOnlyKeys: number;
  readonly readWriteKeys: number;
  readonly measuredResources: MeasuredSorobanResources;
  readonly txHash: string;
}

export interface PlannedAdapterRecord {
  readonly route: RouteSlug;
  readonly contractId: string;
  readonly method: string;
  readonly tokens: readonly string[];
  readonly peers: readonly ChainKey[];
  readonly footprintKeys: number;
  readonly measuredResources: MeasuredSorobanResources;
}

export interface UncoveredAdapterRecord {
  readonly route: RouteSlug;
  readonly contractId: string;
  readonly reason: UncoveredAdapterReason;
  readonly detail: string;
}

export interface AdapterTtlCoverage {
  readonly configuredCount: number;
  readonly maintainedCount: number;
  readonly uncoveredCount: number;
  readonly maintainedAdapters: readonly MaintainedAdapterRecord[];
  readonly uncoveredAdapters: readonly UncoveredAdapterRecord[];
  readonly plannedAdapters: readonly PlannedAdapterRecord[];
}

export interface MaintenanceInspector {
  getContractMethods(contractId: string): Promise<readonly rpc.Api.ContractMethod[]>;
  measureCall(
    contractId: string,
    method: string,
    args: (sender: string) => xdr.ScVal[],
  ): Promise<MeasuredSorobanResources>;
}

export interface TtlBumpPayload {
  readonly maxClaims?: number | undefined;
  readonly maxTransfers?: number | undefined;
  readonly includeAdapters?: boolean | undefined;
  readonly resourceBounds?: Partial<MaintenanceResourceBounds> | undefined;
}

export interface ClaimSettlementPayload {
  readonly limit?: number | undefined;
  readonly resourceBounds?: Partial<MaintenanceResourceBounds> | undefined;
}

export interface TtlBumpResult {
  readonly bumpedTokens: number;
  readonly bumpedClaims: number;
  readonly bumpedTransfers: number;
  readonly dryRun: boolean;
  readonly detail: string;
  readonly routerCoverage: RouterTtlCoverage;
  readonly adapterCoverage: AdapterTtlCoverage;
}

export interface ClaimSettlementResult {
  readonly settled: number;
  readonly attempted: number;
  readonly pending: number;
  readonly dryRun: boolean;
  readonly detail: string;
}

export type KeeperJobResult =
  | { readonly kind: "ttl-bump"; readonly result: TtlBumpResult }
  | { readonly kind: "claim-settlement"; readonly result: ClaimSettlementResult };

export interface KeeperContext {
  readonly db: Transactional;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly maintenanceInspector?: MaintenanceInspector | undefined;
}
