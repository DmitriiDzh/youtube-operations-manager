import assert from "node:assert/strict";
import test from "node:test";
import type { VideoReservationsReport } from "@/lib/sync-gateway";
import type { VideoFolder, VideoRegistryRow } from "@/lib/workspace-videos";
import { isDomainError, type LinkCandidate, type OwnReservation, type VideoProjectsDeps, type WorkspaceVideos } from "./contracts";
import { folderDateNear, folderMonthDay, linkSuggestions } from "./linking";
import { createVideoProjectsService } from "./services";

// BL-194 stage 1 acceptance (docs/roadmap/plans/VIDEO_COST_PLAN.md §4, criteria 1, 2 and 8; ADR 0040). Expected numbers are worked
// out by hand from the plan's rule "the highest Vn of the channel known from every source, plus one", never read back from the
// implementation.

const UC1 = "UC_channel_one";
const UC2 = "UC_channel_two";

type Harness = {
  deviceId: string;
  own: OwnReservation[];
  peers: VideoReservationsReport[];
  workspace: Record<string, WorkspaceVideos | (() => Promise<WorkspaceVideos>)>;
  uploads: Record<string, Array<{ video: string; status: string; videoId?: string | null }>>;
  storyboards: Record<string, string | null | Error>;
  plans: Record<string, { channelId: string; video: string | null } | Error>;
  published: VideoReservationsReport[];
  logs: string[];
  now: Date;
  connected: string[];
  channelVideos: Record<string, LinkCandidate[]>;
  records: Array<{ channelId: string; relativePath: string; record: Record<string, unknown> }>;
};

function harness(overrides: Partial<Harness> = {}) {
  const h: Harness = {
    deviceId: "mac-device",
    own: [],
    peers: [],
    workspace: {},
    uploads: {},
    storyboards: {},
    plans: {},
    published: [],
    logs: [],
    now: new Date("2026-10-17T10:00:05.000Z"),
    connected: [UC1, UC2],
    channelVideos: {},
    records: [],
    ...overrides,
  };
  let queue: Promise<unknown> = Promise.resolve();
  const deps: VideoProjectsDeps = {
    store: {
      list: async (channelId) => h.own.filter((r) => channelId === undefined || r.channelId === channelId).map((r) => ({ ...r })),
      insert: async (row) => {
        if (h.own.some((r) => r.channelId === row.channelId && r.video === row.video)) return false;
        h.own.push({ ...row });
        return true;
      },
      cancel: async (channelId, video, set) => {
        const row = h.own.find((r) => r.channelId === channelId && r.video === video && r.state === "in_work");
        if (!row) return false;
        Object.assign(row, { state: "cancelled", cancelledAt: set.cancelledAt, replacedBy: set.replacedBy });
        return true;
      },
    },
    peers: async () => h.peers,
    publishReport: async (report) => {
      h.published.push(JSON.parse(JSON.stringify(report)) as VideoReservationsReport);
    },
    ownDevice: async () => ({ deviceId: h.deviceId, hostName: "Mac" }),
    isChannelConnected: async (channelId) => h.connected.includes(channelId),
    workspace: async (channelId) => {
      const w = h.workspace[channelId];
      if (typeof w === "function") return w();
      return w ?? { status: "ok", folders: [], registry: [] };
    },
    uploads: async (channelId) => h.uploads[channelId] ?? [],
    storyboardVideo: async (channelId, storyboardId) => {
      const v = h.storyboards[`${channelId}/${storyboardId}`];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
    planVideo: async (planId) => {
      const v = h.plans[planId];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
    channelVideos: async (channelId) => h.channelVideos[channelId] ?? [],
    writeUploadRecord: async (channelId, relativePath, record) => {
      h.records.push({ channelId, relativePath, record: record as Record<string, unknown> });
    },
    now: () => h.now,
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    },
    log: (line) => void h.logs.push(line),
  };
  return { h, service: createVideoProjectsService(deps) };
}

const folder = (path: string, video: string, files: string[] = []): VideoFolder => ({ folder: path, video, files });
const registryRow = (vNumber: string): VideoRegistryRow => ({ vNumber, videoId: "abcdefghijk", folder: "x" });
const reservation = (channelId: string, video: string, reservedAt: string, extra: Partial<OwnReservation> = {}): OwnReservation => ({
  channelId,
  video,
  workingTitle: null,
  reservedAt,
  state: "in_work",
  cancelledAt: null,
  replacedBy: null,
  ...extra,
});
const peerReport = (deviceId: string, reservations: OwnReservation[], hostName = "WIN-PC"): VideoReservationsReport => ({
  format: "ytm-video-reservations",
  version: 1,
  deviceId,
  hostName,
  updatedAt: "2026-10-17T09:59:00.000Z",
  reservations,
});

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
}

