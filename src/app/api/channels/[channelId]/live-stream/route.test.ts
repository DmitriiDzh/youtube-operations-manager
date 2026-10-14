import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/live-streams";
import { createLiveStreamGetHandler } from "./route";
import { createRotationBatchPostHandler } from "./rotation/batch/route";
import { createRotationCandidatesGetHandler } from "./rotation/candidates/route";
import { createRotationPostHandler } from "./rotation/route";
import { createStartPostHandler } from "./start/route";
import { createStopPostHandler } from "./stop/route";
import { createLiveStreamThumbnailHandlers } from "./thumbnail/route";
import { createLiveStreamVideoSettingsPutHandler } from "./video-settings/route";
import type { LiveStreamRouteCore, LiveStreamRouteDeps } from "./shared";

// BL-176 (LIVE_STREAMS_PLAN.md §3.9/§3.12; DEVELOPMENT_PLAYBOOK §6.6): every route needs a Web session (401) and the channel
// must be the active one (403, ADR 0004) before the module is reached; errors keep their codes; the session's user is the
// credential the writes run under.

const calls: string[] = [];

function deps(opts: { session?: boolean; activeChannel?: string; fail?: DomainError } = {}): LiveStreamRouteDeps {
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}:${JSON.stringify(args)}`);
    if (opts.fail) throw opts.fail;
    return { ok: name };
  };
  const core = new Proxy({}, { get: (_t, name: string) => record(name) }) as unknown as LiveStreamRouteCore;
  return {
    getSession: async () => (opts.session === false ? null : { user: { id: "u1" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== (opts.activeChannel ?? "UC1")) throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not the active channel" });
    },
    core,
  };
}

const ctx = (channelId = "UC1") => ({ params: Promise.resolve({ channelId }) });
const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("401 without a Web session; the module is not reached", async () => {
  calls.length = 0;
  const response = await createStartPostHandler(deps({ session: false }))(post({}), ctx());
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test("403 for a channel that is not the active one; the module is not reached", async () => {
  calls.length = 0;
  for (const handler of [createLiveStreamGetHandler, createStartPostHandler, createRotationPostHandler]) {
    const response = await handler(deps({ activeChannel: "UC2" }))(post({ videoId: "AAAAAAAAAA1" }), ctx("UC1"));
    assert.equal(response.status, 403);
  }
  assert.deepEqual(calls, []);
});

test("Start runs under the session's user; Stop passes the encoder-only choice through", async () => {
  calls.length = 0;
  assert.equal((await createStartPostHandler(deps())(post({}), ctx())).status, 200);
  assert.equal((await createStopPostHandler(deps())(post({ encoderOnly: true }), ctx())).status, 200);
  assert.deepEqual(calls, ['start:["UC1",{"userId":"u1"}]', 'stop:["UC1",{"userId":"u1"},{"encoderOnly":true}]']);
});

test("a DomainError keeps its code and status (Live writes off -> 503, a refused video -> 422)", async () => {
  const off = await createStartPostHandler(deps({ fail: new DomainError({ code: "live_writes_disabled", message: "off" }) }))(post({}), ctx());
  assert.equal(off.status, 503);
  assert.equal((await off.json()).error, "live_writes_disabled");
  const refused = await createRotationPostHandler(deps({ fail: new DomainError({ code: "live_stream_video_refused", message: "private", details: { reason: "private" } }) }))(post({ videoId: "AAAAAAAAAA1" }), ctx());
  assert.equal(refused.status, 422);
  assert.deepEqual((await refused.json()).details, { reason: "private" });
});

test("a body that is not JSON is a 400 before the module", async () => {
  calls.length = 0;
  const bad = new Request("http://localhost/x", { method: "POST", body: "{nope" });
  assert.equal((await createRotationPostHandler(deps())(bad, ctx())).status, 400);
  assert.deepEqual(calls, []);
});

// BL-187 (LIVE_STREAMS_FIELDS_PLAN.md §2.4): the picker's list and its batch add are behind the same session and
// active-channel checks; «show all files» is the `all=1` query.
test("the picker's list and batch add: 401/403 before the module; `all=1` asks for every file", async () => {
  calls.length = 0;
  const get = (url: string) => new Request(url, { method: "GET" });
  assert.equal((await createRotationCandidatesGetHandler(deps({ session: false }))(get("http://localhost/x"), ctx())).status, 401);
  assert.equal((await createRotationCandidatesGetHandler(deps({ activeChannel: "UC2" }))(get("http://localhost/x"), ctx())).status, 403);
  assert.equal((await createRotationBatchPostHandler(deps({ activeChannel: "UC2" }))(post({ items: [] }), ctx())).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await createRotationCandidatesGetHandler(deps())(get("http://localhost/x?all=1"), ctx())).status, 200);
  assert.equal((await createRotationCandidatesGetHandler(deps())(get("http://localhost/x"), ctx())).status, 200);
  assert.equal((await createRotationBatchPostHandler(deps())(post({ items: [{ videoId: "AAAAAAAAAA1", originalPath: "04 Videos/a.mp4" }] }), ctx())).status, 200);
  assert.deepEqual(calls, [
    'listCandidates:["UC1",{"showAll":true}]',
    'listCandidates:["UC1",{"showAll":false}]',
    'addVideos:["UC1",{"items":[{"videoId":"AAAAAAAAAA1","originalPath":"04 Videos/a.mp4"}]}]',
  ]);
});

// BL-186 (LIVE_STREAMS_FIELDS_PLAN.md §2.2/§3.1): the video settings and the thumbnail are behind the same session and
// active-channel checks; an image over thumbnails.set's 2 MB is a 413 before the module; the body reaches the module as bytes.
test("video settings and thumbnail: 401/403 first, 2 MB + 1 refused before the module, bytes passed through", async () => {
  calls.length = 0;
  const put = (body: BodyInit, headers: Record<string, string> = {}) => new Request("http://localhost/x", { method: "PUT", body, headers });
  assert.equal((await createLiveStreamVideoSettingsPutHandler(deps({ session: false }))(put("{}"), ctx())).status, 401);
  assert.equal((await createLiveStreamThumbnailHandlers(deps({ activeChannel: "UC2" })).PUT(put(new Uint8Array([1])), ctx())).status, 403);
  assert.deepEqual(calls, []);

  assert.equal((await createLiveStreamVideoSettingsPutHandler(deps())(put(JSON.stringify({ tags: [] })), ctx())).status, 200);
  assert.deepEqual(calls, ['saveVideoSettings:["UC1",{"tags":[]}]']);

  calls.length = 0;
  const big = new Uint8Array(2 * 1024 * 1024 + 1);
  const tooBig = await createLiveStreamThumbnailHandlers(deps()).PUT(put(big), ctx());
  assert.equal(tooBig.status, 413);
  assert.deepEqual(calls, []);

  const ok = await createLiveStreamThumbnailHandlers(deps()).PUT(put(new Uint8Array([0xff, 0xd8, 0xff])), ctx());
  assert.equal(ok.status, 200);
  assert.deepEqual(calls, ['setThumbnail:["UC1",{"0":255,"1":216,"2":255}]']);
});
