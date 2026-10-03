/**
 * The cursor arithmetic, against cursors the live testnet RPC actually returned.
 *
 * Every string in this file was copied out of a real `getEvents` response or confirmed against one
 * by probing the boundary, and that is the entire reason this suite is worth having. The formula
 * is three characters wide and a plausible wrong version of it, say `ledger << 32` without the
 * minus one, passes every test somebody would write from the formula instead of from the wire. It
 * would also quietly skip one ledger per pass forever.
 */
import { describe, expect, it } from "vitest";

import {
  EventCursorError,
  completeThrough,
  endOfLedgerCursor,
  parseEventCursor,
} from "../../src/chains/stellar/cursor.js";

/**
 * Captured from testnet while the router at CDMOLDF4...WCWF was live.
 *
 * `emptyWindow` is the response to `startLedger: 4880000` over a range holding no router events:
 * the scan stopped at 4889999, ten thousand ledgers on, with the head twelve thousand further
 * still. It is the single observation the whole watcher design rests on, because it is the proof
 * that an empty page does not mean there is nothing left to read.
 *
 * `midLedger` is the response to the same start with `limit: 3`, where the page filled before the
 * window ran out, so the cursor is the third event's own id rather than a window marker.
 */
const LIVE = {
  emptyWindow: "0021002390077439999-4294967295",
  emptyWindowLastLedger: 4_889_999,
  midLedger: "0021331637975416832-0000000000",
  midLedgerLedger: 4_966_659,
} as const;

describe("reading a cursor the rpc handed back", () => {
  it("takes the ledger from the top thirty two bits of the toid", () => {
    expect(parseEventCursor(LIVE.emptyWindow).ledger).toBe(LIVE.emptyWindowLastLedger);
    expect(parseEventCursor(LIVE.midLedger).ledger).toBe(LIVE.midLedgerLedger);
  });

  it("tells an end-of-window marker apart from a real event", () => {
    // The whole difference between "this ledger is finished" and "this ledger is half read", and
    // the only thing in the response that carries it. 0xFFFFFFFF is not an event index any event
    // has.
    expect(parseEventCursor(LIVE.emptyWindow).completesLedger).toBe(true);
    expect(parseEventCursor(LIVE.midLedger).completesLedger).toBe(false);
  });

  it("refuses a cursor it cannot read rather than guessing a position", () => {
    // A cursor shape that changed under us would otherwise land as a watcher rewinding to ledger
    // zero and reading the chain again from the start.
    for (const bad of ["", "nonsense", "123", "123-", "-123", "12x-0000000000", "123-45-67"]) {
      expect(() => parseEventCursor(bad), bad).toThrow(EventCursorError);
    }
  });
});

describe("building the cursor for a ledger boundary", () => {
  it("round trips byte for byte against the cursor the rpc produced", () => {
    // Not just the same value: the same string. The RPC compares cursors as text, so a correct
    // number at the wrong padding is a different cursor.
    expect(endOfLedgerCursor(LIVE.emptyWindowLastLedger)).toBe(LIVE.emptyWindow);
  });

  it("sits after every event in its ledger and before the next one", () => {
    // Confirmed at the boundary on testnet: the router's first event is in ledger 4966653, and
    // resuming from endOfLedgerCursor(4966652) returns it while endOfLedgerCursor(4966653) does
    // not. These are the two cursors that were sent to get that answer.
    expect(endOfLedgerCursor(4_966_652)).toBe("0021331612205580287-4294967295");
    expect(endOfLedgerCursor(4_966_653)).toBe("0021331616500547583-4294967295");

    const before = endOfLedgerCursor(4_966_652);
    const firstEventId = "0021331612205608960-0000000000";
    const after = endOfLedgerCursor(4_966_653);
    // Ordering as strings, which is how the RPC itself orders event ids.
    expect(before < firstEventId).toBe(true);
    expect(firstEventId < after).toBe(true);
  });

  it("parses back to the ledger it was built for", () => {
    for (const ledger of [0, 1, 4_966_617, 120_960, 2 ** 31, 2 ** 32 - 1]) {
      const position = parseEventCursor(endOfLedgerCursor(ledger));
      expect(position, String(ledger)).toEqual({ ledger, completesLedger: true });
    }
  });

  it("refuses a ledger that is not a ledger", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => endOfLedgerCursor(bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe("what a page leaves fully read", () => {
  it("counts the whole window when the scan ran out of window", () => {
    // Including when it found nothing. This is what lets a watcher twenty seven thousand ledgers
    // behind arrive in three passes rather than never.
    expect(completeThrough(parseEventCursor(LIVE.emptyWindow))).toBe(LIVE.emptyWindowLastLedger);
  });

  it("stops short of the ledger it was in the middle of", () => {
    // The events already read are still written. They are final, and the upsert keys make the
    // next pass re-reading that ledger a no-op, which is cheaper than a cursor that would have to
    // describe half a ledger.
    expect(completeThrough(parseEventCursor(LIVE.midLedger))).toBe(LIVE.midLedgerLedger - 1);
  });
});
