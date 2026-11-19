import type { Mutation } from "../helpers.js";

export interface ProofMutationCase<T> {
  readonly name: string;
  readonly mutation: Mutation | null;
  readonly candidate: T;
  readonly expectedAccepted: boolean;
}
/** Results come from the supplied real verifier, never from the expectation or mutation itself. */
export async function runProofCorpus<T>(
  cases: readonly ProofMutationCase<T>[],
  verify: (candidate: T) => Promise<object | null>,
): Promise<
  readonly {
    name: string;
    mutation: Mutation | null;
    expectedAccepted: boolean;
    accepted: boolean;
    matchesExpectation: boolean;
  }[]
> {
  const rows = [];
  for (const entry of cases) {
    // A thrown provider/verifier error is a harness failure, not a successful rejection.
    const accepted = (await verify(entry.candidate)) !== null;
    rows.push({
      name: entry.name,
      mutation: entry.mutation,
      expectedAccepted: entry.expectedAccepted,
      accepted,
      matchesExpectation: accepted === entry.expectedAccepted,
    });
  }
  return rows;
}
