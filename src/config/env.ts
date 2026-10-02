/**
 * The environment, read through a schema that refuses to half succeed.
 *
 * Two rules shape this file. The first is that a missing or malformed variable is a startup
 * failure, never a default that papers over it: a watcher that quietly fell back to a public RPC
 * because someone fat fingered a variable name is a watcher nobody notices is slow until a
 * transfer is stuck. The second is that the failure names every variable it could not satisfy,
 * not just the first one. Fixing configuration one restart at a time, five restarts deep, is how
 * a deploy window gets eaten.
 *
 * Nothing here logs a value. `DATABASE_URL` and `REDIS_URL` carry passwords, and a configuration
 * dump at info level is the most common way a credential ends up in a log aggregator.
 */

/** What a variable has to look like. Each kind owns its own parse and its own error sentence. */
export type VarKind = "string" | "integer" | "boolean" | "url" | "enum";

export interface VarSpec {
  readonly name: string;
  readonly kind: VarKind;
  /** Absent and no default means the process does not start. */
  readonly required: boolean;
  readonly fallback?: string;
  /** For `enum`, the only values accepted. */
  readonly choices?: readonly string[];
  /** Lower bound for `integer`, inclusive. */
  readonly min?: number;
  readonly max?: number;
  /**
   * For `url`, the schemes this variable accepts, without the colon.
   *
   * Not optional decoration. `new URL` accepts anything of the form `scheme:body`, so
   * `new URL("sepolia-node:8545")` succeeds with a protocol of `sepolia-node:` and no host at
   * all. A host and port typed without a scheme therefore passes a bare URL parse and then fails
   * inside viem, three layers down, with a message about a fetch. Naming the schemes here is what
   * turns that into a startup failure that says which variable is wrong.
   */
  readonly protocols?: readonly string[];
  /**
   * Whether the value may ever appear in an error message. False for anything carrying a
   * credential, which means a bad `DATABASE_URL` reports the variable name and the shape it
   * failed, never the string itself.
   */
  readonly printable: boolean;
  /** One sentence, shown in the startup failure so somebody knows what to put there. */
  readonly purpose: string;
}

/**
 * An enum spec, with `choices` narrowed to one literal union.
 *
 * `VarSpec["choices"]` is `readonly string[]`, and intersecting that with `readonly T[]` leaves an
 * array type whose `find` resolves to the `string` overload. Omitting the wide field is what makes
 * `choice()` hand back the union the caller declared rather than a widened string.
 */
export type EnumSpec<T extends string> = Omit<VarSpec, "choices"> & {
  readonly choices: readonly T[];
};

/** One variable that did not work out, with enough detail to fix it without reading this file. */
export interface ConfigFault {
  readonly name: string;
  readonly problem: string;
  readonly purpose: string;
}

/**
 * Thrown once, with every fault, at startup.
 *
 * Carries the faults as data as well as prose, because the test suite asserts on which variable
 * failed rather than on the wording of a sentence that will be reworded.
 */
export class ConfigError extends Error {
  constructor(readonly faults: readonly ConfigFault[]) {
    super(renderFaults(faults));
    this.name = "ConfigError";
  }
}

function renderFaults(faults: readonly ConfigFault[]): string {
  const lines = faults.map((fault) => `  ${fault.name}: ${fault.problem}\n      ${fault.purpose}`);
  const count =
    faults.length === 1 ? "1 environment variable" : `${faults.length} environment variables`;
  return [
    `Hyperion backend cannot start: ${count} need attention.`,
    ...lines,
    "",
    "See .env.example for the full list with defaults.",
  ].join("\n");
}

/**
 * A reader that accumulates faults instead of throwing on the first one.
 *
 * Every `read*` call either returns a value or records a fault and returns a placeholder the
 * caller never gets to use, because `finish()` throws before the config object escapes. That
 * keeps the call sites readable: no option types, no early returns, one throw at the end.
 */
export class EnvReader {
  private readonly faults: ConfigFault[] = [];

  constructor(private readonly source: Readonly<Record<string, string | undefined>>) {}

  /** Whether a variable is present at all, for the per chain overrides that have no fixed name. */
  has(name: string): boolean {
    const raw = this.source[name];
    return raw !== undefined && raw.trim().length > 0;
  }

  string(spec: VarSpec): string {
    const raw = this.raw(spec);
    return raw ?? "";
  }

  integer(spec: VarSpec): number {
    const raw = this.raw(spec);
    if (raw === null) return 0;
    if (!/^-?\d+$/.test(raw)) {
      this.record(spec, `expected a whole number, found ${this.show(spec, raw)}`);
      return 0;
    }
    const value = Number.parseInt(raw, 10);
    if (spec.min !== undefined && value < spec.min) {
      this.record(spec, `expected at least ${spec.min}, found ${value}`);
      return 0;
    }
    if (spec.max !== undefined && value > spec.max) {
      this.record(spec, `expected at most ${spec.max}, found ${value}`);
      return 0;
    }
    return value;
  }