// -- Criterion 1: the next number is one above the highest known Vn of the channel ------------------------------------------------

test("AC-1: «Новый ролик» gives one above the highest Vn of the channel from folders, registry, uploads and every computer's reservations", async () => {
  const { h, service } = harness({
    workspace: {
      [UC1]: { status: "ok", folders: [folder("04 Videos/09 September/0928 V39", "V39"), folder("04 Videos/10 October/1014 V47", "V47")], registry: [registryRow("V45")] },
    },
    uploads: { [UC1]: [{ video: "V48", status: "done" }] },
    // The other computer reserved V49 for this channel, and V60 for ANOTHER channel (it must not count here).
    peers: [peerReport("win-device", [reservation(UC1, "V49", "2026-10-16T08:00:00.000Z"), reservation(UC2, "V60", "2026-10-16T08:00:00.000Z")])],
  });
  const { video } = await service.createVideo({ channelId: UC1, workingTitle: "Jazz bar" });
  assert.equal(video.video, "V50");
  assert.equal(video.workingTitle, "Jazz bar");
  assert.equal(video.state, "in_work");
  assert.equal(video.thisComputer, true);
  assert.deepEqual(
    h.own.map((r) => [r.channelId, r.video, r.workingTitle, r.state]),
    [[UC1, "V50", "Jazz bar", "in_work"]]
  );
  // This computer's report carries the reservation for the other computers.
  const last = h.published.at(-1)!;
  assert.equal(last.deviceId, "mac-device");
  assert.deepEqual(last.reservations.map((r) => [r.channelId, r.video, r.state]), [[UC1, "V50", "in_work"]]);
});

test("AC-1: a channel with no known video starts at V1; the next one is V2; numbers of other channels never count", async () => {
  const { service } = harness({ peers: [peerReport("win-device", [reservation(UC2, "V7", "2026-10-16T08:00:00.000Z")])] });
  assert.equal((await service.createVideo({ channelId: UC1 })).video.video, "V1");
  assert.equal((await service.createVideo({ channelId: UC1, workingTitle: null })).video.video, "V2");
  assert.equal((await service.createVideo({ channelId: UC2 })).video.video, "V8");
});

test("AC-1: a number given up (cancelled) is never handed out again", async () => {
  const { service } = harness({ own: [reservation(UC1, "V12", "2026-10-10T08:00:00.000Z", { state: "cancelled", cancelledAt: "2026-10-11T08:00:00.000Z" })] });
  assert.equal((await service.createVideo({ channelId: UC1 })).video.video, "V13");
});

test("AC-1: two reservations at the same moment on one computer get two numbers", async () => {
  const { service } = harness();
  const [a, b] = await Promise.all([service.createVideo({ channelId: UC1 }), service.createVideo({ channelId: UC1 })]);
  assert.deepEqual([a.video.video, b.video.video].sort(), ["V1", "V2"]);
});

test("AC-1: without a readable workspace no number is given (an existing MMDD Vn folder could be missed); the list still answers", async () => {
  const { h, service } = harness({
    own: [reservation(UC1, "V3", "2026-10-10T08:00:00.000Z")],
    workspace: { [UC1]: { status: "unavailable", reason: "the drive is not mounted" } },
  });
  await rejects(service.createVideo({ channelId: UC1 }), "video_workspace_unavailable");
  assert.equal(h.own.length, 1, "nothing reserved");
  const list = await service.listVideos({ channelId: UC1 });
  assert.equal(list.workspace, "unavailable");
  assert.equal(list.nextVideo, null);
  assert.deepEqual(list.videos.map((v) => v.video), ["V3"]);
});

