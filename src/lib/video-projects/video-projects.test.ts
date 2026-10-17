import assert from "node:assert/strict";
import test from "node:test";
import type { VideoReservationsReport } from "@/lib/sync-gateway";
import type { VideoFolder, VideoRegistryRow } from "@/lib/workspace-videos";
import { isDomainError, type OwnReservation, type VideoProjectsDeps, type WorkspaceVideos } from "./contracts";
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
  uploads: Record<string, Array<{ video: string; status: string }>>;
  storyboards: Record<string, string | null | Error>;
  plans: Record<string, { channelId: string; video: string | null } | Error>;
  published: VideoReservationsReport[];
  logs: string[];
  now: Date;
  connected: string[];
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
