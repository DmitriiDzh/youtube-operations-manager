import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  getVideoCommentCheckedOn,
  initializeDatabaseSchema,
  listStoredVideoComments,
  listVideoCommentStates,
  markVideoCommentsChecked,
  recordVideoCommentsFailure,
  saveVideoCommentsRead,
  type AppDb,
} from "@/lib/db";
import { SNAPSHOT_DEVICE_LOCAL_TABLES } from "@/lib/snapshot/contracts";
import { DomainError } from "@/lib/shared-domain";
import { failureKind } from "@/lib/youtube-read-gateway/read-failure";
import { YOUTUBE_DATA_CLASSIFICATION } from "@/lib/youtube-data-policy/contracts";
import { createVideoCommentServices, gateCommentCollection, type OwnVideo } from "./services";

// BL-171 (docs/roadmap/plans/VIDEO_COMMENTS_PLAN.md §3, AC-VC-01..12). Expectations by hand from the plan: once per Pacific day per
// channel the fresh counts of the non-private videos are read, then the due videos (never read with a count above 0; collected/retry when
// the count changed or the read is 7+ days old; disabled/failed only when the count changed), at most 50, never read first; each read
// replaces the video's comments. 2026-10-10T18:00:00Z is 11:00 PDT on 2026-10-10.

const NOW = new Date("2026-10-10T18:00:00Z");
const at = (iso: string) => new Date(iso);
const pacific = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

function googleError(status: number, reason: string): Error {
  return Object.assign(new Error(`HTTP ${status} ${reason} (test)`), { response: { status, data: { error: { errors: [{ reason }] } } } });
}

async function freshDb(): Promise<AppDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-comments-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  await initializeDatabaseSchema(client);
  return drizzle(client) as unknown as AppDb;
}

const comment = (commentId: string, publishedAt: string, extra: Partial<{ text: string; likeCount: number; replyCount: number; byChannelOwner: boolean }> = {}) => ({
  commentId,
  text: extra.text ?? `text ${commentId}`,
  likeCount: extra.likeCount ?? 0,
  publishedAt,
  updatedAt: publishedAt,
  replyCount: extra.replyCount ?? 0,
  byChannelOwner: extra.byChannelOwner ?? false,
});

type World = {
  counts: Map<string, number | null>;
  comments: Map<string, ReturnType<typeof comment>[]>;
  fail?: (videoId: string) => Error | null;
  failCounts?: () => Error | null;
};

function setup(db: AppDb, videos: OwnVideo[], world: World) {
  const clock = { now: NOW };
  const calls: string[] = [];
  const services = createVideoCommentServices({
    clock: { now: () => clock.now },
    toPacificDate: (date) => pacific.format(date),
    channelAccess: {
      assertActiveChannel: async ({ channelId }) => {
        if (channelId !== "UC_A") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
        return channelId;
      },
    },
    listVideos: async () => videos,
    youtube: {
      commentCounts: async (_ref, ids) => {
        calls.push(`counts ${ids.join(",")}`);
        const failure = world.failCounts?.();
        if (failure) throw failure;
        return ids.filter((id) => world.counts.has(id)).map((id) => ({ videoId: id, commentCount: world.counts.get(id) ?? null }));
      },
      comments: async (_ref, videoId) => {
        calls.push(`comments ${videoId}`);
        const failure = world.fail?.(videoId);
        if (failure) throw failure;
        return world.comments.get(videoId) ?? [];
      },
    },
    failureKind,
    store: {
      checkedOn: (channelId) => getVideoCommentCheckedOn(channelId, db),
      markChecked: (channelId, day, when) => markVideoCommentsChecked(channelId, day, when, db),
      listStates: (channelId) => listVideoCommentStates(channelId, db),
      saveRead: (row) => saveVideoCommentsRead(row, db),
      recordFailure: (row) => recordVideoCommentsFailure(row, db),
      listComments: (channelId, ids) => listStoredVideoComments(channelId, ids, db),
    },
  });
  return { services, calls, clock };
}

