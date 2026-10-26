import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/batches/contracts";
import { createSendTogetherHandler } from "./route";
import { createSendTogetherPlanHandler } from "./plan/route";

// BL-198: the routes check the session and the active channel, validate the body, and map the service's errors (409 for an
// unresolved merge conflict) -- the selection itself is the service's (send-together.test.ts).

const params = { params: Promise.resolve({ channelId: "UC_A" }) };
const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });
const allow = { assertActiveChannel: async () => "UC_A" };

test("send-together: 201 with the batch id; the body's sets, resolutions and dryRun reach the service", async () => {
  const calls: unknown[] = [];
  const handler = createSendTogetherHandler({
    getSession: async () => ({ user: { id: "u1" } }),
    channelAccess: allow,
    core: {
      createBatchForChangeSets: async (input) => {
        calls.push(input);
        return { batch: { id: "b1" } as never, changeCount: 3, videoCount: 2, rejectedChangeIds: ["a1"] };
      },
    },
  });
  const res = await handler(post({ changeSetIds: ["A", "B"], resolutions: [{ videoId: "v1", language: "es", changeSetId: "B" }], dryRun: false }), params);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.batchId, "b1");
  assert.deepEqual(body.rejectedChangeIds, ["a1"]);
  assert.deepEqual(calls, [{ channelId: "UC_A", changeSetIds: ["A", "B"], resolutions: [{ videoId: "v1", language: "es", changeSetId: "B" }], dryRun: false }]);
});

test("send-together: an unresolved conflict answers 409 send_merge_conflicts with the conflicts", async () => {
  const handler = createSendTogetherHandler({
    getSession: async () => ({ user: { id: "u1" } }),
    channelAccess: allow,
    core: {
      createBatchForChangeSets: async () => {
        throw new DomainError({ code: "send_merge_conflicts", message: "choose", details: { conflicts: [{ videoId: "v1" }] } });
      },
    },
  });
  const res = await handler(post({ changeSetIds: ["A", "B"] }), params);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "send_merge_conflicts");
  assert.deepEqual(body.details.conflicts, [{ videoId: "v1" }]);
});

test("send-together: no session 401; an empty or unknown-field body 400; another channel is refused before the service", async () => {
  let called = false;
  const core = {
    createBatchForChangeSets: async () => {
      called = true;
      return { batch: { id: "b1" } as never, changeCount: 0, videoCount: 0, rejectedChangeIds: [] };
    },
  };
  assert.equal((await createSendTogetherHandler({ getSession: async () => null, channelAccess: allow, core })(post({ changeSetIds: ["A"] }), params)).status, 401);
  const handler = createSendTogetherHandler({ getSession: async () => ({ user: { id: "u1" } }), channelAccess: allow, core });
  assert.equal((await handler(post({ changeSetIds: [] }), params)).status, 400);
  assert.equal((await handler(post({ changeSetIds: ["A"], extra: 1 }), params)).status, 400);
  const notActive = createSendTogetherHandler({
    getSession: async () => ({ user: { id: "u1" } }),
    channelAccess: {
      assertActiveChannel: async () => {
        throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "no" });
      },
    },
    core,
  });
  assert.equal((await notActive(post({ changeSetIds: ["A"] }), params)).status, 403);
  assert.equal(called, false);
});

test("send-together plan: answers the plan and never creates anything", async () => {
  const plan = { videoCount: 3, changeCount: 7, languageCount: 2, estimatedUnits: 156, conflicts: [], untitled: [], inFlightBatchId: null, inFlightCoversSelection: false };
  const handler = createSendTogetherPlanHandler({ getSession: async () => ({ user: { id: "u1" } }), channelAccess: allow, core: { planSendTogether: async () => plan } });
  const res = await handler(post({ changeSetIds: ["A", "B"] }), params);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), plan);
});
