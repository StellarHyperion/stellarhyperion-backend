import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/config/env.js";
import { completeEnv, TESTNET_DEPLOYMENTS } from "../helpers.js";

function faultNames(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error.faults.map((fault) => fault.name);
    throw error;
  }
  throw new Error("expected a ConfigError and got none");
}

describe("loadConfig", () => {
  it("reads a complete environment and a real deployment record", () => {
    const config = loadConfig({ env: completeEnv() });

    expect(config.network).toBe("testnet");
    expect(config.http.port).toBe(8080);
    expect(config.indexer.enabled).toBe(true);
  });

  it("names every missing variable at once rather than the first one", () => {
    const env = completeEnv();
    delete env.DATABASE_URL;
    delete env.REDIS_URL;
    delete env.HYPERION_NETWORK;

    const names = faultNames(() => loadConfig({ env }));

    // All three, because fixing configuration one restart at a time is what this avoids.
    expect(names).toEqual(["DATABASE_URL", "REDIS_URL", "HYPERION_NETWORK"]);
  });

  it("never puts a connection string in the failure message", () => {
    const secret = "postgres://hyperion:topsecretpassword@db.internal:5432/hyperion";
    const env = completeEnv({ DATABASE_URL: "not a url at all", REDIS_URL: secret });
    // The redis url is valid, so the fault is on DATABASE_URL, and that one is unprintable.
    const env2 = completeEnv({ DATABASE_URL: secret.replace("postgres://", "") });

    expect(() => loadConfig({ env })).toThrow(ConfigError);
    try {
      loadConfig({ env: env2 });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain("topsecretpassword");
      expect((error as ConfigError).message).toContain("DATABASE_URL");
    }
  });

  it("refuses a port outside the range a port can be", () => {
    expect(faultNames(() => loadConfig({ env: completeEnv({ HTTP_PORT: "70000" }) }))).toEqual([
      "HTTP_PORT",
    ]);
    expect(faultNames(() => loadConfig({ env: completeEnv({ HTTP_PORT: "eight" }) }))).toEqual([
      "HTTP_PORT",
    ]);
  });

  it("refuses a log level nobody has", () => {
    expect(faultNames(() => loadConfig({ env: completeEnv({ LOG_LEVEL: "verbose" }) }))).toEqual([
      "LOG_LEVEL",
    ]);
  });

  it("reports the resolved path when the deployment record is not there", () => {
    const env = completeEnv({ HYPERION_DEPLOYMENTS_FILE: "./nope/testnet.json" });
    try {
      loadConfig({ env, cwd: "/srv/hyperion" });
    } catch (error) {
      expect((error as ConfigError).message).toContain("/srv/hyperion/nope/testnet.json");
      return;
    }
    throw new Error("expected a ConfigError");
  });

  it("passes the deployment validator's own field path through", () => {
    const env = completeEnv();
    // A flow ceiling written as a JSON number rather than a string, which is the mistake somebody
    // makes once per deployment file. Patched as text so the fixture's own shape stays the thing
    // under test rather than whatever a cast let through.
    const broken = readFileSync(TESTNET_DEPLOYMENTS, "utf8").replace(
      '"flowLimit": "1000000000000"',
      '"flowLimit": 1000000000000',
    );

    try {
      loadConfig({ env, readFile: () => broken });
    } catch (error) {
      expect((error as ConfigError).message).toContain("$.networks.sepolia.tokens.USDC.flowLimit");
      return;
    }
    throw new Error("expected a ConfigError");
  });

  it("refuses a mainnet record while configured for testnet", () => {
    const env = completeEnv({ HYPERION_NETWORK: "mainnet" });
    try {
      loadConfig({ env });
    } catch (error) {
      const message = (error as ConfigError).message;
      // Both chains in the fixture are testnet chains, so both are named.
      expect(message).toContain("stellar-testnet");
      expect(message).toContain("sepolia");
      expect(message).toContain("not a mainnet chain");
      return;
    }
    throw new Error("expected a ConfigError");
  });
});

