import { describe, expect, it } from "vitest";
import {
  decodeStreamCursor,
  encodeStreamCursor,
  STREAM_CURSOR_TTL_MS,
} from "../../src/http/stream-cursor.js";

describe("bounded durable stream cursors", () => {
  const now = 1_700_000_000_000;
  it("retains full-width history IDs and binds the source transfer", () => {
    const token = encodeStreamCursor("9223372036854775807", "9223372036854775806", now);
    expect(decodeStreamCursor(token, "9223372036854775807", now)).toBe("9223372036854775806");
    expect(() => decodeStreamCursor(token, "2", now)).toThrow("resync");
  });
  it("requires explicit resynchronization for expired, future and oversized cursors", () => {
    for (const token of [
      encodeStreamCursor("1", "2", now - STREAM_CURSOR_TTL_MS - 1),
      encodeStreamCursor("1", "2", now + 1),
      "a".repeat(513),
      "invalid%",
    ])
      expect(() => decodeStreamCursor(token, "1", now)).toThrow("resync");
  });
});
