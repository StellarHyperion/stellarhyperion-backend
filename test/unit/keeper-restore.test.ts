import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import type { rpc, Transaction } from "@stellar/stellar-sdk";
import { prepareWithRestore } from "../../src/keeper/restore.js";

const signer = Keypair.random().publicKey();
const router = "CDVDU67TASWDY7ECUQWGPIIAYVLFYTGULAQVLMUEYRIBILVHKJHBCPSI";
const passphrase = "Test SDF Network ; September 2015";
const fullWidthClaim = 18446744073709551615n;
function harness() {
  let sequence = 100;
  const build = vi.fn(() =>
    Promise.resolve(
      new TransactionBuilder(new Account(signer, String(sequence++)), {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .addOperation(
          new Contract(router).call(
            "settle_claim",
            new Address(signer).toScVal(),
            nativeToScVal(fullWidthClaim, { type: "u64" }),
          ),
        )
        .setTimeout(120)
        .build(),
    ),
  );
  const success: rpc.Api.SimulateTransactionSuccessResponse = {
    _parsed: true,
    id: "test",
    latestLedger: 101,
    events: [],
    transactionData: new SorobanDataBuilder(),
    minResourceFee: "0",
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  };
  const archived: rpc.Api.SimulateTransactionRestoreResponse = {
    ...success,
    result: success.result!,
    restorePreamble: {
      transactionData: new SorobanDataBuilder().setFootprint(
        [],
        [new Contract(router).getFootprint()],
      ),
      minResourceFee: "1000",
    },
  };
  const client = {
    simulateTransaction: vi.fn().mockResolvedValueOnce(archived).mockResolvedValue(success),
    prepareTransaction: vi.fn((tx: Awaited<ReturnType<typeof build>>) => Promise.resolve(tx)),
    getAccount: vi.fn(() => Promise.resolve(new Account(signer, "100"))),
  };
  return { build, client, success, archived };
}
describe("supported archived Soroban footprint restoration", () => {
  it("restores the reported footprint and then repeats the original full-width fixed-recipient call", async () => {
    const { build, client } = harness();
    const journal = vi.fn<(prepared: Transaction, phase: "restore") => Promise<string>>(() =>
      Promise.resolve("confirmed-restore-hash"),
    );
    const prepared = await prepareWithRestore(client, build, journal);
    expect(build).toHaveBeenCalledTimes(2);
    const restore = journal.mock.calls[0]?.[0];
    // The durable callback receives the actual SDK restoreFootprint transaction.
    expect(client.prepareTransaction.mock.calls[0]?.[0].operations[0]?.type).toBe(
      "restoreFootprint",
    );
    expect(journal).toHaveBeenCalledWith(client.prepareTransaction.mock.calls[0]?.[0], "restore");
    expect(restore).toBeDefined();
    const original = await build.mock.results[0]!.value;
    expect(prepared.operations[0]).toEqual(original.operations[0]);
    expect(prepared.sequence).toBe("102");
    expect(prepared.networkPassphrase).toBe(passphrase);
  });
  it("leaves uncertain restoration to durable hash recovery without preparing a second invocation", async () => {
    const { build, client } = harness();
    const journal = vi.fn(() =>
      Promise.reject(new Error("restore remains pending: recover checkpoint")),
    );
    await expect(prepareWithRestore(client, build, journal)).rejects.toThrow("recover checkpoint");
    expect(build).toHaveBeenCalledTimes(1);
    expect(client.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(journal).toHaveBeenCalledTimes(1);
  });
  it("does not interpret archived state as an absent claim or repeatedly submit restorations", async () => {
    const { build, client, archived } = harness();
    client.simulateTransaction.mockReset().mockResolvedValue(archived);
    const journal = vi.fn(() => Promise.resolve("confirmed"));
    await expect(prepareWithRestore(client, build, journal)).rejects.toThrow("remains archived");
    expect(journal).toHaveBeenCalledTimes(1);
  });
  it("prepares live entries without restoration and refuses simulation errors", async () => {
    const { build, client, success } = harness();
    client.simulateTransaction
      .mockReset()
      .mockResolvedValueOnce(success)
      .mockResolvedValue({ error: "provider failure", events: [], latestLedger: 1 });
    const journal = vi.fn(() => Promise.resolve("unused"));
    await prepareWithRestore(client, build, journal);
    expect(journal).not.toHaveBeenCalled();
    await expect(prepareWithRestore(client, build, journal)).rejects.toThrow("simulation failed");
  });
});
