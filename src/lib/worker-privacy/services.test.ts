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
    findChannelVideo: async (channelId, videoId) => (channelId === CHANNEL && ["rec1", "sched", "live1"].includes(videoId) ? {} : null),
    currentBroadcastIds: async () => new Set(["live1"]),
    readVideo: async (videoId) =>
      videoId === "sched" ? { privacyStatus: "private", publishAt: "2026-11-01T10:00:00Z", etag: "e" } : { privacyStatus: "public", publishAt: null, etag: "etag-1" },
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

test("AC-WP-01: public, or any other status than private/unlisted, is invalid input; nothing is read or written", async () => {
  const { services, writes } = fixture({
    readVideo: async () => {
      throw new Error("must not read");
    },
  });
  for (const privacyStatus of ["public", "Public", "", "hidden"]) {
    await assert.rejects(services.setPrivacy({ target: "video", id: "rec1", privacyStatus, dryRun: false }), code("validation_failed"));
  }
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
