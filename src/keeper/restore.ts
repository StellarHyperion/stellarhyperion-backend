import { BASE_FEE, Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";

/**
 * RPC simulation reports an archived footprint as present after restoration. Restore only that
 * footprint with the protocol operation, then rebuild the original call with a fresh sequence.
 * The caller holds the shared signer lease and persists/reconciles each signed restoration.
 */
export async function prepareWithRestore(
  client: Pick<rpc.Server, "simulateTransaction" | "prepareTransaction" | "getAccount">,
  buildInvocation: () => Promise<Transaction>,
  submitRestoration: (prepared: Transaction, phase: "restore") => Promise<string>,
): Promise<Transaction> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const invocation = await buildInvocation();
    const simulation = await client.simulateTransaction(invocation);
    if (rpc.Api.isSimulationError(simulation))
      throw new Error("Keeper operation simulation failed.");
    if (rpc.Api.isSimulationRestore(simulation)) {
      if (attempt > 0)
        throw new Error("Keeper footprint remains archived after confirmed restoration.");
      const restore = new TransactionBuilder(await client.getAccount(invocation.source), {
        fee: BASE_FEE,
        networkPassphrase: invocation.networkPassphrase,
      })
        .setSorobanData(simulation.restorePreamble.transactionData.build())
        .addOperation(Operation.restoreFootprint({}))
        .setTimeout(120)
        .build();
      const prepared = await client.prepareTransaction(restore);
      // Do not retry the invocation unless the durable restoration has confirmed success.
      await submitRestoration(prepared, "restore");
      continue;
    }
    if (!rpc.Api.isSimulationSuccess(simulation))
      throw new Error("Keeper simulation has no usable footprint.");
    return rpc.assembleTransaction(invocation, simulation).build();
  }
  throw new Error("Keeper restoration exceeded its bounded preparation attempts.");
}
