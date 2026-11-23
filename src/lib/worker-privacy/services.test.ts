import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { createWorkerPrivacyServices, type WorkerPrivacyDeps } from "./services";

// WORKER_CAPABILITIES_PLAN.md AC-WP-01..06 (BL-216). Expected behavior from the plan: never public, only the bound channel's
// targets, never a scheduled video or the current broadcast, a preview by default, no write when nothing changes.

const CHANNEL = "UC_T";
const code = (expected: string) => (error: unknown) => isDomainError(error) && error.code === expected;

function fixture(overrides: Partial<WorkerPrivacyDeps> = {}) {
  const writes: string[] = [];
  const deps: WorkerPrivacyDeps = {
    channelId: CHANNEL,
    assertMayNotPublish: (status) => {
      if (status === "public") throw new DomainError({ code: "AGENT_PUBLIC_NOT_ALLOWED", message: "no" });
    },
    findChannelVideo: async (channelId, videoId) => {
      if (channelId !== CHANNEL) return null;
      if (videoId === "peerLive") return { liveBroadcastContent: "live" };
      if (videoId === "upcoming1") return { liveBroadcastContent: "upcoming" };
      return ["rec1", "sched", "live1", "rec-now-live"].includes(videoId) ? { liveBroadcastContent: "none" } : null;
    },
    currentBroadcastIds: async () => new Set(["live1"]),
    readVideo: async (videoId) =>
      videoId === "rec-now-live"
        ? { privacyStatus: "public", publishAt: null, etag: "e", liveBroadcastContent: "live" }
        : videoId === "sched" ? { privacyStatus: "private", publishAt: "2026-11-01T10:00:00Z", etag: "e" } : { privacyStatus: "public", publishAt: null, etag: "etag-1" },
    writeVideo: async ({ videoId, privacyStatus, expectedEtag }) => {
      writes.push(`video:${videoId}:${privacyStatus}:${expectedEtag}`);
      return { privacyStatus };
    },
    listPlaylists: async () => [
      { id: "PL_PUB", privacyStatus: "public" },
      { id: "PL_PRIV", privacyStatus: "private" },
    ],
    writePlaylist: async ({ playlistId, privacyStatus }) => {
      writes.push(`playlist:${playlistId}:${privacyStatus}`);
      return { privacyStatus };
    },
    ...overrides,
  };
  return { services: createWorkerPrivacyServices(deps), writes };
}

// AC-WP-01 changed by the owner, Telegram msg 4782 (2026-11-23, ADR 0048 amendment): a worker may make its channel's PLAYLIST public;
// a VIDEO still never. The old test refused `public` for both targets as invalid input.
test("AC-WP-01: any status other than private/unlisted/public is invalid input; nothing is read or written", async () => {
  const { services, writes } = fixture({
    readVideo: async () => {
      throw new Error("must not read");
    },
  });
  for (const target of ["video", "playlist"]) {
    for (const privacyStatus of ["Public", "", "hidden"]) {
      await assert.rejects(services.setPrivacy({ target, id: target === "video" ? "rec1" : "PL_PRIV", privacyStatus, dryRun: false }), code("validation_failed"));
    }
  }
  assert.deepEqual(writes, []);
});

test("msg 4782: a video is never made public by a worker -- refused before any read, a dry run too", async () => {
  const { services, writes } = fixture({
    readVideo: async () => {
      throw new Error("must not read");
    },
    findChannelVideo: async () => {
      throw new Error("must not read");
    },
  });
  await assert.rejects(services.setPrivacy({ target: "video", id: "rec1", privacyStatus: "public", dryRun: false }), code("AGENT_PUBLIC_NOT_ALLOWED"));
  await assert.rejects(services.setPrivacy({ target: "video", id: "rec1", privacyStatus: "public" }), code("AGENT_PUBLIC_NOT_ALLOWED"));
  assert.deepEqual(writes, []);
});

