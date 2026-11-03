import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createClipReviewRouteHandlers, type ClipReviewRouteDeps } from "./handlers";

// BL-241 AC-CR-11 (CLIP_REVIEWS_PLAN.md items 5-6; AGENTS.md §F; ADR 0029 decision 5): the owner's clip routes need a Web session
// (401) and the ACTIVE channel (403); the video goes only to a loopback request (403) and honours HTTP Range (RFC 9110 §14: a
// satisfiable `bytes=a-b` is 206 with exactly those bytes and `content-range: bytes a-b/size`; no Range is 200 with the whole file);
// a decision reaches the module with the session's user; the module's refusals keep their codes and statuses.

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const post = (body: unknown) => new Request("http://127.0.0.1:3000/x", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:3000" }, body: JSON.stringify(body) });
const get = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/x", { headers: { host: "127.0.0.1:3000", ...headers } });

function make(options: { session?: { user: { id: string } } | null; refuse?: DomainError; file?: { path: string; bytes: number; type: string } | null; loopback?: boolean } = {}) {
  const calls: unknown[][] = [];
  const deps: ClipReviewRouteDeps = {
    getSession: async () => (options.session === undefined ? { user: { id: "u1" } } : options.session),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not the active channel" });
    },
    service: () => ({
      ownerList: async (...args) => (calls.push(["list", ...args]), { clips: [], waiting: 0 }),
      decide: async (...args) => {
        calls.push(["decide", ...args]);
        if (options.refuse) throw options.refuse;
        return { clip: {} as never };
      },
      clipFile: async (...args) => {
        calls.push(["file", ...args]);
        if (options.refuse) throw options.refuse;
        return options.file ?? null;
      },
    }),
    isLoopback: () => options.loopback ?? true,
  };
  return { handlers: createClipReviewRouteHandlers(deps), calls };
}

test("AC-CR-11: no session -> 401, another channel -> 403, not loopback -> 403; none reaches the module", async () => {
  const anonymous = make({ session: null });
  assert.equal((await anonymous.handlers.list(get(), ctx({ channelId: "UC_active" }))).status, 401);
  assert.equal((await anonymous.handlers.video(get(), ctx({ channelId: "UC_active", clipId: "clip_1" }))).status, 401);
  const other = make();
  assert.equal((await other.handlers.decide(post({ action: "approve" }), ctx({ channelId: "UC_other", clipId: "clip_1" }))).status, 403);
  assert.equal((await other.handlers.video(get(), ctx({ channelId: "UC_other", clipId: "clip_1" }))).status, 403);
  const remote = make({ loopback: false });
  assert.equal((await remote.handlers.video(get(), ctx({ channelId: "UC_active", clipId: "clip_1" }))).status, 403);
  assert.deepEqual([...anonymous.calls, ...other.calls, ...remote.calls], []);
});

test("AC-CR-11: a decision reaches the module with the channel, the clip, the body and the session's user; refusals keep their codes", async () => {
  const { handlers, calls } = make();
  const body = { action: "return", comment: "darker" };
  assert.equal((await handlers.decide(post(body), ctx({ channelId: "UC_active", clipId: "clip_1" }))).status, 200);
  assert.deepEqual(calls, [["decide", "UC_active", "clip_1", body, "u1"]]);
  const twice = make({ refuse: new DomainError({ code: "clip_review_not_pending", message: "approved", details: { status: "approved" } }) });
  const res = await twice.handlers.decide(post({ action: "approve" }), ctx({ channelId: "UC_active", clipId: "clip_1" }));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "clip_review_not_pending", message: "approved", details: { status: "approved" } });
  const unknown = make({ refuse: new DomainError({ code: "clip_review_not_found", message: "none" }) });
  assert.equal((await unknown.handlers.video(get(), ctx({ channelId: "UC_active", clipId: "clip_x" }))).status, 404);
  const changed = make({ refuse: new DomainError({ code: "clip_review_file_changed", message: "changed" }) });
  assert.equal((await changed.handlers.decide(post({ action: "approve" }), ctx({ channelId: "UC_active", clipId: "clip_1" }))).status, 409);
});

test("AC-CR-11: the video honours Range -- bytes=10-19 is 206 with exactly those bytes; no Range is 200 whole; a missing file 404", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "clip-route-"));
  try {
    // 40 known bytes: "0123456789" then "abcdefghij" then "ABCDEFGHIJ" then "!@#$%^&*()".
    const content = "0123456789abcdefghijABCDEFGHIJ!@#$%^&*()";
    const file = path.join(dir, "preview_30s.mp4");
    await writeFile(file, content);
    const { handlers, calls } = make({ file: { path: file, bytes: 40, type: "video/mp4" } });
    const partial = await handlers.video(get({ range: "bytes=10-19" }), ctx({ channelId: "UC_active", clipId: "clip_1" }));
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 10-19/40");
    assert.equal(partial.headers.get("content-length"), "10");
    assert.equal(partial.headers.get("content-type"), "video/mp4");
    assert.equal(partial.headers.get("accept-ranges"), "bytes");
    assert.equal(await partial.text(), "abcdefghij");
    const tail = await handlers.video(get({ range: "bytes=-5" }), ctx({ channelId: "UC_active", clipId: "clip_1" }));
    assert.equal(tail.status, 206);
    assert.equal(await tail.text(), "^&*()"); // the last 5 of the 40
    const whole = await handlers.video(get(), ctx({ channelId: "UC_active", clipId: "clip_1" }));
    assert.equal(whole.status, 200);
    assert.equal(await whole.text(), content);
    const beyond = await handlers.video(get({ range: "bytes=40-50" }), ctx({ channelId: "UC_active", clipId: "clip_1" }));
    assert.equal(beyond.status, 416);
    assert.deepEqual(calls[0], ["file", "UC_active", "clip_1"]);
    const missing = make({ file: null });
    const res = await missing.handlers.video(get(), ctx({ channelId: "UC_active", clipId: "clip_1" }));
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "clip_review_file_missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
