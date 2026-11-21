export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0 && reason.length <= 200)
    return new Error(reason);
  return new Error("rail work cancelled");
}

export function combinedSignal(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined));
}
