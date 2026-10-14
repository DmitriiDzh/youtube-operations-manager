import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CH, V2_GLASS, barLoop, code, setup, sha } from "./storyboards-harness.test";

// BL-189 (FO-REQ-0025 B and §3 step 3; STORYBOARD_TAKES_PLAN.md §2.4-§2.5): the Operator attaches the final loop of the APPROVED
// version with the take of each segment it uses; the owner approves it or requests changes; both are read back. Expected values
// come from the request and from the bytes written here (sha256 by node:crypto), never from the module.

const LOOP = "the assembled 31 s loop, chain s8";
const LOOP_FILE = "Sent to YTM/H-0004/bar/v3/loop_s8.mp4";
/** The Mac's takes: job `<segment>-a` and `<segment>-b` render that segment of version 1; anything else is not a take. */
const isTake = async (take: { source: string; jobId: string }, versionNumber: number, segmentId: string) =>
  take.source === "media" && versionNumber === 1 && (take.jobId === `${segmentId}-a` || take.jobId === `${segmentId}-b`);
const PICKS = { S1: { source: "media" as const, jobId: "S1-a" }, S2: { source: "media" as const, jobId: "S2-b" }, S3: { source: "media" as const, jobId: "S3-a" }, S4: { source: "media" as const, jobId: "S4-b" } };

async function approvedBar() {
  const env = await setup();
  await mkdir(path.join(env.bar, "v3"), { recursive: true });
  await writeFile(path.join(env.bar, "v3", "loop_s8.mp4"), LOOP);
  await env.service.create(barLoop());
  await env.service.submit({ channelId: CH, storyboardId: "bar-loop" });
  await env.service.ownerDecide(CH, "bar-loop", { kind: "approved", versionNumber: 1 });
  return env;
}

test("§3 step 3: the final loop is attached to the approved version with its picks and notes; the owner approves it, then asks for changes", async () => {
  const { service, cleanup } = await approvedBar();
  try {
    const { storyboard, renderId } = await service.attachRender({ channelId: CH, storyboardId: "bar-loop", versionNumber: 1, file: LOOP_FILE, picks: PICKS, notes: "crossfaded joints, closed seam" }, isTake);
    assert.equal(storyboard.renders.length, 1);
    const [render] = storyboard.renders;
    assert.deepEqual(
      [render.renderId, render.versionNumber, render.file, render.sha256, render.bytes, render.picks, render.notes, render.device, render.state, render.decisions],
      [renderId, 1, LOOP_FILE, sha(LOOP), Buffer.byteLength(LOOP), PICKS, "crossfaded joints, closed seam", "Mac", "in_review", []]
    );
    assert.equal((await service.ownerRenderDecision(CH, "bar-loop", renderId, { kind: "approved" })).state, "approved");
    assert.equal((await service.ownerRenderDecision(CH, "bar-loop", renderId, { kind: "changes_requested", note: "S3 joint jumps" })).state, "changes_requested");
    const read = (await service.get({ channelId: CH, storyboardId: "bar-loop" })).storyboard.renders[0];
    assert.deepEqual(read.decisions.map((d) => [d.kind, d.note, d.by]), [["approved", null, "owner"], ["changes_requested", "S3 joint jumps", "owner"]]);
    assert.equal(read.state, "changes_requested", "the newest verdict is the state");
    // A second attach is another render; the first stays as it was.
    const second = await service.attachRender({ channelId: CH, storyboardId: "bar-loop", versionNumber: 1, file: LOOP_FILE, picks: PICKS }, isTake);
    const all = (await service.get({ channelId: CH, storyboardId: "bar-loop" })).storyboard.renders;
    assert.deepEqual(all.map((r) => [r.renderId, r.state]), [[second.renderId, "in_review"], [renderId, "changes_requested"]], "newest first");
  } finally {
    await cleanup();
  }
});

