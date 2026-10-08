/**
 * The two rail clients, against the response shapes their APIs actually produce.
 *
 * Every status code and error body asserted here was observed against the live sandbox and testnet
 * endpoints, and the two that matter most are the ones a reasonable person would get backwards.
 * Circle reports a transfer it has not indexed as a 404; Axelar reports the same situation as a 200
 * with an empty array. Both are the normal state of a transfer that left its chain a minute ago,
 * and a client that calls either one a failure reports every healthy transfer as broken and spends
 * its backoff doing it.
 */
import { describe, expect, it } from "vitest";

import { AxelarGmpClient } from "../../src/rails/axelar/gmp.js";
import {
  CCTP_DOMAINS,
  domainFor,
  isIrisMessage,
  isIrisResponsePayload,
  IrisClient,
  reportFor,
} from "../../src/rails/cctp/iris.js";
import { RailError, type PendingTransfer } from "../../src/rails/types.js";

const TRANSFER: PendingTransfer = {
  transferId: 1n,
  route: 0,
  originChain: "sepolia",
  destinationChain: "stellar-testnet",
  nonce: 7n,
  originTx: `0x${"ab".repeat(32)}`,
  status: null,
  checkFailures: 0,
  delivered: false,
};

/** A fetch that answers once, recording what it was asked. */
function answering(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = ((input: unknown, _init?: RequestInit) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Circle's Iris", () => {
  it("asks by source domain and transaction hash", async () => {
    // The transaction hash is enough; there is no need to derive the message hash, and the domain
    // comes from the shared chain registry rather than a table here. Sepolia is domain 0.
    const { fetch, calls } = answering(404, { error: "Message not found for provided parameters" });
    await new IrisClient("testnet", { fetch }).look(TRANSFER);

    expect(calls[0]).toContain("/v2/messages/0?transactionHash=");
    expect(calls[0]).toContain(TRANSFER.originTx);
    expect(calls[0]).toContain("iris-api-sandbox.circle.com");
  });

  it("reads a 404 as not indexed yet, not as a failure", async () => {
    // The single most important line in this suite. This is what every CCTP transfer looks like
    // for the first minute of its life.
    const { fetch } = answering(404, { error: "Message not found for provided parameters" });
    const lookup = await new IrisClient("testnet", { fetch }).look(TRANSFER);
    expect(lookup).toEqual({ kind: "missing" });
  });

  it("reads a 200 with no messages the same way", async () => {
    const { fetch } = answering(200, { messages: [], sourceTxHash: TRANSFER.originTx });
    const lookup = await new IrisClient("testnet", { fetch }).look(TRANSFER);
    expect(lookup).toEqual({ kind: "missing" });
  });

  it("maps pending_confirmations to pending and keeps Circle's own word", async () => {
    const { fetch } = answering(200, {
      messages: [{ status: "pending_confirmations", eventNonce: "42", attestation: "PENDING" }],
      sourceTxHash: TRANSFER.originTx,
    });
    const lookup = await new IrisClient("testnet", { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.status).toBe("pending");
    expect(lookup.report.railStatus).toBe("pending_confirmations");
    // The event nonce, because that is what Circle's support asks for.
    expect(lookup.report.reference).toBe("42");
    expect(lookup.report.attestedAt).toBeNull();
  });

  it("maps complete to attested and stamps the moment", async () => {
    const { fetch } = answering(200, {
      messages: [{ status: "complete", eventNonce: "42", attestation: `0x${"cd".repeat(32)}` }],
      sourceTxHash: TRANSFER.originTx,
    });
    const lookup = await new IrisClient("testnet", { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.status).toBe("attested");
    expect(lookup.report.attestedAt).toBeInstanceOf(Date);
  });

  it("keeps a delay reason, because it is the difference between slow and stuck", async () => {
    // insufficient_fee means the transfer sits until somebody reattests it. Invisible from the
    // status alone, which is pending either way.
    const { fetch } = answering(200, {
      messages: [
        { status: "pending_confirmations", delayReason: "insufficient_fee", eventNonce: "42" },
      ],
      sourceTxHash: TRANSFER.originTx,
    });
    const lookup = await new IrisClient("testnet", { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.status).toBe("pending");
    expect(lookup.report.railStatus).toBe("pending_confirmations/insufficient_fee");
  });

  it("surfaces a fast transfer's expiry block without claiming to have judged it", async () => {
    // Deciding a burn has expired needs the source chain's height, which this client has no
    // connection to. A transfer wrongly marked expired is terminal, so it stops being polled and
    // stops being chased, which is why the number is shown rather than acted on.
    const { fetch } = answering(200, {
      messages: [
        {
          status: "pending_confirmations",
          eventNonce: "42",
          decodedMessage: { decodedMessageBody: { expirationBlock: "9000" } },
        },
      ],
      sourceTxHash: TRANSFER.originTx,
    });
    const lookup = await new IrisClient("testnet", { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.status).toBe("pending");
    expect(lookup.report.railStatus).toContain("expires@9000");
  });

  it("treats a 429 as its own thing, with the five minutes Circle actually takes", async () => {
    // Circle blocks every request for five minutes after one. Doubling from a second would spend
    // those five minutes refreshing the block.
    const { fetch } = answering(429, { error: "rate limit exceeded" });
    await expect(new IrisClient("testnet", { fetch }).look(TRANSFER)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RailError &&
        error.kind === "rateLimited" &&
        error.retryAfterMs === 5 * 60_000,
    );
  });

  it("reads both error body shapes, because both are real", async () => {
    // The API reference documents {code, message}; the live sandbox returns {error}. A client that
    // understands only the documented one says "unparseable" for every error it ever sees.
    for (const body of [
      { error: "Invalid source domain id" },
      { code: 400, message: "Invalid source domain id" },
    ]) {
      const { fetch } = answering(400, body);
      await expect(new IrisClient("testnet", { fetch }).look(TRANSFER)).rejects.toThrow(
        /Invalid source domain id/,
      );
    }
  });

  it("calls a 400 permanent and a 500 worth another go", async () => {
    const bad = answering(400, { error: "Invalid source domain id" });
    await expect(new IrisClient("testnet", { fetch: bad.fetch }).look(TRANSFER)).rejects.toSatisfy(
      (error: unknown) => error instanceof RailError && error.kind === "permanent",
    );

    const broken = answering(503, { error: "upstream" });
    await expect(
      new IrisClient("testnet", { fetch: broken.fetch }).look(TRANSFER),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof RailError && error.kind === "transient",
    );
  });

  it("refuses a chain that has no CCTP domain, rather than retrying it forever", async () => {
    // A transfer filed under CCTP from a chain that cannot burn through CCTP was filed under the
    // wrong rail, and the lookup will be wrong the same way every time.
    const { fetch } = answering(200, { messages: [] });
    const client = new IrisClient("testnet", { fetch });
    await expect(client.look({ ...TRANSFER, originChain: "not-a-chain" })).rejects.toSatisfy(
      (error: unknown) => error instanceof RailError && error.kind === "permanent",
    );
  });

  it("correctly parses v2 Iris JSON payloads with data array and pagination", async () => {
    const { fetch } = answering(200, {
      data: [
        {
          message: "0x11223344",
          attestation: "0xaabbccdd",
          status: "complete",
          eventNonce: "100",
        },
      ],
      pagination: {
        page: 1,
        pageSize: 10,
        total: 1,
      },
    });
    const lookup = await new IrisClient("testnet", { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.status).toBe("attested");
    expect(lookup.report.reference).toBe("100");
    expect(lookup.report.message).toBe("0x11223344");
    expect(lookup.report.messageBytes).toBe("0x11223344");
    expect(lookup.report.attestation).toBe("0xaabbccdd");
    expect(lookup.report.attestationSignature).toBe("0xaabbccdd");
  });

  it("extracts message bytes, attestation signature, and attestation timestamp from v2 payload", async () => {
    const timestampStr = "2024-05-01T12:00:00.000Z";
    const expectedDate = new Date(timestampStr);
    const { fetch } = answering(200, {
      data: [
        {
          messageBytes: "0xdeadbeef",
          signature: "0xcafe",
          status: "completed",
          attestationTimestamp: timestampStr,
          messageId: "msg-999",
        },
      ],
    });
    const lookup = await new IrisClient("testnet", { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.status).toBe("attested");
    expect(lookup.report.messageBytes).toBe("0xdeadbeef");
    expect(lookup.report.message).toBe("0xdeadbeef");
    expect(lookup.report.attestationSignature).toBe("0xcafe");
    expect(lookup.report.attestation).toBe("0xcafe");
    expect(lookup.report.attestationTimestamp).toEqual(expectedDate);
    expect(lookup.report.attestedAt).toEqual(expectedDate);
    expect(lookup.report.reference).toBe("msg-999");
  });

  it("handles unix epoch timestamp in seconds or milliseconds", async () => {
    const epochSeconds = 1_714_564_800;
    const expectedDate = new Date(epochSeconds * 1000);
    const { fetch } = answering(200, {
      messages: [
        {
          message: "0x01",
          attestation: "0x02",
          status: "complete",
          attestationTimestamp: epochSeconds,
        },
      ],
    });
    const lookup = await new IrisClient("testnet", { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.attestationTimestamp).toEqual(expectedDate);
    expect(lookup.report.attestedAt).toEqual(expectedDate);
  });

  it("parses fast attestation metadata, flags fastTransfer, and sets expiry block", async () => {
    const { fetch } = answering(200, {
      data: [
        {
          status: "fast_complete",
          isFastTransfer: true,
          fastAttestation: {
            signature: "0xfastsig",
            expirationBlock: "54321",
            timestamp: "2024-05-01T13:00:00.000Z",
          },
        },
      ],
    });
    const lookup = await new IrisClient("testnet", { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.status).toBe("attested");
    expect(lookup.report.fastTransfer).toBe(true);
    expect(lookup.report.attestationSignature).toBe("0xfastsig");
    expect(lookup.report.railStatus).toContain("expires@54321");
    expect(lookup.report.attestationTimestamp).toEqual(new Date("2024-05-01T13:00:00.000Z"));
  });

  it("passes pagination query parameters (page, pageSize) if configured in IrisOptions", async () => {
    const { fetch, calls } = answering(200, { data: [] });
    await new IrisClient("testnet", { fetch, page: 2, pageSize: 50 }).look(TRANSFER);

    expect(calls[0]).toContain("page=2");
    expect(calls[0]).toContain("pageSize=50");
  });

  it("resolves updated domain mappings across multiple ecosystems", async () => {
    expect(CCTP_DOMAINS.arbitrum).toBe(3);
    expect(CCTP_DOMAINS.solana).toBe(5);
    expect(domainFor("arbitrum")).toBe(3);
    expect(domainFor("optimism")).toBe(2);
    expect(domainFor("solana")).toBe(5);
    expect(domainFor("polygon")).toBe(7);
    expect(domainFor("base")).toBe(6);
    expect(domainFor("avalanche")).toBe(1);
    expect(domainFor("noble")).toBe(4);
    expect(domainFor("sui")).toBe(8);
    expect(domainFor("aptos")).toBe(9);
    expect(domainFor("stellar")).toBe(27);
    expect(domainFor("arc")).toBe(26);

    const { fetch, calls } = answering(200, { data: [] });
    await new IrisClient("testnet", { fetch }).look({
      ...TRANSFER,
      originChain: "arbitrum",
    });
    expect(calls[0]).toContain("/v2/messages/3?transactionHash=");
  });

  it("validates response payloads and messages with strict runtime typeguards", async () => {
    expect(isIrisResponsePayload({ messages: [] })).toBe(true);
    expect(isIrisResponsePayload({ data: [] })).toBe(true);
    expect(isIrisResponsePayload({ data: [], pagination: { page: 1, pageSize: 25 } })).toBe(true);
    expect(isIrisResponsePayload({ message: { status: "complete" } })).toBe(true);
    expect(isIrisResponsePayload([{ status: "complete" }])).toBe(true);

    expect(isIrisResponsePayload(null)).toBe(false);
    expect(isIrisResponsePayload("not-an-object")).toBe(false);
    expect(isIrisResponsePayload({ messages: "not-an-array" })).toBe(false);
    expect(isIrisResponsePayload({ data: 12345 })).toBe(false);
    expect(isIrisResponsePayload({ message: "not-an-object" })).toBe(false);
    expect(isIrisResponsePayload({ unexpected: true })).toBe(false);

    expect(isIrisMessage({ status: "complete" })).toBe(true);
    expect(isIrisMessage({ messageBytes: "0x1234" })).toBe(true);
    expect(isIrisMessage(null)).toBe(false);
    expect(isIrisMessage([])).toBe(false);
    expect(isIrisMessage({ status: 123 })).toBe(false);
    expect(isIrisMessage({ message: 456 })).toBe(false);
    expect(isIrisMessage({ unexpected: "only" })).toBe(false);

    // Runtime rejection during look
    const badPayload = answering(200, { unexpectedFieldOnly: true });
    await expect(
      new IrisClient("testnet", { fetch: badPayload.fetch }).look(TRANSFER),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RailError &&
        error.kind === "transient" &&
        error.message.includes("invalid iris response payload format"),
    );

    const badMessage = answering(200, { data: ["not-a-valid-message-shape"] });
    await expect(
      new IrisClient("testnet", { fetch: badMessage.fetch }).look(TRANSFER),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RailError &&
        error.kind === "transient" &&
        error.message.includes("invalid iris message in response payload"),
    );
  });

  it("maps various status strings across v1 and v2 formats", () => {
    for (const status of [
      "complete",
      "completed",
      "attested",
      "signed",
      "fast_complete",
      "fast_attested",
    ]) {
      expect(reportFor({ status }).status).toBe("attested");
    }
    for (const status of ["failed", "canceled", "cancelled"]) {
      expect(reportFor({ status }).status).toBe("failed");
    }
    expect(reportFor({ status: "expired" }).status).toBe("expired");
    for (const status of ["pending_confirmations", "pending", "unknown_state"]) {
      expect(reportFor({ status }).status).toBe("pending");
    }
  });
});

describe("Axelar's GMP status", () => {
  const BASE = "https://testnet.api.axelarscan.io";

  it("reads an empty data array as not indexed yet", async () => {
    // The opposite convention to Circle's 404, which is why the two clients cannot share a
    // "missing" check.
    const { fetch } = answering(200, { data: [], total: 0 });
    const lookup = await new AxelarGmpClient(BASE, { fetch }).look(TRANSFER);
    expect(lookup).toEqual({ kind: "missing" });
  });

  it("maps executed to attested rather than delivered", async () => {
    // Axelar saying it executed the message is Axelar's account of its own work. `delivered` in
    // this schema means an inbound_delivery row exists, which is our index saying the money
    // arrived, and that is the one backed by a log on the destination chain.
    const { fetch } = answering(200, {
      data: [
        {
          status: "executed",
          simplified_status: "received",
          message_id: "0xmessage",
          executed: { block_timestamp: 1_790_000_000 },
        },
      ],
    });
    const lookup = await new AxelarGmpClient(BASE, { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.status).toBe("attested");
    expect(lookup.report.railStatus).toBe("executed/received");
    expect(lookup.report.reference).toBe("0xmessage");
    expect(lookup.report.attestedAt).toEqual(new Date(1_790_000_000 * 1000));
  });

  it("keeps a recoverable transfer pending and names the reason", async () => {
    // Insufficient gas is exactly what the keeper exists to fix, so it must stay in the queue.
    const { fetch } = answering(200, {
      data: [{ status: "called", simplified_status: "confirming", is_insufficient_fee: true }],
    });
    const lookup = await new AxelarGmpClient(BASE, { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.status).toBe("pending");
    expect(lookup.report.railStatus).toContain("is_insufficient_fee");
  });

  it("lets a fatal flag outrank an optimistic status", async () => {
    // Axelar will report `called` on a message whose destination address is invalid, and that is
    // never going to arrive.
    const { fetch } = answering(200, {
      data: [{ status: "called", is_invalid_destination_chain: true }],
    });
    const lookup = await new AxelarGmpClient(BASE, { fetch }).look(TRANSFER);

    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") return;
    expect(lookup.report.status).toBe("failed");
  });

  it("records a status it has never seen without moving ours, and says so once", async () => {
    // The status enum could not be fully observed: every row on testnet is `executed`, and the
    // API refuses a page size above twenty five. So an unlisted value is reported rather than
    // guessed, and the transfer keeps being polled instead of being written off on the strength
    // of a string nobody has read.
    const seen: string[] = [];
    const { fetch } = answering(200, { data: [{ status: "teleporting" }] });
    const client = new AxelarGmpClient(BASE, {
      fetch,
      onUnknownStatus: (status) => seen.push(status),
    });

    const first = await client.look(TRANSFER);
    await client.look(TRANSFER);

    expect(first.kind).toBe("found");
    if (first.kind !== "found") return;
    expect(first.report.status).toBe("pending");
    expect(first.report.railStatus).toContain("teleporting");
    // Once, not once per lookup.
    expect(seen).toEqual(["teleporting"]);
  });

  it("posts the transaction hash to searchGMP", async () => {
    const { fetch, calls } = answering(200, { data: [] });
    await new AxelarGmpClient(BASE, { fetch }).look(TRANSFER);
    expect(calls[0]).toBe(`${BASE}/gmp/searchGMP`);
  });
});
