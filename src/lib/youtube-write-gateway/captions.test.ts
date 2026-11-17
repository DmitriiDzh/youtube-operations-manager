import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import { insertVideoCaption, updateVideoCaption } from "./captions";

// BL-269 AC-CAP-11 / AC-CAP-39 (VIDEO_CAPTIONS_PLAN.md §2): the request shapes from the YouTube Data API reference --
// captions.insert: part=snippet, snippet.videoId/language/name + isDraft false, never `sync`, the file as media;
// captions.update: part=id, body { id } and no snippet (an omitted settable property is deleted), the file as media.

async function bodyOf(media: { body?: unknown }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of media.body as Readable) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function fakeYoutube(answer: { id?: string } = { id: "AUieDaZ1" }) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const youtube = {
    captions: {
      insert: async (args: Record<string, unknown>) => (calls.push({ method: "insert", args }), { data: answer }),
      update: async (args: Record<string, unknown>) => (calls.push({ method: "update", args }), { data: {} }),
    },
  } as unknown as youtube_v3.Youtube;
  return { youtube, calls };
}

const FILE = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n");

test("AC-CAP-11 insert: part snippet, videoId / en / name / isDraft false, no sync, body = the bytes", async () => {
  const { youtube, calls } = fakeYoutube();
  const result = await insertVideoCaption(youtube, { videoId: "ZeRdh3bZlkg", language: "en", name: "", media: { mimeType: "application/octet-stream", bytes: FILE } });
  assert.deepEqual(result, { trackId: "AUieDaZ1" });
  assert.equal(calls.length, 1);
  const { args } = calls[0];
  assert.deepEqual(args.part, ["snippet"]);
  assert.deepEqual(args.requestBody, { snippet: { videoId: "ZeRdh3bZlkg", language: "en", name: "", isDraft: false } });
  assert.equal("sync" in args, false);
  const media = args.media as { mimeType: string };
  assert.equal(media.mimeType, "application/octet-stream");
  assert.deepEqual(await bodyOf(args.media as { body: unknown }), FILE);
});

test("insert: no id in YouTube's answer is an error, never a silent success", async () => {
  const { youtube } = fakeYoutube({});
  await assert.rejects(insertVideoCaption(youtube, { videoId: "v", language: "en", name: "", media: { mimeType: "application/octet-stream", bytes: FILE } }), /no id/);
});

test("AC-CAP-39 update: part id, body { id } only (no snippet), no sync, body = the bytes", async () => {
  const { youtube, calls } = fakeYoutube();
  await updateVideoCaption(youtube, { trackId: "TRACK1", media: { mimeType: "application/octet-stream", bytes: FILE } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "update");
  const { args } = calls[0];
  assert.deepEqual(args.part, ["id"]);
  assert.deepEqual(args.requestBody, { id: "TRACK1" });
  assert.equal("sync" in args, false);
  assert.deepEqual(await bodyOf(args.media as { body: unknown }), FILE);
});

test("boundaries: an empty file, or one over 100 MB, is refused before any call", async () => {
  const { youtube, calls } = fakeYoutube();
  await assert.rejects(updateVideoCaption(youtube, { trackId: "T", media: { mimeType: "application/octet-stream", bytes: Buffer.alloc(0) } }), /1 byte to 100 MB/);
  await assert.rejects(
    insertVideoCaption(youtube, { videoId: "v", language: "en", name: "", media: { mimeType: "application/octet-stream", bytes: Buffer.alloc(100 * 1024 * 1024 + 1) } }),
    /1 byte to 100 MB/
  );
  await assert.rejects(updateVideoCaption(youtube, { trackId: "", media: { mimeType: "application/octet-stream", bytes: FILE } }), /track id/);
  assert.equal(calls.length, 0);
});
