import assert from "node:assert/strict";
import test from "node:test";
import { createExecuteExperimentHandler } from "./route";

function makeRequest(body: unknown = {}) {
  return new Request("http://localhost/api/decision-engine/experiments/exp-1/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ experimentId: "exp-1" });

// docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md §1/§7 -- `advisor()` review round 2 found the
// fail-closed Live Writes gate had no test proving the ROUTE actually passes the real
// `getLiveWritesEnabled()` value through, only that the service honors whatever boolean it's
// handed by hand (services.test.ts). This proves the wiring itself, not just the logic.
test("execute route: {live:true} with the real Live Writes toggle off still reaches the core with liveWritesEnabled:false", async () => {
  let capturedLiveWritesEnabled: boolean | undefined;
  const handler = createExecuteExperimentHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async executeExperiment(_id, _input, _ctx, _resolver, liveWritesEnabled) {
        capturedLiveWritesEnabled = liveWritesEnabled;
        return { experiment: {} as never, batchId: "batch-1", videoCount: 1, dryRun: true };
      },
    },
    resolver: {
      async verifyChangeSetBelongsToChannel() {
        return true;
      },
      async createDryRunBatch() {
        return { batchId: "batch-1", videoCount: 1 };
      },
    },
    getLiveWritesEnabled: async () => false,
  });

  const response = await handler(makeRequest({ live: true }), { params });
  assert.equal(response.status, 201);
  assert.equal(capturedLiveWritesEnabled, false, "the route must pass the REAL toggle value through, not assume/hardcode true");
});

test("execute route: with the real toggle on, liveWritesEnabled:true reaches the core", async () => {
  let capturedLiveWritesEnabled: boolean | undefined;
  const handler = createExecuteExperimentHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async executeExperiment(_id, _input, _ctx, _resolver, liveWritesEnabled) {
        capturedLiveWritesEnabled = liveWritesEnabled;
        return { experiment: {} as never, batchId: "batch-1", videoCount: 1, dryRun: false };
      },
    },
    resolver: {
      async verifyChangeSetBelongsToChannel() {
        return true;
      },
      async createDryRunBatch() {
        return { batchId: "batch-1", videoCount: 1 };
      },
    },
    getLiveWritesEnabled: async () => true,
  });

  const response = await handler(makeRequest({ live: true }), { params });
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(capturedLiveWritesEnabled, true);
  assert.equal(payload.dryRun, false, "the response surfaces dryRun so the operator can tell whether a live write actually happened");
});

test("execute route: an unauthenticated request is rejected before touching the core", async () => {
  let called = false;
  const handler = createExecuteExperimentHandler({
    getSession: async () => null,
    core: {
      async executeExperiment() {
        called = true;
        throw new Error("must not be called");
      },
    },
    resolver: {
      async verifyChangeSetBelongsToChannel() {
        throw new Error("must not be called");
      },
      async createDryRunBatch() {
        throw new Error("must not be called");
      },
    },
    getLiveWritesEnabled: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });

  const response = await handler(makeRequest(), { params });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("execute route: a non-JSON body returns validation_failed 400 before touching the core", async () => {
  let called = false;
  const handler = createExecuteExperimentHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async executeExperiment() {
        called = true;
        throw new Error("must not be called");
      },
    },
    resolver: {
      async verifyChangeSetBelongsToChannel() {
        throw new Error("must not be called");
      },
      async createDryRunBatch() {
        throw new Error("must not be called");
      },
    },
    getLiveWritesEnabled: async () => false,
  });

  const response = await handler(
    new Request("http://localhost/api/decision-engine/experiments/exp-1/execute", { method: "POST", body: "not json" }),
    { params }
  );
  assert.equal(response.status, 400);
  assert.equal(called, false);
});
