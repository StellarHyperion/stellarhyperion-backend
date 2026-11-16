import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { viemClient } from "../../src/chains/evm/client.js";
import { loadConfig } from "../../src/config/config.js";
import { createLogger, redactUrlSecrets } from "../../src/logging/logger.js";
import { completeEnv, runLogRedactionFuzzer } from "../helpers.js";

function dynamicBytes(fill: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = (fill + i * 7) & 0xff;
  }
  return bytes;
}

function dynamicHex(fill: number, byteLen = 32): `0x${string}` {
  const out: string[] = [];
  for (let i = 0; i < byteLen; i += 1) {
    out.push(((fill + i * 13) & 0xff).toString(16).padStart(2, "0"));
  }
  return `0x${out.join("")}`;
}

describe("Structured log redaction fuzzing (#146)", () => {
  it("runs deterministic multi-seed fuzzing across logger, boot logger, and config failure paths with zero leaks", () => {
    for (const seed of [0x146_0001, 0x146_0002, 0x146_0003]) {
      const report = runLogRedactionFuzzer({ seed, iterations: 35 });
      expect(report.totalLinesChecked).toBe(70);
      expect(report.failures).toEqual([]);
    }
  });

  it("scrubs credential-bearing RPC URLs and nested transport errors during real viemClient failover while preserving public hashes", async () => {
    const primaryKey = "alcht_PrimarySecretKey_998877";
    const primaryQuerySecret = "qk_QueryToken_554433";
    const fallbackPass = "fb_Pass_221100";
    const stellarSeed = Keypair.fromRawEd25519Seed(Buffer.from(dynamicBytes(19))).secret();

    const primaryUrl = `https://rpcuser:${fallbackPass}@sepolia-primary.example.invalid/v2/${primaryKey}?api_key=${primaryQuerySecret}`;
    const secondaryUrl = `https://sepolia-secondary.example.invalid/v3/${primaryKey}?token=${primaryQuerySecret}`;

    const config = loadConfig({
      env: completeEnv({
        NODE_ENV: "production",
        KEEPER_ENABLED: "false",
        KEEPER_STELLAR_SECRET: stellarSeed,
        EVM_RPC_URLS_SEPOLIA: `${primaryUrl}, ${secondaryUrl}`,
      }),
    });

    const lines: string[] = [];
    const logger = createLogger(config, {
      write(chunk: string): void {
        for (const line of chunk.split("\n")) {
          if (line.trim() !== "") lines.push(line);
        }
      },
    });

    let callIndex = 0;
    const client = viemClient([primaryUrl, secondaryUrl], {
      logger,
      timeoutMs: 2_000,
      fetchFn: (input) => {
        callIndex += 1;
        const targetUrl =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (callIndex === 1) {
          return Promise.reject(
            new Error(`502 Bad Gateway from ${targetUrl} using key=${primaryQuerySecret}`),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });

    const chainId = await client.chainId();
    expect(chainId).toBe(11_155_111);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const serialized = lines.join("\n");
    for (const secret of [primaryKey, primaryQuerySecret, fallbackPass, stellarSeed]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("sepolia-primary.example.invalid");
    expect(serialized).toContain("[redacted]");
  });

  it("handles query parameter edge cases while keeping public tx hashes, token addresses, and Stellar strkeys intact", () => {
    const publicTxHash = dynamicHex(0x42, 32);
    const publicToken = dynamicHex(0x71, 20);
    const publicStellar = encodeStellarAddress(AddressKind.Contract, dynamicHex(0x88, 32));

    const scrubbed = redactUrlSecrets(
      `https://user:s3cr3t@api.provider.invalid/v1/transfers/by-tx/${publicTxHash}?%61pi_key=sec_one&API-KEY=sec_two&token=${publicToken}&contract=${publicStellar}&token=sec_three#access_token=frag_sec`,
    );

    expect(scrubbed).not.toContain("s3cr3t");
    expect(scrubbed).not.toContain("sec_one");
    expect(scrubbed).not.toContain("sec_two");
    expect(scrubbed).not.toContain("sec_three");
    expect(scrubbed).not.toContain("frag_sec");

    expect(scrubbed).toContain(publicTxHash);
    expect(scrubbed).toContain(publicToken);
    expect(scrubbed).toContain(publicStellar);
    expect(scrubbed).toContain("https://[redacted]@api.provider.invalid");
  });
});
