import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/http/cursor.js";
describe("bounded filter-scoped transfer cursors", () => {
  it("preserves a full-width database identifier and binds the filters", () => {
    const scope = { originChain: "stellar-testnet", route: "1" };
    const cursor = encodeCursor("9223372036854775807", scope);
    expect(decodeCursor(cursor, scope)).toBe("9223372036854775807");
    expect(() => decodeCursor(cursor, { ...scope, recipient: "another" })).toThrow("filters");
  });
  it.each([
    "",
    "a".repeat(2049),
    "%",
    encodeCursor("9223372036854775808", {}),
    encodeCursor("0001", {}),
    encodeCursor("-1", {}),
  ])("rejects malformed or oversized cursor %s", (cursor) => {
    expect(() => decodeCursor(cursor, {})).toThrow("cursor");
  });
});
