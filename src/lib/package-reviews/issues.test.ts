import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError, type PackageReviewDecision, type PackageReviewsSnapshot, type ReviewPackage } from "./contracts";
import { decisionsOfVideo, issueCounts, issuesOf, issuesReadout } from "./issues";
import { ownerReviewProblemOf, ownerReviewStateOf, wellFormedDecision } from "./model";
import { createPackageReviewsService, type PackageReviewsDeps } from "./services";
import { wellFormedReplies } from "./timed-comments";

// Owner TG 4846/4848 (PACKAGE_REVIEW_PLAN.md AC-IS-01..08). Expected values are written by hand from the plan: an issue per timed
// comment, id `<decisionId>.<n>` in time order; the key across package versions is the video code (or its recode alias), never the
// manifest or mp4; the factory's answers come in `reviewReplies` and are snapshotted into the next decision; the owner resolves or
// follows up with his next approve / return; open (return) / noted (approval) / resolved; the moment is the agent's latest.

const M1 = "1".repeat(64);
const M2 = "2".repeat(64);
const SHA1 = "a".repeat(64);
const SHA2 = "b".repeat(64);
const base = { thumbnailSha256: null, by: "owner" as const, device: "Mac", comment: "x" };

const ret = (id: string, at: string, seq: number, over: Partial<PackageReviewDecision> = {}): PackageReviewDecision => ({ ...base, id, kind: "returned", manifestSha256: M1, video: "V11", videoSha256: SHA1, videoSizeBytes: 10, at, seq, ...over });

test("AC-IS-01/02: issues carry over to the next package version of the same video (new manifest, new mp4); another video's do not", () => {
  const d1 = ret("pr_a", "2026-11-24T10:00:00Z", 1, { timedComments: [{ atSeconds: 61, text: "wrong map" }, { atSeconds: 3, text: "black frame" }] });
  const other = ret("pr_o", "2026-11-24T10:30:00Z", 2, { video: "V12", timedComments: [{ atSeconds: 5, text: "not mine" }] });
  // The re-packaged V11 has M2 / SHA2: the return no longer covers its media, but its issues are still V11's.
  const ofV11 = decisionsOfVideo([d1, other], "V11", new Map());
  assert.deepEqual(ofV11.map((d) => d.id), ["pr_a"]);
  const issues = issuesOf(ofV11);
  assert.deepEqual(issues.map((i) => [i.id, i.atSeconds, i.text, i.state]), [
    ["pr_a.1", 3, "black frame", "open"],
    ["pr_a.2", 61, "wrong map", "open"],
  ]);
  // A recoded video (V11 -> S3) keeps them under the alias.
  assert.deepEqual(issuesOf(decisionsOfVideo([d1], "S3", new Map([["V11", "S3"]]))).length, 2);
  void M2;
  void SHA2;
});

test("AC-IS-03/05: a reply binds to its issue by id, moves its moment, and shows as pending until a decision saw it", () => {
  const d1 = ret("pr_a", "2026-11-24T10:00:00Z", 1, { timedComments: [{ atSeconds: 3, text: "black frame" }, { atSeconds: 61, text: "wrong map" }] });
  const replies = wellFormedReplies([
    { issueId: "pr_a.1", status: "fixed", text: "trimmed the first second" },
    { issueId: "pr_a.2", status: "partly", text: "map redrawn, label later", atSeconds: 63.04 },
    { issueId: "pr_zz.1", status: "fixed", text: "an unknown issue" },
    { issueId: "pr_a.1", status: "maybe", text: "bad status" },
    "garbage",
  ]);
  assert.equal(replies.length, 3, "the malformed ones are dropped, the unknown issue is kept for the model to ignore");
  const issues = issuesOf([d1], replies);
  const map = issues.find((i) => i.id === "pr_a.2")!;
  assert.equal(map.atSeconds, 63);
  assert.equal(map.originalAtSeconds, 61);
  assert.deepEqual(map.thread.at(-1), { by: "agent", status: "partly", text: "map redrawn, label later", atSeconds: 63, at: null });
  assert.equal(issues.length, 2, "a reply to an unknown issue adds nothing");
  // The owner then decides on that package: the answers he saw are part of his decision -- no longer pending, and not twice.
  const d2 = ret("pr_b", "2026-11-25T10:00:00Z", 2, { kind: "approved", repliesSeen: replies.filter((r) => r.issueId.startsWith("pr_a")), issueActions: [{ issueId: "pr_a.1", kind: "resolved" }] });
  const after = issuesOf([d1, d2], replies);
  const frame = after.find((i) => i.id === "pr_a.1")!;
  assert.deepEqual(frame.thread.map((t) => (t.by === "owner" ? `owner:${t.kind}` : `agent:${t.status}:${t.at}`)), ["owner:opened", "agent:fixed:2026-11-25T10:00:00Z", "owner:resolved"]);
  assert.equal(frame.state, "resolved");
});

