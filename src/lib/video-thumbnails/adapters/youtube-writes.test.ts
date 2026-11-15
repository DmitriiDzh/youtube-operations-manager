// BL-255 AC-TH-07 (ADR 0069 §3, AGENTS.md §G): the Live writes check runs immediately before `thumbnails.set` -- after the client is
// built, with nothing in between -- and when it refuses, the write is never called.
import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createVideoThumbnailWrites } from "./youtube-writes";

const credentials = { credentialRef: { userId: "u" }, accessToken: "t", scopeSet: new Set<string>() } as ResolvedCredentials;
const image = { mimeType: "image/jpeg" as const, bytes: Buffer.from([0xff, 0xd8, 0xff]) };

test("AC-TH-07 order: client, then Live writes, then the one thumbnails.set", async () => {
  const calls: string[] = [];
  const writes = createVideoThumbnailWrites({
    client: async () => (calls.push("client"), {}),
    assertLiveWrites: async () => void calls.push("liveWrites"),
    write: async (_y, videoId) => void calls.push(`write:${videoId}`),
  });
  await writes.setThumbnail(credentials, "ZeRdh3bZlkg", image);
  assert.deepEqual(calls, ["client", "liveWrites", "write:ZeRdh3bZlkg"]);
});

test("AC-TH-07 Live writes off: thumbnails.set is never called", async () => {
  const calls: string[] = [];
  const writes = createVideoThumbnailWrites({
    client: async () => ({}),
    assertLiveWrites: async () => {
      throw Object.assign(new Error("Live writes are off"), { code: "live_writes_disabled" });
    },
    write: async () => void calls.push("write"),
  });
  await assert.rejects(writes.setThumbnail(credentials, "ZeRdh3bZlkg", image), /Live writes/);
  assert.deepEqual(calls, []);
});
