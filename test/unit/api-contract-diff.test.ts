import { AddressKind, encodeStellarAddress } from "@hyperion/protocol";
import { describe, expect, it } from "vitest";

import {
  classifyTokenOrAddressRepresentation,
  diffApiFixtureBundles,
  loadBaselineApiFixtures,
  loadPublishedApiSchema,
  runLiveFastifyContractCheck,
  validateAgainstPublishedSchema,
  type ApiFixtureBundle,
} from "../helpers.js";

function cloneBundle(
  bundle: ApiFixtureBundle,
  candidateVersion = "2.0.0-candidate",
): ApiFixtureBundle {
  return {
    version: candidateVersion,
    responses: JSON.parse(JSON.stringify(bundle.responses)) as ApiFixtureBundle["responses"],
  };
}

function hexWord32(seed: number): `0x${string}` {
  const bytes: string[] = [];
  for (let i = 0; i < 32; i += 1) {
    bytes.push(((seed + i * 17) & 0xff).toString(16).padStart(2, "0"));
  }
  return `0x${bytes.join("")}`;
}

describe("API contract differential runner (#141)", () => {
  it("validates live Fastify HTTP responses across all public endpoints against the published v1 schema and baseline fixtures", async () => {
    const { liveBundle, report } = await runLiveFastifyContractCheck({
      candidateVersion: "1.0.0-fastify",
    });

    expect(liveBundle.responses.length).toBeGreaterThanOrEqual(10);
    expect(report.compatible).toBe(true);
    expect(report.breakingChanges).toEqual([]);
    expect(report.additiveChanges).toEqual([]);
    expect(report.schemaViolations).toEqual([]);

    // Also verify muxed M... strkey classification and schema acceptance on recipient fields.
    const muxedRecipient = encodeStellarAddress(AddressKind.MuxedAccount, hexWord32(0x41), 99_102n);
    expect(classifyTokenOrAddressRepresentation(muxedRecipient)).toBe("stellar_muxed_strkey");

    const schema = loadPublishedApiSchema();
    const muxedClaimFixture = {
      id: "muxed_claim_200",
      endpoint: "GET /v1/claims/:chain/:claimId",
      requestPath: "/v1/claims/stellar-testnet/88",
      statusCode: 200,
      body: {
        id: "stellar-testnet:88",
        chain: "stellar-testnet",
        claimId: "88",
        recipient: muxedRecipient,
        token: "CD5IB466XCQIUDYWV22PUMJTF6EE3KPXBDGLLBSKAPNE6QPXVUZLXJGA",
        amount: "340282366920938463463374607431768211455",
        route: 1,
        sourceChain: "sepolia",
        sourceNonce: "18446744073709551615",
        settled: false,
        createdAt: "2026-10-16T10:10:00.000Z",
        observedAt: "2026-10-16T10:10:00.000Z",
      },
    };
    expect(validateAgainstPublishedSchema(muxedClaimFixture, schema)).toEqual([]);
  }, 30_000);

  it("detects wide-integer representation regressions including IEEE-754 number coercion, float precision loss, hex, and formatted decimals", () => {
    const baseline = loadBaselineApiFixtures();
    const candidate = cloneBundle(baseline, "2.0.0-broken-ints");

    const delivered = candidate.responses.find((r) => r.id === "transfer_by_nonce_delivered_200");
    const parked = candidate.responses.find((r) => r.id === "transfer_by_tx_parked_200");
    const routeHealth = candidate.responses.find((r) => r.id === "routes_health_200");
    if (!delivered || !parked || !routeHealth) throw new Error("Missing baseline fixtures");

    const deliveredBody = delivered.body as {
      origin: Record<string, unknown>;
      destination: Record<string, unknown>;
    };
    // 1) Coerce uint256 string to JSON number
    deliveredBody.origin.fee = 1_000_000;
    // 2) Truncate 128-bit uint256 string via Number() round-trip precision loss
    deliveredBody.origin.grossAmount = String(
      BigInt(Math.trunc(Number("340282366920938463463374607431768211455"))),
    );
    // 3) Encode u64 nonce as hex instead of decimal string
    deliveredBody.origin.nonce = "0xfffffffffffffff0";

    const parkedBody = parked.body as { origin: Record<string, unknown> };
    // 4) Format integer string as human decimal float string
    parkedBody.origin.netAmount = "9.970000";

    const routesBody = routeHealth.body as { routes: Record<string, unknown>[] };
    if (routesBody.routes[0]) {
      routesBody.routes[0].flowAvailable = "1e+13";
    }

    const report = diffApiFixtureBundles(baseline, candidate);
    expect(report.compatible).toBe(false);

    const wideIntBreaks = report.breakingChanges.filter(
      (c) => c.category === "wide_integer_representation",
    );
    expect(wideIntBreaks.map((c) => `${c.fixtureId}:${c.path}`)).toEqual(
      expect.arrayContaining([
        "transfer_by_nonce_delivered_200:$.origin.fee",
        "transfer_by_nonce_delivered_200:$.origin.grossAmount",
        "transfer_by_nonce_delivered_200:$.origin.nonce",
        "transfer_by_tx_parked_200:$.origin.netAmount",
        "routes_health_200:$.routes[0].flowAvailable",
      ]),
    );
  });

  it("detects token and recipient address representation changes across Stellar strkeys and EVM addresses", () => {
    const baseline = loadBaselineApiFixtures();
    const candidate = cloneBundle(baseline, "2.0.0-broken-tokens");

    const delivered = candidate.responses.find((r) => r.id === "transfer_by_nonce_delivered_200");
    const claim = candidate.responses.find((r) => r.id === "claim_by_id_200");
    if (!delivered || !claim) throw new Error("Missing baseline fixtures");

    const deliveredBody = delivered.body as {
      origin: Record<string, unknown>;
      destination: Record<string, unknown>;
    };
    // 1) Stellar SAC C... contract strkey replaced by ticker symbol "USDC"
    deliveredBody.origin.token = "USDC";
    // 2) EVM 20-byte recipient regressed to raw 32-byte padded word
    deliveredBody.destination.recipient =
      "0x0000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc";
    // 3) EVM 20-byte token address replaced by 32-byte word
    deliveredBody.destination.token =
      "0x0000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238";

    const claimBody = claim.body as Record<string, unknown>;
    // 4) Stellar G... recipient corrupted (invalid CRC16 checksum)
    claimBody.recipient = "GD4IEL76RCF2CULJZAKDTEZOQIIUTH3JDKY52W7SR6GBI42PZFIZGWI0";

    const report = diffApiFixtureBundles(baseline, candidate);
    expect(report.compatible).toBe(false);

    const reprBreaks = report.breakingChanges.filter(
      (c) => c.category === "token_or_address_representation",
    );
    expect(reprBreaks.map((c) => `${c.fixtureId}:${c.path}`)).toEqual(
      expect.arrayContaining([
        "transfer_by_nonce_delivered_200:$.origin.token",
        "transfer_by_nonce_delivered_200:$.destination.recipient",
        "transfer_by_nonce_delivered_200:$.destination.token",
        "claim_by_id_200:$.recipient",
      ]),
    );
    expect(report.schemaViolations.length).toBeGreaterThanOrEqual(4);
  });

  it("distinguishes compatible additive metadata from breaking removals, enum drift, status changes, and credential leaks", () => {
    const baseline = loadBaselineApiFixtures();

    // Case A: Purely additive metadata fields -> compatible === true!
    const additiveCandidate = cloneBundle(baseline, "1.1.0-additive");
    const addTransfer = additiveCandidate.responses.find(
      (r) => r.id === "transfer_by_nonce_delivered_200",
    );
    const addMetrics = additiveCandidate.responses.find((r) => r.id === "metrics_200");
    if (!addTransfer || !addMetrics) throw new Error("Missing baseline fixtures");

    const addTransferBody = addTransfer.body as {
      origin: Record<string, unknown>;
      rail: Record<string, unknown>;
      meta?: Record<string, unknown>;
    };
    addTransferBody.origin.explorerUrl = "https://stellar.expert/explorer/testnet/tx/1001";
    addTransferBody.rail.estimatedConfirmationSeconds = 18;
    (addMetrics.body as Record<string, unknown>).schemaRevision = "2026-10";

    const additiveReport = diffApiFixtureBundles(baseline, additiveCandidate);
    expect(additiveReport.compatible).toBe(true);
    expect(additiveReport.breakingChanges).toEqual([]);
    expect(additiveReport.schemaViolations).toEqual([]);
    expect(additiveReport.additiveChanges.map((c) => c.path)).toEqual([
      "$.origin.explorerUrl",
      "$.rail.estimatedConfirmationSeconds",
      "$.schemaRevision",
    ]);

    // Case B: Breaking field removal, unknown enum value, status code drift, and credential exposure -> compatible === false!
    const breakingCandidate = cloneBundle(baseline, "2.0.0-breaking");
    const brkTransfer = breakingCandidate.responses.find(
      (r) => r.id === "transfer_by_tx_parked_200",
    );
    const brkNotFound = breakingCandidate.responses.find((r) => r.id === "transfer_by_id_404");
    if (!brkTransfer || !brkNotFound) throw new Error("Missing baseline fixtures");

    const brkBody = brkTransfer.body as {
      stage: string;
      origin: Record<string, unknown>;
      rail: Record<string, unknown>;
    };
    delete brkBody.origin.fee;
    brkBody.stage = "bridging_in_progress";
    const syntheticCredUrl = [
      "postgres",
      "://",
      "user",
      ":",
      "redacted-test",
      "@127.0.0.1:5432/db",
    ].join("");
    brkBody.rail.lastError = `upstream failed talking to ${syntheticCredUrl}`;
    (brkNotFound as { statusCode: number }).statusCode = 200;

    const breakingReport = diffApiFixtureBundles(baseline, breakingCandidate);
    expect(breakingReport.compatible).toBe(false);
    const categories = breakingReport.breakingChanges.map((c) => c.category);
    expect(categories).toEqual(
      expect.arrayContaining([
        "removed_field",
        "enum_violation",
        "credential_exposure",
        "status_code_changed",
      ]),
    );
  });
});