test("AC-IS-04/05: a follow-up keeps the issue open with the owner's new turn; counts follow the states; an approval's issues are noted", () => {
  const d1 = ret("pr_a", "2026-11-24T10:00:00Z", 1, { timedComments: [{ atSeconds: 3, text: "black frame" }, { atSeconds: 61, text: "wrong map" }] });
  const d2 = ret("pr_b", "2026-11-25T10:00:00Z", 2, {
    issueActions: [
      { issueId: "pr_a.1", kind: "resolved" },
      { issueId: "pr_a.2", kind: "follow_up", text: "still the old border" },
    ],
    timedComments: [{ atSeconds: 90, text: "new: outro too long" }],
  });
  const d3 = ret("pr_c", "2026-11-26T10:00:00Z", 3, { kind: "approved", timedComments: [{ atSeconds: 10, text: "next time a shorter intro" }] });
  const issues = issuesOf([d1, d2, d3]);
  assert.deepEqual(issues.map((i) => [i.id, i.state]), [
    ["pr_a.1", "resolved"],
    ["pr_c.1", "noted"],
    ["pr_a.2", "open"],
    ["pr_b.1", "open"],
  ]);
  assert.deepEqual(issues.find((i) => i.id === "pr_a.2")!.thread.at(-1), { by: "owner", kind: "follow_up", text: "still the old border", at: "2026-11-25T10:00:00Z" });
  assert.deepEqual(issueCounts(issues), { open: 2, resolved: 1, noted: 1 });
  const readout = issuesReadout(issues).find((i) => i.id === "pr_b.1")!;
  assert.deepEqual([readout.time, readout.state, readout.thread[0].by], ["1:30", "open", "owner"]);
});

test("AC-IS-02: a carried copy of a decision (recode) adds no second issue or turn; a stage-1 comment without an id gets the derived one", () => {
  const d1 = ret("pr_a", "2026-11-24T10:00:00Z", 1, { timedComments: [{ atSeconds: 3, text: "black frame" }] });
  const copy = { ...d1, id: "pr_copy", manifestSha256: M2, video: "S3", carriedFrom: M1, timedComments: [{ atSeconds: 3, text: "black frame", id: "pr_a.1" }], seq: 2 };
  const issues = issuesOf(decisionsOfVideo([d1, copy], "S3", new Map([["V11", "S3"]])));
  assert.deepEqual(issues.map((i) => [i.id, i.thread.length]), [["pr_a.1", 1]]);
});

test("AC-IS-08: a decision with issue fields reads as before -- the same gate answer with or without them; malformed ones dropped", () => {
  const stored = {
    ...ret("pr_b", "2026-11-25T10:00:00Z", 2, { kind: "approved", videoSha256: SHA1 }),
    timedComments: [{ atSeconds: 4, text: "noted", id: "pr_b.1" }],
    issueActions: [{ issueId: "pr_a.1", kind: "resolved" }, { issueId: "bad id!", kind: "resolved" }, { issueId: "pr_a.2", kind: "follow_up" }],
    repliesSeen: [{ issueId: "pr_a.1", status: "fixed", text: "done" }, { issueId: "pr_a.2", status: "nope", text: "x" }],
  };
  const read = wellFormedDecision(stored)!;
  assert.deepEqual(read.issueActions, [{ issueId: "pr_a.1", kind: "resolved" }]);
  assert.deepEqual(read.repliesSeen, [{ issueId: "pr_a.1", status: "fixed", text: "done" }]);
  const { issueActions: _a, repliesSeen: _r, timedComments: _t, ...older } = stored;
  void _a;
  void _r;
  void _t;
  for (const record of [stored, older]) {
    assert.equal(wellFormedDecision(record)?.kind, "approved");
    const state = ownerReviewStateOf({ exists: true, required: { value: true, updatedAt: "2026-11-01T00:00:00Z", by: "owner", device: null }, decisions: { pr_b: record as never } });
    assert.equal(ownerReviewProblemOf(state, { manifestSha256: M1, video: "V11", videoSha256: SHA1, videoSizeBytes: 10 }), null);
  }
});

// --- the service: actions, the answers seen, the wrong channel --------------------------------------------------------------

const CH = "UC_wwe";
const FOLDER = "04 Videos/11 November/1115 V11";
function pkg(over: Partial<ReviewPackage> = {}): ReviewPackage {
  return { manifestSha256: M1, manifestPath: `${FOLDER}/V11_release.json`, video: "V11", title: "t", description: "", languages: [], slotId: null, plannedPublishDate: null, durationSeconds: 100, videoPath: `${FOLDER}/V11.mp4`, thumbnailPath: null, videoSha256: SHA1, videoSizeBytes: 1000, uploaded: false, otherProblems: [], ...over };
}