test("AC-1 / §F: a channel not connected on this computer is refused; a malformed input is refused", async () => {
  const { service } = harness({ connected: [UC1] });
  await rejects(service.createVideo({ channelId: UC2 }), "video_workspace_unavailable");
  await rejects(service.listVideos({ channelId: UC2 }), "video_workspace_unavailable");
  await rejects(service.createVideo({ channelId: UC1, workingTitle: "x".repeat(201) }), "validation_failed");
  await rejects(service.createVideo({ channelId: UC1, extra: true }), "validation_failed");
});

test("AC-1: the list derives each video's state (published, packaged, in work, cancelled) and the next number", async () => {
  const { service } = harness({
    own: [reservation(UC1, "V50", "2026-10-16T08:00:00.000Z", { workingTitle: "Rain" }), reservation(UC1, "V51", "2026-10-16T09:00:00.000Z", { state: "cancelled", cancelledAt: "2026-10-16T10:00:00.000Z" })],
    workspace: {
      [UC1]: {
        status: "ok",
        folders: [
          folder("04 Videos/10 October/1001 V46", "V46", ["V46_release.json", "V46 Tropico.mp4"]),
          folder("04 Videos/10 October/1003 V47", "V47", ["V47_release.json", "V47_youtube.json"]),
          folder("04 Videos/10 October/1016 V50", "V50"),
        ],
        registry: [registryRow("V45")],
      },
    },
  });
  const list = await service.listVideos({ channelId: UC1 });
  assert.equal(list.workspace, "ok");
  assert.equal(list.nextVideo, "V52");
  assert.deepEqual(
    list.videos.map((v) => [v.video, v.state]),
    [
      ["V51", "cancelled"],
      ["V50", "in_work"],
      ["V47", "published"],
      ["V46", "packaged"],
      ["V45", "published"],
    ]
  );
  const v50 = list.videos.find((v) => v.video === "V50")!;
  assert.deepEqual([v50.workingTitle, v50.folder, v50.sources], ["Rain", "04 Videos/10 October/1016 V50", ["reservation", "folder"]]);
  assert.deepEqual((await service.listVideos({ channelId: UC1, state: "in_work" })).videos.map((v) => v.video), ["V50"]);
});

// -- Criterion 1: a duplicate is shown on both computers, and nothing is renumbered without a choice ------------------------------

test("AC-1: the same number reserved on two computers is a conflict on BOTH; the earlier keeps it; nothing is renumbered", async () => {
  const mine = reservation(UC1, "V50", "2026-10-17T10:00:05.000Z", { workingTitle: "Mac's video" });
  const theirs = reservation(UC1, "V50", "2026-10-17T10:00:01.000Z", { workingTitle: "Windows' video" });
  const mac = harness({ own: [mine], peers: [peerReport("win-device", [theirs])] });
  const list = await mac.service.listVideos({ channelId: UC1 });
  const v50 = list.videos.find((v) => v.video === "V50")!;
  assert.ok(v50.conflict);
  assert.equal(v50.conflict.winnerDeviceId, "win-device");
  assert.equal(v50.conflict.thisComputerLoses, true);
  assert.equal(v50.conflict.suggestedVideo, "V51");
  assert.deepEqual(v50.conflict.reservations.map((r) => r.deviceId), ["win-device", "mac-device"]);
  assert.equal(v50.workingTitle, "Windows' video", "the video is the winner's");
  assert.deepEqual(mac.h.own.map((r) => [r.video, r.state]), [["V50", "in_work"]], "never renumbered by a read");

  const win = harness({ deviceId: "win-device", own: [theirs], peers: [peerReport("mac-device", [mine], "Mac")] });
  const other = (await win.service.listVideos({ channelId: UC1 })).videos.find((v) => v.video === "V50")!;
  assert.ok(other.conflict, "the winning computer shows it too");
  assert.equal(other.conflict.thisComputerLoses, false);
  assert.equal(other.conflict.suggestedVideo, null);
});