const RUN = { credentialRef: { userId: "u1" }, channelId: "UC_A" };
const video = (videoId: string, privacyStatus = "public"): OwnVideo => ({ videoId, title: `Title ${videoId}`, privacyStatus });

test("AC-VC-01: the counts of the non-private videos are read; only a video with comments is read; a second run the same day makes no call", async () => {
  const db = await freshDb();
  const world: World = { counts: new Map([["a", 2], ["b", 0]]), comments: new Map([["a", [comment("c1", "2026-09-27T19:16:28Z")]]]) };
  const { services, calls, clock } = setup(db, [video("a"), video("b"), video("c", "unlisted"), video("d", "private")], world);
  assert.deepEqual(await services.collectDueComments(RUN), { checked: true, read: 1, disabled: 0, failed: 0 });
  assert.deepEqual(calls, ["counts a,b,c", "comments a"]);
  clock.now = at("2026-10-11T06:00:00Z"); // 23:00 PDT, still 10-10
  assert.deepEqual(await services.collectDueComments(RUN), { checked: false, read: 0, disabled: 0, failed: 0 });
  assert.equal(calls.length, 2);
});

test("AC-VC-03/05: a read stores each comment as returned with the read time, and a reread replaces only that video's comments", async () => {
  const db = await freshDb();
  const world: World = {
    counts: new Map([["a", 2], ["b", 1]]),
    comments: new Map([
      ["a", [comment("c1", "2026-09-27T19:16:28Z", { text: "Beautiful music!", likeCount: 3, replyCount: 2, byChannelOwner: true }), comment("c2", "2026-09-20T10:00:00Z")]],
      ["b", [comment("b1", "2026-09-01T10:00:00Z")]],
    ]),
  };
  const { services, clock } = setup(db, [video("a"), video("b")], world);
  await services.collectDueComments(RUN);
  const c1 = (await listStoredVideoComments("UC_A", ["a"], db)).find((row) => row.commentId === "c1");
  assert.deepEqual(
    [c1?.text, c1?.likeCount, c1?.replyCount, c1?.byChannelOwner, c1?.publishedAt, c1?.updatedAt, c1?.fetchedAt.toISOString()],
    ["Beautiful music!", 3, 2, true, "2026-09-27T19:16:28Z", "2026-09-27T19:16:28Z", NOW.toISOString()]
  );
  // A comment of `a` was removed: its count went to 1; the next day `a` is read again and only `a`'s rows change.
  world.counts.set("a", 1);
  world.comments.set("a", [comment("c1", "2026-09-27T19:16:28Z")]);
  clock.now = at("2026-10-11T18:00:00Z");
  await services.collectDueComments(RUN);
  assert.deepEqual((await listStoredVideoComments("UC_A", ["a", "b"], db)).map((row) => row.commentId).sort(), ["b1", "c1"]);
});

test("AC-VC-04: due when the count changes or a week has passed; a disabled video only when its count changes; a count dropping to 0 clears", async () => {
  const db = await freshDb();
  const world: World = {
    counts: new Map([["a", 2], ["z", 1]]),
    comments: new Map([["a", [comment("c1", "2026-09-27T19:16:28Z"), comment("c2", "2026-09-28T19:16:28Z")]]]),
    fail: (videoId) => (videoId === "z" ? googleError(403, "commentsDisabled") : null),
  };
  const { services, calls, clock } = setup(db, [video("a"), video("z")], world);
  await services.collectDueComments(RUN);
  const reads = () => calls.filter((call) => call.startsWith("comments"));
  const day = async (iso: string) => {
    clock.now = at(iso);
    const before = reads().length;
    await services.collectDueComments(RUN);
    return reads().slice(before);
  };
  for (const iso of ["2026-10-11T18:00:00Z", "2026-10-13T18:00:00Z", "2026-10-16T18:00:00Z"]) assert.deepEqual(await day(iso), [], iso);
  assert.deepEqual(await day("2026-10-17T18:00:00Z"), ["comments a"], "7 days later; the disabled z is not reread on the same count");
  world.counts.set("a", 3);
  assert.deepEqual(await day("2026-10-18T18:00:00Z"), ["comments a"], "its count changed");
  world.counts.set("z", 2);
  assert.deepEqual(await day("2026-10-19T18:00:00Z"), ["comments z"], "the disabled one, its count changed");
  world.counts.set("a", 0);
  world.comments.set("a", []);
  assert.deepEqual(await day("2026-10-20T18:00:00Z"), ["comments a"], "dropped to 0");
  assert.deepEqual(await listStoredVideoComments("UC_A", ["a"], db), []);
});

