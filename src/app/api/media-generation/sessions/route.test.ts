import assert from "node:assert/strict";
import test from "node:test";
import type { MediaGenerationCore } from "@/lib/media-generation";
import type { MediaRouteDeps } from "../shared";
import { createSessionsPostHandler } from "./route";

// BL-157 (review round 6; ADR 0029 §6, ADR 0031): only the factory links a session to a generation plan (checked by the plans
// module). The operator's own session request never carries a plan link, whatever the request names.
test("the operator's session request is created without any plan link the request names", async () => {
  const requested: Array<Record<string, unknown>> = [];
  const deps: MediaRouteDeps = {
    getSession: async () => ({ user: { id: "u1" } }),
    core: { requestSession: async (input: Record<string, unknown>) => (requested.push(input), { sessionId: "s1" }) } as unknown as MediaGenerationCore,
    isConnectedChannel: async () => true,
  };
  const res = await createSessionsPostHandler(deps)(new Request("http://127.0.0.1/api/media-generation/sessions", { method: "POST", body: JSON.stringify({ channelId: "UC_tropico", maxMinutes: 30, planId: "R-0001-japan" }) }));
  assert.equal(res.status, 201);
  assert.deepEqual(requested, [{ channelId: "UC_tropico", maxMinutes: 30, requestedBy: "operator" }]);
});
