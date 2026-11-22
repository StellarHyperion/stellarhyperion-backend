import { createPublicKey, verify } from "node:crypto";

/**
 * Allbridge's validator signature is an attestation about a provider message, not proof that the
 * destination chain paid the recipient.  The two records are intentionally separate.
 */
export interface AllbridgeSignedIntent {
    readonly messageId: string;
    readonly sourceChain: string;
    readonly destinationChain: string;
    readonly sourceTransaction: string;
    readonly sourceBlockHash: string;
    readonly nonce: string;
    readonly token: string;
    readonly amount: string;
    readonly signature: string;
}

export interface AllbridgeConfiguredValidator {
    readonly publicKey: string;
    readonly keyId: string;
}

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

export function allbridgeIntentPayload(intent: AllbridgeSignedIntent): Buffer {
    return Buffer.from(
        JSON.stringify([
            "hyperion-allbridge-signed-intent-v1",
            intent.messageId,
            intent.sourceChain,
            intent.destinationChain,
            intent.sourceTransaction,
            intent.sourceBlockHash,
            intent.nonce,
            intent.token,
            intent.amount,
        ]),
    );
}

function validHash(value: string): boolean {
    return /^(0x)?[0-9a-fA-F]{64}$/.test(value);
}

function validAmount(value: string): boolean {
    return /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) <= (1n << 256n) - 1n;
}

export function verifyAllbridgeSignedIntent(
    intent: AllbridgeSignedIntent,
    validators: readonly AllbridgeConfiguredValidator[],
): boolean {
    if (
        intent.messageId.length === 0 ||
        intent.messageId.length > 512 ||
        intent.sourceChain.length === 0 ||
        intent.sourceChain.length > 256 ||
        intent.destinationChain.length === 0 ||
        intent.destinationChain.length > 256 ||
        intent.token.length === 0 ||
        intent.token.length > 256 ||
        !validHash(intent.sourceTransaction) ||
        !validHash(intent.sourceBlockHash) ||
        !/^\d+$/.test(intent.nonce) ||
        !validAmount(intent.amount) ||
        !/^[0-9a-fA-F]{128}$/.test(intent.signature)
    ) {
        return false;
    }

    try {
        const payload = allbridgeIntentPayload(intent);
        const signature = Buffer.from(intent.signature, "hex");
        return validators.some((validator) => {
            const publicKey = createPublicKey(validator.publicKey);
            return (
                publicKey.asymmetricKeyType === "ed25519" &&
                verify(null, payload, publicKey, signature)
            );
        });
    } catch {
        return false;
    }
}

export function evaluateAllbridgePayment(
    intent: AllbridgeSignedIntent,
    payment: AllbridgeDestinationPayment | undefined,
    validators: readonly AllbridgeConfiguredValidator[],
    source: {
        readonly sourceChain: string;
        readonly destinationChain: string;
        readonly sourceTransaction: string;
        readonly sourceBlockHash: string;
        readonly nonce: string;
        readonly token: string;
        readonly amount: string;
    },
): AllbridgeVerificationResult {
    const intentSignatureVerified = verifyAllbridgeSignedIntent(intent, validators);
    const sourceMessageMatched =
        intent.sourceChain === source.sourceChain &&
        intent.destinationChain === source.destinationChain &&
        intent.sourceTransaction.toLowerCase() === source.sourceTransaction.toLowerCase() &&
        intent.sourceBlockHash.toLowerCase() === source.sourceBlockHash.toLowerCase() &&
        intent.nonce === source.nonce &&
        intent.token === source.token &&
        intent.amount === source.amount;

    const destinationPaymentMatched =
        payment !== undefined &&
        validHash(payment.transactionHash) &&
        validHash(payment.blockHash) &&
        Number.isSafeInteger(payment.logIndex) &&
        payment.logIndex >= 0 &&
        payment.finalized &&
        !payment.reverted &&
        validAmount(payment.amount) &&
        payment.token === intent.token &&
        payment.amount === intent.amount;

    const evidence: AllbridgePaymentEvidence = {
        sourceMessageMatched,
        destinationPaymentMatched,
        intentSignatureVerified,
        receiptVerified:
            payment !== undefined &&
            payment.finalized &&
            !payment.reverted &&
            validHash(payment.transactionHash) &&
            validHash(payment.blockHash),
        receiptCanonical:
            payment !== undefined &&
            Number.isSafeInteger(payment.logIndex) &&
            payment.logIndex >= 0,
        replaySafe:
            payment !== undefined &&
            validHash(payment.transactionHash) &&
            validHash(payment.blockHash) &&
            validAmount(payment.amount),
    };

    if (intentSignatureVerified && sourceMessageMatched && destinationPaymentMatched && evidence.replaySafe) {
        return { state: "verified", evidence, reason: "signed intent and canonical destination payout verified" };
    }
    if (intentSignatureVerified && sourceMessageMatched) {
        return {
            state: "intent_verified",
            evidence,
            reason: "configured validator signed the source intent; destination payout remains unverified",
        };
    }
    if (intentSignatureVerified) {
        return {
            state: "blocked",
            evidence,
            reason: "validator signature is valid but source message identity does not match",
        };
    }
    return {
        state: "pending",
        evidence,
        reason: "signed validator intent or configured validator trust is unavailable",
    };
}
