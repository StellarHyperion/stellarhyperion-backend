import type * as Protocol from "@hyperion/protocol";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import { completeEnv, readFixture } from "../helpers.js";

const metadata = vi.hoisted(() => ({ mode: "all" }));
vi.mock("@hyperion/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof Protocol>();
  return {
    ...actual,
    RAIL_CONTRACTS: new Proxy(actual.RAIL_CONTRACTS, {
      get(target, key): unknown {
        if (metadata.mode === "none" || (metadata.mode === "mainnet" && key !== "ethereum"))
          return undefined;
        return typeof key === "string" ? target[key as keyof typeof target] : undefined;
      },
    }),
  };
});

function sourceRecord(): string {
  const record = JSON.parse(readFixture("deployments-testnet.json")) as {
    networks: Record<string, { adapters?: Record<string, string> }>;
  };
  const stellar = record.networks["stellar-testnet"];
  if (!stellar) throw new Error("fixture has no Stellar deployment");
  stellar.adapters = {
    ...stellar.adapters,
    "axelar-its": "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT",
  };
  return JSON.stringify(record);
}

describe("Axelar deployment admission", () => {
  beforeEach(() => {
    metadata.mode = "all";
  });
  it("rejects absent receiver metadata despite an unrelated deployed EVM router", () => {
    metadata.mode = "none";
    expect(() => loadConfig({ env: completeEnv(), readFile: sourceRecord })).toThrow(
      "supported deployed destination receiver",
    );
    expect(() => loadConfig({ env: completeEnv(), readFile: sourceRecord })).toThrow(ConfigError);
  });
  it("cannot use a mainnet receiver to admit a testnet source", () => {
    metadata.mode = "mainnet";
    expect(() => loadConfig({ env: completeEnv(), readFile: sourceRecord })).toThrow(ConfigError);
  });
  it("admits the checked-in direct ITS record without inventing an EVM Hyperion deployment", () => {
    const record = readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8");
    const config = loadConfig({
      env: completeEnv({ KEEPER_ENABLED: "false" }),
      readFile: () => record,
    });
    expect(config.indexer.stellar?.chain).toBe("stellar-testnet");
    expect(config.indexer.evm).toEqual([]);
  });
  it("leaves a source without ITS enabled independent of ITS receiver availability", () => {
    metadata.mode = "none";
    expect(() => loadConfig({ env: completeEnv() })).not.toThrow();
  });
});
