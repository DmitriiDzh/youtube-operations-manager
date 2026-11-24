import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError, type PackageReviewDecision, type PackageReviewsSnapshot, type ReviewPackage } from "./contracts";
import { ownerReviewProblemOf, ownerReviewStateOf, wellFormedDecision } from "./model";
import { createPackageReviewsService, type PackageReviewsDeps } from "./services";
import { clockOf, commentIsTimedText, timedCommentsAsText, timedCommentsReadout, wellFormedTimedComments } from "./timed-comments";

// Owner TG 4817 (PACKAGE_REVIEW_PLAN.md AC-TC-01..09): the owner's comments bound to moments of the package's video. Expected values
// are written by hand from the plan: seconds kept to one decimal, `m:ss` (`h:mm:ss` past an hour, whole seconds rounded down), at most
// 200 comments of 1-500 characters; a draft per (channel, manifest) on this computer, only for a package of that channel; sent with an
// approval or a return as one batch (sorted by time), the draft cleared only after the decision is stored; never with a packaging
// comment; a return without a general comment states the timed comments as its comment.

const CH = "UC_wwe";
const MANIFEST = "a".repeat(64);
const OTHER_MANIFEST = "b".repeat(64);
const VIDEO_SHA = "f".repeat(64);
const FOLDER = "04 Videos/11 November/1115 V11";

function pkg(over: Partial<ReviewPackage> = {}): ReviewPackage {
  return {
    manifestSha256: MANIFEST,
    manifestPath: `${FOLDER}/V11_release.json`,
    video: "V11",
    title: "Why the bell rings",
    description: "",
    languages: [],
    slotId: null,
    plannedPublishDate: "2026-11-20",
    durationSeconds: 600,
    videoPath: `${FOLDER}/V11.mp4`,
    thumbnailPath: null,
    videoSha256: VIDEO_SHA,
    videoSizeBytes: 1000,
    uploaded: false,
    otherProblems: [],
    ...over,
  };
}

function harness(options: { failAdd?: boolean; packages?: ReviewPackage[]; removeFails?: boolean } = {}) {
  let clock = new Date("2026-11-24T10:00:00.000Z");
  const audits: Array<Record<string, unknown>> = [];
  const decisions: Record<string, PackageReviewDecision> = {};
  let exists = false;
  const drafts = new Map<string, { commentsJson: string; updatedAt: Date }>();
  const key = (c: string, m: string) => `${c}|${m}`;
  let n = 0;
  const deps: PackageReviewsDeps = {
    store: {
      async read(): Promise<PackageReviewsSnapshot> {
        return { exists, required: { value: true, updatedAt: "2026-11-01T00:00:00.000Z", by: "owner", device: null }, decisions: { ...decisions } };
      },
      async setRequired() {
        exists = true;
      },
      async addDecision(_c, decision) {
        if (options.failAdd) throw new Error("disk full");
        exists = true;
        decisions[decision.id] = decision;
      },
    },
    // Channel UC_other has its own package with another manifest: a draft of UC_wwe is never reached through it.
    packages: async (channelId) =>
      channelId === CH ? { status: "ok", packages: options.packages ?? [pkg()] } : channelId === "UC_other" ? { status: "ok", packages: [pkg({ manifestSha256: OTHER_MANIFEST })] } : { status: "ok", packages: [] },
    resolveFile: async (channelId, rel) => (channelId === CH && rel === `${FOLDER}/V11.mp4` ? { path: `/ws/${rel}`, bytes: 1000 } : null),
    hashFile: async () => VIDEO_SHA,
    assertDeviceAvailable: async () => undefined,
    deviceLabel: async () => "Mac",
    now: () => clock,
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async (e) => void audits.push(e.detail),
    afterChange: () => undefined,
    drafts: {
      get: async (c, m) => drafts.get(key(c, m)) ?? null,
      set: async (c, m, commentsJson, updatedAt) => void drafts.set(key(c, m), { commentsJson, updatedAt }),
      remove: async (c, m) => {
        if (options.removeFails) throw new Error("database is locked");
        drafts.delete(key(c, m));
      },
      prune: async (c, keep, untouchedSince) => {
        let removed = 0;
        for (const [k, row] of [...drafts.entries()]) if (k.startsWith(`${c}|`) && !keep.includes(k.slice(c.length + 1)) && row.updatedAt < untouchedSince) {
            drafts.delete(k);
            removed++;
          }
        return removed;
      },
    },
  };
  const setClock = (iso: string) => {
    clock = new Date(iso);
  };
  return { service: createPackageReviewsService(deps), drafts, audits, setClock, decisions: () => Object.values(decisions) };
}

