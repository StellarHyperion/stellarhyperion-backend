import { nativeToScVal, rpc, SorobanDataBuilder } from "@stellar/stellar-sdk";
import { CHAINS, RAIL_CONTRACTS, RouteKind, toHex } from "@hyperion/protocol";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Hex } from "viem";
import type * as Viem from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCctpDelivery } from "../../src/rails/cctp/delivery.js";
import { verifyItsDelivery } from "../../src/rails/axelar/delivery.js";
import { ITS_ABI, type DeliveryLog } from "../../src/rails/axelar/events.js";
import { loadConfig } from "../../src/config/config.js";
import type { Queryable } from "../../src/db/pool.js";
import type { PendingTransfer, RailReport } from "../../src/rails/types.js";
import { completeEnv, destinationProofMutations, type Mutation } from "../helpers.js";
import { runProofCorpus, type ProofMutationCase } from "../tooling/proof-corpus.js";
import { cctpProofFixture, itsProofFixture } from "../tooling/proof-fixtures.js";

const evm = vi.hoisted(() => ({
  getChainId: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getBlockNumber: vi.fn(),
  readContract: vi.fn(),
  getBlock: vi.fn(),
}));
vi.mock("viem", async (original) => ({
  ...(await original<typeof Viem>()),
  createPublicClient: () => evm,
}));
afterEach(() => vi.restoreAllMocks());
const hash: Hex = `0x${"ef".repeat(32)}`;
const changedHash: Hex = `0x${"dd".repeat(32)}`;
interface Candidate {
  readonly logs: readonly DeliveryLog[];
  readonly blockHash: Hex;
  readonly message: Hex;
}
const transfer: PendingTransfer = {
  transferId: 1n,
  route: 0,
  originChain: "stellar-testnet",
  destinationChain: "sepolia",
  nonce: 18446744073709551615n,
  originTx: hash,
  status: null,
  checkFailures: 0,
  retryAttempts: 0,
  delivered: false,
};
describe("independent real CCTP and ITS destination proof mutation corpus", () => {
  it.each(["CCTP", "ITS"] as const)(
    "runs %s receipt/message mutations and records actual full-verifier outcomes",
    async (rail) => {
      const cctp = cctpProofFixture(),
        its = itsProofFixture(RAIL_CONTRACTS.sepolia?.axelar?.interchainTokenService as Hex);
      const config = loadConfig({ env: completeEnv() });
      const source = config.deployments.networks["stellar-testnet"];
      if (source?.family !== "stellar") throw new Error("Missing Stellar fixture");
      const usdc = source.tokens.USDC;
      const destinationChain = CHAINS.sepolia;
      if (!usdc || destinationChain.family !== "evm")
        throw new Error("Missing token/chain fixture");
      const modifiedConfig = {
        ...config,
        deployments: {
          ...config.deployments,
          networks: {
            ...config.deployments.networks,
            "stellar-testnet": {
              ...source,
              adapters: {
                ...source.adapters,
                [RouteKind.Cctp]: cctp.expected.sourceAdapter,
                [RouteKind.AxelarIts]: cctp.expected.sourceAdapter,
              },
              tokens: {
                ...source.tokens,
                USDC: { ...usdc, sacId: cctp.expected.sourceToken },
              },
            },
          },
        },
      };
      const proof = rail === "CCTP" ? cctp : its;
      const baseline: Candidate = {
        logs: [proof.received, proof.paid],
        blockHash: hash,
        message: cctp.raw,
      };
      const cases: ProofMutationCase<Candidate>[] = [
        { name: "valid proof", mutation: null, candidate: baseline, expectedAccepted: true },
      ];
      const mutations = destinationProofMutations({
        recipient: proof.expected.recipient,
        amount: (rail === "CCTP" ? 99600000n : its.expected.amount).toString(),
        token: proof.expected.token,
        domain: rail === "CCTP" ? "0" : its.expected.sourceChain,
        canonicalHash: hash,
      });
      for (const mutation of mutations) {
        let candidate: Candidate = { ...baseline };
        switch (mutation.field) {
          case "recipient":
            candidate = {
              ...baseline,
              logs: [
                proof.received,
                {
                  ...proof.paid,
                  topics: encodeEventTopics({
                    abi: ITS_ABI,
                    eventName: "Transfer",
                    args: {
                      from:
                        rail === "CCTP"
                          ? `0x${"0".repeat(40)}`
                          : (its.expected.tokenManager as Hex),
                      to: its.expected.token as Hex,
                    },
                  }) as [Hex, ...Hex[]],
                },
              ],
            };
            break;
          case "amount":
            candidate = {
              ...baseline,
              logs: [
                proof.received,
                {
                  ...proof.paid,
                  data: encodeAbiParameters(
                    [{ type: "uint256" }],
                    [(rail === "CCTP" ? 99600000n : its.expected.amount) + 1n],
                  ),
                },
              ],
            };
            break;
          case "token":
            candidate = {
              ...baseline,
              logs: [proof.received, { ...proof.paid, address: its.expected.recipient as Hex }],
            };
            break;
          case "domain": {
            if (rail === "CCTP") {
              const bytes = hexToBytes(cctp.raw);
              new DataView(bytes.buffer).setUint32(8, 6);
              candidate = { ...baseline, message: toHex(bytes) };
            } else
              candidate = {
                ...baseline,
                logs: [
                  {
                    ...proof.received,
                    data: encodeAbiParameters(
                      [
                        { type: "string" },
                        { type: "bytes" },
                        { type: "uint256" },
                        { type: "bytes32" },
                      ],
                      [
                        "wrong-source-chain",
                        its.expected.sourceAddress as Hex,
                        its.expected.amount,
                        `0x${"0".repeat(64)}`,
                      ],
                    ),
                  },
                  proof.paid,
                ],
              };
            break;
          }
          case "canonicalHash":
            candidate = { ...baseline, blockHash: changedHash };
            break;
        }
        const actualValues: Record<Mutation["field"], string> = {
          recipient: its.expected.token,
          amount: ((rail === "CCTP" ? 99600000n : its.expected.amount) + 1n).toString(),
          token: its.expected.recipient,
          domain: rail === "CCTP" ? "6" : "wrong-source-chain",
          canonicalHash: changedHash,
        };
        cases.push({
          name: mutation.field,
          mutation: { ...mutation, mutated: actualValues[mutation.field] },
          candidate,
          expectedAccepted: false,
        });
      }
      cases.push({
        name: "unrelated receipt log",
        mutation: null,
        candidate: {
          ...baseline,
          logs: [
            proof.received,
            { address: its.expected.token as Hex, topics: [], data: "0x", logIndex: 99 },
            proof.paid,
          ],
        },
        expectedAccepted: true,
      });
      const db: Queryable = {
        query: (sql: string) =>
          Promise.resolve(
            sql.includes("FROM inbound_delivery")
              ? { rows: [], rowCount: 0 }
              : {
                  rows: [
                    {
                      origin_chain: transfer.originChain,
                      origin_router: source.router,
                      nonce: transfer.nonce.toString(),
                      origin_tx: transfer.originTx,
                      destination_chain: transfer.destinationChain,
                      sender: "Gsource",
                      token: cctp.expected.sourceToken,
                      net_amount:
                        rail === "CCTP"
                          ? cctp.expected.sourceAmount.toString()
                          : its.expected.amount.toString(),
                      destination: `0x${its.expected.recipient.slice(2).padStart(64, "0")}`,
                    },
                  ],
                  rowCount: 1,
                },
          ),
      };
      const stellar = vi.spyOn(rpc.Server.prototype, "simulateTransaction");
      const simulation = (value: unknown) => ({
        _parsed: true,
        id: "fixture",
        latestLedger: 100,
        events: [],
        minResourceFee: "0",
        transactionData: new SorobanDataBuilder(),
        result: { auth: [], retval: nativeToScVal(value) },
      });
      const records = await runProofCorpus(cases, async (candidate) => {
        evm.getChainId.mockResolvedValue(destinationChain.chainId);
        evm.getBlockNumber.mockResolvedValue(1000n);
        evm.getTransactionReceipt.mockResolvedValue({
          status: "success",
          blockNumber: 100n,
          transactionHash: hash,
          blockHash: hash,
          logs: candidate.logs,
        });
        evm.getBlock.mockResolvedValue({ hash: candidate.blockHash, timestamp: 1700000000n });
        evm.readContract.mockImplementation(({ functionName }: { functionName: string }) =>
          Promise.resolve(
            functionName === "registeredTokenAddress"
              ? its.expected.token
              : its.expected.tokenManager,
          ),
        );
        stellar
          .mockReset()
          .mockResolvedValueOnce(simulation(hexToBytes(its.expected.tokenId as Hex)))
          .mockResolvedValueOnce(simulation({ its: cctp.expected.sourceAdapter }))
          .mockResolvedValueOnce(simulation(its.expected.sourceChain));
        const report: RailReport = {
          status: "attested",
          railStatus: "fixture-only",
          reference: null,
          attestedAt: null,
          forwardTxHash: hash,
          messageBytes: candidate.message,
          execution: { txHash: hash, commandId: its.expected.commandId as Hex },
        };
        if (rail === "CCTP") return verifyCctpDelivery(modifiedConfig, db, transfer, report);
        const outcome = await verifyItsDelivery(
          modifiedConfig,
          db,
          { ...transfer, route: RouteKind.AxelarIts },
          report,
        );
        if (outcome !== null && "diagnostics" in outcome) {
          expect(outcome.state).toBe("payout_unverified");
          expect(outcome.diagnostics.length).toBeGreaterThan(0);
          return null;
        }
        return outcome;
      });
      expect(
        records.every((record) => record.matchesExpectation),
        JSON.stringify(records),
      ).toBe(true);
      expect(records.map((record) => record.accepted)).toEqual([
        true,
        false,
        false,
        false,
        false,
        false,
        true,
      ]);
      expect(
        records.filter((record) => record.mutation).map((record) => record.mutation?.field),
      ).toEqual(["recipient", "amount", "token", "domain", "canonicalHash"]);
      expect(RAIL_CONTRACTS.sepolia?.cctp?.tokenMessengerV2.toLowerCase()).toBe(
        cctp.expected.destinationMessenger.toLowerCase(),
      );
      if (rail === "ITS") {
        const report: RailReport = {
          status: "attested",
          railStatus: "executed",
          reference: null,
          attestedAt: null,
          execution: { txHash: hash, commandId: its.expected.commandId as Hex },
        };
        evm.getTransactionReceipt.mockRejectedValueOnce(
          new Error("receipt temporarily unavailable"),
        );
        stellar
          .mockReset()
          .mockResolvedValueOnce(simulation(hexToBytes(its.expected.tokenId as Hex)));
        const unavailable = await verifyItsDelivery(
          modifiedConfig,
          db,
          { ...transfer, route: RouteKind.AxelarIts },
          {
            status: "attested",
            railStatus: "executed",
            reference: null,
            attestedAt: null,
            execution: { txHash: hash, commandId: its.expected.commandId as Hex },
          },
        );
        expect(unavailable).toEqual({ state: "receipt_unavailable", diagnostics: [] });

        const withSecondary = {
          ...modifiedConfig,
          destinationVerification: {
            ...modifiedConfig.destinationVerification,
            evmRpcUrls: {
              ...modifiedConfig.destinationVerification.evmRpcUrls,
              sepolia: ["https://primary.example/private-key", "https://secondary.example/rpc"],
            },
          },
        };
        evm.getTransactionReceipt.mockClear().mockResolvedValue({
          status: "success",
          blockNumber: 100n,
          transactionHash: hash,
          blockHash: hash,
          logs: [its.received, its.paid],
        });
        evm.getTransactionReceipt.mockRejectedValueOnce(new Error("primary unavailable"));
        stellar
          .mockReset()
          .mockResolvedValueOnce(simulation(hexToBytes(its.expected.tokenId as Hex)))
          .mockResolvedValueOnce(simulation({ its: cctp.expected.sourceAdapter }))
          .mockResolvedValueOnce(simulation(its.expected.sourceChain));
        const recovered = await verifyItsDelivery(
          withSecondary,
          db,
          { ...transfer, route: RouteKind.AxelarIts },
          report,
        );
        expect(recovered).not.toBeNull();
        expect(
          recovered !== null && "diagnostics" in recovered ? recovered.state : "verified",
        ).toBe("verified");
        expect(evm.getTransactionReceipt).toHaveBeenCalledTimes(2);

        evm.getTransactionReceipt.mockClear().mockRejectedValue(new Error("all endpoints offline"));
        stellar
          .mockReset()
          .mockResolvedValueOnce(simulation(hexToBytes(its.expected.tokenId as Hex)))
          .mockResolvedValueOnce(simulation({ its: cctp.expected.sourceAdapter }))
          .mockResolvedValueOnce(simulation(its.expected.sourceChain));
        const exhausted = await verifyItsDelivery(
          withSecondary,
          db,
          { ...transfer, route: RouteKind.AxelarIts },
          report,
        );
        expect(exhausted).toEqual({ state: "receipt_unavailable", diagnostics: [] });

        evm.getChainId.mockResolvedValue(1);
        evm.getTransactionReceipt.mockClear();
        stellar
          .mockReset()
          .mockResolvedValueOnce(simulation(hexToBytes(its.expected.tokenId as Hex)))
          .mockResolvedValueOnce(simulation({ its: cctp.expected.sourceAdapter }))
          .mockResolvedValueOnce(simulation(its.expected.sourceChain));
        const wrongNetwork = await verifyItsDelivery(
          withSecondary,
          db,
          { ...transfer, route: RouteKind.AxelarIts },
          report,
        );
        expect(wrongNetwork).toEqual({ state: "receipt_unavailable", diagnostics: [] });
        expect(evm.getTransactionReceipt).not.toHaveBeenCalled();
      }
      console.info("HYPERION_PROOF_MUTATION_CORPUS " + JSON.stringify({ rail, records }));
    },
  );
  it("does not turn an exception or unexpected acceptance into a passing rejection", async () => {
    const cases = [{ name: "bad proof", mutation: null, candidate: null, expectedAccepted: false }];
    expect(
      (await runProofCorpus(cases, () => Promise.resolve({ forged: true })))[0]?.matchesExpectation,
    ).toBe(false);
    await expect(
      runProofCorpus(cases, () => Promise.reject(new Error("provider unavailable"))),
    ).rejects.toThrow("provider unavailable");
  });
});