test("AC-VC-06: at most 50 reads per run, never read first then least recently read; the next day reads the other 10", async () => {
  const db = await freshDb();
  const ids = Array.from({ length: 60 }, (_, i) => `v${String(i).padStart(2, "0")}`);
  const world: World = { counts: new Map(ids.map((id) => [id, 1])), comments: new Map() };
  const { services, calls, clock } = setup(db, ids.map((id) => video(id)), world);
  assert.deepEqual(await services.collectDueComments(RUN), { checked: true, read: 50, disabled: 0, failed: 0 });
  assert.deepEqual(calls.filter((c) => c.startsWith("comments")).slice(0, 2), ["comments v00", "comments v01"]);
  calls.length = 0;
  clock.now = at("2026-10-11T18:00:00Z");
  assert.deepEqual(await services.collectDueComments(RUN), { checked: true, read: 10, disabled: 0, failed: 0 });
  assert.deepEqual(calls.filter((c) => c.startsWith("comments")), ids.slice(50).map((id) => `comments ${id}`));
});

test("AC-VC-07: a 404 counts attempts (retry after 24 h, failed after 3, then only on a new count); 5xx/429/no answer defer and end the run", async () => {
  const db = await freshDb();
  const world: World = { counts: new Map([["a", 1], ["b", 1]]), comments: new Map(), fail: (videoId) => (videoId === "a" ? googleError(404, "videoNotFound") : null) };
  const { services, calls, clock } = setup(db, [video("a"), video("b")], world);
  assert.deepEqual(await services.collectDueComments(RUN), { checked: true, read: 1, disabled: 0, failed: 1 });
  let a = (await listVideoCommentStates("UC_A", db)).find((s) => s.videoId === "a");
  assert.deepEqual([a?.status, a?.attempts, a?.nextAttemptAt?.toISOString()], ["retry", 1, "2026-10-11T18:00:00.000Z"]);
  for (const iso of ["2026-10-11T19:00:00Z", "2026-10-12T19:00:00Z"]) {
    clock.now = at(iso);
    await services.collectDueComments(RUN);
  }
  a = (await listVideoCommentStates("UC_A", db)).find((s) => s.videoId === "a");
  assert.deepEqual([a?.status, a?.attempts], ["failed", 3]);
  const aReads = () => calls.filter((c) => c === "comments a").length;
  assert.equal(aReads(), 3);
  clock.now = at("2026-10-25T19:00:00Z");
  await services.collectDueComments(RUN);
  assert.equal(aReads(), 3, "failed: not read again on the same count");

  for (const error of [googleError(503, "backendError"), googleError(429, "rateLimitExceeded"), new Error("socket hang up (test)")]) {
    const db2 = await freshDb();
    const w: World = { counts: new Map([["a", 1], ["b", 1]]), comments: new Map(), fail: (videoId) => (videoId === "a" ? error : null) };
    const run = setup(db2, [video("a"), video("b")], w);
    await assert.rejects(() => run.services.collectDueComments(RUN), (thrown: unknown) => thrown === error);
    assert.deepEqual(run.calls, ["counts a,b", "comments a"], `${error.message}: the run stopped`);
    const state = (await listVideoCommentStates("UC_A", db2)).find((s) => s.videoId === "a");
    assert.deepEqual([state?.status, state?.attempts, state?.nextAttemptAt?.toISOString()], ["retry", 0, "2026-10-11T18:00:00.000Z"], error.message);
    assert.equal(await getVideoCommentCheckedOn("UC_A", db2), null, "an interrupted day is tried again on the next open");
  }
});

