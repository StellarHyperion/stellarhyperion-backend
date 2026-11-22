import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    allbridgeIntentPayload,
    evaluateAllbridgePayment,
    type AllbridgeSignedIntent,
} from "../../src/rails/allbridge/intent.js";

describe("Allbridge signed intent verification", () => {
    it("distinguishes validator intent from destination payout", () => {
        const { publicKey, privateKey } = generateKeyPairSync("ed25519");
        const intent: AllbridgeSignedIntent = {
            messageId: "allbridge-message-1",
            sourceChain: "stellar-testnet",
            destinationChain: "sepolia",
            sourceTransaction: `0x${"11".repeat(32)}`,
            sourceBlockHash: `0x${"22".repeat(32)}`,
            nonce: "7",
            token: "USDC",
            amount: "123456",
            signature: "",
        };
        const unsignedPayload = allbridgeIntentPayload(intent);
        intent.signature = sign(null, unsignedPayload, privateKey).toString("hex");
        const validator = { keyId: "reviewed-validator", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
        const source = {
            sourceChain: intent.sourceChain,
            destinationChain: intent.destinationChain,
            sourceTransaction: intent.sourceTransaction,
            sourceBlockHash: intent.sourceBlockHash,
            nonce: intent.nonce,
            token: intent.token,
            amount: intent.amount,
        };

        expect(evaluateAllbridgePayment(intent, undefined, [validator], source).state).toBe("intent_verified");
        expect(evaluateAllbridgePayment(intent, {
            transactionHash: `0x${"33".repeat(32)}`,
            blockHash: `0x${"44".repeat(32)}`,
            blockNumber: "100",
            logIndex: 2,
            recipient: `0x${"55".repeat(20)}`,
            token: "USDC",
            amount: "123456",
            finalized: true,
            reverted: false,
        }, [validator], source).state).toBe("verified");
    });

    it("rejects a signature whose source message or payment identity differs", () => {
        const { publicKey, privateKey } = generateKeyPairSync("ed25519");
        const intent: AllbridgeSignedIntent = {
            messageId: "allbridge-message-2",
            sourceChain: "stellar-testnet",
            destinationChain: "sepolia",
            sourceTransaction: `0x${"11".repeat(32)}`,
            sourceBlockHash: `0x${"22".repeat(32)}`,
            nonce: "8",
            token: "USDC",
            amount: "999",
            signature: "",
        };
        intent.signature = sign(null, allbridgeIntentPayload(intent), privateKey).toString("hex");
        const validator = { keyId: "reviewed-validator", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
        const mismatched = evaluateAllbridgePayment(intent, {
            transactionHash: `0x${"33".repeat(32)}`,
            blockHash: `0x${"44".repeat(32)}`,
            blockNumber: "101",
            logIndex: 3,
            recipient: `0x${"55".repeat(20)}`,
            token: "USDC",
            amount: "1000",
            finalized: true,
            reverted: false,
        }, [validator], { ...intent, sourceTransaction: `0x${"66".repeat(32)}` });
        expect(mismatched.state).toBe("blocked");
    });
});
