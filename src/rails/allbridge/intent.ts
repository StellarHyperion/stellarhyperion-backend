import { createHash, createPublicKey, verify } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { keccak256, type Hex } from "viem";

/** Fields signed by the implemented Allbridge adapter, plus independently indexed source references. */
export interface AllbridgeSignedIntent {
  readonly messageId: string;
  readonly sourceChain: string;
  readonly destinationChain: string;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly sourceTransaction: string;
  readonly sourceBlockHash: string;
  readonly nonce: string;
  readonly token: string;
  readonly recipient: string;
  readonly amount: string;
  readonly validatorEpoch: number;
  readonly signature: string;
}

/** Trusted deployment review supplies the active network, adapter and validator epoch. */
export interface AllbridgeConfiguredValidator {
  readonly publicKey: string;
  readonly keyId: string;
  readonly networkId: string;
  readonly adapter: string;
  readonly epoch: number;
  /** Legacy epoch zero is never admitted implicitly. */
  readonly allowLegacyEpoch?: boolean;
}

/** Provider discovery only. These flags do not establish chain finality or payout. */
export interface AllbridgeDestinationPayment {
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly logIndex: number;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
  readonly finalized: boolean;
  readonly reverted: boolean;
}

export interface AllbridgePaymentEvidence {
  readonly sourceMessageMatched: boolean;
  readonly destinationPaymentMatched: boolean;
  readonly intentSignatureVerified: boolean;
  readonly receiptVerified: boolean;
  readonly receiptCanonical: boolean;
  readonly replaySafe: boolean;
}

export interface AllbridgeVerificationResult {
  readonly state: "verified" | "intent_verified" | "pending" | "blocked";
  readonly evidence: AllbridgePaymentEvidence;
  readonly reason: string;
}

export function allbridgeAddressKey(value: string): Buffer {
  if (/^0x[0-9a-fA-F]{40}$/.test(value))
    return Buffer.from(value.slice(2).padStart(64, "0"), "hex");
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value.replace(/^0x/, ""), "hex");
  if (StrKey.isValidEd25519PublicKey(value))
    return Buffer.from(StrKey.decodeEd25519PublicKey(value));
  if (StrKey.isValidContract(value)) return Buffer.from(StrKey.decodeContract(value));
  throw new Error("Allbridge address is not a supported 32-byte identity.");
}

function uint(value: string, bits: number, positive = false): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error("Allbridge integer is malformed.");
  const result = BigInt(value);
  if (result >= 1n << BigInt(bits) || (positive && result === 0n))
    throw new Error("Allbridge integer exceeds the contract range.");
  return result;
}

function word(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

/** Exact hyperion-adapter-allbridge rail::hash_message, including messenger routing bytes. */
export function allbridgeMessageId(intent: AllbridgeSignedIntent): Hex {
  for (const id of [intent.sourceChainId, intent.destinationChainId]) {
    if (!Number.isInteger(id) || id < 0 || id > 255)
      throw new Error("Allbridge chain identifier is outside messenger routing range.");
  }
  const preimage = Buffer.concat([
    word(uint(intent.amount, 127, true)),
    allbridgeAddressKey(intent.recipient),
    word(BigInt(intent.sourceChainId)),
    allbridgeAddressKey(intent.token),
    word(uint(intent.nonce, 256)),
    Buffer.from([1]),
  ]);
  const digest = Buffer.from(keccak256(`0x${preimage.toString("hex")}`).slice(2), "hex");
  digest[0] = intent.sourceChainId;
  digest[1] = intent.destinationChainId;
  return `0x${digest.toString("hex")}`;
}

/** Exact rail::validator_attestation_digest; source transaction identity is verified separately. */
export function allbridgeIntentPayload(
  intent: AllbridgeSignedIntent,
  validator: AllbridgeConfiguredValidator,
): Buffer {
  const message = Buffer.from(allbridgeMessageId(intent).slice(2), "hex");
  if (
    validator.epoch !== intent.validatorEpoch ||
    !Number.isInteger(validator.epoch) ||
    validator.epoch < 0 ||
    validator.epoch > 0xffffffff
  )
    throw new Error("Allbridge validator epoch does not match.");
  if (validator.epoch === 0) {
    if (validator.allowLegacyEpoch !== true)
      throw new Error("Legacy validator epoch requires explicit review.");
    return message;
  }
  if (
    !/^(0x)?[0-9a-fA-F]{64}$/.test(validator.networkId) ||
    !StrKey.isValidContract(validator.adapter)
  )
    throw new Error("Allbridge deployment identity is malformed.");
  const publicKey = createPublicKey(validator.publicKey);
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("Allbridge requires an Ed25519 validator.");
  const rawKey = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  const epoch = Buffer.alloc(4);
  epoch.writeUInt32BE(validator.epoch);
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("HYPERION_ALLBRIDGE_VALIDATOR_V1"),
        Buffer.from(validator.networkId.replace(/^0x/, ""), "hex"),
        allbridgeAddressKey(validator.adapter),
        epoch,
        rawKey,
        message,
      ]),
    )
    .digest();
}