test("AC-1: equal reservation times go to the lower device id", async () => {
  const at = "2026-10-17T10:00:00.000Z";
  const { service } = harness({ deviceId: "b-device", own: [reservation(UC1, "V50", at)], peers: [peerReport("a-device", [reservation(UC1, "V50", at)])] });
  const v50 = (await service.listVideos({ channelId: UC1 })).videos.find((v) => v.video === "V50")!;
  assert.equal(v50.conflict?.winnerDeviceId, "a-device");
  assert.equal(v50.conflict?.thisComputerLoses, true);
});

test("AC-1: the losing computer takes the next free number only when asked; its old reservation is released, not deleted", async () => {
  const { h, service } = harness({
    own: [reservation(UC1, "V50", "2026-10-17T10:00:05.000Z", { workingTitle: "Mac's video" })],
    peers: [peerReport("win-device", [reservation(UC1, "V50", "2026-10-17T10:00:01.000Z")])],
  });
  const result = await service.renumber({ channelId: UC1, video: "V50" });
  assert.equal(result.video.video, "V51");
  assert.equal(result.video.workingTitle, "Mac's video");
  assert.equal(result.replaced, "V50");
  assert.deepEqual(
    h.own.map((r) => [r.video, r.state, r.replacedBy]),
    [
      ["V50", "cancelled", "V51"],
      ["V51", "in_work", null],
    ]
  );
  const list = await service.listVideos({ channelId: UC1 });
  assert.equal(list.videos.find((v) => v.video === "V50")!.conflict, null, "the dispute is over on this computer");
  assert.deepEqual(h.published.at(-1)!.reservations.map((r) => [r.video, r.state]), [["V50", "cancelled"], ["V51", "in_work"]]);
});

test("AC-1: the winning computer cannot renumber, and a number without a dispute is not renumbered", async () => {
  const win = harness({
    deviceId: "win-device",
    own: [reservation(UC1, "V50", "2026-10-17T10:00:01.000Z")],
    peers: [peerReport("mac-device", [reservation(UC1, "V50", "2026-10-17T10:00:05.000Z")])],
  });
  await rejects(win.service.renumber({ channelId: UC1, video: "V50" }), "validation_failed");
  const alone = harness({ own: [reservation(UC1, "V50", "2026-10-17T10:00:01.000Z")] });
  await rejects(alone.service.renumber({ channelId: UC1, video: "V50" }), "validation_failed");
  assert.deepEqual(alone.h.own.map((r) => r.state), ["in_work"]);
});

test("AC-1: nothing is attached to a number in dispute (on either computer)", async () => {
  const mine = reservation(UC1, "V50", "2026-10-17T10:00:05.000Z");
  const theirs = reservation(UC1, "V50", "2026-10-17T10:00:01.000Z");
  const mac = harness({ own: [mine], peers: [peerReport("win-device", [theirs])] });
  await rejects(mac.service.assertAttachable(UC1, "V50"), "video_in_dispute");
  const win = harness({ deviceId: "win-device", own: [theirs], peers: [peerReport("mac-device", [mine])] });
  await rejects(win.service.assertAttachable(UC1, "V50"), "video_in_dispute");
});

test("cancelling a video of this computer releases it (the number stays taken); another computer's video cannot be cancelled here", async () => {
  const { h, service } = harness({ own: [reservation(UC1, "V50", "2026-10-17T10:00:01.000Z")], peers: [peerReport("win-device", [reservation(UC1, "V51", "2026-10-17T10:00:02.000Z")])] });
  await service.cancelVideo({ channelId: UC1, video: "V50" });
  assert.deepEqual(h.own.map((r) => r.state), ["cancelled"]);
  await rejects(service.cancelVideo({ channelId: UC1, video: "V51" }), "video_not_found");
  await rejects(service.assertAttachable(UC1, "V50"), "video_not_found");
  assert.equal((await service.createVideo({ channelId: UC1 })).video.video, "V52");
});

// -- Criterion 2: a job inherits its storyboard's, else its plan's video; an explicit video of another channel is refused --------

