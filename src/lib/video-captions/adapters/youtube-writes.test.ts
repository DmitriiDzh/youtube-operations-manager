// BL-269 AC-CAP-12 / AC-CAP-44 (ADR 0074 §6, §10; AGENTS.md §G): the Live writes check runs immediately before `captions.insert` and
// `captions.update` -- after the client is built, with nothing in between -- and when it refuses, neither write is called.
import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createVideoCaptionWrites } from "./youtube-writes";

const credentials = { credentialRef: { userId: "u" }, accessToken: "t", scopeSet: new Set<string>() } as ResolvedCredentials;
const media = { mimeType: "application/octet-stream", bytes: Buffer.from("WEBVTT\n") };

test("AC-CAP-12 / AC-CAP-44 order: client, then Live writes, then the one insert or update", async () => {
  const calls: string[] = [];
  const writes = createVideoCaptionWrites({
    client: async () => (calls.push("client"), {}),
    assertLiveWrites: async () => void calls.push("liveWrites"),
    insert: async (_y, args) => (calls.push(`insert:${args.videoId}`), { trackId: "T1" }),
    update: async (_y, args) => void calls.push(`update:${args.trackId}`),
  });
  assert.deepEqual(await writes.insert(credentials, { videoId: "V", language: "en", name: "", media }), { trackId: "T1" });
  await writes.update(credentials, { trackId: "T9", media });
  assert.deepEqual(calls, ["client", "liveWrites", "insert:V", "client", "liveWrites", "update:T9"]);
});

test("AC-CAP-12 / AC-CAP-44 Live writes off: no insert and no update", async () => {
  const calls: string[] = [];
  const writes = createVideoCaptionWrites({
    client: async () => ({}),
    assertLiveWrites: async () => {
      throw Object.assign(new Error("Live writes are off"), { code: "live_writes_disabled" });
    },
    insert: async () => (calls.push("insert"), { trackId: "x" }),
    update: async () => void calls.push("update"),
  });
  await assert.rejects(writes.insert(credentials, { videoId: "V", language: "en", name: "", media }), /Live writes/);
  await assert.rejects(writes.update(credentials, { trackId: "T", media }), /Live writes/);
  assert.deepEqual(calls, []);
});
