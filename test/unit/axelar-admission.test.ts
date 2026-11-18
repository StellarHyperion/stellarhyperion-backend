import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import { completeEnv, readFixture } from "../helpers.js";

describe("Axelar deployment admission", () => {
  it("rejects an Axelar source when no supported destination receiver exists", () => {
    const record = JSON.parse(readFixture("deployments-testnet.json")) as {
      networks: Record<string, { adapters?: Record<string, string> }>;
    };
    const stellar = record.networks["stellar-testnet"];
    if (!stellar) throw new Error("fixture has no Stellar deployment");
    stellar.adapters = {
      ...stellar.adapters,
      "axelar-its": "CARH6IA4TA5QAJNQG4B4I7N4336JEBS3GYLPZSEBUCWSNYTDRC7L3AHT",
    };
    delete record.networks.sepolia;

    expect(() =>
      loadConfig({
        env: completeEnv(),
        readFile: () => JSON.stringify(record),
      }),
    ).toThrow(ConfigError);
    try {
      loadConfig({ env: completeEnv(), readFile: () => JSON.stringify(record) });
    } catch (error) {
      expect((error as ConfigError).message).toContain("supported deployed destination receiver");
    }
  });
});