test("AC-2: a job of a storyboard linked to V49 is counted for V49 without passing a video; else its plan's", async () => {
  const { service } = harness({
    own: [reservation(UC1, "V49", "2026-10-16T08:00:00.000Z"), reservation(UC1, "V50", "2026-10-16T09:00:00.000Z")],
    storyboards: { [`${UC1}/bar-loop`]: "V49", [`${UC1}/no-video`]: null },
    plans: { "plan-49": { channelId: UC1, video: "V49" }, "plan-50": { channelId: UC1, video: "V50" }, "plan-none": { channelId: UC1, video: null } },
  });
  assert.equal(await service.resolveJobVideo({ channelId: UC1, storyboardId: "bar-loop" }), "V49");
  assert.equal(await service.resolveJobVideo({ channelId: UC1, planId: "plan-49" }), "V49");
  assert.equal(await service.resolveJobVideo({ channelId: UC1, storyboardId: "bar-loop", planId: "plan-50" }), "V49", "the storyboard's video first");
  assert.equal(await service.resolveJobVideo({ channelId: UC1, storyboardId: "no-video", planId: "plan-50" }), "V50", "else the plan's");
  assert.equal(await service.resolveJobVideo({ channelId: UC1, videoNumber: "V50", storyboardId: "bar-loop" }), "V50", "an explicit video wins");
  assert.equal(await service.resolveJobVideo({ channelId: UC1, planId: "plan-none" }), null, "«не привязано»");
  assert.equal(await service.resolveJobVideo({ channelId: UC1 }), null);
});

test("AC-2: an explicit video of another channel is refused; so is a malformed one", async () => {
  const { service } = harness({
    own: [reservation(UC2, "V49", "2026-10-16T08:00:00.000Z")],
    workspace: { [UC1]: { status: "ok", folders: [folder("04 Videos/10 October/1016 V30", "V30")], registry: [] } },
  });
  await rejects(service.resolveJobVideo({ channelId: UC1, videoNumber: "V49" }), "video_not_found");
  await rejects(service.resolveJobVideo({ channelId: UC1, videoNumber: "49" }), "validation_failed");
  await rejects(service.resolveJobVideo({ channelId: UC1, videoNumber: "V049" }), "validation_failed");
  await rejects(service.resolveJobVideo({ channelId: UC1, videoNumber: "v49" }), "validation_failed");
  // A video the factory made a folder for, without a reservation, may be named.
  assert.equal(await service.resolveJobVideo({ channelId: UC1, videoNumber: "V30" }), "V30");
  assert.equal(await service.assertAttachable(UC2, "V49"), "V49");
});

test("AC-2: a plan of another channel never lends its video", async () => {
  const { service } = harness({ own: [reservation(UC2, "V49", "2026-10-16T08:00:00.000Z")], plans: { "plan-b": { channelId: UC2, video: "V49" } } });
  assert.equal(await service.resolveJobVideo({ channelId: UC1, planId: "plan-b" }), null);
});

test("AC-2: an inherited video in dispute is not attached -- the job is made unlinked", async () => {
  const { h, service } = harness({
    own: [reservation(UC1, "V49", "2026-10-17T10:00:05.000Z")],
    peers: [peerReport("win-device", [reservation(UC1, "V49", "2026-10-17T10:00:01.000Z")])],
    storyboards: { [`${UC1}/bar-loop`]: "V49" },
  });
  assert.equal(await service.resolveJobVideo({ channelId: UC1, storyboardId: "bar-loop" }), null);
  assert.ok(h.logs.some((line) => line.includes("V49")));
  await rejects(service.resolveJobVideo({ channelId: UC1, videoNumber: "V49" }), "video_in_dispute");
});

// -- Criterion 8: the media modules keep working when the video module fails -----------------------------------------------------

test("AC-8: a failing storyboard, plan or workspace lookup never blocks an unnamed job: it is made unlinked", async () => {
  const { h, service } = harness({
    storyboards: { [`${UC1}/bar-loop`]: new Error("storyboards document unreadable") },
    plans: { "plan-49": new Error("SQLITE_BUSY") },
    workspace: { [UC1]: async () => Promise.reject(new Error("EIO")) },
  });
  assert.equal(await service.resolveJobVideo({ channelId: UC1, storyboardId: "bar-loop", planId: "plan-49" }), null);
  assert.ok(h.logs.length >= 1, "the failure is logged");
});

