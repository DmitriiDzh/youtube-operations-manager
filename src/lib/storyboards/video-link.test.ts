import assert from "node:assert/strict";
import test from "node:test";
import { CH, barLoop, code, setup } from "./storyboards-harness.test";

// BL-194 stage 1 (VIDEO_COST_PLAN.md §2 "Where a number is used", criterion 2): a storyboard may name the channel's video it is
// for -- the Operator on create/update, the owner with the picker. A number the channel cannot link to is refused (§F).

test("BL-194: factory_storyboard_create keeps a video of its channel; a video of another channel is refused and nothing is made", async () => {
  const { service, cleanup } = await setup({ videos: { [CH]: ["V49"], UC_other: ["V50"] } });
  try {
    const { storyboard } = await service.create({ ...barLoop(), videoNumber: "V49" });
    assert.equal(storyboard.video, "V49");
    assert.equal((await service.list({ channelId: CH })).storyboards[0].video, "V49");
    await code(service.create({ ...barLoop(), storyboardId: "second", videoNumber: "V50" }), "video_not_found");
    await code(service.create({ ...barLoop(), storyboardId: "third", videoNumber: "49" }), "validation_failed");
    assert.deepEqual((await service.list({ channelId: CH })).storyboards.map((s) => s.storyboardId), ["bar-loop"]);
  } finally {
    await cleanup();
  }
});

test("BL-194: without a video a storyboard has video null; update sets or clears it without a new version", async () => {
  const { service, cleanup } = await setup({ videos: { [CH]: ["V49", "V51"] } });
  try {
    assert.equal((await service.create(barLoop())).storyboard.video, null);
    const set = await service.update({ ...barLoop(), videoNumber: "V51" });
    assert.deepEqual([set.storyboard.video, set.changed, set.versionNumber], ["V51", false, 1]);
    const kept = await service.update(barLoop());
    assert.equal(kept.storyboard.video, "V51", "absent keeps it");
    const cleared = await service.update({ ...barLoop(), videoNumber: null });
    assert.equal(cleared.storyboard.video, null);
  } finally {
    await cleanup();
  }
});

test("BL-194: the owner's picker links the storyboard to a video of its channel or to none; another channel's number is refused", async () => {
  const { service, cleanup } = await setup({ videos: { [CH]: ["V49"] } });
  try {
    await service.create(barLoop());
    assert.equal((await service.ownerSetVideo(CH, "bar-loop", { videoNumber: "V49" })).storyboard.video, "V49");
    await code(service.ownerSetVideo(CH, "bar-loop", { videoNumber: "V77" }), "video_not_found");
    assert.equal((await service.get({ channelId: CH, storyboardId: "bar-loop" })).storyboard.video, "V49", "a refusal changes nothing");
    assert.equal((await service.ownerSetVideo(CH, "bar-loop", { videoNumber: null })).storyboard.video, null);
    await code(service.ownerSetVideo(CH, "missing", { videoNumber: "V49" }), "storyboard_not_found");
  } finally {
    await cleanup();
  }
});

// Independent review (2026-10-17): an update refused for its content changes nothing -- the video link given with it included.
test("BL-194: an update refused for a missing keyframe file leaves the storyboard's video as it was", async () => {
  const { service, cleanup } = await setup({ videos: { [CH]: ["V49", "V51"] } });
  try {
    await service.create({ ...barLoop(), videoNumber: "V49" });
    const broken = barLoop();
    broken.keyframes[0] = { ...broken.keyframes[0], file: "Sent to YTM/storyboards/bar/missing.png" };
    await code(service.update({ ...broken, videoNumber: "V51" }), "storyboard_file_unavailable");
    assert.equal((await service.get({ channelId: CH, storyboardId: "bar-loop" })).storyboard.video, "V49");
  } finally {
    await cleanup();
  }
});
