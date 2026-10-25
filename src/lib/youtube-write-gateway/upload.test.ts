import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { beginResumableVideoUpload, putVideoUploadChunk, queryVideoUploadOffset, type UploadHttp, type VideoInsertResource } from "./upload";

// BL-182 (ADR 0037). Expected requests and answers follow Google's "Resumable Uploads" guide for the YouTube Data API
// (developers.google.com/youtube/v3/guides/using_resumable_upload_protocol):
// - start: POST .../upload/youtube/v3/videos?uploadType=resumable&part=snippet,status with the resource as JSON and
//   X-Upload-Content-Length / X-Upload-Content-Type; the session URI is the `Location` of the 200 answer;
// - a chunk: PUT with `Content-Range: bytes first-last/total`; non-final chunks are multiples of 256 KB; 308 + `Range: bytes=0-N`
//   = N+1 bytes stored; 200/201 = done, with the video resource; 404 = the session expired;
// - status: PUT with `Content-Range: bytes */total` and no body.
// Plus this app's rule: the access token is sent only to https://www.googleapis.com.

const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc";
const RESOURCE: VideoInsertResource = {
  snippet: { title: "T", description: "D", defaultLanguage: "en", defaultAudioLanguage: "en" },
  status: { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
};

function fake(answers: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  const calls: Array<Parameters<UploadHttp>[0]> = [];
  const http: UploadHttp = async (args) => {
    calls.push(args);
    const answer = answers.shift();
    if (!answer) throw new Error("unexpected request");
    return { status: answer.status, headers: answer.headers ?? {}, body: answer.body ?? "" };
  };
  return { http, calls };
}

test("start: one POST to the resumable endpoint with the resource and the upload's size and type; the Location is the session", async () => {
  const { http, calls } = fake([{ status: 200, headers: { location: SESSION } }]);
  const result = await beginResumableVideoUpload({ accessToken: "tok", resource: RESOURCE, contentLength: 3832961, contentType: "video/mp4", notifySubscribers: false }, http);
  assert.deepEqual(result, { sessionUri: SESSION });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false");
  assert.equal(call.headers.Authorization, "Bearer tok");
  assert.equal(call.headers["X-Upload-Content-Length"], "3832961");
  assert.equal(call.headers["X-Upload-Content-Type"], "video/mp4");
  assert.deepEqual(JSON.parse(String(call.body)), RESOURCE);
});

test("start: a refusal keeps Google's reason; a session URI outside googleapis.com is refused (the token never goes there)", async () => {
  const refused = fake([{ status: 403, body: JSON.stringify({ error: { message: "The request cannot be completed", errors: [{ reason: "uploadLimitExceeded" }] } }) }]);
  await assert.rejects(
    beginResumableVideoUpload({ accessToken: "tok", resource: RESOURCE, contentLength: 10, contentType: "video/mp4", notifySubscribers: false }, refused.http),
    (error: unknown) => error instanceof DomainError && /uploadLimitExceeded/.test(error.message)
  );
  const elsewhere = fake([{ status: 200, headers: { location: "https://evil.example/upload/youtube/v3/videos?upload_id=x" } }]);
  await assert.rejects(
    beginResumableVideoUpload({ accessToken: "tok", resource: RESOURCE, contentLength: 10, contentType: "video/mp4", notifySubscribers: false }, elsewhere.http),
    /Refusing to send the token/
  );
});

// Owner msgs 3510/3511 (FO-REQ-0040 item 4): an upload is inserted private and never with a date -- the date is written after the
// upload is verified. So any publishAt in the insert is refused, private or not (before: allowed with private, msg 2717).
test("start: nothing is sent for an empty file, a video that is not private, or any publish date", async () => {
  const { http, calls } = fake([]);
  await assert.rejects(beginResumableVideoUpload({ accessToken: "t", resource: RESOURCE, contentLength: 0, contentType: "video/mp4", notifySubscribers: false }, http));
  const notPrivate = { ...RESOURCE, status: { ...RESOURCE.status, privacyStatus: "public" as unknown as "private" } };
  await assert.rejects(beginResumableVideoUpload({ accessToken: "t", resource: notPrivate, contentLength: 5, contentType: "video/mp4", notifySubscribers: false }, http));
  const privateWithDate = { ...RESOURCE, status: { ...RESOURCE.status, publishAt: "2026-10-20T12:00:00Z" } as typeof RESOURCE.status };
  await assert.rejects(beginResumableVideoUpload({ accessToken: "t", resource: privateWithDate, contentLength: 5, contentType: "video/mp4", notifySubscribers: false }, http), /without publishAt/);
  assert.equal(calls.length, 0);
});

test("chunk: Content-Range names the bytes; 308 with Range bytes=0-262143 means 262144 stored; 200 with the resource means done", async () => {
  const total = 3 * 262144;
  const { http, calls } = fake([
    { status: 308, headers: { range: "bytes=0-262143" } },
    { status: 200, body: JSON.stringify({ id: "vid123", status: { privacyStatus: "private" } }) },
  ]);
  const first = await putVideoUploadChunk({ accessToken: "tok", sessionUri: SESSION, chunk: Buffer.alloc(262144), start: 0, total, contentType: "video/mp4" }, http);
  assert.deepEqual(first, { done: false, storedBytes: 262144 });
  const last = await putVideoUploadChunk({ accessToken: "tok", sessionUri: SESSION, chunk: Buffer.alloc(2 * 262144), start: 262144, total, contentType: "video/mp4" }, http);
  assert.deepEqual(last, { done: true, videoId: "vid123" });
  assert.equal(calls[0].headers["Content-Range"], "bytes 0-262143/786432");
  assert.equal(calls[1].headers["Content-Range"], "bytes 262144-786431/786432");
  assert.equal(calls[1].method, "PUT");
  assert.equal(calls[1].url, SESSION);
});

test("chunk: a non-final chunk that is not a multiple of 256 KB, or a session outside googleapis.com, is refused before sending", async () => {
  const { http, calls } = fake([]);
  await assert.rejects(putVideoUploadChunk({ accessToken: "t", sessionUri: SESSION, chunk: Buffer.alloc(1000), start: 0, total: 5000, contentType: "video/mp4" }, http));
  await assert.rejects(putVideoUploadChunk({ accessToken: "t", sessionUri: "https://example.com/upload/youtube/v3/videos?x", chunk: Buffer.alloc(10), start: 0, total: 10, contentType: "video/mp4" }, http));
  // The final chunk may be any size.
  assert.equal(calls.length, 0);
});

test("status: PUT with bytes */total and no body; 308 without Range = nothing stored; 404 = expired; 201 = done", async () => {
  const { http, calls } = fake([{ status: 308 }, { status: 404 }, { status: 201, body: JSON.stringify({ id: "v9" }) }]);
  assert.deepEqual(await queryVideoUploadOffset({ accessToken: "t", sessionUri: SESSION, total: 99 }, http), { done: false, storedBytes: 0 });
  assert.deepEqual(await queryVideoUploadOffset({ accessToken: "t", sessionUri: SESSION, total: 99 }, http), { expired: true });
  assert.deepEqual(await queryVideoUploadOffset({ accessToken: "t", sessionUri: SESSION, total: 99 }, http), { done: true, videoId: "v9" });
  assert.equal(calls[0].headers["Content-Range"], "bytes */99");
  assert.equal(calls[0].body, undefined);
});

// Owner msgs 2751/2753: «Прямая реклама» -- `paidProductPlacementDetails` is a part of its own (YouTube Data API videos resource),
// named in `part` only when the resource carries it.
test("start: paid promotion goes as the paidProductPlacementDetails part, named in part=", async () => {
  const { http, calls } = fake([{ status: 200, headers: { location: SESSION } }]);
  const resource = { ...RESOURCE, paidProductPlacementDetails: { hasPaidProductPlacement: true } };
  await beginResumableVideoUpload({ accessToken: "tok", resource, contentLength: 10, contentType: "video/mp4", notifySubscribers: true }, http);
  assert.equal(calls[0].url, "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,paidProductPlacementDetails&notifySubscribers=true");
  assert.deepEqual(JSON.parse(String(calls[0].body)).paidProductPlacementDetails, { hasPaidProductPlacement: true });
});
