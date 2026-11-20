import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RailPass } from "../../src/rails/pass.js";
import { RailError, type PendingTransfer, type RailClient } from "../../src/rails/types.js";
import { RateLimitSimulator, RailRateLimitError, RailTimeoutError } from "../helpers.js";
import { RecordingDb, capturingLogger, seedOutboundTransfer } from "../stellar-fakes.js";

describe("RateLimitSimulator and RailPass backoff coordination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not attempt next check for the SAME transfer after Retry-After until cooldown passes", async () => {
    const startTime = new Date("2026-11-19T12:00:00.000Z");
    vi.setSystemTime(startTime);

    const db = new RecordingDb();
    const { logger } = capturingLogger();
    const transferId = seedOutboundTransfer(db, { route: 0, nonce: 101n });

    const sim = new RateLimitSimulator();
    sim.simulateRetryAfter(30); // 30 second cooldown

    const pass = new RailPass({
      route: 0,
      client: sim,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 5_000,
      maxCheckFailures: 5,
    });

    // 1st tick: encounters Retry-After 30s
    await pass.tick(new AbortController().signal);
    expect(sim.callCount).toBe(1);
    expect(sim.callsFor(transferId)).toBe(1);
    expect(sim.backoffTimesObserved).toEqual([30]);

    // Check DB attestation row
    const attestation = db.railAttestations.get(transferId);
    expect(attestation).toBeDefined();
    expect(attestation?.status).toBe("pending");
    expect(attestation?.retry_class).toBe("rate_limited");
    expect(attestation?.retry_attempts).toBe(1);
    expect(attestation?.next_attempt_at?.toISOString()).toBe("2026-11-19T12:00:30.000Z");

    // Advance 15s (still within 30s cooldown)
    vi.advanceTimersByTime(15_000);
    await pass.tick(new AbortController().signal);
    expect(sim.callCount).toBe(1);
    expect(sim.callsFor(transferId)).toBe(1);

    // Advance another 14s (total 29s, still within cooldown)
    vi.advanceTimersByTime(14_000);
    await pass.tick(new AbortController().signal);
    expect(sim.callCount).toBe(1);
    expect(sim.callsFor(transferId)).toBe(1);

    // Advance another 2s (total 31s, cooldown has passed)
    vi.advanceTimersByTime(2_000);
    await pass.tick(new AbortController().signal);
    expect(sim.callCount).toBe(2);
    expect(sim.callsFor(transferId)).toBe(2);
  });

  it("does not starve unrelated transfers when one is in backoff", async () => {
    const startTime = new Date("2026-11-19T12:00:00.000Z");
    vi.setSystemTime(startTime);

    const db = new RecordingDb();
    const { logger } = capturingLogger();

    // Transfer 1 and Transfer 2 on same route
    const transfer1 = seedOutboundTransfer(db, { route: 0, nonce: 201n });
    const transfer2 = seedOutboundTransfer(db, { route: 0, nonce: 202n });

    const sim = new RateLimitSimulator();
    // Simulate timeout for transfer 1 (transient exponential backoff)
    sim.simulateTimeout("provider timeout");

    const pass = new RailPass({
      route: 0,
      client: sim,
      db,
      logger,
      batchSize: 1, // 1 per batch to process them distinctly
      recheckAfterMs: 20_000,
      maxCheckFailures: 5,
    });

    // 1st tick processes transfer 1 and fails with timeout -> backoff 20s
    await pass.tick(new AbortController().signal);
    expect(sim.callsFor(transfer1)).toBe(1);
    expect(sim.callsFor(transfer2)).toBe(0);

    const a1 = db.railAttestations.get(transfer1);
    expect(a1?.retry_class).toBe("transient");
    expect(a1?.next_attempt_at?.toISOString()).toBe("2026-11-19T12:00:20.000Z");

    // 2nd tick immediately: transfer 1 is cooling down (next_attempt_at in +20s),
    // but transfer 2 is ready and NOT starved!
    await pass.tick(new AbortController().signal);
    expect(sim.callsFor(transfer1)).toBe(1);
    expect(sim.callsFor(transfer2)).toBe(1);

    const a2 = db.railAttestations.get(transfer2);
    expect(a2?.status).toBe("pending");
  });

  it("does not corrupt the transfer record or mark it delivered on malformed responses", async () => {
    const startTime = new Date("2026-11-19T12:00:00.000Z");
    vi.setSystemTime(startTime);

    const db = new RecordingDb();
    const { logger } = capturingLogger();
    const transferId = seedOutboundTransfer(db, { route: 0, nonce: 301n });

    const sim = new RateLimitSimulator();
    sim.simulateMalformed();

    const pass = new RailPass({
      route: 0,
      client: sim,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 5_000,
      maxCheckFailures: 5,
    });

    await pass.tick(new AbortController().signal);
    expect(sim.callCount).toBe(1);

    const attestation = db.railAttestations.get(transferId);
    expect(attestation).toBeDefined();
    // Status must remain pending and NEVER delivered
    expect(attestation?.status).toBe("pending");
    expect(attestation?.status).not.toBe("delivered");
    expect(attestation?.check_failures).toBe(1);
    expect(attestation?.last_error).toBe("lookup or delivery evidence verification failed");
  });

  it("does not mark the transfer as delivered on timeout", async () => {
    const startTime = new Date("2026-11-19T12:00:00.000Z");
    vi.setSystemTime(startTime);

    const db = new RecordingDb();
    const { logger } = capturingLogger();
    const transferId = seedOutboundTransfer(db, { route: 0, nonce: 401n });

    const sim = new RateLimitSimulator();
    sim.simulateTimeout("gateway timeout");

    const pass = new RailPass({
      route: 0,
      client: sim,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 5_000,
      maxCheckFailures: 5,
    });

    await pass.tick(new AbortController().signal);
    expect(sim.callCount).toBe(1);

    const attestation = db.railAttestations.get(transferId);
    expect(attestation).toBeDefined();
    expect(attestation?.status).toBe("pending");
    expect(attestation?.status).not.toBe("delivered");
    expect(attestation?.retry_class).toBe("transient");
    expect(attestation?.retry_attempts).toBe(1);
    expect(attestation?.last_error).toBe("cctp transient lookup failure");
  });

  it("retains durable backoff decisions across process restart (new RailPass instance with same DB)", async () => {
    const startTime = new Date("2026-11-19T12:00:00.000Z");
    vi.setSystemTime(startTime);

    const db = new RecordingDb();
    const { logger } = capturingLogger();
    const transferId = seedOutboundTransfer(db, { route: 0, nonce: 501n });

    const sim = new RateLimitSimulator();
    sim.simulateRetryAfter(60); // 60s cooldown

    const pass1 = new RailPass({
      route: 0,
      client: sim,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 5_000,
      maxCheckFailures: 5,
    });

    // Run first process instance
    await pass1.tick(new AbortController().signal);
    expect(sim.callCount).toBe(1);
    const saved = db.railAttestations.get(transferId);
    expect(saved?.next_attempt_at?.toISOString()).toBe("2026-11-19T12:01:00.000Z");

    // Simulate process crash / restart:
    // Create new pass instance with same DB. Its in-memory state (cooldownUntil) starts fresh null.
    const pass2 = new RailPass({
      route: 0,
      client: sim,
      db,
      logger,
      batchSize: 10,
      recheckAfterMs: 5_000,
      maxCheckFailures: 5,
    });

    // Advance 30 seconds (still within durable 60s backoff in DB)
    vi.advanceTimersByTime(30_000);
    await pass2.tick(new AbortController().signal);
    // Durable backoff state from DB prevents recheck
    expect(sim.callCount).toBe(1);

    // Advance 31 more seconds (now 61s elapsed, past backoff)
    vi.advanceTimersByTime(31_000);
    await pass2.tick(new AbortController().signal);
    // Should now be picked up from DB queue
    expect(sim.callCount).toBe(2);
  });

  it("CRITICAL: simulator cannot generate fake delivered records", async () => {
    const transfer: PendingTransfer = {
      transferId: 601n,
      route: 0,
      originChain: "sepolia",
      destinationChain: "stellar-testnet",
      nonce: 601n,
      originTx: "0x123",
      status: "pending",
      checkFailures: 0,
      retryAttempts: 0,
      delivered: false,
    };

    // A fake client attempting to return "delivered"
    const rogueClient: RailClient = {
      rail: "cctp",
      look: () =>
        Promise.resolve({
          kind: "found",
          report: {
            status: "delivered",
            railStatus: "complete",
            reference: "rogue-ref",
            attestedAt: new Date(),
          },
        }),
    };

    const sim = new RateLimitSimulator(rogueClient);
    const lookup = await sim.look(transfer);
    expect(lookup.kind).toBe("found");
    if (lookup.kind === "found") {
      expect(lookup.report.status).not.toBe("delivered");
      expect(lookup.report.status).toBe("pending");
    }

    expect(() => {
      sim.simulateDelivered();
    }).toThrow(/cannot generate fake delivered records/i);
  });

  it("supports intermittent timeouts and malformed responses with configured rates", async () => {
    const transfer: PendingTransfer = {
      transferId: 701n,
      route: 0,
      originChain: "sepolia",
      destinationChain: "stellar-testnet",
      nonce: 701n,
      originTx: "0x777",
      status: "pending",
      checkFailures: 0,
      retryAttempts: 0,
      delivered: false,
    };

    const simTimeout = new RateLimitSimulator({ timeoutRate: 1.0 });
    await expect(simTimeout.look(transfer)).rejects.toThrow("timeout");

    const simMalformed = new RateLimitSimulator({ malformedRate: 1.0 });
    const malformedResult = await simMalformed.look(transfer);
    expect(malformedResult.kind).toBe("malformed");
  });

  it("verifies error classes have expected properties", () => {
    const rateLimitError = new RailRateLimitError("cctp", 45);
    expect(rateLimitError.rail).toBe("cctp");
    expect(rateLimitError.kind).toBe("rateLimited");
    expect(rateLimitError.retryAfter).toBe(45);
    expect(rateLimitError.retryAfterMs).toBe(45_000);
    expect(rateLimitError).toBeInstanceOf(RailError);

    const timeoutError = new RailTimeoutError("cctp", "timeout");
    expect(timeoutError.rail).toBe("cctp");
    expect(timeoutError.kind).toBe("transient");
    expect(timeoutError.message).toBe("timeout");
    expect(timeoutError).toBeInstanceOf(RailError);
  });
});