export function verifyAllbridgeSignedIntent(
  intent: AllbridgeSignedIntent,
  validators: readonly AllbridgeConfiguredValidator[],
): boolean {
  try {
    if (
      validators.length === 0 ||
      validators.length > 32 ||
      !/^[0-9a-fA-F]{128}$/.test(intent.signature) ||
      ![intent.sourceChain, intent.destinationChain].every(
        (value) => value.length > 0 && value.length <= 256,
      ) ||
      ![intent.sourceTransaction, intent.sourceBlockHash].every((value) =>
        /^(0x)?[0-9a-fA-F]{64}$/.test(value),
      ) ||
      allbridgeMessageId(intent).toLowerCase() !== intent.messageId.toLowerCase()
    )
      return false;
    return validators.some((validator) => {
      try {
        if (validator.keyId.length === 0 || validator.keyId.length > 256) return false;
        const publicKey = createPublicKey(validator.publicKey);
        return (
          publicKey.asymmetricKeyType === "ed25519" &&
          verify(
            null,
            allbridgeIntentPayload(intent, validator),
            publicKey,
            Buffer.from(intent.signature, "hex"),
          )
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Signature and provider discovery never become a successful payment without canonical chain inspection. */
export function evaluateAllbridgePayment(
  intent: AllbridgeSignedIntent,
  _payment: AllbridgeDestinationPayment | undefined,
  validators: readonly AllbridgeConfiguredValidator[],
  source: Omit<AllbridgeSignedIntent, "signature" | "validatorEpoch">,
): AllbridgeVerificationResult {
  const intentSignatureVerified = verifyAllbridgeSignedIntent(intent, validators);
  const sourceMessageMatched = [
    "sourceChain",
    "destinationChain",
    "sourceChainId",
    "destinationChainId",
    "sourceTransaction",
    "sourceBlockHash",
    "nonce",
    "token",
    "recipient",
    "amount",
    "messageId",
  ].every(
    (key) => intent[key as keyof AllbridgeSignedIntent] === source[key as keyof typeof source],
  );
  const evidence: AllbridgePaymentEvidence = {
    sourceMessageMatched,
    intentSignatureVerified,
    destinationPaymentMatched: false,
    receiptVerified: false,
    receiptCanonical: false,
    replaySafe: false,
  };
  if (intentSignatureVerified && sourceMessageMatched)
    return {
      state: "intent_verified",
      evidence,
      reason:
        "configured validator signed the adapter message; canonical destination payout remains unverified",
    };
  if (intentSignatureVerified)
    return {
      state: "blocked",
      evidence,
      reason: "validator signature does not bind the independently indexed source record",
    };
  return {
    state: "pending",
    evidence,
    reason: "matching configured validator epoch or signed adapter message is unavailable",
  };
}
