import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import {
  createBootLogger,
  createLogger,
  sanitizeDiagnosticText,
} from "../../src/logging/logger.js";
import { completeEnv } from "../helpers.js";

function capturedLogs() {
  let serialized = "";
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      serialized += chunk.toString();
      done();
    },
  });
  const config = loadConfig({ env: completeEnv({ LOG_LEVEL: "info", NODE_ENV: "test" }) });
  return {
    logger: createLogger(config, destination),
    bootLogger: createBootLogger("info", destination),
    output: () => serialized,
    records: () =>
      serialized
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Deterministic corpus: reproducible locally and large enough to cover delimiter/URL edges. */
function credentialCorpus(): readonly string[] {
  const values = ["pw", "token", "secret", "a/b?c=d", "ümlaut", "Bearer-x"];
  const cases: string[] = [];
  for (let index = 0; index < 100; index += 1) {
    const value = values[index % values.length];
    cases.push(
      `provider=${index} https://user:${value}@rpc.example.test/v${index}?apiKey=${value}&n=${index}`,
      `nested error: postgres://user:${value}@db.example.test:5432/hyperion?sslmode=require`,
      `authorization: Bearer ${value}-${String(index)} password=${value}; secret=${value}`,
    );
  }
  return cases;
}

describe("structured log redaction corpus", () => {
  it("removes credential-bearing URLs, auth headers, and secret fields from every case", () => {
    for (const input of credentialCorpus()) {
      const sanitized = sanitizeDiagnosticText(input);
      expect(sanitized).not.toMatch(/:\/\/[^\s"'<>]*:[^\s"'<>]*@/);
      expect(sanitized).not.toMatch(/Bearer\s+(?!\[redacted\])/);
      expect(sanitized).not.toMatch(/(?:password|secret|apiKey)=(?!\[redacted\])([^\s,;]+)/i);
    }
  });

  it("keeps bounded diagnostic text useful after redaction", () => {
    const sanitized = sanitizeDiagnosticText(
      "rpc https://user:password@rpc.example.test/v1 failed: upstream timeout",
    );
    expect(sanitized).toContain("[redacted URL]");
    expect(sanitized).toContain("upstream timeout");
    expect(sanitized.length).toBeLessThanOrEqual(2048);
  });

  it("redacts the actual serialized logger and configuration paths across a seeded corpus", () => {
    const { logger, output, records } = capturedLogs();
    const publicHash = "ab".repeat(32);
    for (let seed = 0; seed < 100; seed += 1) {
      const password = `synthetic-password-${seed}`;
      const token = `synthetic-token-${seed}`;
      const signer = `synthetic-signer-${seed}`;
      const source = {
        config: {
          keeper: { stellarSecret: signer },
          DATABASE_URL: `postgres://user:${password}@db.example.test/hyperion`,
        },
        provider: {
          nested: {
            headers: { Authorization: `Bearer ${token}` },
            signerPrivateKey: signer,
            error: new Error(
              `upstream https://user:${password}@rpc.example.test/key?api%4Bey=${token} failed`,
            ),
          },
        },
        errorClass: "rpc_unavailable",
        publicHash,
        amount: 18_446_744_073_709_551_615n,
      };
      logger.error(source, "provider reconciliation failed");
      logger.error(new Error(`upstream https://rpc.example.test/path?token=${token} failed`));
      const serialized = output();
      for (const secret of [password, token, signer]) {
        expect(serialized, `seed=${seed}; secret=${secret}`).not.toContain(secret);
      }
      expect(source.config.keeper.stellarSecret).toBe(signer);
      expect(source.provider.nested.headers.Authorization).toBe(`Bearer ${token}`);
    }
    expect(records()).toHaveLength(200);
    const record = records()[0];
    expect(record).toMatchObject({
      publicHash,
      amount: "18446744073709551615",
      errorClass: "rpc_unavailable",
      msg: "provider reconciliation failed",
    });
  });

  it("sanitizes nested causes, aggregate errors, boot logs and message substitutions", () => {
    const { logger, bootLogger, output, records } = capturedLogs();
    const cause = new Error("postgres://user:synthetic-cause@db.example.test/hyperion rejected");
    const error = new Error("upstream timeout", { cause });
    Object.assign(error, { code: "RPC_TIMEOUT", provider: { password: "synthetic-nested" } });
    logger.error({ err: error }, "failed %s", "Bearer synthetic-substitution");
    logger.error({ err: new AggregateError([cause], "batch failed") });
    bootLogger.error({
      config: { nested: { KEEPER_STELLAR_SECRET: "synthetic-boot" } },
      err: error,
    });
    for (const secret of [
      "synthetic-cause",
      "synthetic-nested",
      "synthetic-substitution",
      "synthetic-boot",
    ]) {
      expect(output()).not.toContain(secret);
    }
    expect(records()[0]?.err).toMatchObject({
      type: "Error",
      code: "RPC_TIMEOUT",
      message: "upstream timeout: [redacted URL] rejected",
    });
    expect(records()[0]?.msg).toBe("failed Bearer [redacted]");
  });

  it("bounds cycles, nesting and wide arrays without evaluating getters or toJSON", () => {
    const { logger, output, records } = capturedLogs();
    const cyclic: Record<string, unknown> = { publicHash: "cd".repeat(32) };
    cyclic.self = cyclic;
    let reads = 0;
    Object.defineProperty(cyclic, "detail", {
      enumerable: true,
      get() {
        reads += 1;
        return "synthetic-getter";
      },
    });
    cyclic.toJSON = () => {
      reads += 1;
      return { raw: "synthetic-toJSON" };
    };
    let deep: unknown = { secret: "synthetic-depth" };
    for (let index = 0; index < 20; index += 1) deep = { nested: deep };
    logger.info(
      {
        cyclic,
        deep,
        wide: Array.from({ length: 10_000 }, () => ({ password: "synthetic-width" })),
      },
      "bounded log",
    );
    expect(reads).toBe(0);
    expect(output()).not.toMatch(/synthetic-(getter|toJSON|depth|width)/);
    expect(output().length).toBeLessThan(20_000);
    expect(records()[0]?.cyclic).toMatchObject({
      publicHash: "cd".repeat(32),
      self: "[redacted: circular]",
      detail: "[redacted: accessor]",
    });
  });

  it("keeps ordinary public URLs and nonsecret diagnostic messages unchanged", () => {
    const { logger, records } = capturedLogs();
    logger.info(
      { explorer: "https://example.test/transaction/123?network=testnet", nested: { block: 42n } },
      "indexer caught up",
    );
    expect(records()[0]).toMatchObject({
      explorer: "https://example.test/transaction/123?network=testnet",
      nested: { block: "42" },
      msg: "indexer caught up",
    });
  });

  it("sanitizes child bindings and keeps Fastify request and response fields", async () => {
    const { logger, records, output } = capturedLogs();
    logger
      .child({
        provider: { nested: { authorization: "Bearer synthetic-binding" } },
        worker: "indexer",
      })
      .info("child ready");
    const child = logger
      .child({ worker: "keeper" })
      .child({ nested: { token: "synthetic-child" } });
    child.setBindings({ config: { password: "synthetic-set-binding" } });
    child.info("nested child ready");
    const app = Fastify({ loggerInstance: logger });
    app.get("/health", () => ({ ready: true }));
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(output()).not.toContain("synthetic-binding");
    expect(output()).not.toContain("synthetic-child");
    expect(output()).not.toContain("synthetic-set-binding");
    expect(records().find((record) => record.msg === "child ready")).toMatchObject({
      worker: "indexer",
    });
    expect(records().find((record) => record.msg === "incoming request")?.req).toMatchObject({
      method: "GET",
      url: "/health",
      host: "localhost:80",
      remoteAddress: "127.0.0.1",
    });
    expect(records().find((record) => record.msg === "request completed")?.res).toMatchObject({
      statusCode: 200,
    });
    await app.close();
  });
});
