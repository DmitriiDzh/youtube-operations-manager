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
import { createLiveStreamLocalizationsHandlers } from "./localizations/route";
import { createLiveStreamAnalyticsGetHandler } from "./analytics/route";
import { createSourceModePutHandler } from "./source/route";
import { createLibraryHandlers } from "./library/route";
import { createLibrarySegmentDeleteHandler } from "./library/[seq]/route";
import { createLibraryPosterGetHandler } from "./library/[seq]/poster/route";
import { createStreamLocalizations } from "@/lib/live-streams/localizations";
import { readStoredVideoSettings } from "@/lib/live-streams/video-settings";
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

// BL-207 (LIVE_LOCALIZATIONS_PLAN.md AC-LL-07, AC-LL-10; DEVELOPMENT_PLAYBOOK §6.6): the translations route is behind the same
// session and active-channel checks; PUT passes `localizations` to the module, which refuses the whole set per language.
test("translations: 401/403 before the module; PUT passes `localizations` through; GET reads the view", async () => {
  calls.length = 0;
  const handlers = createLiveStreamLocalizationsHandlers(deps({ session: false }));
  assert.equal((await handlers.PUT(post({ localizations: {} }), ctx())).status, 401);
  assert.equal((await createLiveStreamLocalizationsHandlers(deps({ activeChannel: "UC2" })).GET(new Request("http://localhost/x"), ctx("UC1"))).status, 403);
  assert.deepEqual(calls, []);
  const ok = createLiveStreamLocalizationsHandlers(deps());
  assert.equal((await ok.PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ localizations: { de: { title: "T", description: "D" } } }) }), ctx())).status, 200);
  assert.equal((await ok.GET(new Request("http://localhost/x"), ctx())).status, 200);
  assert.deepEqual(calls, ['saveLocalizations:["UC1",{"de":{"title":"T","description":"D"}}]', 'getLocalizations:["UC1"]']);
});

/** The route over the real translations store with one in-memory row (null = no stream on this computer). */
function localizationsRoute(initial: Record<string, unknown> | null) {
  let row: Record<string, unknown> | null = initial ? { channelId: "UC1", localizationsJson: null, ...initial } : null;
  const service = createStreamLocalizations({
    store: {
      getStream: async () => row as never,
      updateStream: async (_channelId, set) => {
        if (!row) return false;
        row = { ...row, ...set };
        return true;
      },
      insertEvent: async () => undefined,
    },
    channelLanguage: async () => "en",
    readVideoSettings: readStoredVideoSettings,
    lastApplied: async () => null,
    clock: () => new Date("2026-10-21T10:00:00Z"),
    newId: () => "e1",
  });
  const base = deps();
  const core = { ...base.core, getLocalizations: (channelId: string) => service.view(channelId), saveLocalizations: (channelId: string, body: unknown) => service.save(channelId, body, "owner") } as unknown as LiveStreamRouteCore;
  const handlers = createLiveStreamLocalizationsHandlers({ ...base, core });
  const put = async (localizations: unknown) => handlers.PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ localizations }) }), ctx());
  return { handlers, put, row: () => row };
}

test("AC-LL-07 via the route: each refusal is a 400 with every refused language; nothing stored; 5000 bytes accepted", async () => {
  const before = JSON.stringify({ fr: { title: "Ft", description: "Fd" } });
  const route = localizationsRoute({ localizationsJson: before });
  const cases: Array<[Record<string, unknown>, Array<[string, string]>]> = [
    [{ de: { title: "", description: "D" } }, [["de", "title_empty"]]],
    [{ de: { title: "x".repeat(101), description: "D" } }, [["de", "title_too_long"]]],
    [{ de: { title: "T", description: "é".repeat(2501) } }, [["de", "description_too_long"]]],
    [{ de: { title: "T", description: "   " } }, [["de", "description_empty"]]],
    [{ de: { title: "T", description: "a > b" } }, [["de", "description_angle_brackets"]]],
    [{ "pt-br": { title: "T", description: "D" }, xx: { title: "T", description: "D" } }, [["pt-br", "unsupported_language"], ["xx", "unsupported_language"]]],
    [{ en: { title: "T", description: "D" } }, [["en", "baseline_language"]]],
  ];
  for (const [localizations, refused] of cases) {
    const response = await route.put(localizations);
    assert.equal(response.status, 400, JSON.stringify(localizations).slice(0, 80));
    const body = await response.json();
    assert.equal(body.error, "validation_failed");
    assert.deepEqual(body.details.refused.map((r: { language: string; reason: string }) => [r.language, r.reason]), refused);
  }
  assert.equal(route.row()!.localizationsJson, before);

  const accepted = await route.put({ de: { title: "Dt", description: "é".repeat(2500) } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {
    localizations: { de: { title: "Dt", description: "é".repeat(2500) } },
    warnings: [{ code: "video_settings_not_saved", message: "The stream's video settings are not saved, so nothing is applied after Start -- the translations are written only as part of the video settings: save them" }],
  });
  const view = await (await route.handlers.GET(new Request("http://localhost/x"), ctx())).json();
  assert.deepEqual(view.localizations, { de: { title: "Dt", description: "é".repeat(2500) } });
});

test("AC-LL-10 via the route: no stream on this computer is a 404 live_stream_not_found", async () => {
  const response = await localizationsRoute(null).put({ de: { title: "T", description: "D" } });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "live_stream_not_found");
});