describe("watch plan", () => {
  it("takes the Stellar router and its start ledger from the record, not from a default", () => {
    const config = loadConfig({ env: completeEnv() });
    const stellar = config.indexer.stellar;

    expect(stellar).not.toBeNull();
    expect(stellar?.routerContractId).toBe(
      "CDVDU67TASWDY7ECUQWGPIIAYVLFYTGULAQVLMUEYRIBILVHKJHBCPSI",
    );
    expect(stellar?.startLedger).toBe(1_287_400);
    // The registry endpoint, because no override was set.
    expect(stellar?.rpcUrl).toBe("https://soroban-testnet.stellar.org");
  });

  it("takes each EVM chain's confirmations from the chain registry", () => {
    const config = loadConfig({ env: completeEnv() });
    const sepolia = config.indexer.evm.find((entry) => entry.chain === "sepolia");

    expect(sepolia?.chainId).toBe(11_155_111);
    expect(sepolia?.startBlock).toBe(9_412_880n);
    // Sepolia is three in the registry. Hard coding twelve here would be the backend inventing a
    // fact the shared package already owns.
    expect(sepolia?.confirmations).toBe(3);
    expect(sepolia?.reorgDepth).toBe(3);
  });

  it("lets an operator override one chain's RPC without touching the others", () => {
    const config = loadConfig({
      env: completeEnv({ EVM_RPC_URL_SEPOLIA: "https://sepolia.example.invalid/v1" }),
    });
    const sepolia = config.indexer.evm.find((entry) => entry.chain === "sepolia");

    expect(sepolia?.rpcUrl).toBe("https://sepolia.example.invalid/v1");
  });

  it("refuses an override that is not a URL instead of falling back to the public endpoint", () => {
    expect(
      faultNames(() =>
        loadConfig({ env: completeEnv({ EVM_RPC_URL_SEPOLIA: "sepolia-node:8545" }) }),
      ),
    ).toEqual(["EVM_RPC_URL_SEPOLIA"]);
  });

  it("refuses a host and port typed without a scheme, which a bare URL parse accepts", () => {
    // The reason every URL variable declares its schemes. `new URL("sepolia-node:8545")` succeeds:
    // it reads as the scheme "sepolia-node" with an opaque body and no host at all. Without the
    // host and scheme checks this lands in viem on the first request, as a fetch error that names
    // nothing an operator can act on.
    expect(new URL("sepolia-node:8545").protocol).toBe("sepolia-node:");
    expect(new URL("sepolia-node:8545").host).toBe("");

    for (const bad of ["sepolia-node:8545", "127.0.0.1:8545", "localhost:8545"]) {
      expect(
        faultNames(() => loadConfig({ env: completeEnv({ EVM_RPC_URL_SEPOLIA: bad }) })),
        `expected ${bad} to be refused`,
      ).toEqual(["EVM_RPC_URL_SEPOLIA"]);
    }
  });

  it("refuses a URL whose scheme belongs to a different service", () => {
    // A redis url in DATABASE_URL parses, has a host, and would fail inside pg. Naming the
    // accepted schemes turns it into a startup failure that says which variable is wrong.
    expect(
      faultNames(() =>
        loadConfig({ env: completeEnv({ DATABASE_URL: "redis://127.0.0.1:6380" }) }),
      ),
    ).toEqual(["DATABASE_URL"]);
    expect(
      faultNames(() => loadConfig({ env: completeEnv({ REDIS_URL: "postgres://h/db" }) })),
    ).toEqual(["REDIS_URL"]);
  });

  it("accepts the schemes each service actually speaks", () => {
    const config = loadConfig({
      env: completeEnv({
        DATABASE_URL: "postgresql://hyperion:x@127.0.0.1:5433/hyperion",
        REDIS_URL: "rediss://127.0.0.1:6380",
      }),
    });
    expect(config.databaseUrl.startsWith("postgresql://")).toBe(true);
    expect(config.redisUrl.startsWith("rediss://")).toBe(true);
  });

  it("names a variable once, even when one mistake has several consequences", () => {
    // A missing HYPERION_NETWORK makes `choice` fall back to the first mode, which makes every
    // chain in a testnet record look like it belongs to the wrong network. Reporting that against
    // HYPERION_DEPLOYMENTS_FILE would send somebody to edit a file that is fine, so the derived
    // check stands down when its own inputs have already failed.
    const env = completeEnv();
    delete env.HYPERION_NETWORK;

    const names = faultNames(() => loadConfig({ env }));
    expect(names).toEqual(["HYPERION_NETWORK"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("refuses a record whose chain id disagrees with the registry", () => {
    const env = completeEnv();
    const record = readFileSync(TESTNET_DEPLOYMENTS, "utf8").replace(
      '"chainId": 11155111',
      '"chainId": 1',
    );

    try {
      loadConfig({ env, readFile: () => record });
    } catch (error) {
      expect((error as ConfigError).message).toContain("chain id 1");
      return;
    }
    throw new Error("expected a ConfigError");
  });
});
