import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, type ResolvedCredentials } from "@/lib/shared-domain";
import { getLiveWritesEnabled } from "@/lib/db";
import { createVideoDetailsYoutubeApiAdapter, PRODUCTION_IO, snippetPartOf, statusPartOf, type VideoDetailsYoutubeIo } from "./youtube-api";

// Changed by BL-265 (ADR 0072 §5, MEDIA_GATE_PLAN.md §3.4 gap 1, AC-MG-24; the same order as the thumbnail writer's AC-TH-07): Live
// writes is no longer the first statement of `applyPatch` ("refuses before ever touching the network") but is checked immediately
// before the gateway write -- client -> fresh read -> Live writes -> write -- so a switch-off during the read still stops the write.
// The real adapter with fake I/O records the order; with Live writes off nothing is written.
function fakeIo(liveWrites: boolean) {
  const order: string[] = [];
  const snippet = { title: "Old", description: "D", tags: ["a"], categoryId: "10", defaultLanguage: "ja", defaultAudioLanguage: "ja", channelId: "UC_x" };
  const sent: Array<Record<string, unknown>> = [];
  const io: VideoDetailsYoutubeIo = {
    createClient: () => {
      order.push("client");
      return {} as never;
    },
    readContext: async () => {
      order.push("read");
      return { etag: "e1", snippet: sent.length > 0 ? { ...snippet, ...(sent.at(-1)!.snippet as object) } : snippet, status: { privacyStatus: "private" }, recordingDate: null, paidProductPlacement: null } as never;
    },
    assertLiveWrites: async () => {
      order.push("live_writes");
      if (!liveWrites) throw new DomainError({ code: "live_writes_disabled", message: "off" });
    },
    applyUpdate: async (args) => {
      order.push("write");
      sent.push(args.parts as Record<string, unknown>);
    },
  };
  return { io, order, sent };
}
const CREDENTIALS = { accessToken: "fake-token", refreshToken: "fake-refresh" } as unknown as ResolvedCredentials;

test("AC-MG-24: applyPatch -- client, read, Live writes, write in that order; Live writes off -> refused, nothing written", async () => {
  const on = fakeIo(true);
  await createVideoDetailsYoutubeApiAdapter(on.io).applyPatch({ credentials: CREDENTIALS, videoId: "v1", patch: { title: "New" }, readBackRetries: 0 });
  assert.deepEqual(on.order, ["client", "read", "live_writes", "write", "read"]);
  const off = fakeIo(false);
  await assert.rejects(
    () => createVideoDetailsYoutubeApiAdapter(off.io).applyPatch({ credentials: CREDENTIALS, videoId: "v1", patch: { title: "New" }, readBackRetries: 0 }),
    (error: unknown) => error instanceof DomainError && error.code === "live_writes_disabled"
  );
  assert.deepEqual(off.order, ["client", "read", "live_writes"]);
  assert.equal(off.sent.length, 0);
});

// Independent review fix 5: the production wiring's Live-writes check is the write gateway's own (`assertLiveWritesAuthorized`) and
// runs before the write. With the real check (Live writes is off in a test process) and fake client / read / write, the write is
// never reached.
test("AC-MG-24 (production wiring): PRODUCTION_IO.assertLiveWrites is the gateway's check -- Live writes off refuses before the write", async () => {
  assert.equal(await getLiveWritesEnabled(), false, "sanity check -- a test process starts with Live writes off");
  const fake = fakeIo(true);
  const io: VideoDetailsYoutubeIo = { ...fake.io, assertLiveWrites: PRODUCTION_IO.assertLiveWrites };
  await assert.rejects(
    () => createVideoDetailsYoutubeApiAdapter(io).applyPatch({ credentials: CREDENTIALS, videoId: "v1", patch: { title: "New" }, readBackRetries: 0 }),
    (error: unknown) => error instanceof DomainError && error.code === "live_writes_disabled"
  );
  assert.deepEqual(fake.order, ["client", "read"]);
  assert.equal(fake.sent.length, 0);
});

test("AC-MG-26: a title/description/tags patch sends the whole snippet as read (categoryId, defaultLanguage, defaultAudioLanguage) with the new texts, and no status part", async () => {
  const { io, sent } = fakeIo(true);
  const result = await createVideoDetailsYoutubeApiAdapter(io).applyPatch({ credentials: CREDENTIALS, videoId: "v1", patch: { title: "New", description: "Text", tags: ["b", "c"] }, readBackRetries: 0 });
  assert.deepEqual(sent, [{ snippet: { title: "New", description: "Text", tags: ["b", "c"], categoryId: "10", defaultLanguage: "ja", defaultAudioLanguage: "ja" } }]);
  assert.equal(result.before.channelId, "UC_x", "the snapshot names the video's channel (read only)");
});

test("AC-MG-27: snippetPartOf leaves an audio language read as zxx out (RISK-102); keeps any other as read", () => {
  const read = { title: "Old", categoryId: "10", defaultLanguage: "ja", defaultAudioLanguage: "zxx", channelId: "UC_x" };
  assert.deepEqual(snippetPartOf(read, { title: "New" }), { title: "New", categoryId: "10", defaultLanguage: "ja" });
  assert.deepEqual(snippetPartOf({ ...read, defaultAudioLanguage: "ja" }, { title: "New" }), { title: "New", categoryId: "10", defaultLanguage: "ja", defaultAudioLanguage: "ja" });
});

// BL-225 stage 3 (ADR 0051 §5): removing a date sends the status part without publishAt (the part is replaced whole, so the date is
// gone) and keeps every other status field as read; a new date replaces the old one.
test("BL-225: statusPartOf -- publishAt null leaves the date out, the rest as read; a date replaces it", () => {
  const read = { privacyStatus: "private", publishAt: "2026-10-26T09:00:00Z", license: "youtube", embeddable: true, selfDeclaredMadeForKids: false, uploadStatus: "processed" };
  assert.deepEqual(statusPartOf(read, { privacyStatus: "private", publishAt: null, containsSyntheticMedia: true }), {
    privacyStatus: "private",
    license: "youtube",
    embeddable: true,
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: true,
  });
  assert.equal(statusPartOf(read, { privacyStatus: "private", publishAt: "2026-10-27T09:00:00.000Z", containsSyntheticMedia: true }).publishAt, "2026-10-27T09:00:00.000Z");
});