async function refusedWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => isDomainError(error) && error.code === code);
}

test("AC-TC-02/08: a moment is spelled m:ss, h:mm:ss past an hour, whole seconds rounded down", () => {
  assert.equal(clockOf(0), "0:00");
  assert.equal(clockOf(83.4), "1:23");
  assert.equal(clockOf(59.99), "0:59");
  assert.equal(clockOf(600), "10:00");
  assert.equal(clockOf(3599.9), "59:59");
  assert.equal(clockOf(3725), "1:02:05");
  assert.deepEqual(timedCommentsReadout([{ atSeconds: 83.4, text: "logo too early" }]), [{ atSeconds: 83.4, time: "1:23", text: "logo too early" }]);
});

test("AC-TC-07: well-formed comments are kept sorted by time with one decimal; malformed ones are dropped", () => {
  const read = wellFormedTimedComments([
    { atSeconds: 90.06, text: " second " },
    { atSeconds: 12.34, text: "first" },
    { atSeconds: -1, text: "before the start" },
    { atSeconds: 86_401, text: "past a day" },
    { atSeconds: 5, text: "   " },
    { atSeconds: 5, text: "bell\u0007" },
    { atSeconds: "7", text: "a string time" },
    { atSeconds: 8, text: "x".repeat(501) },
    null,
  ]);
  assert.deepEqual(read, [
    { atSeconds: 12.3, text: "first" },
    { atSeconds: 90.1, text: "second" },
  ]);
  assert.deepEqual(wellFormedTimedComments("not a list"), []);
  assert.equal(wellFormedTimedComments(Array.from({ length: 250 }, (_, i) => ({ atSeconds: i, text: `c${i}` }))).length, 200);
});

test("AC-TC-06: the comment a return gets from its timed comments is one `m:ss text` line per comment", () => {
  assert.equal(
    timedCommentsAsText([
      { atSeconds: 12.3, text: "cut the pause" },
      { atSeconds: 3725, text: "music too loud" },
    ]),
    "0:12 cut the pause\n1:02:05 music too loud"
  );
  const long = timedCommentsAsText([{ atSeconds: 1, text: "x".repeat(500) }], 100);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith("…"));
});

test("AC-TC-07: a decision from the other computer keeps its timed comments; malformed ones never drop or change the decision", () => {
  const base = { id: "pr_1", manifestSha256: MANIFEST, video: "V11", thumbnailSha256: null, by: "owner", device: "Mac", at: "2026-11-24T10:00:00.000Z" };
  const approved = wellFormedDecision({ ...base, kind: "approved", comment: null, timedComments: [{ atSeconds: 10, text: "ok but" }, { atSeconds: "x", text: "bad" }] });
  assert.deepEqual(approved?.timedComments, [{ atSeconds: 10, text: "ok but" }]);
  const garbage = wellFormedDecision({ ...base, kind: "returned", comment: "redo", timedComments: "garbage" });
  assert.ok(garbage);
  assert.equal(garbage.timedComments, undefined);
  // A packaging comment never carries them (AC-TC-06).
  const packaging = wellFormedDecision({ ...base, kind: "packaging_comment", comment: "title", timedComments: [{ atSeconds: 1, text: "x" }] });
  assert.equal(packaging?.timedComments, undefined);
  // The gate reads the return exactly as without them.
  const state = ownerReviewStateOf({ exists: true, required: { value: true, updatedAt: base.at, by: "owner", device: null }, decisions: { pr_1: { ...base, kind: "returned", comment: "redo", timedComments: "garbage" } as never } });
  assert.deepEqual(ownerReviewProblemOf(state, { manifestSha256: MANIFEST, video: "V11", videoSha256: null, videoSizeBytes: null }), { code: "owner_review_returned", params: { comment: "redo" } });
});

test("AC-TC-03: the draft is replaced whole, read back sorted by time, and an empty draft is no row", async () => {
  const h = harness();
  assert.deepEqual(await h.service.draft(CH, MANIFEST), { manifestSha256: MANIFEST, comments: [], updatedAt: null });
  const saved = await h.service.saveDraft(CH, {
    manifestSha256: MANIFEST,
    comments: [
      { id: "b", atSeconds: 95.25, text: "music too loud" },
      { id: "a", atSeconds: 12.3, text: "cut the pause" },
    ],
  });
  const expected = [
    { id: "a", atSeconds: 12.3, text: "cut the pause" },
    { id: "b", atSeconds: 95.3, text: "music too loud" },
  ];
  assert.deepEqual(saved, { manifestSha256: MANIFEST, comments: expected, updatedAt: "2026-11-24T10:00:00.000Z" });
  // A reload (a new read) finds the same draft.
  assert.deepEqual(await h.service.draft(CH, MANIFEST), saved);
  // Edit and delete: the screen sends the whole list again.
  await h.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: [{ id: "b", atSeconds: 95.3, text: "music too loud at the chorus" }] });
  assert.deepEqual((await h.service.draft(CH, MANIFEST)).comments, [{ id: "b", atSeconds: 95.3, text: "music too loud at the chorus" }]);
  await h.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: [] });
  assert.equal(h.drafts.size, 0);
});

