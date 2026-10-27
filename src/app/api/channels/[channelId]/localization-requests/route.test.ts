import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createRequestsHandlers } from "./route";
import { createCancelRequestHandler } from "./[requestId]/cancel/route";

// BL-227 stage 2: the request routes check the session and the active channel before anything else.
const allow = { assertActiveChannel: async () => "UC_A" };
const deny = { assertActiveChannel: async () => { throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "no" }); } };
const params = { params: Promise.resolve({ channelId: "UC_A" }) };

test("create: 201 with the body reaching the module for the active channel; refused before the module for another channel", async () => {
  const calls: unknown[] = [];
  const deps = { getSession: async () => ({ user: { id: "u" } }), channelAccess: allow, create: async (channelId: string, body: unknown) => (calls.push([channelId, body]), { requestId: "q-1" } as never), list: async () => ({ requests: [] }) };
  const res = await createRequestsHandlers(deps).POST(new Request("http://x", { method: "POST", body: JSON.stringify({ videoIds: ["v1"], languages: ["it"] }) }), params);
  assert.equal(res.status, 201);
  assert.deepEqual(calls, [["UC_A", { videoIds: ["v1"], languages: ["it"] }]]);
  const refused = await createRequestsHandlers({ ...deps, channelAccess: deny }).POST(new Request("http://x", { method: "POST", body: "{}" }), params);
  assert.notEqual(refused.status, 201);
  assert.equal(calls.length, 1);
});

test("cancel: a finished request answers 409 request_not_claimable", async () => {
  const handler = createCancelRequestHandler({
    getSession: async () => ({ user: { id: "u" } }),
    channelAccess: allow,
    cancel: async () => {
      throw new DomainError({ code: "request_not_claimable", message: "done" });
    },
  });
  const res = await handler(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ channelId: "UC_A", requestId: "q-1" }) });
  assert.equal(res.status, 409);
});