test("msg 4782: a worker makes its channel's playlist public (a preview first), and private again", async () => {
  const { services, writes } = fixture();
  const preview = await services.setPrivacy({ target: "playlist", id: "PL_PRIV", privacyStatus: "public" });
  assert.deepEqual(preview, { target: "playlist", id: "PL_PRIV", dryRun: true, privacyStatus: "public", previousPrivacyStatus: "private", changed: true });
  assert.deepEqual(writes, []);
  const written = await services.setPrivacy({ target: "playlist", id: "PL_PRIV", privacyStatus: "public", dryRun: false });
  assert.deepEqual(written, { target: "playlist", id: "PL_PRIV", dryRun: false, privacyStatus: "public", previousPrivacyStatus: "private", changed: true });
  const hidden = await services.setPrivacy({ target: "playlist", id: "PL_PUB", privacyStatus: "private", dryRun: false });
  assert.equal(hidden.changed, true);
  assert.deepEqual(writes, ["playlist:PL_PRIV:public", "playlist:PL_PUB:private"]);
});

test("msg 4782: another channel's playlist stays not_found even for public; nothing written", async () => {
  const { services, writes } = fixture();
  await assert.rejects(services.setPrivacy({ target: "playlist", id: "PL_OTHER", privacyStatus: "public", dryRun: false }), code("not_found"));
  assert.deepEqual(writes, []);
});

test("AC-WP-02: a video outside the channel's synced list and a playlist not of the channel are not_found", async () => {
  const { services, writes } = fixture();
  await assert.rejects(services.setPrivacy({ target: "video", id: "foreign", privacyStatus: "private", dryRun: false }), code("not_found"));
  await assert.rejects(services.setPrivacy({ target: "playlist", id: "PL_OTHER", privacyStatus: "private", dryRun: false }), code("not_found"));
  assert.deepEqual(writes, []);
});

test("AC-WP-03: a scheduled video is refused, nothing written", async () => {
  const { services, writes } = fixture();
  await assert.rejects(services.setPrivacy({ target: "video", id: "sched", privacyStatus: "unlisted", dryRun: false }), code("AGENT_SCHEDULE_OWNER_ONLY"));
  assert.deepEqual(writes, []);
});

test("AC-WP-04: the channel's current live broadcast is refused; a finished recording is allowed", async () => {
  const { services, writes } = fixture();
  await assert.rejects(services.setPrivacy({ target: "video", id: "live1", privacyStatus: "private", dryRun: false }), code("AGENT_LIVE_BROADCAST_OWNER_ONLY"));
  // A stream run by another computer (only the synced list knows it is live), and an upcoming broadcast.
  await assert.rejects(services.setPrivacy({ target: "video", id: "peerLive", privacyStatus: "private", dryRun: false }), code("AGENT_LIVE_BROADCAST_OWNER_ONLY"));
  await assert.rejects(services.setPrivacy({ target: "video", id: "upcoming1", privacyStatus: "private", dryRun: false }), code("AGENT_LIVE_BROADCAST_OWNER_ONLY"));
  // The synced list still says "none", but YouTube says it is live now (it started after the last sync): refused too.
  await assert.rejects(services.setPrivacy({ target: "video", id: "rec-now-live", privacyStatus: "private", dryRun: false }), code("AGENT_LIVE_BROADCAST_OWNER_ONLY"));
  const result = await services.setPrivacy({ target: "video", id: "rec1", privacyStatus: "private", dryRun: false });
  assert.equal(result.changed, true);
  assert.deepEqual(writes, ["video:rec1:private:etag-1"]);
});

test("AC-WP-05: dryRun defaults to true and only reports the change; dryRun false writes bound to the read etag", async () => {
  const { services, writes } = fixture();
  const preview = await services.setPrivacy({ target: "video", id: "rec1", privacyStatus: "unlisted" });
  assert.deepEqual(preview, { target: "video", id: "rec1", dryRun: true, privacyStatus: "unlisted", previousPrivacyStatus: "public", changed: true });
  assert.deepEqual(writes, []);
  const written = await services.setPrivacy({ target: "playlist", id: "PL_PUB", privacyStatus: "private", dryRun: false });
  assert.deepEqual(written, { target: "playlist", id: "PL_PUB", dryRun: false, privacyStatus: "private", previousPrivacyStatus: "public", changed: true });
  assert.deepEqual(writes, ["playlist:PL_PUB:private"]);
});

test("AC-WP-06: a target already at that status is not written", async () => {
  const { services, writes } = fixture();
  const result = await services.setPrivacy({ target: "playlist", id: "PL_PRIV", privacyStatus: "private", dryRun: false });
  assert.equal(result.changed, false);
  assert.deepEqual(writes, []);
});
