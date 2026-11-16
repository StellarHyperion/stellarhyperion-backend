import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { Keypair } from "@stellar/stellar-sdk";

import { StellarRpcError } from "../src/chains/stellar/rpc.js";
import { loadConfig } from "../src/config/config.js";
import { ConfigError } from "../src/config/env.js";
import { createBootLogger, createLogger } from "../src/logging/logger.js";
import { RailError } from "../src/rails/types.js";
import { TESTNET_DEPLOYMENTS } from "./helpers.js";

export interface FuzzCaseResult {
  readonly iteration: number;
  readonly seed: number;
  readonly serializedLines: readonly string[];
  readonly leakedSecrets: readonly string[];
  readonly preservedPublicHashes: boolean;
  readonly preservedCategories: boolean;
}

export interface FuzzRunReport {
  readonly seed: number;
  readonly iterations: number;
  readonly totalLinesChecked: number;
  readonly failures: readonly FuzzCaseResult[];
}

function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomBytes(next: () => number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = Math.floor(next() * 256);
  }
  return out;
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function pick<T>(next: () => number, items: readonly T[]): T {
  const idx = Math.floor(next() * items.length);
  const chosen = items[idx];
  if (chosen === undefined) {
    throw new Error("cannot pick from empty array");
  }
  return chosen;
}

function alphaToken(next: () => number, prefix: string, length = 18): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let body = "";
  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(next() * alphabet.length);
    body += alphabet[idx] ?? "x";
  }
  return `${prefix}_${body}`;
}

const MNEMONIC_WORDS = [
  "abandon",
  "ability",
  "able",
  "about",
  "above",
  "absent",
  "absorb",
  "abstract",
  "absurd",
  "abuse",
  "access",
  "accident",
  "account",
  "accuse",
  "achieve",
  "acid",
  "acoustic",
  "acquire",
  "across",
  "act",
  "action",
  "actor",
  "actress",
  "actual",
] as const;

function syntheticMnemonic(next: () => number): string {
  const words: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    words.push(pick(next, MNEMONIC_WORDS));
  }
  return words.join(" ");
}

function syntheticJwt(next: () => number): string {
  const seg1 = `eyJ${alphaToken(next, "hdr", 12)}`;
  const seg2 = `eyJ${alphaToken(next, "pld", 16)}`;
  const seg3 = alphaToken(next, "sig", 16);
  return `${seg1}.${seg2}.${seg3}`;
}