test("AC-8: a video reserved on this computer is attachable without reading the workspace", async () => {
  const { service } = harness({
    own: [reservation(UC1, "V49", "2026-10-16T08:00:00.000Z")],
    workspace: { [UC1]: async () => Promise.reject(new Error("EIO")) },
  });
  assert.equal(await service.resolveJobVideo({ channelId: UC1, videoNumber: "V49" }), "V49");
});

// -- BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage B): the YouTube video each number became, and whether its video file exists --

test("BL-221: the YouTube video of a number -- the folder's Vn_youtube.json first, then this computer's upload, then the registry", async () => {
  const { service } = harness({
    workspace: {
      [UC1]: {
        status: "ok",
        folders: [
          folder("04 Videos/10 October/1001 V41", "V41", ["V41_youtube.json"]),
          folder("04 Videos/10 October/1002 V42", "V42"),
          folder("04 Videos/10 October/1003 V43", "V43"),
          folder("04 Videos/10 October/1004 V44", "V44"),
        ],
        registry: [
          { vNumber: "V41", videoId: "REGISTRY_41", folder: "10 October/1001 V41" },
          { vNumber: "V42", videoId: "REGISTRY_42", folder: "10 October/1002 V42" },
        ],
        uploadRecords: [
          { video: "V41", videoId: "RECORD___41" },
          // a record of a number whose folder the list does not know is ignored
          { video: "V99", videoId: "RECORD___99" },
        ],
      },
    },
    uploads: { [UC1]: [{ video: "V41", status: "done", videoId: "UPLOAD___41" }, { video: "V43", status: "done", videoId: "UPLOAD___43" }] },
  });
  const byVideo = new Map((await service.listVideos({ channelId: UC1 })).videos.map((v) => [v.video, v.youtubeVideoId]));
  assert.equal(byVideo.get("V41"), "RECORD___41");
  assert.equal(byVideo.get("V42"), "REGISTRY_42");
  assert.equal(byVideo.get("V43"), "UPLOAD___43");
  assert.equal(byVideo.get("V44"), null);
  assert.equal(byVideo.has("V99"), false);
});

test("BL-221: a folder has the video file only when a .mp4/.mov/.m4v is named after its own number", async () => {
  const { service } = harness({
    workspace: {
      [UC1]: {
        status: "ok",
        folders: [
          folder("04 Videos/10 October/1001 V5", "V5", ["V5 Tropico Jazz.mp4"]),
          folder("04 Videos/10 October/1002 V6", "V6", ["V60 Tropico Jazz.mp4", "V6_Report.txt"]),
          folder("04 Videos/10 October/1003 V7", "V7", ["V7_final.MOV"]),
          folder("04 Videos/10 October/1004 V8", "V8", ["V8 Tropico Jazz.wav"]),
        ],
        registry: [],
      },
    },
  });
  const byVideo = new Map((await service.listVideos({ channelId: UC1 })).videos.map((v) => [v.video, v.hasVideoFile]));
  assert.deepEqual([byVideo.get("V5"), byVideo.get("V6"), byVideo.get("V7"), byVideo.get("V8")], [true, false, true, false]);
});

// -- BL-221 «Привязать к видео» (CONTENT_UX_PLAN.md stage B; owner msgs 3448/3449/3451: by the folder's date, never by title) ---------

const candidate = (videoId: string, publishedAt: string, extra: Partial<LinkCandidate> = {}): LinkCandidate => ({
  videoId,
  title: `title of ${videoId}`,
  publishedAt,
  publishAt: null,
  privacyStatus: "public",
  durationSeconds: 7200,
  liveBroadcastContent: "none",
  thumbnailUrl: null,
  ...extra,
});

test("BL-221: the folder date is the MMDD of the folder name, in the year nearest to now", () => {
  assert.deepEqual(folderMonthDay("04 Videos/10 October/1011 V52"), { month: 10, day: 11 });
  assert.equal(folderMonthDay("04 Videos/10 October/1014 Live 24-7"), null);
  assert.equal(folderMonthDay("04 Videos/10 October/1311 V52"), null);
  assert.equal(folderDateNear("04 Videos/10 October/1011 V52", new Date("2026-10-24T10:00:00Z")), Date.parse("2026-10-11T00:00:00Z"));
  // In early January a December folder is last year's; in late December a January folder is next year's.
  assert.equal(folderDateNear("04 Videos/12 December/1230 V90", new Date("2027-01-03T10:00:00Z")), Date.parse("2026-12-30T00:00:00Z"));
  assert.equal(folderDateNear("04 Videos/01 January/0102 V95", new Date("2026-12-28T10:00:00Z")), Date.parse("2027-01-02T00:00:00Z"));
});

