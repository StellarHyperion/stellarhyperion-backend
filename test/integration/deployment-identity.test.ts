import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import { writeInbound, writeOutbound, type Position } from "../../src/chains/writers.js";
import { pendingForRail } from "../../src/rails/queue.js";
import { buildServer } from "../../src/http/server.js";
import { loadConfig } from "../../src/config/config.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

const connection = process.env.TEST_DATABASE_URL;
const suite = connection ? describe : describe.skip;
suite("router deployment identity and destination proof", () => {
  let db: Database;
  const source = "identity-test";
  const position = (router?: string): Position => ({
    chainKey: source,
    ...(router === undefined ? {} : { router }),
    block: 12n,
    txHash: router ? `source-${router}` : "legacy",
    logIndex: 1,
    observedAt: new Date(),
  });
  const row = {
    route: 1,
    nonce: 9n,
    sender: "Gsender",
    token: "USDC",
    grossAmount: 100n,
    fee: 1n,
    netAmount: 99n,
    destinationChain: "stellar-testnet",
    destination: "Grecipient",
    railRef: null,
  };
  const clean = async () => {
    await db.query("DELETE FROM inbound_delivery WHERE source_chain = $1", [source]);
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain = $1", [source]);
  };
  beforeAll(() => {
    db = Database.open(connection ?? "");
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.close();
  });
  const ids = async () =>
    (
      await db.query(
        "SELECT id, origin_router FROM outbound_transfer WHERE origin_chain = $1 ORDER BY id",
        [source],
      )
    ).rows;
  const receipt = async (sourceTransferId?: bigint) =>
    db.transaction((tx) =>
      writeInbound(
        tx,
        {
          chainKey: "stellar-testnet",
          block: 20n,
          txHash: `receipt-${String(sourceTransferId ?? "unbound")}`,
          logIndex: 1,
          observedAt: new Date(),
        },
        {
          ...(sourceTransferId === undefined ? {} : { sourceTransferId }),
          route: 1,
          sourceChain: source,
          sourceNonce: 9n,
          railMessageId: null,
          recipient: "Grecipient",
          token: "USDC",
          amount: 99n,
          delivered: true,
          claimId: null,
        },
      ),
    );
  const server = () =>
    buildServer({
      config: loadConfig({ env: completeEnv({ KEEPER_ENABLED: "false" }) }),
      logger: capturingLogger().logger,
      db,
      readiness: [],
      redis: { ping: () => Promise.resolve("PONG") },
    });
  it("retains two routers with one nonce and makes replay idempotent", async () => {
    await db.transaction((tx) => writeOutbound(tx, position("router-a"), row));
    await db.transaction((tx) => writeOutbound(tx, position("router-b"), row));
    const before = await ids();
    await db.transaction((tx) => writeOutbound(tx, position("router-a"), row));
    expect(await ids()).toEqual(before);
    expect(before).toHaveLength(2);
  });
  it("adopts a legacy deployment only on exact replay and preserves its id and attestation", async () => {
    const legacy = position();
    await db.transaction((tx) => writeOutbound(tx, legacy, row));
    const id = String((await ids())[0]!.id);
    await db.query(
      "INSERT INTO rail_attestation(transfer_id, route, status) VALUES ($1, 1, 'pending')",
      [id],
    );
    await db.transaction((tx) => writeOutbound(tx, { ...legacy, router: "proved-router" }, row));
    expect(await ids()).toEqual([{ id, origin_router: "proved-router" }]);
    expect(
      (await db.query("SELECT transfer_id FROM rail_attestation WHERE transfer_id = $1", [id]))
        .rows,
    ).toHaveLength(1);
  });
  it("keeps independently verified receipts bound to their exact source deployment", async () => {
    await db.transaction((tx) => writeOutbound(tx, position("router-a"), row));
    await db.transaction((tx) => writeOutbound(tx, position("router-b"), row));
    const [a, b] = await ids();
    await receipt(BigInt(String(a!.id)));
    const app = server();
    try {
      expect(
        (await app.inject(`/v1/transfers/${String(a!.id)}`)).json().destination.delivered,
      ).toBe(true);
      expect(
        (await app.inject(`/v1/transfers/${String(b!.id)}`)).json().destination.delivered,
      ).toBe(false);
      expect((await app.inject(`/v1/transfers/${source}/9`)).statusCode).toBe(409);
      await receipt(BigInt(String(b!.id)));
      expect(
        (
          await db.query(
            "SELECT source_transfer_id FROM inbound_delivery WHERE source_chain = $1",
            [source],
          )
        ).rows,
      ).toHaveLength(2);
      expect(
        (await app.inject(`/v1/transfers/${String(b!.id)}`)).json().destination.delivered,
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
  it("does not infer either deployment from an ambiguous unbound receipt", async () => {
    await db.transaction((tx) => writeOutbound(tx, position("router-a"), row));
    await db.transaction((tx) => writeOutbound(tx, position("router-b"), row));
    await receipt();
    const app = server();
    try {
      for (const entry of await ids()) {
        expect(
          (await app.inject(`/v1/transfers/${String(entry.id)}`)).json().destination.delivered,
        ).toBe(false);
      }
      const candidates = await pendingForRail(db, {
        route: 1,
        limit: 100,
        maxCheckFailures: 5,
        now: new Date(),
        notCheckedSince: new Date(),
      });
      expect(
        candidates.filter((entry) => entry.originChain === source).map((entry) => entry.delivered),
      ).toEqual([false, false]);
    } finally {
      await app.close();
    }
  });
});
