/** Cursor ownership is fenced by the existing Stellar/EVM stores inside each write transaction.
 * This shared factory deliberately reuses their deployed lease schema instead of introducing a
 * second ownership table that could disagree with the watcher. */
export { acquireLease, assertLeaseHeld, releaseLease } from "../chains/evm/store.js";
