import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createClipReviewRouteHandlers, rfc5987, type ClipReviewRouteDeps } from "./handlers";

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
      stageAttachment: async (...args) => {
        calls.push(["stage", ...args]);
        if (options.refuse) throw options.refuse;
        return { uploadId: "a".repeat(32), name: "note.txt", mime: "text/plain" };
      },
      appendAttachmentPiece: async (channelId, clipId, uploadId, offset, bytes) => {
        calls.push(["piece", channelId, clipId, uploadId, offset, Buffer.from(bytes).toString("utf8")]);
        if (options.refuse) throw options.refuse;
        return { received: offset + bytes.length, complete: false };
      },
      discardAttachment: async (...args) => (calls.push(["discard", ...args]), { removed: true as const }),
      attachmentFile: async (...args) => {
        calls.push(["attachment", ...args]);
        if (options.refuse) throw options.refuse;
        return { ...(options.file ?? { path: "/none", bytes: 0, type: "text/plain" }), name: "Скриншот 1.png" };
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

// BL-246 (CLIP_REVIEWS_PLAN.md items 13 and 16, AC-CR-22 / AC-CR-27): the attachment routes need the same session and active channel;
// a piece is at most 4 MiB (the proxy keeps only 40 MB of a body) and reaches the module with its offset and exact bytes; an
// attachment goes only to a loopback request, inline, with its name, never its path.

const put = (body: string | Uint8Array<ArrayBuffer>, query = "?offset=0") => new Request(`http://127.0.0.1:3000/x${query}`, { method: "PUT", headers: { host: "127.0.0.1:3000" }, body });

test("AC-CR-22 / AC-CR-27: the attachment routes refuse without a session (401) and for another channel (403); none reaches the module", async () => {
  const anonymous = make({ session: null });
  assert.equal((await anonymous.handlers.stageAttachment(post({}), ctx({ channelId: "UC_active", clipId: "clip_1" }))).status, 401);
  assert.equal((await anonymous.handlers.attachmentPiece(put("x"), ctx({ channelId: "UC_active", clipId: "clip_1", uploadId: "u" }))).status, 401);
  assert.equal((await anonymous.handlers.attachment(get(), ctx({ channelId: "UC_active", clipId: "clip_1", decisionId: "cd_1", index: "0" }))).status, 401);
  const other = make();
  assert.equal((await other.handlers.stageAttachment(post({}), ctx({ channelId: "UC_other", clipId: "clip_1" }))).status, 403);
  assert.equal((await other.handlers.attachmentPiece(put("x"), ctx({ channelId: "UC_other", clipId: "clip_1", uploadId: "u" }))).status, 403);
  assert.equal((await other.handlers.discardAttachment(get(), ctx({ channelId: "UC_other", clipId: "clip_1", uploadId: "u" }))).status, 403);
  assert.equal((await other.handlers.attachment(get(), ctx({ channelId: "UC_other", clipId: "clip_1", decisionId: "cd_1", index: "0" }))).status, 403);
  const remote = make({ loopback: false });
  assert.equal((await remote.handlers.attachment(get(), ctx({ channelId: "UC_active", clipId: "clip_1", decisionId: "cd_1", index: "0" }))).status, 403);
  assert.deepEqual([...anonymous.calls, ...other.calls, ...remote.calls], []);
});

test("AC-CR-27: staging and a piece reach the module with the body, the offset and the exact bytes; a bad offset or a piece over 4 MiB does not", async () => {
  const { handlers, calls } = make();
  const body = { name: "note.txt", type: "text/plain", size: 5, sha256: "b".repeat(64) };
  const staged = await handlers.stageAttachment(post(body), ctx({ channelId: "UC_active", clipId: "clip_1" }));
  assert.equal(staged.status, 200);
  assert.deepEqual(await staged.json(), { uploadId: "a".repeat(32), name: "note.txt", mime: "text/plain" });
  const piece = await handlers.attachmentPiece(put("hello", "?offset=12"), ctx({ channelId: "UC_active", clipId: "clip_1", uploadId: "u1" }));
  assert.deepEqual([piece.status, await piece.json()], [200, { received: 17, complete: false }]);
  for (const query of ["", "?offset=-1", "?offset=abc", "?offset=1.5"]) {
    assert.equal((await handlers.attachmentPiece(put("x", query), ctx({ channelId: "UC_active", clipId: "clip_1", uploadId: "u1" }))).status, 400, query);
  }
  const tooBig = await handlers.attachmentPiece(put(new Uint8Array(4 * 1024 * 1024 + 1)), ctx({ channelId: "UC_active", clipId: "clip_1", uploadId: "u1" }));
  assert.equal(tooBig.status, 400);
  assert.equal((await handlers.discardAttachment(get(), ctx({ channelId: "UC_active", clipId: "clip_1", uploadId: "u1" }))).status, 200);
  assert.deepEqual(calls, [
    ["stage", "UC_active", "clip_1", body],
    ["piece", "UC_active", "clip_1", "u1", 12, "hello"],
    ["discard", "UC_active", "clip_1", "u1"],
  ]);
  const unknown = make({ refuse: new DomainError({ code: "clip_attachment_upload_offset", message: "no" }) });
  assert.equal((await unknown.handlers.attachmentPiece(put("x"), ctx({ channelId: "UC_active", clipId: "clip_1", uploadId: "u1" }))).status, 409);
  const notAllowed = make({ refuse: new DomainError({ code: "clip_attachment_type_not_allowed", message: "no" }) });
  assert.equal((await notAllowed.handlers.stageAttachment(post(body), ctx({ channelId: "UC_active", clipId: "clip_1" }))).status, 415);
});

test("AC-CR-22: an attachment is served inline with its name and type; missing is 404, changed 409, a bad index 404", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "clip-route-"));
  try {
    const file = path.join(dir, "shot.png");
    await writeFile(file, "PNGDATA");
    const { handlers, calls } = make({ file: { path: file, bytes: 7, type: "image/png" } });
    const res = await handlers.attachment(get(), ctx({ channelId: "UC_active", clipId: "clip_1", decisionId: "cd_1", index: "2" }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-disposition"), "inline; filename*=UTF-8''%D0%A1%D0%BA%D1%80%D0%B8%D0%BD%D1%88%D0%BE%D1%82%201.png");
    assert.equal(await res.text(), "PNGDATA");
    assert.deepEqual(calls, [["attachment", "UC_active", "clip_1", "cd_1", 2]]);
    for (const index of ["-1", "x", "100", ""]) {
      assert.equal((await handlers.attachment(get(), ctx({ channelId: "UC_active", clipId: "clip_1", decisionId: "cd_1", index }))).status, 404, index);
    }
    const missing = make({ refuse: new DomainError({ code: "clip_attachment_missing", message: "not yet" }) });
    const notHere = await missing.handlers.attachment(get(), ctx({ channelId: "UC_active", clipId: "clip_1", decisionId: "cd_1", index: "0" }));
    assert.deepEqual([notHere.status, (await notHere.json()).error], [404, "clip_attachment_missing"]);
    const changed = make({ refuse: new DomainError({ code: "clip_attachment_changed", message: "other" }) });
    assert.equal((await changed.handlers.attachment(get(), ctx({ channelId: "UC_active", clipId: "clip_1", decisionId: "cd_1", index: "0" }))).status, 409);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review 8: the file name in content-disposition is an RFC 5987 ext-value -- ' ( ) * are percent-encoded too", () => {
  assert.equal(rfc5987("it's (final)*.png"), "it%27s%20%28final%29%2A.png");
  assert.equal(rfc5987("a.txt"), "a.txt");
  assert.equal(rfc5987("Скрин.png"), "%D0%A1%D0%BA%D1%80%D0%B8%D0%BD.png");
});