test("AC-TC-01/03: a draft over the limits, with a duplicate id, an empty text or an unknown field is refused and nothing is stored", async () => {
  const h = harness();
  const bad = [
    { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 1, text: "" }] },
    { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: -0.1, text: "x" }] },
    { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 86_400.1, text: "x" }] },
    { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 1, text: "x".repeat(501) }] },
    { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 1, text: "line\nbreak" }] },
    { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 1, text: "x" }, { id: "a", atSeconds: 2, text: "y" }] },
    { manifestSha256: MANIFEST, comments: [{ id: "a b", atSeconds: 1, text: "x" }] },
    { manifestSha256: MANIFEST, comments: Array.from({ length: 201 }, (_, i) => ({ id: `c${i}`, atSeconds: i, text: "x" })) },
    { manifestSha256: MANIFEST, comments: [], extra: true },
  ];
  for (const input of bad) await refusedWith(h.service.saveDraft(CH, input), "validation_failed");
  assert.equal(h.drafts.size, 0);
});

test("AC-TC-04: a draft is only for a package of that channel -- another channel's manifest is package_review_not_found", async () => {
  const h = harness();
  await h.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 1, text: "x" }] });
  await refusedWith(h.service.draft("UC_other", MANIFEST), "package_review_not_found");
  await refusedWith(h.service.saveDraft("UC_other", { manifestSha256: MANIFEST, comments: [] }), "package_review_not_found");
  await refusedWith(h.service.draft(CH, OTHER_MANIFEST), "package_review_not_found");
  await refusedWith(h.service.draft(CH, "../x"), "validation_failed");
  assert.equal(h.drafts.size, 1, "the refusals changed nothing");
});

test("AC-TC-05/09: an approval sends the timed comments as one batch sorted by time; the draft goes; the card shows them", async () => {
  const h = harness();
  await h.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 30, text: "x" }] });
  const { decision, view } = await h.service.decide(CH, {
    manifestSha256: MANIFEST,
    kind: "approved",
    comment: null,
    // Review fix 1 (changed requirement: delete only the draft that was sent): the stamp of the draft the screen made it from.
    draftUpdatedAt: "2026-11-24T10:00:00.000Z",
    timedComments: [
      { atSeconds: 61.26, text: "logo late, fine" },
      { atSeconds: 4, text: "nice start" },
    ],
  });
  const expected = [
    { atSeconds: 4, text: "nice start" },
    { atSeconds: 61.3, text: "logo late, fine" },
  ];
  assert.deepEqual(decision.timedComments, expected);
  assert.equal(decision.comment, null);
  assert.equal(h.decisions().length, 1);
  assert.equal(h.drafts.size, 0);
  assert.deepEqual(view.items[0].timedComments, expected);
  assert.equal(view.items[0].state, "approved");
});

test("AC-TC-06: a return with only timed comments is stored with them as its comment; with a general comment that comment stays", async () => {
  const h = harness();
  const only = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned", timedComments: [{ atSeconds: 125, text: "wrong map" }, { atSeconds: 3, text: "black frame" }] });
  assert.equal(only.decision.comment, "0:03 black frame\n2:05 wrong map");
  assert.deepEqual(only.decision.timedComments, [
    { atSeconds: 3, text: "black frame" },
    { atSeconds: 125, text: "wrong map" },
  ]);
  // An older build reads the return (it needs a non-empty comment).
  assert.equal(wellFormedDecision(only.decision)?.kind, "returned");
  const general = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned", comment: "redo the ending", timedComments: [{ atSeconds: 3, text: "black frame" }] });
  assert.equal(general.decision.comment, "redo the ending");
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned", timedComments: [] }), "validation_failed");
});

test("AC-TC-06: a packaging comment with timed comments is refused; one without them keeps the draft", async () => {
  const h = harness();
  await h.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 30, text: "x" }] });
  await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "packaging_comment", comment: "title", timedComments: [{ atSeconds: 1, text: "x" }] }), "validation_failed");
  const { decision } = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "packaging_comment", comment: "shorter title" });
  assert.equal(decision.timedComments, undefined);
  assert.equal(h.drafts.size, 1);
});

