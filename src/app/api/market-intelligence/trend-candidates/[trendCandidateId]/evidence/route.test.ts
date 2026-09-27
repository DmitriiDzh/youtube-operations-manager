import assert from "node:assert/strict";
import test from "node:test";
import { recordTrendEvidenceInputSchema } from "@/lib/market-intelligence/schemas";
import { DomainError, parseWithSchema } from "@/lib/market-intelligence/contracts";
import { createTrendEvidenceGetHandler, createTrendEvidencePostHandler } from "./route";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/market-intelligence/trend-candidates/tc-1/evidence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest() {
  return new Request("http://localhost/api/market-intelligence/trend-candidates/tc-1/evidence");
}

const params = Promise.resolve({ trendCandidateId: "tc-1" });

test("evidence route GET: returns getTrendEvidenceSummary's own result, not the plain listTrendEvidence shape", async () => {
  const handler = createTrendEvidenceGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async getTrendEvidenceSummary() {
        return { evidence: [{ evidenceId: "eve-1" }], independentChannelCount: 3 } as never;
      },
      async recordTrendEvidence() {
        throw new Error("must not be called");
      },
    },
  });

  const response = await handler(makeGetRequest(), { params });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.independentChannelCount, 3);
});

test("evidence route GET: an unauthenticated request is rejected before touching the core", async () => {
  let called = false;
  const handler = createTrendEvidenceGetHandler({
    getSession: async () => null,
    core: {
      async getTrendEvidenceSummary() {
        called = true;
        throw new Error("must not be called");
      },
      async recordTrendEvidence() {
        throw new Error("must not be called");
      },
    },
  });

  const response = await handler(makeGetRequest(), { params });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

// A fake `core.recordTrendEvidence` that validates through the REAL
// `recordTrendEvidenceInputSchema` (not a hand-rolled stand-in) -- this is the exact schema the
// real service applies, so a route bug that only manifests against the strict discriminated union
// (like the `referenceId: undefined` bug this test guards against) is actually exercised here,
// not merely asserted by inspection.
function makeCore() {
  return {
    async recordTrendEvidence(input: unknown) {
      const parsed = parseWithSchema(recordTrendEvidenceInputSchema, input, "record trend evidence input");
      return {
        evidenceId: "eve-1",
        trendCandidateId: parsed.trendCandidateId,
        evidenceType: parsed.evidenceType,
        referenceId: "referenceId" in parsed ? parsed.referenceId : null,
        description: parsed.description,
        recordedAt: "2026-01-01T00:00:00.000Z",
      };
    },
    async getTrendEvidenceSummary() {
      return { evidence: [], independentChannelCount: 0 };
    },
  };
}

test("evidence route POST: a 'signal' submission with no referenceId in the body succeeds (regression -- the route used to always set an own `referenceId: undefined` key, which the strict schema's 'signal' branch has no key for at all and rejected outright)", async () => {
  const handler = createTrendEvidencePostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: makeCore(),
  });

  const response = await handler(makeRequest({ evidenceType: "signal", description: "Multiple channels covering this format" }), { params });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.evidence.evidenceType, "signal");
  assert.equal(payload.evidence.referenceId, null);
});

test("evidence route POST: a 'supporting_channel' submission requires and forwards referenceId", async () => {
  const handler = createTrendEvidencePostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: makeCore(),
  });

  const response = await handler(
    makeRequest({ evidenceType: "supporting_channel", referenceId: "UC1234567890123456789012", description: "Same format" }),
    { params }
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.evidence.referenceId, "UC1234567890123456789012");
});

test("evidence route POST: a 'supporting_channel' submission missing referenceId is rejected as validation_failed, not silently accepted", async () => {
  const handler = createTrendEvidencePostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: makeCore(),
  });

  const response = await handler(makeRequest({ evidenceType: "supporting_channel", description: "Same format" }), { params });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, "validation_failed");
});

test("evidence route POST: an unauthenticated request is rejected before touching the core", async () => {
  let called = false;
  const handler = createTrendEvidencePostHandler({
    getSession: async () => null,
    core: {
      async recordTrendEvidence() {
        called = true;
        throw new Error("must not be called");
      },
      async getTrendEvidenceSummary() {
        return { evidence: [], independentChannelCount: 0 };
      },
    },
  });

  const response = await handler(makeRequest({ evidenceType: "signal", description: "x" }), { params });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("evidence route POST: a DomainError from the core is mapped to its own error code/status", async () => {
  const handler = createTrendEvidencePostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async recordTrendEvidence() {
        throw new DomainError({ code: "TREND_CANDIDATE_NOT_FOUND", message: "No such trend candidate", details: { trendCandidateId: "tc-1" } });
      },
      async getTrendEvidenceSummary() {
        return { evidence: [], independentChannelCount: 0 };
      },
    },
  });

  const response = await handler(makeRequest({ evidenceType: "signal", description: "x" }), { params });
  const payload = await response.json();
  assert.equal(payload.error, "TREND_CANDIDATE_NOT_FOUND");
});
