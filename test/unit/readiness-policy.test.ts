import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/config.js";
import type { Database } from "../../src/db/pool.js";
import { buildServer } from "../../src/http/server.js";
import {
  evaluateReadiness,
  inferDeploymentMode,
  resolveReadinessPolicy,
} from "../../src/runtime/readiness.js";
import { completeEnv } from "../helpers.js";
import { capturingLogger } from "../stellar-fakes.js";

describe("readiness dependency policy configuration (#116)", () => {
  it("infers deployment modes from component flags when DEPLOYMENT_MODE is omitted", () => {
    expect(
      inferDeploymentMode({ indexerEnabled: false, railsEnabled: false, keeperEnabled: false }),
    ).toBe("api-only");
    expect(
      inferDeploymentMode({ indexerEnabled: true, railsEnabled: false, keeperEnabled: false }),
    ).toBe("indexer-only");
    expect(
      inferDeploymentMode({ indexerEnabled: false, railsEnabled: false, keeperEnabled: true }),
    ).toBe("keeper-only");
    expect(
      inferDeploymentMode({ indexerEnabled: true, railsEnabled: true, keeperEnabled: true }),
    ).toBe("all-in-one");
  });

  it("models required vs optional vs disabled dependencies across deployment modes", () => {
    const apiOnly = resolveReadinessPolicy({
      mode: "api-only",
      indexerEnabled: false,
      railsEnabled: false,
      keeperEnabled: false,
    });
    expect(apiOnly).toEqual({
      database: "required",
      indexer: "disabled",
      rails: "disabled",
      keeper: "disabled",
    });

    const customWithOptionalKeeper = resolveReadinessPolicy({
      mode: "all-in-one",
      indexerEnabled: true,
      railsEnabled: true,
      keeperEnabled: true,
      overrides: { keeper: "optional", rails: "optional" },
    });
    expect(customWithOptionalKeeper).toEqual({
      database: "required",
      indexer: "required",
      rails: "optional",
      keeper: "optional",
    });
  });

  it("downgrades optional down dependencies to degraded (HTTP 200) while required down returns 503", async () => {
    const config = loadConfig({
      env: completeEnv({
        DEPLOYMENT_MODE: "all-in-one",
        READINESS_KEEPER_POLICY: "optional",
        READINESS_RAILS_POLICY: "optional",
      }),
    });
    const { logger } = capturingLogger();

    const db = {
      ping: () => Promise.resolve(),
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as unknown as Database;

    const app = buildServer({
      config,
      logger,
      db,
      readiness: [
        {
          readiness: () => ({
            name: "rail:cctp",
            state: "down",
            detail: "iris unreachable",
          }),
        },
      ],
    });

    // Redis is not provided even though keeper.enabled=true -> checkRedis reports "down",
    // and rail:cctp reports "down", but both are policy="optional" -> overall "degraded" (200).
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.deploymentMode).toBe("all-in-one");
    expect(body.policy.keeper).toBe("optional");
    expect(body.policy.rails).toBe("optional");
  });

  it("returns 503 when a required dependency is down", () => {
    const evaluated = evaluateReadiness(
      [
        { name: "postgres", state: "down", detail: "connection refused" },
        { name: "rail:cctp", state: "ready", detail: "ok" },
      ],
      {
        database: "required",
        indexer: "disabled",
        rails: "optional",
        keeper: "disabled",
      },
    );
    expect(evaluated.state).toBe("down");
    expect(evaluated.checks[0]?.required).toBe(true);
    expect(evaluated.checks[1]?.required).toBe(false);
  });
});