function harness() {
  const decisions: Record<string, PackageReviewDecision> = {};
  let n = 0;
  let clock = new Date("2026-11-24T10:00:00.000Z");
  let packages: Record<string, ReviewPackage[]> = { [CH]: [pkg()], UC_other: [pkg({ manifestSha256: M2, video: "V11" })] };
  const deps: PackageReviewsDeps = {
    store: {
      async read(channelId): Promise<PackageReviewsSnapshot> {
        const own = Object.fromEntries(Object.entries(decisions).filter(([k]) => k.startsWith(`${channelId}|`)).map(([k, v]) => [k.split("|")[1], v]));
        return { exists: Object.keys(own).length > 0, required: { value: true, updatedAt: "2026-11-01T00:00:00Z", by: "owner", device: null }, decisions: own };
      },
      async setRequired() {},
      async addDecision(channelId, decision) {
        decisions[`${channelId}|${decision.id}`] = { ...decision, seq: ++n };
      },
    },
    packages: async (channelId) => ({ status: "ok", packages: packages[channelId] ?? [] }),
    resolveFile: async (_c, rel) => ({ path: `/ws/${rel}`, bytes: 1000 }),
    hashFile: async (abs) => (abs.includes("v2") ? SHA2 : SHA1),
    assertDeviceAvailable: async () => undefined,
    deviceLabel: async () => "Mac",
    now: () => clock,
    randomId: () => `id${n + 1}`,
    withLock: (fn) => fn(),
    audit: async () => undefined,
    afterChange: () => undefined,
  };
  return {
    service: createPackageReviewsService(deps),
    setPackages: (channelId: string, list: ReviewPackage[]) => {
      packages = { ...packages, [channelId]: list };
    },
    tick: (iso: string) => {
      clock = new Date(iso);
    },
    decisions: () => Object.values(decisions),
  };
}

async function refusedWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => isDomainError(error) && error.code === code);
}

test("AC-IS-01..07 end to end: return with comments -> re-package with answers -> resolve one, follow up another -> counts", async () => {
  const h = harness();
  const first = await h.service.decide(CH, { manifestSha256: M1, kind: "returned", timedComments: [{ atSeconds: 61, text: "wrong map" }, { atSeconds: 3, text: "black frame" }] });
  const [frameId, mapId] = first.decision.timedComments!.map((c) => c.id!);
  assert.deepEqual([frameId, mapId], ["pr_id1.1", "pr_id1.2"]);
  // The factory re-packages V11: a new manifest and mp4, with its answers.
  h.setPackages(CH, [pkg({ manifestSha256: M2, videoPath: `${FOLDER}/V11-v2.mp4`, videoSha256: SHA2, reviewReplies: wellFormedReplies([{ issueId: frameId, status: "fixed", text: "cut" }, { issueId: mapId, status: "partly", text: "redrawn", atSeconds: 64 }]) })]);
  const view = await h.service.view(CH);
  assert.equal(view.items[0].state, "pending", "a new mp4 waits for the owner again");
  assert.deepEqual(view.items[0].issueCounts, { open: 2, resolved: 0, noted: 0 });
  assert.equal(view.items[0].issues.find((i) => i.id === mapId)!.atSeconds, 64);
  h.tick("2026-11-25T10:00:00.000Z");
  const second = await h.service.decide(CH, {
    manifestSha256: M2,
    kind: "returned",
    issueActions: [
      { issueId: frameId, kind: "resolved" },
      { issueId: mapId, kind: "follow_up", text: "label still overlaps" },
    ],
  });
  // The answers he saw are kept in his decision; a return with only a follow-up states it as its comment (older builds need one).
  assert.deepEqual(second.decision.repliesSeen?.map((r) => r.issueId), [frameId, mapId]);
  assert.equal(second.decision.comment, "1:04 label still overlaps");
  assert.deepEqual(second.view.items[0].issueCounts, { open: 1, resolved: 1, noted: 0 });
});

test("AC-IS-04: an action on an issue of another channel or another video is refused and nothing is decided", async () => {
  const h = harness();
  const first = await h.service.decide(CH, { manifestSha256: M1, kind: "returned", timedComments: [{ atSeconds: 3, text: "black frame" }] });
  const id = first.decision.timedComments![0].id!;
  // The same id named through another channel (its own V11 has no such issue).
  await refusedWith(h.service.decide("UC_other", { manifestSha256: M2, kind: "returned", issueActions: [{ issueId: id, kind: "follow_up", text: "x" }] }), "package_review_issue_unknown");
  // An id this channel never minted.
  await refusedWith(h.service.decide(CH, { manifestSha256: M1, kind: "approved", issueActions: [{ issueId: "pr_nope.1", kind: "resolved" }] }), "package_review_issue_unknown");
  // A packaging comment never carries actions.
  await refusedWith(h.service.decide(CH, { manifestSha256: M1, kind: "packaging_comment", comment: "t", issueActions: [{ issueId: id, kind: "resolved" }] }), "validation_failed");
  assert.equal(h.decisions().length, 1);
});
