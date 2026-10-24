import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createVideoProjectsRouteHandlers, type VideoProjectsRouteDeps } from "./handlers";

// BL-194 stage 1 (AGENTS.md §F, ADR 0004): every video route needs a session and the ACTIVE channel; the channel comes from the
// address, never from the body; refusals keep their codes.

function setup(options: { userId?: string | null; active?: string } = {}) {
  const calls: string[] = [];
  const deps: VideoProjectsRouteDeps = {
    getSession: async () => (options.userId === null ? null : { user: { id: options.userId ?? "user-1" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== (options.active ?? "UC_A")) throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "not the active channel" });
    },
    service: () => ({
      listVideos: async (input) => (calls.push(`list:${JSON.stringify(input)}`), { channelId: "UC_A", videos: [], workspace: "ok", nextVideo: "V1" }),
      createVideo: async (input) => (calls.push(`create:${JSON.stringify(input)}`), { video: { video: "V1" } as never }),
      renumber: async (input) => {
        calls.push(`renumber:${JSON.stringify(input)}`);
        throw new DomainError({ code: "validation_failed", message: "not lost" });
      },
      cancelVideo: async (input) => (calls.push(`cancel:${JSON.stringify(input)}`), { video: { video: "V1" } as never }),
      linkSuggestions: async (input) => (calls.push(`suggest:${JSON.stringify(input)}`), { video: { video: "V52" } as never, suggested: [], others: [] }),
      linkVideo: async (input) => {
        calls.push(`link:${JSON.stringify(input)}`);
        throw new DomainError({ code: "video_already_linked", message: "already linked" });
      },
    }),
  };
  return { handlers: createVideoProjectsRouteHandlers(deps), calls };
}

const ctx = <T>(params: T) => ({ params: Promise.resolve(params) });
const post = (body: unknown) => new Request("http://127.0.0.1/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("BL-194 routes: no session -> 401; another channel than the active one -> refused before the module", async () => {
  const anon = setup({ userId: null });
  assert.equal((await anon.handlers.list(new Request("http://127.0.0.1/x"), ctx({ channelId: "UC_A" }))).status, 401);
  assert.deepEqual(anon.calls, []);
  const other = setup();
  const res = await other.handlers.create(post({ workingTitle: "x" }), ctx({ channelId: "UC_B" }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "CHANNEL_NOT_AUTHORIZED");
  assert.deepEqual(other.calls, []);
});

test("BL-194 routes: the list passes the state filter; «Новый ролик» takes the channel from the address and refuses one in the body", async () => {
  const { handlers, calls } = setup();
  assert.equal((await handlers.list(new Request("http://127.0.0.1/x?state=in_work"), ctx({ channelId: "UC_A" }))).status, 200);
  const created = await handlers.create(post({ workingTitle: "Jazz bar" }), ctx({ channelId: "UC_A" }));
  assert.equal(created.status, 201);
  assert.equal((await handlers.create(post({ channelId: "UC_B" }), ctx({ channelId: "UC_A" }))).status, 400);
  assert.deepEqual(calls, ['list:{"channelId":"UC_A","state":"in_work"}', 'create:{"workingTitle":"Jazz bar","channelId":"UC_A"}']);
});

test("BL-194 routes: renumber and cancel name the video from the address; a refusal keeps its code", async () => {
  const { handlers, calls } = setup();
  const res = await handlers.renumber(new Request("http://127.0.0.1/x", { method: "POST" }), ctx({ channelId: "UC_A", video: "V50" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "validation_failed");
  assert.equal((await handlers.cancel(new Request("http://127.0.0.1/x", { method: "POST" }), ctx({ channelId: "UC_A", video: "V50" }))).status, 200);
  assert.deepEqual(calls, ['renumber:{"channelId":"UC_A","video":"V50"}', 'cancel:{"channelId":"UC_A","video":"V50"}']);
});

test("BL-221 routes: «Привязать к видео» takes the channel and the number from the address, only videoId from the body", async () => {
  const { handlers, calls } = setup();
  assert.equal((await handlers.linkSuggestions(new Request("http://127.0.0.1/x"), ctx({ channelId: "UC_A", video: "V52" }))).status, 200);
  const refused = await handlers.link(post({ videoId: "abcdefghijk" }), ctx({ channelId: "UC_A", video: "V52" }));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "video_already_linked");
  assert.equal((await handlers.link(post({ videoId: "abcdefghijk", video: "V9" }), ctx({ channelId: "UC_A", video: "V52" }))).status, 400);
  assert.equal((await handlers.link(post({ videoId: "abcdefghijk", channelId: "UC_B" }), ctx({ channelId: "UC_A", video: "V52" }))).status, 400);
  assert.equal((await handlers.link(post({ videoId: "abcdefghijk" }), ctx({ channelId: "UC_B", video: "V52" }))).status, 403);
  assert.deepEqual(calls, ['suggest:{"channelId":"UC_A","video":"V52"}', 'link:{"videoId":"abcdefghijk","channelId":"UC_A","video":"V52"}']);
});
