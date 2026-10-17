import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createVideoCostsRouteHandlers, type VideoCostsRouteDeps } from "./handlers";

// BL-194 stage 3 (AGENTS.md §F, ADR 0004): the cost routes need a session and the ACTIVE channel; the video comes from the address;
// refusals keep their codes.

function setup(options: { userId?: string | null } = {}) {
  const calls: string[] = [];
  const deps: VideoCostsRouteDeps = {
    getSession: async () => (options.userId === null ? null : { user: { id: options.userId ?? "user-1" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_A") throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "not the active channel" });
    },
    service: async () => ({
      summary: async (input) => (calls.push(`summary:${JSON.stringify(input)}`), { channelId: "UC_A", videos: [], unlinked: { runpodUsd: 0, geminiUsd: 0, totalUsd: 0, runs: 0, estimated: false }, computers: [] }),
      videoCost: async (input) => {
        calls.push(`video:${JSON.stringify(input)}`);
        if ((input as { video: string }).video === "V049") throw new DomainError({ code: "validation_failed", message: "bad number" });
        return { channelId: "UC_A", video: "V49", totals: { runpodUsd: 0, geminiUsd: 0, totalUsd: 0, runs: 0, estimated: false }, runs: [], computers: [] };
      },
    }),
  };
  return { handlers: createVideoCostsRouteHandlers(deps), calls };
}
const ctx = <T>(params: T) => ({ params: Promise.resolve(params) });
const get = () => new Request("http://127.0.0.1/x");

test("BL-194 cost routes: no session -> 401; another channel than the active one -> refused before the module", async () => {
  const anon = setup({ userId: null });
  assert.equal((await anon.handlers.summary(get(), ctx({ channelId: "UC_A" }))).status, 401);
  const other = setup();
  const res = await other.handlers.video(get(), ctx({ channelId: "UC_B", video: "V49" }));
  assert.equal(res.status, 403);
  assert.deepEqual([...anon.calls, ...other.calls], []);
});

test("BL-194 cost routes: the channel and the video come from the address; a refusal keeps its code", async () => {
  const { handlers, calls } = setup();
  assert.equal((await handlers.summary(get(), ctx({ channelId: "UC_A" }))).status, 200);
  assert.equal((await handlers.video(get(), ctx({ channelId: "UC_A", video: "V49" }))).status, 200);
  const bad = await handlers.video(get(), ctx({ channelId: "UC_A", video: "V049" }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "validation_failed");
  assert.deepEqual(calls, ['summary:{"channelId":"UC_A"}', 'video:{"channelId":"UC_A","video":"V49"}', 'video:{"channelId":"UC_A","video":"V049"}']);
});
