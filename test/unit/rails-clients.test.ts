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
import { IrisClient } from "../../src/rails/cctp/iris.js";
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