// BL-213 (LIVE_ANALYTICS_PLAN.md stage 3): the «Эфиры» summary route -- session 401, active channel 403, days 1..90 (default 7).
test("BL-213: analytics route -- 401 without a session, 403 for another channel, 400 for a bad range, default 7 days", async () => {
  const get = (d: LiveStreamRouteDeps, query = "", channelId = "UC1") => createLiveStreamAnalyticsGetHandler(d)(new Request(`http://localhost/x${query}`), ctx(channelId));
  calls.length = 0;
  assert.equal((await get(deps({ session: false }))).status, 401);
  assert.equal((await get(deps(), "", "UC2")).status, 403);
  for (const bad of ["?days=0", "?days=91", "?days=x", "?days=1.5"]) assert.equal((await get(deps(), bad)).status, 400, bad);
  assert.deepEqual(calls, [], "the module is not reached");
  assert.equal((await get(deps())).status, 200);
  assert.equal((await get(deps(), "?days=30")).status, 200);
  assert.deepEqual(calls, ['liveAnalytics:["UC1",7]', 'liveAnalytics:["UC1",30]']);
});

// BL-234 (FO-REQ-0048, ADR 0056): the source switch and the segment library are the owner's Web routes -- a session (401) and the
// active channel (403, wrong channel fails closed) before the module; a seq that is not 1-6 digits is a 400 before the module.
test("BL-234: source switch and library routes -- 401/403 before the module, the body and seq passed through, bad seq 400", async () => {
  calls.length = 0;
  const put = (body: unknown) => new Request("http://localhost/x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const get = () => new Request("http://localhost/x", { method: "GET" });
  const seqCtx = (seq: string, channelId = "UC1") => ({ params: Promise.resolve({ channelId, seq }) });
  assert.equal((await createSourceModePutHandler(deps({ session: false }))(put({ mode: "segments" }), ctx())).status, 401);
  assert.equal((await createSourceModePutHandler(deps({ activeChannel: "UC2" }))(put({ mode: "segments" }), ctx())).status, 403);
  assert.equal((await createLibraryHandlers(deps({ activeChannel: "UC2" })).GET(get(), ctx())).status, 403);
  assert.equal((await createLibraryHandlers(deps({ activeChannel: "UC2" })).POST(post({ seqs: [1] }), ctx())).status, 403);
  assert.equal((await createLibrarySegmentDeleteHandler(deps({ activeChannel: "UC2" }))(new Request("http://localhost/x", { method: "DELETE" }), seqCtx("1"))).status, 403);
  assert.equal((await createLibraryPosterGetHandler(deps({ session: false }))(get(), seqCtx("1"))).status, 401);
  assert.deepEqual(calls, []);

  assert.equal((await createSourceModePutHandler(deps())(put({ mode: "segments" }), ctx())).status, 200);
  assert.equal((await createLibraryHandlers(deps()).POST(post({ seqs: [3, 1] }), ctx())).status, 201);
  assert.equal((await createLibraryHandlers(deps()).PUT(put({ seqs: [1, 3] }), ctx())).status, 200);
  assert.equal((await createLibrarySegmentDeleteHandler(deps())(new Request("http://localhost/x", { method: "DELETE" }), seqCtx("000003"))).status, 200);
  assert.deepEqual(calls, ['setSourceMode:["UC1",{"mode":"segments"}]', 'addSegments:["UC1",{"seqs":[3,1]}]', 'reorderSegments:["UC1",{"seqs":[1,3]}]', 'removeSegment:["UC1",3]']);

  calls.length = 0;
  for (const bad of ["abc", "1234567", "-1", "1.5"]) {
    assert.equal((await createLibrarySegmentDeleteHandler(deps())(new Request("http://localhost/x", { method: "DELETE" }), seqCtx(bad))).status, 400, bad);
    assert.equal((await createLibraryPosterGetHandler(deps())(get(), seqCtx(bad))).status, 400, bad);
  }
  assert.deepEqual(calls, []);
});
