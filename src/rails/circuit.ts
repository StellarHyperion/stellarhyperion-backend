import { sanitizeDiagnosticText } from "../logging/logger.js";

export type ProviderCircuitState = "open" | "half-open" | "closed";

export interface ProviderCircuitSnapshot {
  readonly key: string;
  readonly state: ProviderCircuitState;
  readonly failures: number;
  readonly openedAt: string | null;
  readonly nextProbeAt: string | null;
  readonly lastReason: string | null;
}

export interface ProviderCircuitOptions {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly maxCooldownMs?: number;
  readonly now?: () => Date;
}

interface Circuit {
  readonly key: string;
  state: ProviderCircuitState;
  failures: number;
  openedAt: Date | null;
  nextProbeAt: Date | null;
  lastReason: string | null;
  cooldownMs: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_COOLDOWN_MS = 15 * 60_000;

export function safeCircuitKey(value: string): string {
  try {
    const url = new URL(value);
    if (url.host.length > 0) {
      const origin = `${url.protocol}//${url.host}`;
      return origin.length <= 128 ? origin : `${origin.slice(0, 64)}…${origin.slice(-63)}`;
    }
  } catch {
    return circuitTextKey(value);
  }
  return circuitTextKey(value);
}

function circuitTextKey(value: string): string {
  const safe = sanitizeDiagnosticText(value);
  if (safe.length === 0) return "unknown";
  return safe.length <= 128 ? safe : `${safe.slice(0, 64)}…${safe.slice(-63)}`;
}

export class ProviderCircuitBreaker {
  private readonly circuits = new Map<string, Circuit>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => Date;

  constructor(options: ProviderCircuitOptions = {}) {
    const threshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    const cooldown = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const maxCooldown = options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
    if (!Number.isSafeInteger(threshold) || threshold < 1)
      throw new RangeError("provider circuit failure threshold must be a positive integer");
    if (!Number.isSafeInteger(cooldown) || cooldown < 1)
      throw new RangeError("provider circuit cooldown must be a positive integer");
    if (!Number.isSafeInteger(maxCooldown) || maxCooldown < cooldown)
      throw new RangeError("provider circuit maximum cooldown must exceed its cooldown");
    this.failureThreshold = threshold;
    this.cooldownMs = cooldown;
    this.maxCooldownMs = maxCooldown;
    this.now = options.now ?? (() => new Date());
  }

  isPaused(key: string, at: Date = this.now()): boolean {
    const circuit = this.circuits.get(key);
    if (circuit?.state !== "open") return false;
    return circuit.nextProbeAt !== null && at.getTime() < circuit.nextProbeAt.getTime();
  }

  allow(key: string, at: Date = this.now()): boolean {
    const circuit = this.circuits.get(key);
    if (circuit === undefined || circuit.state === "closed") return true;
    if (circuit.state === "half-open") return false;
    if (circuit.nextProbeAt !== null && at.getTime() < circuit.nextProbeAt.getTime()) return false;
    circuit.state = "half-open";
    return true;
  }

  recordSuccess(key: string): void {
    this.circuits.delete(key);
  }

  recordFailure(key: string, reason: string, at: Date = this.now()): void {
    const circuit = this.circuits.get(key) ?? this.create(key);
    const reopened = circuit.state === "half-open";
    circuit.failures += 1;
    circuit.lastReason = sanitizeDiagnosticText(reason).slice(0, 256) || null;
    if (circuit.failures < this.failureThreshold && !reopened) return;
    circuit.state = "open";
    circuit.openedAt = at;
    circuit.cooldownMs = Math.min(circuit.cooldownMs * (reopened ? 2 : 1), this.maxCooldownMs);
    circuit.nextProbeAt = new Date(at.getTime() + circuit.cooldownMs);
  }

  snapshot(): readonly ProviderCircuitSnapshot[] {
    return [...this.circuits.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((circuit) => ({
        key: circuit.key,
        state: circuit.state,
        failures: circuit.failures,
        openedAt: circuit.openedAt?.toISOString() ?? null,
        nextProbeAt: circuit.nextProbeAt?.toISOString() ?? null,
        lastReason: circuit.lastReason,
      }));
  }

  private create(key: string): Circuit {
    const circuit: Circuit = {
      key,
      state: "closed",
      failures: 0,
      openedAt: null,
      nextProbeAt: null,
      lastReason: null,
      cooldownMs: this.cooldownMs,
    };
    this.circuits.set(key, circuit);
    return circuit;
  }
}
