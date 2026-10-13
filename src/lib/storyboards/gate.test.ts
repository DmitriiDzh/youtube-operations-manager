import assert from "node:assert/strict";
import test from "node:test";
import { CH, V1, V2, V2_GLASS, barLoop, code, segments, setup, sha } from "./storyboards-harness.test";
import { createStoryboardGate } from "./gate";

// BL-184 stage 2 -- acceptance FO-REQ-0024 §5 step 4 and B4 (owner 1183), written before the gate was wired:
// AC-SG-01 two different frames, no link, setting on (the default)  -> storyboard_not_approved, reason no_link;
// AC-SG-02 the same with the setting off                              -> allowed, nothing recorded;
// AC-SG-03 only a first frame, or the same image as both frames      -> never gated (no storyboard for a one-image video);
// AC-SG-04 a link is always checked, whatever the setting: unknown storyboard -> not_found; latest version not approved ->
//          not_approved; segment not in it -> segment_not_found; frames not exactly from/to by sha256 (reversed, or a file from
//          another version) -> frames_mismatch;
// AC-SG-05 a link to the approved latest version with its two keyframes -> allowed; the job records storyboard, version, segment;
// AC-SG-06 approved v2, then the Operator adds v3 -> the v2 link is refused (not_approved) until v3 is approved;
// AC-SG-07 the gate cannot read the storyboards -> the error propagates (no job on an unknown gate state).
// Every sha256 is computed here over the harness's bytes.

async function approvedBarV2() {
  const env = await setup();
  await env.service.create(barLoop());
  await env.service.submit({ channelId: CH, storyboardId: "bar-loop" });
  return env;
}

test("§5 step 4 / AC-SG-04, AC-SG-05: a link is refused before approval and accepted after the owner approves v2", async () => {
  const env = await approvedBarV2();
  try {
    const gate = createStoryboardGate(env.sync);
    const s1v1 = { channelId: CH, firstFrameSha256: sha(V1.K0), lastFrameSha256: sha(V1.K1), link: { storyboardId: "bar-loop", segmentId: "S1" } };
    // v1 is submitted and waits for the owner (in review): not approved.
    await code(gate.check(s1v1), "storyboard_not_approved", { reason: "not_approved" });
    // The same storyboard id named for another channel: it is not there.
    await code(gate.check({ ...s1v1, channelId: "UC_other" }), "storyboard_not_approved", { reason: "not_found" });
    await env.service.ownerDecide(CH, "bar-loop", { kind: "changes_requested", versionNumber: 1 });
    await env.service.update(barLoop("bar/v2", V2_GLASS));
    await env.service.submit({ channelId: CH, storyboardId: "bar-loop" });
    await code(gate.check({ ...s1v1, firstFrameSha256: sha(V2.K0), lastFrameSha256: sha(V2.K1) }), "storyboard_not_approved", { reason: "not_approved" });
    await env.service.ownerDecide(CH, "bar-loop", { kind: "approved", versionNumber: 2 });

    const s1v2 = { ...s1v1, firstFrameSha256: sha(V2.K0), lastFrameSha256: sha(V2.K1) };
    assert.deepEqual(await gate.check(s1v2), { storyboardId: "bar-loop", versionNumber: 2, segmentId: "S1" });
    // The loop's closing segment S4 runs from K3 back to K0.
    assert.deepEqual(await gate.check({ ...s1v2, firstFrameSha256: sha(V2.K3), lastFrameSha256: sha(V2.K0), link: { storyboardId: "bar-loop", segmentId: "S4" } }), { storyboardId: "bar-loop", versionNumber: 2, segmentId: "S4" });
    // v1's K1 (the glass handed over) is not v2's K1; frames the wrong way round; only a first frame.
    await code(gate.check({ ...s1v2, lastFrameSha256: sha(V1.K1) }), "storyboard_not_approved", { reason: "frames_mismatch" });
    await code(gate.check({ ...s1v2, firstFrameSha256: sha(V2.K1), lastFrameSha256: sha(V2.K0) }), "storyboard_not_approved", { reason: "frames_mismatch" });
    await code(gate.check({ ...s1v2, lastFrameSha256: null }), "storyboard_not_approved", { reason: "frames_mismatch" });
    await code(gate.check({ ...s1v2, link: { storyboardId: "bar-loop", segmentId: "S9" } }), "storyboard_not_approved", { reason: "segment_not_found" });
    await code(gate.check({ ...s1v2, link: { storyboardId: "nope", segmentId: "S1" } }), "storyboard_not_approved", { reason: "not_found" });

    // AC-SG-06: a new version ends the approval -- the v2 link is refused until v3 is approved.
    await env.service.update({ ...barLoop("bar/v2", V2_GLASS), segments: segments().map((s) => (s.id === "S3" ? { ...s, action: "he folds the towel" } : s)) });
    await code(gate.check(s1v2), "storyboard_not_approved", { reason: "not_approved" });
  } finally {
    await env.cleanup();
  }
});

test("§5 step 4 / AC-SG-01..03: without a link, two different frames are refused while the setting is on; one image never is", async () => {
  const env = await approvedBarV2();
  try {
    const gate = createStoryboardGate(env.sync);
    const flf = { channelId: CH, firstFrameSha256: sha(V2.K0), lastFrameSha256: sha(V2.K1), link: null };
    await code(gate.check(flf), "storyboard_not_approved", { reason: "no_link" });
    // A single-image loop (the same still as first and last frame) and a first-frame-only video run without any storyboard.
    assert.equal(await gate.check({ ...flf, lastFrameSha256: sha(V2.K0) }), null);
    assert.equal(await gate.check({ ...flf, lastFrameSha256: null }), null);
    assert.equal(await gate.check({ ...flf, firstFrameSha256: null, lastFrameSha256: null }), null);

    // AC-SG-02: the owner turns the setting off -- no link needed; a link is still checked (B4's first rule).
    const turnedOff = await env.service.setGateSetting(CH, { requireApproved: false });
    assert.deepEqual([turnedOff.requireApproved, turnedOff.changedBy, Number.isFinite(Date.parse(turnedOff.changedAt ?? ""))], [false, "Mac", true]);
    assert.equal(await gate.check(flf), null);
    await code(gate.check({ ...flf, link: { storyboardId: "bar-loop", segmentId: "S1" } }), "storyboard_not_approved", { reason: "not_approved" });
    await env.service.setGateSetting(CH, { requireApproved: true });
    await code(gate.check(flf), "storyboard_not_approved", { reason: "no_link" });
    // The default when nobody changed it: on.
    const fresh = await setup();
    try {
      assert.deepEqual(await fresh.service.gateSetting(CH), { requireApproved: true, changedAt: null, changedBy: null });
    } finally {
      await fresh.cleanup();
    }
  } finally {
    await env.cleanup();
  }
});

test("AC-SG-07: a gate that cannot read the storyboards never lets a two-frame job through", async () => {
  const broken = { read: async () => Promise.reject(new Error("document unreadable")), readGate: async () => Promise.reject(new Error("document unreadable")) };
  const gate = createStoryboardGate(broken);
  await assert.rejects(gate.check({ channelId: CH, firstFrameSha256: "a", lastFrameSha256: "b", link: null }), /document unreadable/);
  await assert.rejects(gate.check({ channelId: CH, firstFrameSha256: "a", lastFrameSha256: "b", link: { storyboardId: "x", segmentId: "S1" } }), /document unreadable/);
  // A one-image job does not need the storyboards at all.
  assert.equal(await gate.check({ channelId: CH, firstFrameSha256: "a", lastFrameSha256: "a", link: null }), null);
});
