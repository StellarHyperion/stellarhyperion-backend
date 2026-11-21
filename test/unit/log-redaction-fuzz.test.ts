import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticText } from "../../src/logging/logger.js";

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
});
