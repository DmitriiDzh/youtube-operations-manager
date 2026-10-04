import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { createCollectionDepthHandlers } from "./route";

const DEFAULTS = {
  maxVideosPerChannel: 120,
  publishedAfter: null,
  effectiveMaxVideosPerChannel: 120,
  estimatedFirstCollectionUnits: 4,
  estimatedFirstCollectionWorstCaseUnits: 7,
};

function post(body: unknown) {
  return new Request("http://localhost/api/market-intelligence/collection-depth", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

test("collection-depth route: GET returns the defaults; an unauthenticated request never reaches the core", async () => {
  let called = 0;
  const core = {
    async getCollectionDepthDefaults() {
      called += 1;
      return DEFAULTS;
    },
    async setCollectionDepthDefaults() {},
  };
  const ok = createCollectionDepthHandlers({ getSession: async () => ({ user: { id: "u1" } }), core });
  const response = await ok.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), DEFAULTS);

  called = 0;
  const denied = createCollectionDepthHandlers({ getSession: async () => null, core });
  assert.equal((await denied.GET()).status, 401);
  assert.equal((await denied.POST(post({}))).status, 401);
  assert.equal(called, 0);
});

test("collection-depth route: POST forwards the body to the core and returns the stored defaults; invalid JSON is 400; a DomainError keeps its code", async () => {
  let received: unknown;
  const handlers = createCollectionDepthHandlers({
    getSession: async () => ({ user: { id: "u1" } }),
    core: {
      async getCollectionDepthDefaults() {
        return DEFAULTS;
      },
      async setCollectionDepthDefaults(input: unknown) {
        received = input;
      },
    },
  });
  const response = await handlers.POST(post({ maxVideosPerChannel: 120, publishedAfter: null }));
  assert.equal(response.status, 200);
  assert.deepEqual(received, { maxVideosPerChannel: 120, publishedAfter: null });
  assert.deepEqual(await response.json(), DEFAULTS);

  assert.equal((await handlers.POST(post("not json"))).status, 400);

  const failing = createCollectionDepthHandlers({
    getSession: async () => ({ user: { id: "u1" } }),
    core: {
      async getCollectionDepthDefaults() {
        return DEFAULTS;
      },
      async setCollectionDepthDefaults() {
        throw new DomainError({ code: "validation_failed", message: "bad", details: {} });
      },
    },
  });
  const failed = await failing.POST(post({ maxVideosPerChannel: 0, publishedAfter: null }));
  assert.equal(failed.status, 400);
  assert.equal((await failed.json()).error, "validation_failed");
});
