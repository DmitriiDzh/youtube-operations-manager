import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createVideoInsightsHandler } from "./handlers";

// BL-221 (AGENTS.md §F, ADR 0004): the insights need a session and the ACTIVE channel; another channel is refused before any read.

const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });

test("BL-221 insights route: no session -> 401, another channel -> refused, the active one -> its insights", async () => {
  const loaded: string[] = [];
  const handler = (userId: string | null) =>
    createVideoInsightsHandler({
      getSession: async () => (userId ? { user: { id: userId } } : null),
      assertActiveChannel: async ({ channelId }) => {
        if (channelId !== "UC_A") throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "not the active channel" });
      },
      load: async (channelId) => (loaded.push(channelId), { channelId, videos: {}, viewsThrough: null, reachThrough: null }),
    });
  assert.equal((await handler(null)(new Request("http://127.0.0.1/x"), ctx("UC_A"))).status, 401);
  assert.equal((await handler("u")(new Request("http://127.0.0.1/x"), ctx("UC_B"))).status, 403);
  const ok = await handler("u")(new Request("http://127.0.0.1/x"), ctx("UC_A"));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).channelId, "UC_A");
  assert.deepEqual(loaded, ["UC_A"]);
});
