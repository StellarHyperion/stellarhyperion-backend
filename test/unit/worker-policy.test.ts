import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { completeEnv, readFixture } from "../helpers.js";
import {
  WorkerPolicyStore,
  deploymentIdentity,
  workerPolicy,
} from "../../src/runtime/worker-policy.js";

describe("validated worker policy reload", () => {
  it("publishes a new version atomically and keeps secrets out of the policy", () => {
    const first = loadConfig({ env: completeEnv({ RAIL_POLL_INTERVAL_MS: "1000" }) });
    const second = loadConfig({ env: completeEnv({ RAIL_POLL_INTERVAL_MS: "2000" }) });
    const store = new WorkerPolicyStore(first);
    expect(store.snapshot().version).toBe(1);
    expect(store.replace(second)).toMatchObject({ version: 2, rails: { pollIntervalMs: 2000 } });
    expect(JSON.stringify(store.snapshot())).not.toContain(first.databaseUrl);
    expect(workerPolicy(second).keeper).toEqual(workerPolicy(first).keeper);
  });

  it("rejects deployment changes without changing the active policy", () => {
    const first = loadConfig({ env: completeEnv() });
    const changed = loadConfig({
      env: completeEnv({ HYPERION_DEPLOYMENTS_FILE: "./test/fixtures/deployments-testnet.json" }),
      cwd: "/tmp/hyperion",
      readFile: () => readFixture("deployments-testnet.json"),
    });
    const store = new WorkerPolicyStore(first);
    expect(deploymentIdentity(changed)).not.toBe(deploymentIdentity(first));
    expect(() => store.replace(changed)).toThrow(/deployment identity/);
    expect(store.snapshot().version).toBe(1);
  });
});