test("AC-TC-05: a decision that is refused or cannot be stored keeps the draft", async () => {
  const uploaded = harness({ packages: [pkg({ uploaded: true })] });
  await uploaded.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 30, text: "x" }] });
  await refusedWith(uploaded.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned", timedComments: [{ atSeconds: 30, text: "x" }] }), "package_review_uploaded");
  assert.equal(uploaded.drafts.size, 1);
  const failing = harness({ failAdd: true });
  await failing.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 30, text: "x" }] });
  await assert.rejects(failing.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned", timedComments: [{ atSeconds: 30, text: "x" }] }));
  assert.equal(failing.drafts.size, 1);
});

test("AC-TC-01: a decision's timed comments outside the limits are refused (validation_failed), nothing stored", async () => {
  const h = harness();
  for (const timedComments of [[{ atSeconds: -1, text: "x" }], [{ atSeconds: 1, text: "" }], [{ atSeconds: 1, text: "x", id: "a" }], Array.from({ length: 201 }, (_, i) => ({ atSeconds: i, text: "x" }))]) {
    await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved", timedComments }), "validation_failed");
  }
  assert.deepEqual(h.decisions(), []);
});

// Independent review fix 1: a decision deletes only the draft it was made from. Scenario from the review: five comments saved from the
// phone (stamp T2), then «Одобрить» in an older tab that saw no draft (null) or an earlier one (T1) -> refused, nothing decided, the
// draft stays; the matching stamp -> decided and the draft goes; no stamp at all (an older screen) -> decided, the draft stays.
test("review fix 1: a decision made from another draft is refused and the draft stays; the matching one is deleted", async () => {
  const T1 = "2026-11-24T10:00:00.000Z";
  const T2 = "2026-11-24T10:05:00.000Z";
  const h = harness();
  await h.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 1, text: "one" }] });
  h.setClock(T2);
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, atSeconds: i * 10, text: `phone ${i}` }));
  await h.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: five });
  for (const stale of [null, T1]) {
    await refusedWith(h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved", draftUpdatedAt: stale }), "package_review_draft_changed");
  }
  assert.deepEqual(h.decisions(), [], "nothing was decided");
  assert.equal((await h.service.draft(CH, MANIFEST)).comments.length, 5, "the phone's draft stays");
  // An older screen sends no stamp: decided, the draft is not touched.
  await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved" });
  assert.equal(h.drafts.size, 1);
  // The screen that saw T2 sends it with the five comments: decided, the draft goes.
  await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "returned", draftUpdatedAt: T2, timedComments: five.map(({ atSeconds, text }) => ({ atSeconds, text })) });
  assert.equal(h.drafts.size, 0);
  assert.equal(h.decisions().length, 2);
});

// Review fix 2: a save names the stored draft it replaces; a save made before the stored one was seen (a stale or not-loaded base)
// is refused and the stored draft stays as it was.
test("review fix 2: a draft save on a stale base is refused; on the current base it is written", async () => {
  const h = harness();
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, atSeconds: i, text: `c${i}` }));
  const first = await h.service.saveDraft(CH, { manifestSha256: MANIFEST, baseUpdatedAt: null, comments: five });
  assert.equal(first.updatedAt, "2026-11-24T10:00:00.000Z");
  // A tab that typed before its load returned: base null over an existing draft.
  await refusedWith(h.service.saveDraft(CH, { manifestSha256: MANIFEST, baseUpdatedAt: null, comments: [{ id: "x", atSeconds: 3, text: "only" }] }), "package_review_draft_changed");
  await refusedWith(h.service.saveDraft(CH, { manifestSha256: MANIFEST, baseUpdatedAt: "2026-11-24T09:00:00.000Z", comments: [] }), "package_review_draft_changed");
  assert.equal((await h.service.draft(CH, MANIFEST)).comments.length, 5);
  h.setClock("2026-11-24T10:01:00.000Z");
  const next = await h.service.saveDraft(CH, { manifestSha256: MANIFEST, baseUpdatedAt: "2026-11-24T10:00:00.000Z", comments: five.slice(0, 4) });
  assert.equal(next.updatedAt, "2026-11-24T10:01:00.000Z");
  assert.equal((await h.service.draft(CH, MANIFEST)).comments.length, 4);
});