test("AC-VC-07: quota, Data API reads off, a 401 and a 403 quotaExceeded stop the run with nothing written, also when reading the counts", async () => {
  const stops = [
    new DomainError({ code: "youtube_quota_exceeded", message: "quota" }),
    new DomainError({ code: "data_api_reads_disabled", message: "off" }),
    googleError(401, "authError"),
    googleError(403, "quotaExceeded"),
  ];
  for (const error of stops) {
    for (const where of ["comments", "counts"] as const) {
      const db = await freshDb();
      const world: World = { counts: new Map([["a", 1]]), comments: new Map(), fail: () => (where === "comments" ? error : null), failCounts: () => (where === "counts" ? error : null) };
      const { services } = setup(db, [video("a")], world);
      await assert.rejects(() => services.collectDueComments(RUN));
      assert.deepEqual(await listVideoCommentStates("UC_A", db), [], `${error.message} ${where}`);
      assert.equal(await getVideoCommentCheckedOn("UC_A", db), null);
    }
  }
});

test("AC-VC-08: while the Data API background reserve is not allowed, a run makes no call", async () => {
  let called = 0;
  const gated = gateCommentCollection({ isBackgroundReadAllowed: async () => false }, async () => {
    called += 1;
    return { checked: true, read: 1, disabled: 0, failed: 0 };
  });
  assert.deepEqual(await gated(RUN), { checked: false, read: 0, disabled: 0, failed: 0 });
  assert.equal(called, 0);
});

test("AC-VC-10: reads return the session channel's videos, newest comments first, up to the limit; a never-read video is not_collected", async () => {
  const db = await freshDb();
  const world: World = {
    counts: new Map([["a", 3]]),
    comments: new Map([["a", [comment("c1", "2026-09-01T10:00:00Z"), comment("c3", "2026-09-03T10:00:00Z", { byChannelOwner: true }), comment("c2", "2026-09-02T10:00:00Z")]]]),
  };
  const { services } = setup(db, [video("a"), video("b")], world);
  await services.collectDueComments(RUN);
  const result = await services.listStoredComments({ channelId: "UC_A", videoIds: ["a", "b", "other-channel-video"], limit: 2 });
  assert.deepEqual(result, {
    channelId: "UC_A",
    videos: [
      {
        videoId: "a",
        title: "Title a",
        commentCountAtRead: 3,
        status: "collected",
        readAt: NOW.toISOString(),
        lastError: null,
        comments: [
          { commentId: "c3", text: "text c3", likeCount: 0, publishedAt: "2026-09-03T10:00:00Z", updatedAt: "2026-09-03T10:00:00Z", replyCount: 0, byChannelOwner: true },
          { commentId: "c2", text: "text c2", likeCount: 0, publishedAt: "2026-09-02T10:00:00Z", updatedAt: "2026-09-02T10:00:00Z", replyCount: 0, byChannelOwner: false },
        ],
      },
      { videoId: "b", title: "Title b", commentCountAtRead: null, status: "not_collected", readAt: null, lastError: null, comments: [] },
    ],
  });
  for (const bad of [{ videoIds: [] }, { videoIds: Array.from({ length: 21 }, (_, i) => `v${i}`) }, { videoIds: ["a"], limit: 0 }, { videoIds: ["a"], limit: 101 }]) {
    await assert.rejects(
      () => services.listStoredComments({ channelId: "UC_A", ...bad }),
      (error: unknown) => error instanceof DomainError && error.code === "validation_failed",
      JSON.stringify(bad)
    );
  }
  await assert.rejects(
    () => services.listStoredComments({ channelId: "UC_B", videoIds: ["a"] }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("AC-VC-12: the comment tables stay on this device; comments are III.E.4.c data with a 30-day clock", () => {
  for (const table of ["video_comments", "video_comment_state", "video_comment_channel_state"]) assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES[table], table);
  assert.deepEqual(YOUTUBE_DATA_CLASSIFICATION.video_comments, {
    kind: "authorized_expiring",
    clockColumn: "fetched_at",
    reason: "comments on our own videos (BL-171): Authorized Data that is not analytics, at most 30 days (III.E.4.c); no author data",
  });
});