export function runLogRedactionFuzzer(
  options: {
    readonly seed?: number;
    readonly iterations?: number;
  } = {},
): FuzzRunReport {
  const seed = options.seed ?? 0x51a7e146;
  const iterations = options.iterations ?? 40;
  const next = createPrng(seed);

  const failures: FuzzCaseResult[] = [];
  let totalLinesChecked = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const iterSeed = Math.floor(next() * 0xffffffff);
    const rng = createPrng(iterSeed);

    // Secrets generated dynamically at runtime (never literal in source).
    const stellarSeedBytes = randomBytes(rng, 32);
    const stellarSecret = Keypair.fromRawEd25519Seed(Buffer.from(stellarSeedBytes)).secret();
    const evmPrivateKey = `0x${hexFromBytes(randomBytes(rng, 32))}`;
    const dbPassword = alphaToken(rng, "dbpw", 20);
    const redisPassword = alphaToken(rng, "rdpw", 20);
    const rpcUserSecret = alphaToken(rng, "rpcusr", 16);
    const rpcPassSecret = alphaToken(rng, "rpcpw", 18);
    const queryApiKey1 = alphaToken(rng, "qkeyA", 18);
    const queryApiKey2 = alphaToken(rng, "qkeyB", 18);
    const pathApiKey = alphaToken(rng, "alcht", 22);
    const bearerSecret = alphaToken(rng, "brtok", 22);
    const fragmentSecret = alphaToken(rng, "frag", 18);
    const jwtSecret = syntheticJwt(rng);
    const mnemonicSecret = syntheticMnemonic(rng);

    // Public identifiers and normalized categories that MUST remain intact.
    const publicTxHash = `0x${hexFromBytes(randomBytes(rng, 32))}`;
    const publicBlockHash = `0x${hexFromBytes(randomBytes(rng, 32))}`;
    const publicEvmToken = `0x${hexFromBytes(randomBytes(rng, 20))}`;
    const publicStellarAccount = encodeStellarAddress(
      AddressKind.Account,
      `0x${hexFromBytes(randomBytes(rng, 32))}`,
    );
    const publicStellarContract = encodeStellarAddress(
      AddressKind.Contract,
      `0x${hexFromBytes(randomBytes(rng, 32))}`,
    );
    const publicStellarMuxed = encodeStellarAddress(
      AddressKind.MuxedAccount,
      `0x${hexFromBytes(randomBytes(rng, 32))}`,
      BigInt(iteration + 1000),
    );
    const railCategory = pick(rng, ["transient", "permanent", "rateLimited"] as const);
    const errorCode = pick(rng, ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"] as const);

    const databaseUrl = `postgresql://hyperion:${dbPassword}@db.internal:5432/hyperion?sslpassword=${dbPassword}`;
    const redisUrl = `rediss://:${redisPassword}@redis.internal:6380/0`;

    // Query parameter edge cases: percent-encoded key, mixed case, duplicate keys, fragment, path key.
    const queryVariant = iteration % 4;
    const rpcUrlWithSecrets =
      queryVariant === 0
        ? `https://${rpcUserSecret}:${rpcPassSecret}@sepolia.rpc.invalid/v2/${pathApiKey}?api_key=${queryApiKey1}&API-KEY=${queryApiKey2}&txHash=${publicTxHash}#access_token=${fragmentSecret}`
        : queryVariant === 1
          ? `https://sepolia.rpc.invalid/v3/${pathApiKey}?%61pi_key=${queryApiKey1}&x_api_key=${queryApiKey2}&account=${publicStellarAccount}#token=${fragmentSecret}`
          : queryVariant === 2
            ? `wss://${rpcPassSecret}@ws.rpc.invalid/apikey/${pathApiKey}?auth_token=${queryApiKey1}&signature=${queryApiKey2}#jwt=${jwtSecret}`
            : `https://${rpcUserSecret}:${rpcPassSecret}@[malformed-host]/v2/${pathApiKey}?secret=${queryApiKey1};password=${queryApiKey2}`;

    const validEnv = {
      NODE_ENV: "production",
      LOG_LEVEL: "debug",
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      HYPERION_NETWORK: "testnet",
      HYPERION_DEPLOYMENTS_FILE: TESTNET_DEPLOYMENTS,
      KEEPER_ENABLED: "false",
      KEEPER_STELLAR_SECRET: stellarSecret,
      EVM_RPC_URL_SEPOLIA: "https://sepolia.rpc.invalid/v1",
    };

    const config = loadConfig({ env: validEnv });
    const capturedLines: string[] = [];
    const destination = {
      write(chunk: string): void {
        for (const line of chunk.split("\n")) {
          if (line.trim() !== "") {
            capturedLines.push(line);
          }
        }
      },
    };

    const logger = createLogger(config, destination);
    const bootLogger = createBootLogger("debug", destination);

    // Deeply nested provider error with AggregateError, headers, metaMessages, and circular reference.
    const deepestCause = Object.assign(
      new Error(
        `Upstream socket failed for (${rpcUrlWithSecrets}) with Bearer ${bearerSecret} and seed ${stellarSecret}`,
      ),
      {
        code: errorCode,
        url: rpcUrlWithSecrets,
        headers: {
          authorization: `Bearer ${bearerSecret}`,
          "x-api-key": queryApiKey1,
          cookie: `session=${fragmentSecret}`,
        },
        metaMessages: [
          `URL: ${rpcUrlWithSecrets}`,
          `Request signer privateKey=${evmPrivateKey}`,
          `Mnemonic: "${mnemonicSecret}"`,
        ],
      },
    );

    const siblingRpcError = new StellarRpcError(
      "getEvents",
      `Soroban node https://:${rpcPassSecret}@soroban.rpc.invalid?token=${queryApiKey2} rejected jwt ${jwtSecret}`,
      true,
    );

    const aggregateCause = new AggregateError(
      [deepestCause, siblingRpcError],
      `All endpoints failed while indexing tx ${publicTxHash}`,
    );

    const topRailError = Object.assign(
      new RailError(
        "axelar",
        railCategory,
        `searchGMP failed against ${rpcUrlWithSecrets} for block ${publicBlockHash}`,
        railCategory === "rateLimited" ? 30_000 : null,
      ),
      { cause: aggregateCause },
    );

    const signerBag: Record<string, unknown> = {
      privateKey: evmPrivateKey,
      signing_key: evmPrivateKey,
      stellarSecret,
      mnemonic: mnemonicSecret,
      nested: {
        clientSecret: bearerSecret,
        api_key: queryApiKey1,
        connectionString: databaseUrl,
      },
    };
    signerBag.circular = signerBag;

    logger.error(
      {
        err: topRailError,
        config,
        signerBag,
        txHash: publicTxHash,
        blockHash: publicBlockHash,
        token: publicEvmToken,
        stellarAccount: publicStellarAccount,
        stellarContract: publicStellarContract,
        stellarMuxed: publicStellarMuxed,
        nonce: BigInt(iteration + 1),
      },
      `watcher pass failed on tx ${publicTxHash} via ${rpcUrlWithSecrets}`,
    );

    bootLogger.warn(topRailError, `boot probe warning for ${databaseUrl} and ${redisUrl}`);

    // Also exercise ConfigError secret non-echo paths.
    let configFailureText = "";
    try {
      loadConfig({
        env: {
          ...validEnv,
          DATABASE_URL: `not-a-valid-scheme-${dbPassword}`,
          HTTP_PORT: `postgres://u:${rpcPassSecret}@host:5432/db`,
          LOG_LEVEL: stellarSecret,
        },
      });
    } catch (error) {
      if (error instanceof ConfigError) {
        configFailureText = `${error.message}\n${JSON.stringify(error.faults)}`;
      }
    }

    const forbiddenSecrets = [
      stellarSecret,
      evmPrivateKey,
      dbPassword,
      redisPassword,
      rpcUserSecret,
      rpcPassSecret,
      queryApiKey1,
      queryApiKey2,
      pathApiKey,
      bearerSecret,
      fragmentSecret,
      jwtSecret,
      mnemonicSecret,
    ];

    const haystack = `${capturedLines.join("\n")}\n${configFailureText}`;
    const leakedSecrets = forbiddenSecrets.filter(
      (secret) => haystack.includes(secret) || haystack.includes(encodeURIComponent(secret)),
    );

    const primaryLine = capturedLines[0] ?? "{}";
    const parsedPrimary = JSON.parse(primaryLine) as {
      txHash?: string;
      blockHash?: string;
      token?: string;
      stellarAccount?: string;
      stellarContract?: string;
      stellarMuxed?: string;
      err?: {
        kind?: string;
        rail?: string;
        cause?: {
          errors?: { code?: string; method?: string; retryable?: boolean }[];
        };
      };
    };

    const preservedPublicHashes =
      parsedPrimary.txHash === publicTxHash &&
      parsedPrimary.blockHash === publicBlockHash &&
      parsedPrimary.token === publicEvmToken &&
      parsedPrimary.stellarAccount === publicStellarAccount &&
      parsedPrimary.stellarContract === publicStellarContract &&
      parsedPrimary.stellarMuxed === publicStellarMuxed &&
      primaryLine.includes(publicTxHash);

    const nestedErrors = parsedPrimary.err?.cause?.errors ?? [];
    const preservedCategories =
      parsedPrimary.err?.rail === "axelar" &&
      parsedPrimary.err.kind === railCategory &&
      nestedErrors.some((entry) => entry.code === errorCode) &&
      nestedErrors.some((entry) => entry.method === "getEvents" && entry.retryable === true);

    totalLinesChecked += capturedLines.length;

    if (leakedSecrets.length > 0 || !preservedPublicHashes || !preservedCategories) {
      failures.push({
        iteration,
        seed: iterSeed,
        serializedLines: capturedLines,
        leakedSecrets,
        preservedPublicHashes,
        preservedCategories,
      });
    }
  }

  return {
    seed,
    iterations,
    totalLinesChecked,
    failures,
  };
}
