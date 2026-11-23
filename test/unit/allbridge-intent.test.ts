import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  allbridgeIntentPayload,
  allbridgeMessageId,
  evaluateAllbridgePayment,
  verifyAllbridgeSignedIntent,
  type AllbridgeSignedIntent,
  type AllbridgeConfiguredValidator,
} from "../../src/rails/allbridge/intent.js";

const key = generateKeyPairSync("ed25519");
const validator: AllbridgeConfiguredValidator = {
  publicKey: key.publicKey.export({ type: "spki", format: "pem" }),
  keyId: "reviewed-active-key",
  networkId: "0x" + "77".repeat(32),
  adapter: StrKey.encodeContract(Buffer.from("88".repeat(32), "hex")),
  epoch: 42,
};
const unsigned: AllbridgeSignedIntent = {
  messageId: "",
  sourceChain: "ethereum",
  destinationChain: "stellar-testnet",
  sourceChainId: 1,
  destinationChainId: 7,
  sourceTransaction: `0x${"11".repeat(32)}`,
  sourceBlockHash: `0x${"22".repeat(32)}`,
  nonce: ((1n << 256n) - 1n).toString(),
  recipient: `0x${"55".repeat(32)}`,
  token: `0x${"66".repeat(32)}`,
  amount: "123456",
  validatorEpoch: 42,
  signature: "",
};
const withId = { ...unsigned, messageId: allbridgeMessageId(unsigned) };
const signed = {
  ...withId,
  signature: sign(null, allbridgeIntentPayload(withId, validator), key.privateKey).toString("hex"),
};
const source = { ...signed };
const providerPayment = {
  transactionHash: `0x${"33".repeat(32)}`,
  blockHash: `0x${"44".repeat(32)}`,
  blockNumber: "100",
  logIndex: 2,
  recipient: signed.recipient,
  token: signed.token,
  amount: signed.amount,
  finalized: true,
  reverted: false,
};

describe("Allbridge actual adapter message and validator epoch", () => {
  it("matches an independently computed161-byte contract wire vector including both routing bytes", () => {
    expect(allbridgeMessageId(unsigned)).toBe(
      "0x01071b9474b3ef5275dde9fd27fdf219c0b5a2ae3901a6a1574d0e8793007ac2",
    );
    const epoch = Buffer.alloc(4);
    epoch.writeUInt32BE(42);
    const rawKey = Buffer.from(key.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
    const independentlyPacked = Buffer.concat([
      Buffer.from("HYPERION_ALLBRIDGE_VALIDATOR_V1"),
      Buffer.from("77".repeat(32), "hex"),
      Buffer.from("88".repeat(32), "hex"),
      epoch,
      rawKey,
      Buffer.from(signed.messageId.slice(2), "hex"),
    ]);
    expect(allbridgeIntentPayload(signed, validator)).toEqual(
      createHash("sha256").update(independentlyPacked).digest(),
    );
    expect(verifyAllbridgeSignedIntent(signed, [validator])).toBe(true);
  });
  it("distinguishes configured validator intent from fabricated provider payout flags", () => {
    for (const payment of [
      undefined,
      providerPayment,
      { ...providerPayment, recipient: "wrong" },
    ]) {
      const result = evaluateAllbridgePayment(signed, payment, [validator], source);
      expect(result.state).toBe("intent_verified");
      expect(result.evidence).toMatchObject({
        intentSignatureVerified: true,
        sourceMessageMatched: true,
        destinationPaymentMatched: false,
        receiptVerified: false,
        receiptCanonical: false,
        replaySafe: false,
      });
    }
  });
  it.each([
    "recipient",
    "token",
    "nonce",
    "amount",
    "sourceChainId",
    "destinationChainId",
    "messageId",
  ] as const)("rejects changed signed%s", (field) => {
    const mutation =
      field === "nonce" || field === "amount"
        ? "1"
        : field.endsWith("Id") && field !== "messageId"
          ? 2
          : `0x${"99".repeat(32)}`;
    expect(verifyAllbridgeSignedIntent({ ...signed, [field]: mutation }, [validator])).toBe(false);
  });
  it.each(["sourceTransaction", "sourceBlockHash", "sourceChain", "destinationChain"] as const)(
    "requires independent source binding for%s that the contract digest does not sign",
    (field) => {
      expect(
        evaluateAllbridgePayment(signed, providerPayment, [validator], {
          ...source,
          [field]: "other",
        }).state,
      ).toBe("blocked");
    },
  );
  it.each([
    { epoch: 43 },
    { networkId: "aa".repeat(32) },
    { adapter: StrKey.encodeContract(Buffer.from("aa".repeat(32), "hex")) },
    {
      publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }),
    },
  ])("rejects network/adapter/epoch/key substitution", (change) => {
    expect(verifyAllbridgeSignedIntent(signed, [{ ...validator, ...change }])).toBe(false);
  });
  it("requires explicit legacy epoch review and does not reuse that signature in an active epoch", () => {
    const old = { ...withId, validatorEpoch: 0 };
    const legacy = { ...validator, epoch: 0, allowLegacyEpoch: true };
    const intent = {
      ...old,
      signature: sign(null, allbridgeIntentPayload(old, legacy), key.privateKey).toString("hex"),
    };
    expect(verifyAllbridgeSignedIntent(intent, [{ ...legacy, allowLegacyEpoch: false }])).toBe(
      false,
    );
    expect(verifyAllbridgeSignedIntent(intent, [legacy])).toBe(true);
    expect(verifyAllbridgeSignedIntent(intent, [validator])).toBe(false);
  });
  it.each([
    { nonce: (1n << 256n).toString() },
    { nonce: "0001" },
    { amount: (1n << 127n).toString() },
    { amount: "0" },
    { amount: "-1" },
    { sourceChainId: 256 },
    { destinationChainId: -1 },
    { signature: "00" },
    { recipient: "invalid-strkey" },
    { validatorEpoch: 1.5 },
  ])("rejects malformed and contract-out-of-range values", (change) => {
    expect(verifyAllbridgeSignedIntent({ ...signed, ...change }, [validator])).toBe(false);
  });
  it("does not let one malformed configured key suppress a valid active key", () => {
    expect(
      verifyAllbridgeSignedIntent(signed, [{ ...validator, publicKey: "bad-key" }, validator]),
    ).toBe(true);
    expect(
      verifyAllbridgeSignedIntent(
        signed,
        Array.from({ length: 33 }, () => validator),
      ),
    ).toBe(false);
  });
});
