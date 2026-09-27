import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { createTrendCandidatesGetHandler, createTrendCandidatesPostHandler } from "./route";

function makePostRequest(body: unknown) {
  return new Request("http://localhost/api/market-intelligence/trend-candidates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("trend-candidates route GET: returns listTrendCandidatesWithFreshness's own result, not the plain listTrendCandidates shape", async () => {
  const handler = createTrendCandidatesGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async listTrendCandidatesWithFreshness() {
        return { trendCandidates: [{ trendCandidateId: "tc-1", freshness: "fresh" }] } as never;
      },
      async createTrendCandidate() {
        throw new Error("must not be called");
      },
    },
  });

  const response = await handler();
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.trendCandidates[0].freshness, "fresh");
});

test("trend-candidates route GET: an unauthenticated request is rejected before touching the core", async () => {
  let called = false;
  const handler = createTrendCandidatesGetHandler({
    getSession: async () => null,
    core: {
      async listTrendCandidatesWithFreshness() {
        called = true;
        throw new Error("must not be called");
      },
      async createTrendCandidate() {
        throw new Error("must not be called");
      },
    },
  });

  const response = await handler();
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("trend-candidates route POST: forwards the parsed body to createTrendCandidate unchanged", async () => {
  let receivedInput: unknown;
  const handler = createTrendCandidatesPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async listTrendCandidatesWithFreshness() {
        throw new Error("must not be called");
      },
      async createTrendCandidate(input: unknown) {
        receivedInput = input;
        return { trendCandidateId: "tc-1" } as never;
      },
    },
  });

  const response = await handler(makePostRequest({ title: "Jazz revival" }));
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.deepEqual(receivedInput, { title: "Jazz revival" });
  assert.equal(payload.trendCandidate.trendCandidateId, "tc-1");
});

test("trend-candidates route POST: a DomainError from the core is mapped to its own error code", async () => {
  const handler = createTrendCandidatesPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async listTrendCandidatesWithFreshness() {
        throw new Error("must not be called");
      },
      async createTrendCandidate() {
        throw new DomainError({ code: "TOPIC_NOT_FOUND", message: "No such topic", details: {} });
      },
    },
  });

  const response = await handler(makePostRequest({ title: "Jazz revival" }));
  const payload = await response.json();
  assert.equal(payload.error, "TOPIC_NOT_FOUND");
});
