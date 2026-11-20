import { describe, expect, it, vi } from "vitest";

import {
  DestinationVerificationRpcError,
  safeRpcEndpointIdentity,
  withDestinationVerification,
} from "../../src/chains/evm/client.js";

describe("destination verification RPC failover", () => {
  const urls = ["https://first.example/private-key/rpc?key=one", "https://second.example/rpc"];
  const chainId = 11_155_111;

  it("restarts all evidence reads on the secondary after a primary transport failure", async () => {
    const calls: string[] = [];
    const clientForUrl = (url: string) => ({
      getChainId: () => Promise.resolve(chainId),
      read: (method: string): Promise<string> => {
        calls.push(`${url}:${method}`);
        if (url === urls[0] && method === "block") throw new Error("transport failure");
        return Promise.resolve(method);
      },
    });

    const result = await withDestinationVerification(
      urls,
      chainId,
      clientForUrl,
      async (client) => {
        const receipt = await client.read("receipt");
        const block = await client.read("block");
        return { receipt, block };
      },
      { chain: "sepolia" },
    );

    expect(result).toEqual({ receipt: "receipt", block: "block" });
    expect(calls).toEqual([
      `${urls[0]}:receipt`,
      `${urls[0]}:block`,
      `${urls[1]}:receipt`,
      `${urls[1]}:block`,
    ]);
  });

  it("leaves verification unverified when every endpoint fails", async () => {
    const clientForUrl = vi.fn(() => ({
      getChainId: () => Promise.reject(new Error("offline")),
    }));

    await expect(
      withDestinationVerification(urls, chainId, clientForUrl, () => Promise.resolve("delivered"), {
        chain: "sepolia",
      }),
    ).rejects.toBeInstanceOf(DestinationVerificationRpcError);
    expect(clientForUrl).toHaveBeenCalledTimes(2);
  });

  it("never runs proof reads on a wrong-network endpoint", async () => {
    const verify = vi.fn((client: { readonly getChainId: () => Promise<number> }) =>
      client.getChainId(),
    );
    const clientForUrl = (url: string) => ({
      getChainId: () => Promise.resolve(url === urls[0] ? 1 : 5),
    });

    await expect(
      withDestinationVerification(
        urls,
        chainId,
        clientForUrl,
        async (client) => {
          await verify(client);
          return "delivered";
        },
        { chain: "sepolia" },
      ),
    ).rejects.toMatchObject({ reason: "chain_mismatch" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails closed when evidence differs between endpoints", async () => {
    const clientForUrl = (url: string) => ({
      getChainId: () => Promise.resolve(chainId),
      getTransactionReceipt: (_args: { readonly hash: string }) =>
        Promise.resolve({ blockHash: url === urls[0] ? "0xaaa" : "0xbbb" }),
    });

    await expect(
      withDestinationVerification(
        urls,
        chainId,
        clientForUrl,
        async (client) => {
          await client.getTransactionReceipt({ hash: "0x1" });
          return "delivered";
        },
        { chain: "sepolia" },
      ),
    ).rejects.toMatchObject({ reason: "inconsistent_evidence" });
  });

  it("logs only the endpoint origin identity", () => {
    expect(
      safeRpcEndpointIdentity("https://user:password@rpc.example/private/api-key?token=secret"),
    ).toBe("https://rpc.example");
  });
});