// Review fix 5: the listing removes drafts of manifests the channel no longer has; fix 6: a draft that cannot be removed is audited.
test("review fixes 5-6: drafts of gone packages are pruned on listing; a failed removal after a decision is audited", async () => {
  const h = harness();
  // 14 days before the clock (2026-11-24) is 2026-11-10: a gone package's draft from 11-01 goes, one from 11-20 (maybe a manifest being
  // rewritten during this scan) stays.
  h.drafts.set(`${CH}|${"c".repeat(64)}`, { commentsJson: "[]", updatedAt: new Date("2026-11-01T00:00:00Z") });
  h.drafts.set(`${CH}|${"d".repeat(64)}`, { commentsJson: "[]", updatedAt: new Date("2026-11-20T00:00:00Z") });
  await h.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 1, text: "x" }] });
  await h.service.view(CH);
  assert.deepEqual([...h.drafts.keys()].sort(), [`${CH}|${"d".repeat(64)}`, `${CH}|${MANIFEST}`].sort());
  const failing = harness({ removeFails: true });
  await failing.service.saveDraft(CH, { manifestSha256: MANIFEST, comments: [{ id: "a", atSeconds: 1, text: "x" }] });
  await failing.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved", draftUpdatedAt: "2026-11-24T10:00:00.000Z" });
  assert.ok(failing.audits.some((a) => a.event === "package_review.draft_remove_failed" && a.message === "database is locked"));
});

// Owner TG 4836: approve WITH a general comment (notes for future videos) and timed comments in one action; an approved video can be
// approved again with notes -- a new approval, the state stays approved and the card shows the latest notes.
test("TG 4836: an approval carries a general comment with timed comments; approving an approved video again keeps it approved", async () => {
  const h = harness();
  const first = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved", comment: null });
  assert.equal(first.view.items[0].state, "approved");
  h.setClock("2026-11-24T11:00:00.000Z");
  const again = await h.service.decide(CH, { manifestSha256: MANIFEST, kind: "approved", comment: "  Next time a shorter intro  ", timedComments: [{ atSeconds: 12, text: "intro drags" }] });
  assert.equal(again.decision.kind, "approved");
  assert.equal(again.decision.comment, "Next time a shorter intro");
  assert.deepEqual(again.decision.timedComments, [{ atSeconds: 12, text: "intro drags" }]);
  assert.equal(again.view.items[0].state, "approved");
  assert.equal(again.view.items[0].comment, "Next time a shorter intro");
  assert.deepEqual(again.view.items[0].timedComments, [{ atSeconds: 12, text: "intro drags" }]);
  assert.equal(h.decisions().length, 2);
});

// Sync compatibility (TG 4836): an older build reads decisions with the same well-formed rule minus the fields it does not know -- an
// approval with a comment (allowed since BL-257) and timed comments (an unknown field, dropped) is still an approval that lets the
// package through the gate; never a return, never dropped.
test("TG 4836 sync: an approval with notes read as an older build reads it is still a well-formed approval that passes the gate", () => {
  const stored = {
    id: "pr_9",
    manifestSha256: MANIFEST,
    video: "V11",
    thumbnailSha256: "1".repeat(64),
    videoSha256: VIDEO_SHA,
    videoSizeBytes: 1000,
    kind: "approved",
    comment: "Next time a shorter intro",
    by: "owner",
    device: "Mac",
    at: "2026-11-24T11:00:00.000Z",
    seq: 2,
    timedComments: [{ atSeconds: 12, text: "intro drags" }],
  };
  const { timedComments: _unknown, ...asOlderBuildKnowsIt } = stored;
  void _unknown;
  for (const record of [stored, asOlderBuildKnowsIt]) {
    const read = wellFormedDecision(record);
    assert.equal(read?.kind, "approved");
    assert.equal(read?.comment, "Next time a shorter intro");
    const state = ownerReviewStateOf({ exists: true, required: { value: true, updatedAt: "2026-11-01T00:00:00Z", by: "owner", device: null }, decisions: { pr_9: record as never } });
    assert.equal(ownerReviewProblemOf(state, { manifestSha256: MANIFEST, video: "V11", videoSha256: VIDEO_SHA, videoSizeBytes: 1000 }), null, "the gate lets it through");
  }
});

test("review fix 7: a comment that is only the timed comments written out is recognised; a general one is not", () => {
  const timed = [{ atSeconds: 3, text: "black frame" }];
  assert.equal(commentIsTimedText("0:03 black frame", timed), true);
  assert.equal(commentIsTimedText("redo the ending", timed), false);
  assert.equal(commentIsTimedText("0:03 black frame", []), false);
  assert.equal(commentIsTimedText(null, timed), false);
});
