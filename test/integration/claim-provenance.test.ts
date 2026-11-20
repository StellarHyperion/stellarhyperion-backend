import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../../src/db/pool.js";
import { loadConfig } from "../../src/config/config.js";
import { buildServer } from "../../src/http/server.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";
const connection = process.env.TEST_DATABASE_URL;
(connection ? describe : describe.skip)("source-bound public claim provenance", () => {
  const db = Database.open(connection ?? "");
  const chain = "claim-provenance-source";
  const claim = "18446744073709551615";
  beforeAll(async () => {
    await db.query("DELETE FROM pending_claim WHERE chain='claim-provenance-destination'");
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain=$1", [chain]);
    const first = await db.query(
      `INSERT INTO outbound_transfer(origin_chain,origin_router,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx)
      VALUES($1,'CONE',0,$2,'GSENDER','CUSDC',100,10,90,'claim-provenance-destination','GRECIPIENT',7,$3) RETURNING id`,
      [chain, claim, "a".repeat(64)],
    );
    await db.query(
      `INSERT INTO outbound_transfer(origin_chain,origin_router,route,nonce,sender,token,gross_amount,fee,net_amount,destination_chain,destination,origin_block,origin_tx)
      VALUES($1,'CTWO',0,$2,'GOTHER','CUSDC',100,10,90,'claim-provenance-destination','GRECIPIENT',8,$3)`,
      [chain, claim, "b".repeat(64)],
    );
    await db.query(
      `INSERT INTO pending_claim(chain,claim_id,recipient,token,amount,route,source_chain,source_nonce,source_transfer_id,created_at)
      VALUES('claim-provenance-destination',$1,'GRECIPIENT','CUSDC',90,0,$2,$1,$3,now())`,
      [claim, chain, first.rows[0]?.id],
    );
  });
  afterAll(async () => {
    await db.query("DELETE FROM pending_claim WHERE chain='claim-provenance-destination'");
    await db.query("DELETE FROM outbound_transfer WHERE origin_chain=$1", [chain]);
    await db.close();
  });
  it("projects exactly the FK-bound source among reused deployment nonces and labels absent proof unverified", async () => {
    const app = buildServer({
      config: loadConfig({ env: completeEnv() }),
      logger: capturingLogger().logger,
      db,
      readiness: [],
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/claims?chain=claim-provenance-destination",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ claims: { provenance: unknown }[] }>();
      expect(body.claims).toHaveLength(1);
      expect(body.claims[0]?.provenance).toMatchObject({
        source: { txHash: "a".repeat(64), block: "7", chain },
        destination: { status: "unverified", txHash: null },
      });
      await db.query(
        "UPDATE pending_claim SET source_transfer_id=NULL WHERE chain='claim-provenance-destination'",
      );
      const legacy = await app.inject({
        method: "GET",
        url: "/v1/claims?chain=claim-provenance-destination",
      });
      expect(
        legacy.json<{ claims: { provenance: { source: unknown } }[] }>().claims[0]?.provenance
          .source,
      ).toBeNull();
    } finally {
      await app.close();
    }
  });
});
