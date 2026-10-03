/**
 * The Soroban event decoder, against events the live testnet actually emitted.
 *
 * The fixtures in `test/fixtures/stellar-events.json` were captured from the deployed router on
 * Stellar testnet with `getEvents` and `xdrFormat: "json"`. They are not hand written, and that is
 * the point: three details of this encoding will produce a plausible wrong answer if they are
 * guessed, and a fixture somebody typed would encode the guess rather than the format.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RouteKind } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";

import { decodeStellarEvent, type RawStellarEvent } from "../../src/chains/stellar/events.js";
import { ScValError, scBigInt, scMap, scU32, scUnion } from "../../src/chains/stellar/scval.js";
import { FIXTURES_DIR } from "../helpers.js";

const captured = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "stellar-events.json"), "utf8"),
) as RawStellarEvent[];

function byTag(tag: string): RawStellarEvent {
  const found = captured.find((event) => {
    const second = event.topicJson[1] as { symbol?: string } | undefined;
    return second?.symbol === tag;
  });
  if (found === undefined) throw new Error(`no captured event tagged "${tag}"`);
  return found;
}

describe("the ScVal JSON encoding, as the RPC actually writes it", () => {
  it("gives a u32 as a number and a u64 as a string", () => {
    // Not interchangeable. A u64 does not fit a double, so the RPC quotes it, and anything reading
    // one with Number() rounds a large nonce into a different nonce.
    const queued = scMap(byTag("queued").valueJson);
    expect(typeof (queued.eta as Record<string, unknown>).u64).toBe("string");

    const action = scUnion(queued.action);
    expect(action.variant).toBe("EnableRoute");
    expect(typeof (action.payload[0] as Record<string, unknown>).u32).toBe("number");
  });

  it("gives an i128 as a string, so an amount keeps every digit", () => {
    const token = scMap(byTag("token").valueJson);
    const config = scMap(token.config);
    expect(typeof (config.flow_limit as Record<string, unknown>).i128).toBe("string");
    expect(scBigInt(config.flow_limit)).toBe(10_000_000_000_000n);
  });

  it("reads an address as a strkey rather than as bytes", () => {
    const [, , third] = byTag("token").topicJson;
    expect((third as { address?: string }).address).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("sorts map keys by name and omits a void field", () => {
    // Both are `#[contractevent]` defaults in soroban-sdk 28, and both change what a decoder can
    // assume. Absence is a value here, not malformed input.
    const settled = scMap(byTag("cancelled").valueJson);
    expect(Object.keys(settled)).toEqual(["id"]);
  });

  it("encodes a repr(u32) enum as a bare u32, not as a union", () => {
    // RouteKind and AddressKind carry explicit discriminants, so they are not tagged unions on the
    // wire even though they are enums in the Rust. Reading one through the union decoder is the
    // mistake, and this is the assertion that documents the difference.
    const route = byTag("route").topicJson[2];
    expect(scU32(route)).toBe(RouteKind.AxelarIts);
    expect(() => scUnion(route)).toThrow(ScValError);
  });
});

describe("decoding a captured event", () => {
  it("reads a queued administrative action", () => {
    const decoded = decodeStellarEvent(byTag("queued"));
    expect(decoded.kind).toBe("actionQueued");
    if (decoded.kind !== "actionQueued") return;
    expect(decoded.data.variant).toBe("EnableRoute");
    expect(decoded.data.id).toBeGreaterThan(0n);
    expect(decoded.data.expiresAt).toBeGreaterThan(decoded.data.eta);
  });

  it("reads a cancellation and takes the actor off the topic", () => {
    const decoded = decodeStellarEvent(byTag("cancelled"));
    expect(decoded.kind).toBe("actionCancelled");
    if (decoded.kind !== "actionCancelled") return;
    expect(decoded.data.actor).toMatch(/^G[A-Z2-7]{55}$/);
    expect(decoded.data.variant).toBeNull();
  });

  it("reads a token registration, with the token from the topic and the rest from the value", () => {
    const decoded = decodeStellarEvent(byTag("token"));
    expect(decoded.kind).toBe("tokenRegistered");
    if (decoded.kind !== "tokenRegistered") return;
    expect(decoded.data.token).toMatch(/^C[A-Z2-7]{55}$/);
    expect(decoded.data.decimals).toBe(7);
    expect(decoded.data.flowLimit).toBe(10_000_000_000_000n);
    expect(decoded.data.enabled).toBe(true);
  });

  it("reads a route being enabled", () => {
    const decoded = decodeStellarEvent(byTag("route"));
    expect(decoded.kind).toBe("routeConfigured");
    if (decoded.kind !== "routeConfigured") return;
    expect(decoded.data.route).toBe(RouteKind.AxelarIts);
    expect(decoded.data.enabled).toBe(true);
  });

  it("decodes every captured event without throwing", () => {
    for (const event of captured) {
      expect(
        () => decodeStellarEvent(event),
        `tag ${JSON.stringify(event.topicJson[1])}`,
      ).not.toThrow();
    }
  });
});

describe("events this build does not understand", () => {
  const base = (): RawStellarEvent => ({ ...byTag("cancelled") });

  it("reports an unknown tag rather than crashing on it", () => {
    // A contract newer than the indexer is a normal operational state. It should produce a log
    // line somebody reads on Monday, not a crash loop.
    const event = { ...base(), topicJson: [{ symbol: "hyperion" }, { symbol: "teleported" }] };
    expect(decodeStellarEvent(event)).toEqual({ kind: "unknown", tag: "teleported" });
  });

  it("tells a tag it knows and ignores apart from one it has never seen", () => {
    const event = { ...base(), topicJson: [{ symbol: "hyperion" }, { symbol: "config" }] };
    expect(decodeStellarEvent(event)).toEqual({ kind: "ignored", tag: "config" });
  });

  it("throws for an event it recognises and cannot read", () => {
    // The other half of the same decision. Skipping a malformed event it was supposed to handle
    // would lose a transfer, so this one is loud.
    const event = { ...base(), topicJson: [{ symbol: "hyperion" }, { symbol: "out" }] };
    expect(() => decodeStellarEvent(event)).toThrow(ScValError);
  });

  it("refuses a route tag from a newer contract instead of guessing", () => {
    const event = {
      ...base(),
      topicJson: [{ symbol: "hyperion" }, { symbol: "route" }, { u32: 9 }],
      valueJson: { map: [{ key: { symbol: "enabled" }, val: { bool: true } }] },
    };
    expect(() => decodeStellarEvent(event)).toThrow(/not a rail this build knows about/);
  });
});