test("BL-221: suggestions are the unlinked regular videos published or scheduled on the folder's UTC day; the rest by nearest date", () => {
  const now = new Date("2026-10-24T10:00:00Z");
  const result = linkSuggestions(
    "04 Videos/10 October/1011 V52",
    [
      candidate("published__A", "2026-10-11T12:00:31Z"),
      candidate("scheduled__B", "2026-10-01T09:00:00Z", { publishAt: "2026-10-11T23:30:00Z", privacyStatus: "private" }),
      candidate("nextday____C", "2026-10-12T00:10:00Z"),
      candidate("weekbefore_D", "2026-10-04T12:00:00Z"),
      candidate("upcoming___E", "2026-10-11T12:00:00Z", { liveBroadcastContent: "upcoming" }),
      candidate("livenow____F", "2026-10-11T12:00:00Z", { liveBroadcastContent: "live" }),
      candidate("linked_____G", "2026-10-11T12:00:00Z"),
      // published on the 11th of a different month: not the folder's day
      candidate("othermonthH", "2026-09-11T12:00:00Z"),
    ],
    new Set(["linked_____G"]),
    now,
  );
  // Distances from 2026-10-11T00:00Z: A 12h00m31s, B 23h30m -> A first.
  assert.deepEqual(result.suggested.map((c) => c.videoId), ["published__A", "scheduled__B"]);
  // C is 1 day 10 min away, D 7 days, H 30 days.
  assert.deepEqual(result.others.map((c) => c.videoId), ["nextday____C", "weekbefore_D", "othermonthH"]);
});

function linkHarness(extra: Partial<Harness> = {}) {
  return harness({
    workspace: {
      [UC1]: {
        status: "ok",
        folders: [folder("04 Videos/10 October/1011 V52", "V52", ["V52 Tropico Jazz.mp4"]), folder("04 Videos/10 October/1010 V51", "V51", ["V51_youtube.json"])],
        registry: [],
        uploadRecords: [{ video: "V51", videoId: "already__51" }],
      },
    },
    channelVideos: { [UC1]: [candidate("publishd_52", "2026-10-11T12:00:00Z"), candidate("already__51", "2026-10-10T12:00:00Z")] },
    ...extra,
  });
}

test("BL-221: linking a number writes its Vn_youtube.json into its folder (result linked, by the owner) and the list then shows the video", async () => {
  const { h, service } = linkHarness();
  const suggestions = await service.linkSuggestions({ channelId: UC1, video: "V52" });
  assert.deepEqual(suggestions.suggested.map((c) => c.videoId), ["publishd_52"]);
  assert.deepEqual(suggestions.others.map((c) => c.videoId), []);

  // The harness has no real file: the list reads the record through uploadRecords, so add it as the adapter would read it back.
  const result = await service.linkVideo({ channelId: UC1, video: "V52", videoId: "publishd_52" });
  assert.equal(h.records.length, 1);
  const written = h.records[0];
  assert.equal(written.channelId, UC1);
  assert.equal(written.relativePath, "04 Videos/10 October/1011 V52/V52_youtube.json");
  assert.deepEqual(
    { ...written.record, device: undefined },
    {
      schema: "yt-release-upload/1",
      channelId: UC1,
      video: "V52",
      videoId: "publishd_52",
      linkedAt: "2026-10-17T10:00:05.000Z",
      linkedBy: "owner",
      device: undefined,
      result: "linked",
    },
  );
  assert.deepEqual(written.record.device, { deviceId: "mac-device", hostname: "Mac" });
  assert.equal(result.video.video, "V52");
});

