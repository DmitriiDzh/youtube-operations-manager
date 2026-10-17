import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "./contracts";
import { createVideoCostsBackfill, type BackfillDeps, type BackfillStoryboard } from "./backfill";

// BL-194 stage 4 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 stage 4, §4 criterion 7, owner msg 2871: "storyboard→video matches for old
// runs only after the owner confirms"). A storyboard whose render file is the video file of a `MMDD Vn` folder -- the same name and
// size, then the same sha256 -- is PROPOSED for that video; nothing is linked until the owner confirms it (or picks a video by hand).

const RENDER = { file: "From YTM/media/job-9/bar_loop_v2.mp4", sha256: "a".repeat(64), bytes: 1234, versionNumber: 2 };
const bar: BackfillStoryboard = { id: "sb_bar", title: "Jazz bar", video: null, renders: [RENDER] };

function setup(over: Partial<BackfillDeps> = {}) {
  const calls: string[] = [];
  const deps: BackfillDeps = {
    isChannelConnected: async (c) => c === "UC1",
    storyboards: async () => [bar, { id: "sb_rain", title: "Rain", video: "V41", renders: [] }, { id: "sb_new", title: "No render", video: null, renders: [] }],
    videoFolders: async () => [
      { video: "V39", folder: "04 Videos/09 September/0928 V39", files: [{ name: "bar_loop_v2.mp4", bytes: 1234 }, { name: "V39_release.json", bytes: 900 }] },
      // Same name, other size: not the render.
      { video: "V38", folder: "04 Videos/09 September/0921 V38", files: [{ name: "bar_loop_v2.mp4", bytes: 999 }] },
      // Same name and size but other content: refused by the hash.
      { video: "V37", folder: "04 Videos/09 September/0914 V37", files: [{ name: "bar_loop_v2.mp4", bytes: 1234 }] },
    ],
    hashOf: async (_c, relativePath) => {
      calls.push(`hash:${relativePath}`);
      return relativePath.includes("V39") ? "a".repeat(64) : "b".repeat(64);
    },
    unlinkedRuns: async () => [
      { kind: "storyboard", id: "sb_bar", runs: 7 },
      { kind: "storyboard", id: "sb_rain", runs: 3 },
      { kind: "plan", id: "plan-1", runs: 2 },
    ],
    plans: async () => [{ id: "plan-1", title: "Night drive", video: "V40" }],
    assertAttachable: async (_c, video) => {
      if (video === "V99") throw new DomainError({ code: "video_not_found", message: "unknown" });
      return video as string;
    },
    setStoryboardVideo: async (c, s, v) => void calls.push(`set:${c}:${s}:${v}`),
    linkRuns: async (c, target, v) => {
      calls.push(`link:${c}:${JSON.stringify(target)}:${v}`);
      return "storyboardId" in target ? 7 : 2;
    },
    ...over,
  };
  return { backfill: createVideoCostsBackfill(deps), calls };
}

test("criterion 7: the storyboard whose render is the video file in 0928 V39 is proposed for V39 -- by name, size, then hash -- and nothing is linked", async () => {
  const { backfill, calls } = setup();
  const found = await backfill.proposals({ channelId: "UC1" });
  assert.deepEqual(found.matches, [{ storyboardId: "sb_bar", title: "Jazz bar", video: "V39", folder: "04 Videos/09 September/0928 V39", file: "bar_loop_v2.mp4", bytes: 1234, runs: 7 }]);
  assert.deepEqual(calls, ["hash:04 Videos/09 September/0928 V39/bar_loop_v2.mp4", "hash:04 Videos/09 September/0914 V37/bar_loop_v2.mp4"], "only same-name, same-size files are hashed; nothing is set or linked");
  assert.equal(found.workspace, "ok");
});

test("criterion 7: confirming links the storyboard to V39 (through the storyboards module) and then its unlinked runs here", async () => {
  const { backfill, calls } = setup();
  const done = await backfill.confirmStoryboard({ channelId: "UC1", storyboardId: "sb_bar", video: "V39" });
  assert.deepEqual(done, { storyboardId: "sb_bar", video: "V39", linkedRuns: 7 });
  assert.deepEqual(calls, ["set:UC1:sb_bar:V39", 'link:UC1:{"storyboardId":"sb_bar"}:V39']);
});

test("the owner may pick another video by hand; a video that cannot be linked is refused before anything is set", async () => {
  const { backfill, calls } = setup();
  assert.equal((await backfill.confirmStoryboard({ channelId: "UC1", storyboardId: "sb_bar", video: "V38" })).video, "V38");
  calls.length = 0;
  await assert.rejects(backfill.confirmStoryboard({ channelId: "UC1", storyboardId: "sb_bar", video: "V99" }), (e: unknown) => isDomainError(e) && e.code === "video_not_found");
  assert.deepEqual(calls, []);
});

test("a storyboard already linked to another video is not re-linked by the backfill; an unknown storyboard is refused", async () => {
  const { backfill, calls } = setup();
  await assert.rejects(backfill.confirmStoryboard({ channelId: "UC1", storyboardId: "sb_rain", video: "V39" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(backfill.confirmStoryboard({ channelId: "UC1", storyboardId: "sb_none", video: "V39" }), (e: unknown) => isDomainError(e) && e.code === "not_found");
  assert.deepEqual(calls, []);
});

test("runs of a storyboard or plan that already has a video are listed, and linked here only on the owner's click", async () => {
  const { backfill, calls } = setup();
  const found = await backfill.proposals({ channelId: "UC1" });
  assert.deepEqual(found.linkable, [
    { kind: "storyboard", id: "sb_rain", title: "Rain", video: "V41", runs: 3 },
    { kind: "plan", id: "plan-1", title: "Night drive", video: "V40", runs: 2 },
  ]);
  assert.deepEqual(found.withoutVideo, [{ storyboardId: "sb_bar", title: "Jazz bar", runs: 7 }]);
  calls.length = 0;
  assert.deepEqual(await backfill.linkRuns({ channelId: "UC1", kind: "plan", id: "plan-1" }), { video: "V40", linkedRuns: 2 });
  assert.deepEqual(calls, ['link:UC1:{"planId":"plan-1"}:V40']);
  await assert.rejects(backfill.linkRuns({ channelId: "UC1", kind: "storyboard", id: "sb_bar" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed", "no video yet: confirm one first");
});

test("§F: another channel, or a workspace that cannot be read (no proposals, the rest still listed)", async () => {
  const { backfill } = setup({
    videoFolders: async () => {
      throw new Error("workspace unreadable");
    },
  });
  await assert.rejects(backfill.proposals({ channelId: "UC2" }), (e: unknown) => isDomainError(e) && e.code === "video_costs_unavailable");
  await assert.rejects(backfill.confirmStoryboard({ channelId: "UC2", storyboardId: "sb_bar", video: "V39" }), (e: unknown) => isDomainError(e) && e.code === "video_costs_unavailable");
  const found = await backfill.proposals({ channelId: "UC1" });
  assert.deepEqual([found.workspace, found.matches.length, found.linkable.length], ["unavailable", 0, 2]);
});

test("without the storyboards module (no port), a storyboard cannot be confirmed -- nothing is linked half-way", async () => {
  const { backfill, calls } = setup({ setStoryboardVideo: undefined });
  await assert.rejects(backfill.confirmStoryboard({ channelId: "UC1", storyboardId: "sb_bar", video: "V39" }), (e: unknown) => isDomainError(e) && e.code === "video_costs_unavailable");
  assert.deepEqual(calls, []);
});