test("without picks, the owner's current picks of that version are recorded", async () => {
  const { service, cleanup } = await approvedBar();
  try {
    await service.ownerPick(CH, "bar-loop", { versionNumber: 1, segmentId: "S1", take: { source: "media", jobId: "S1-b" } }, isTake);
    await service.ownerPick(CH, "bar-loop", { versionNumber: 1, segmentId: "S2", take: { source: "media", jobId: "S2-a" } }, isTake);
    const { storyboard } = await service.attachRender({ channelId: CH, storyboardId: "bar-loop", versionNumber: 1, file: LOOP_FILE }, isTake);
    assert.deepEqual(storyboard.renders[0].picks, { S1: { source: "media", jobId: "S1-b" }, S2: { source: "media", jobId: "S2-a" } });
  } finally {
    await cleanup();
  }
});

test("refusals: only the approved latest version; a video inside the exchange folders; real segments; takes of exactly that segment", async () => {
  const { service, cleanup } = await approvedBar();
  try {
    const attach = (over: Record<string, unknown>) => service.attachRender({ channelId: CH, storyboardId: "bar-loop", versionNumber: 1, file: LOOP_FILE, ...over }, isTake);
    await code(attach({ versionNumber: 2 }), "storyboard_not_found");
    await code(attach({ storyboardId: "sea-loop" }), "storyboard_not_found");
    await code(attach({ file: "outside.mp4" }), "validation_failed", { field: "file" });
    await code(attach({ file: "/Users/x/loop.mp4" }), "validation_failed", { field: "file" });
    await code(attach({ file: "Sent to YTM/H-0004/bar/K1.jpg" }), "validation_failed", { field: "file" });
    await code(attach({ file: "Sent to YTM/../../outside.mp4" }), "storyboard_file_unavailable");
    await code(attach({ file: "From YTM/media/job9/../../../outside.mp4" }), "storyboard_file_unavailable");
    await code(attach({ file: "Sent to YTM/H-0004/bar/v3/missing.mp4" }), "storyboard_file_unavailable");
    await code(attach({ picks: { S9: { source: "media", jobId: "S1-a" } } }), "validation_failed", { field: "picks", segmentId: "S9" });
    await code(attach({ picks: { S2: { source: "media", jobId: "S1-a" } } }), "validation_failed", { field: "picks", segmentId: "S2" });
    await code(attach({ picks: { S1: { source: "gemini", jobId: "S1-a" } } }), "validation_failed", { field: "picks" });
    await code(service.ownerRenderDecision(CH, "bar-loop", "rn_nope", { kind: "approved" }), "storyboard_render_not_found");
    assert.deepEqual((await service.get({ channelId: CH, storyboardId: "bar-loop" })).storyboard.renders, [], "nothing was attached");

    // A new version ends the approval: a render of v1 (no longer the latest) or of the unapproved v2 is refused.
    await service.update({ ...barLoop("bar/v2", V2_GLASS) });
    await code(attach({}), "storyboard_not_approved", { reason: "not_approved" });
    await code(attach({ versionNumber: 2 }), "storyboard_not_approved", { reason: "not_approved", state: "draft" });
  } finally {
    await cleanup();
  }
});

test("a channel that is not connected here takes no render; this computer's copy is checked against the frozen sha256", async () => {
  const off = await setup({ connected: false });
  try {
    await code(off.service.attachRender({ channelId: CH, storyboardId: "bar-loop", versionNumber: 1, file: LOOP_FILE }, isTake), "storyboard_channel_unavailable");
  } finally {
    await off.cleanup();
  }
  const { service, bar, cleanup } = await approvedBar();
  try {
    const { renderId } = await service.attachRender({ channelId: CH, storyboardId: "bar-loop", versionNumber: 1, file: LOOP_FILE, picks: PICKS }, isTake);
    assert.equal((await service.renderFile(CH, "bar-loop", renderId)).status, "ok");
    await writeFile(path.join(bar, "v3", "loop_s8.mp4"), "re-rendered in place");
    assert.equal((await service.renderFile(CH, "bar-loop", renderId)).status, "differs");
    await rm(path.join(bar, "v3", "loop_s8.mp4"));
    assert.deepEqual(await service.renderFile(CH, "bar-loop", renderId), { status: "missing", path: null, bytes: null, file: LOOP_FILE });
    await code(service.renderFile(CH, "bar-loop", "rn_nope"), "storyboard_render_not_found");
  } finally {
    await cleanup();
  }
});