test("BL-221: a link is refused for a video of another channel, a video linked to another number, a linked number, a number without a folder", async () => {
  const { h, service } = linkHarness();
  await rejects(service.linkVideo({ channelId: UC1, video: "V52", videoId: "otherChanVd" }), "video_not_found");
  await rejects(service.linkVideo({ channelId: UC1, video: "V52", videoId: "already__51" }), "video_already_linked");
  await rejects(service.linkVideo({ channelId: UC1, video: "V51", videoId: "publishd_52" }), "video_already_linked");
  await rejects(service.linkVideo({ channelId: UC1, video: "V77", videoId: "publishd_52" }), "video_not_found");
  await rejects(service.linkVideo({ channelId: UC1, video: "V52", videoId: "bad id" }), "validation_failed");
  await rejects(service.linkVideo({ channelId: "UC_not_connected", video: "V52", videoId: "publishd_52" }), "video_workspace_unavailable");
  assert.equal(h.records.length, 0);
});

test("BL-221: without a readable workspace nothing is linked", async () => {
  const { h, service } = linkHarness({ workspace: { [UC1]: { status: "unavailable", reason: "disk missing" } } });
  await rejects(service.linkVideo({ channelId: UC1, video: "V52", videoId: "publishd_52" }), "video_workspace_unavailable");
  assert.equal(h.records.length, 0);
});

// -- BL-221 review: a link never races an upload, never takes a cancelled number, never a video any source already names ---------

test("BL-221 review: a number this computer is uploading (queued or running) is not linked; a failed or finished upload does not block", async () => {
  const { h, service } = linkHarness({ uploads: { [UC1]: [{ video: "V52", status: "queued", videoId: null }] } });
  const list = await service.listVideos({ channelId: UC1 });
  assert.equal(list.videos.find((v) => v.video === "V52")?.uploading, true);
  await rejects(service.linkVideo({ channelId: UC1, video: "V52", videoId: "publishd_52" }), "video_upload_in_progress");
  await rejects(service.linkSuggestions({ channelId: UC1, video: "V52" }), "video_upload_in_progress");
  assert.equal(h.records.length, 0);

  const failed = linkHarness({ uploads: { [UC1]: [{ video: "V52", status: "failed", videoId: null }] } });
  assert.equal((await failed.service.listVideos({ channelId: UC1 })).videos.find((v) => v.video === "V52")?.uploading, false);
  await failed.service.linkVideo({ channelId: UC1, video: "V52", videoId: "publishd_52" });
  assert.equal(failed.h.records.length, 1);
});

test("BL-221 review: a cancelled number is not linked, even through the API", async () => {
  const { h, service } = linkHarness({
    own: [reservation(UC1, "V53", "2026-10-11T08:00:00.000Z", { state: "cancelled", cancelledAt: "2026-10-12T08:00:00.000Z" })],
    workspace: { [UC1]: { status: "ok", folders: [], registry: [] } },
  });
  // A cancelled number has no folder here: not linkable. With a folder the list does not call it cancelled (the folder is work).
  await rejects(service.linkVideo({ channelId: UC1, video: "V53", videoId: "publishd_52" }), "video_not_found");
  assert.equal(h.records.length, 0);
});

test("BL-221 review: a video the registry names for another number is not linked again, even when that number has its own record", async () => {
  const { h, service } = linkHarness({
    workspace: {
      [UC1]: {
        status: "ok",
        folders: [folder("04 Videos/10 October/1011 V52", "V52", ["V52 Tropico Jazz.mp4"]), folder("04 Videos/10 October/1010 V41", "V41", ["V41_youtube.json"])],
        // V41's record names another video, so V41's chosen id is "record_v41_"; the registry still names "publishd_52" for V41.
        registry: [{ vNumber: "V41", videoId: "publishd_52", folder: "10 October/1010 V41" }],
        uploadRecords: [{ video: "V41", videoId: "record_v41_" }],
      },
    },
  });
  const suggestions = await service.linkSuggestions({ channelId: UC1, video: "V52" });
  assert.deepEqual(suggestions.suggested.map((c) => c.videoId), []);
  await rejects(service.linkVideo({ channelId: UC1, video: "V52", videoId: "publishd_52" }), "video_already_linked");
  assert.equal(h.records.length, 0);
});