  boolean(spec: VarSpec): boolean {
    const raw = this.raw(spec);
    if (raw === null) return false;
    const lowered = raw.toLowerCase();
    if (lowered === "true" || lowered === "1" || lowered === "yes") return true;
    if (lowered === "false" || lowered === "0" || lowered === "no") return false;
    this.record(spec, `expected true or false, found ${this.show(spec, raw)}`);
    return false;
  }

  url(spec: VarSpec): string {
    const raw = this.raw(spec);
    if (raw === null) return "";

    let parsed: URL;
    try {
      // Parsed rather than pattern matched, because a URL that `new URL` refuses is a URL that pg
      // and viem will also refuse, three layers further down where the message is worse.
      parsed = new URL(raw);
    } catch {
      this.record(spec, `expected a URL, ${this.expectation(spec)}`);
      return "";
    }

    // `new URL` is far more permissive than anybody expects. It accepts any `scheme:body`, so a
    // host and port typed without a scheme parses as a scheme with an opaque body and an empty
    // host. Both checks below exist because of that, and skipping either one lets a plainly wrong
    // value through to the library that cannot explain it.
    if (parsed.host === "") {
      this.record(spec, `has no host, ${this.expectation(spec)}`);
      return "";
    }

    const scheme = parsed.protocol.replace(/:$/, "");
    if (spec.protocols !== undefined && !spec.protocols.includes(scheme)) {
      this.record(
        spec,
        `uses the ${scheme} scheme, and this one accepts ${spec.protocols.join(" or ")}`,
      );
      return "";
    }

    return raw;
  }

  /** The tail of a URL complaint, so every one of them says what good looks like. */
  private expectation(spec: VarSpec): string {
    if (spec.protocols === undefined) return "with a scheme and a host";
    const schemes = spec.protocols.join(" or ");
    return `for example ${spec.protocols[0] ?? "https"}://host:5432/path, using ${schemes}`;
  }

  /** An enum, returning the literal union the caller declared rather than a widened string. */
  choice<T extends string>(spec: EnumSpec<T>): T {
    const first = spec.choices[0];
    if (first === undefined) {
      // A spec with no choices is a programming mistake in this file, not a configuration fault.
      throw new TypeError(`${spec.name} was declared as an enum with no choices`);
    }
    const raw = this.raw(spec);
    if (raw === null) return first;
    const match = spec.choices.find((candidate) => candidate === raw);
    if (match === undefined) {
      this.record(
        spec,
        `expected one of ${spec.choices.join(", ")}, found ${this.show(spec, raw)}`,
      );
      return first;
    }
    return match;
  }

  /** Record a fault found by something other than a kind check, such as a file that is not there. */
  reject(spec: VarSpec, problem: string): void {
    this.record(spec, problem);
  }

  /**
   * Whether a variable has already failed.
   *
   * Exists so a derived check can stand down. A missing `HYPERION_NETWORK` makes every chain in
   * the deployment record look like it belongs to the wrong network, and reporting that as two
   * faults against `HYPERION_DEPLOYMENTS_FILE` sends somebody to edit the file that was fine. A
   * cascading fault is worse than a silent one, because it points at the wrong variable with
   * complete confidence.
   */
  failed(spec: VarSpec | string): boolean {
    const name = typeof spec === "string" ? spec : spec.name;
    return this.faults.some((fault) => fault.name === name);
  }

  /** Throw if anything went wrong. Called once, after the whole config object is assembled. */
  finish(): void {
    if (this.faults.length > 0) throw new ConfigError(this.faults);
  }

  private raw(spec: VarSpec): string | null {
    const present = this.source[spec.name];
    const trimmed = present?.trim();
    if (trimmed !== undefined && trimmed.length > 0) return trimmed;
    if (spec.fallback !== undefined) return spec.fallback;
    if (spec.required) {
      this.record(spec, "not set, and there is no sensible default for it");
    }
    return null;
  }

  private record(spec: VarSpec, problem: string): void {
    // One line per variable. The first problem found is the root cause and anything after it is
    // a consequence, so a list that names one variable three times reads as three separate things
    // to fix when it is one.
    if (this.failed(spec)) return;
    this.faults.push({ name: spec.name, problem, purpose: spec.purpose });
  }

  /** A value in an error message, or a description of it when printing it would leak a secret. */
  private show(spec: VarSpec, raw: string): string {
    return spec.printable ? `"${raw}"` : `a ${raw.length} character value`;
  }
}
