import assert from "node:assert/strict";
import test from "node:test";
import type { PackageReviewDecision, PackageReviewsSnapshot } from "./contracts";
import { latestOwnerDecision, ownerReviewProblemOf as problemOf, ownerReviewStateOf, triedExceptionsOf, triedKeysOf, wellFormedDecision } from "./model";
import type { OwnerReviewState, ReviewKey } from "./contracts";

// BL-257 (PACKAGE_REVIEW_PLAN.md AC-PR-01/03/04/07/11; ADR 0070 §1-§5), amended by BL-265 (MEDIA_GATE_PLAN.md AC-MG-01..11/35; ADR
// 0072 §1, §2, §6). Expected values are written from the ADRs' rules: no document = off; unreadable = on, nothing approved; the LATEST
// owner approval or return covering a package stands; a BL-257 decision covers its manifest only; a BL-265 decision covers its mp4
// (sha256 + size) under its video code or the BL-263 recode alias. The thumbnail is no longer part of the gate (ADR 0072 §1).

const A = "a".repeat(64);
const B = "b".repeat(64);
const T1 = "1".repeat(64);

const d = (id: string, manifest: string, kind: "approved" | "returned", at: string, thumb: string | null = T1): PackageReviewDecision => ({
  id,
  manifestSha256: manifest,
  video: "V11",
  thumbnailSha256: thumb,
  kind,
  comment: kind === "returned" ? `fix ${id}` : null,
  by: "owner",
  device: "Mac",
  at,
});
/** The key of a package whose manifest is `manifest` and whose mp4 is V11's (sha VS, 1000 bytes) unless said otherwise. */
const VS = "5".repeat(64);
const key = (manifest: string | null, over: Partial<ReviewKey> = {}): ReviewKey => ({ manifestSha256: manifest, video: "V11", videoSha256: VS, videoSizeBytes: 1000, ...over });
/** The gate for a package of V11's mp4 whose manifest is `manifest` (the thumbnail is no longer part of it, ADR 0072 §1). */
const ownerReviewProblemOf = (state: OwnerReviewState, manifest: string | null) => problemOf(state, key(manifest));
/** A decision written by BL-265: it names the mp4. */
const m = (id: string, manifest: string, kind: "approved" | "returned" | "packaging_comment", at: string, over: Partial<PackageReviewDecision> = {}): PackageReviewDecision => ({
  ...d(id, manifest, kind === "packaging_comment" ? "returned" : kind, at),
  kind,
  comment: kind === "approved" ? null : `note ${id}`,
  videoSha256: VS,
  videoSizeBytes: 1000,
  ...over,
});
const snap = (required: boolean | null, decisions: PackageReviewDecision[]): PackageReviewsSnapshot => ({
  exists: true,
  required: required === null ? null : { value: required, updatedAt: "2026-11-15T08:00:00.000Z", by: "owner", device: "Mac" },
  decisions: Object.fromEntries(decisions.map((x) => [x.id, x])),
});

test("AC-PR-01: no document -> the gate is off and no problem is ever added", () => {
  const state = ownerReviewStateOf({ exists: false, required: null, decisions: {} });
  assert.equal(state.required, false);
  assert.equal(ownerReviewProblemOf(state, A), null);
  assert.equal(ownerReviewProblemOf(state, null), null);
});

test("a document whose switch was never set, or is off, does not gate", () => {
  assert.equal(ownerReviewStateOf(snap(null, [])).required, false);
  assert.equal(ownerReviewStateOf(snap(false, [])).required, false);
  assert.equal(ownerReviewStateOf(snap(true, [])).required, true);
});

test("AC-PR-07: an unreadable document -> required, nothing approved: every package pending", () => {
  const state = ownerReviewStateOf("unreadable");
  assert.equal(state.required, true);
  assert.deepEqual(ownerReviewProblemOf(state, A), { code: "owner_review_pending" });
});

// AC-PR-03's thumbnail clause is withdrawn by BL-265 (changed requirement, owner TG 2340, ADR 0072 §1): a BL-257 approval of A now
// counts for A whatever its thumbnail file is (AC-MG-09 "ready as today").
test("AC-PR-02/03, AC-MG-09: gate on -- no decision pending; a BL-257 approval of A ready for A (any thumbnail); B pending; no manifest hash pending", () => {
  const state = ownerReviewStateOf(snap(true, [d("d1", A, "approved", "2026-11-15T10:00:00.000Z", T1)]));
  assert.equal(ownerReviewProblemOf(state, A), null);
  assert.equal(ownerReviewProblemOf(state, A), null);
  assert.deepEqual(ownerReviewProblemOf(state, B), { code: "owner_review_pending" }, "a re-package of a legacy-approved package: one re-approval");
  assert.deepEqual(ownerReviewProblemOf(state, null), { code: "owner_review_pending" });
});

test("AC-MG-01/02: a media approval covers every manifest of the same mp4 (sha256 AND size) under the same code; a different sha256 or size is pending", () => {
  const state = ownerReviewStateOf(snap(true, [m("d1", A, "approved", "2026-11-15T10:00:00.000Z")]));
  assert.equal(problemOf(state, key(A)), null);
  assert.equal(problemOf(state, key(B)), null, "re-packaged texts / thumbnail / translations: still ready, no new decision");
  assert.deepEqual(problemOf(state, key(B, { videoSha256: "6".repeat(64) })), { code: "owner_review_pending" });
  assert.deepEqual(problemOf(state, key(B, { videoSizeBytes: 1001 })), { code: "owner_review_pending" });
});

test("AC-MG-03: a package whose manifest states no sha256 is never covered by a media decision (pending)", () => {
  const state = ownerReviewStateOf(snap(true, [m("d1", A, "approved", "2026-11-15T10:00:00.000Z")]));
  assert.deepEqual(problemOf(state, key(B, { videoSha256: null })), { code: "owner_review_pending" });
});

test("AC-MG-06: a return of the mp4 -> returned with its comment for every manifest of it; another mp4 pending; a later approval of it ready", () => {
  const returned = ownerReviewStateOf(snap(true, [m("d1", A, "returned", "2026-11-15T10:00:00.000Z")]));
  assert.deepEqual(problemOf(returned, key(B)), { code: "owner_review_returned", params: { comment: "note d1" } });
  assert.deepEqual(problemOf(returned, key(B, { videoSha256: "6".repeat(64) })), { code: "owner_review_pending" });
  const thenApproved = ownerReviewStateOf(snap(true, [m("d1", A, "returned", "2026-11-15T10:00:00.000Z"), m("d2", B, "approved", "2026-11-15T11:00:00.000Z")]));
  assert.equal(problemOf(thenApproved, key("c".repeat(64))), null);
});

test("ADR 0072 §1: one order across BL-257 and BL-265 decisions -- a later media return beats an earlier legacy approval of the manifest, and vice versa", () => {
  const legacyThenReturn = ownerReviewStateOf(snap(true, [{ ...d("d1", A, "approved", "2026-11-15T10:00:00.000Z"), seq: 1 }, m("d2", B, "returned", "2026-11-15T11:00:00.000Z", { seq: 2 })]));
  assert.deepEqual(problemOf(legacyThenReturn, key(A)), { code: "owner_review_returned", params: { comment: "note d2" } });
  const returnThenLegacy = ownerReviewStateOf(snap(true, [m("d2", B, "returned", "2026-11-15T09:00:00.000Z", { seq: 1 }), { ...d("d1", A, "approved", "2026-11-15T10:00:00.000Z"), seq: 2 }]));
  assert.equal(problemOf(returnThenLegacy, key(A)), null);
});

test("AC-MG-07: a packaging comment is never a gate decision -- it neither approves, nor returns, nor hides an approval", () => {
  const onlyComment = ownerReviewStateOf(snap(true, [m("c1", A, "packaging_comment", "2026-11-15T10:00:00.000Z")]));
  assert.deepEqual(problemOf(onlyComment, key(A)), { code: "owner_review_pending" });
  const approvedThenComment = ownerReviewStateOf(snap(true, [m("d1", A, "approved", "2026-11-15T10:00:00.000Z"), m("c1", A, "packaging_comment", "2026-11-15T11:00:00.000Z")]));
  assert.equal(problemOf(approvedThenComment, key(A)), null);
  assert.equal(wellFormedDecision({ ...m("c2", A, "packaging_comment", "2026-11-15T11:00:00.000Z"), comment: " " }), null, "a comment needs text");
});

test("AC-MG-08: an approval of V7's mp4 does not approve V9 with the same mp4, unless V9 is V7's recode alias", () => {
  const decisions = [m("d1", A, "approved", "2026-11-15T10:00:00.000Z", { video: "V7" })];
  const exact = ownerReviewStateOf(snap(true, decisions));
  assert.deepEqual(problemOf(exact, key(B, { video: "V9" })), { code: "owner_review_pending" });
  assert.equal(problemOf(exact, key(B, { video: "V7" })), null);
  const aliased = ownerReviewStateOf(snap(true, decisions), new Map([["V7", "S3"]]));
  assert.equal(problemOf(aliased, key(B, { video: "S3" })), null);
  assert.deepEqual(problemOf(aliased, key(B, { video: "V9" })), { code: "owner_review_pending" });
  // the alias is one-way: a decision on S3 does not approve V7
  const reverse = ownerReviewStateOf(snap(true, [m("d1", A, "approved", "2026-11-15T10:00:00.000Z", { video: "S3" })]), new Map([["V7", "S3"]]));
  assert.deepEqual(problemOf(reverse, key(B, { video: "V7" })), { code: "owner_review_pending" });
});

test("AC-MG-10: an unreadable document holds every package, media-keyed or not; no document -- no gate", () => {
  assert.deepEqual(problemOf(ownerReviewStateOf("unreadable"), key(A)), { code: "owner_review_pending" });
  assert.equal(problemOf(ownerReviewStateOf({ exists: false, required: null, decisions: {} }), key(A)), null);
});

test("AC-MG-11: a BL-265 decision keeps manifestSha256 and a thumbnail hash; a reader with BL-257's rules sees an approval of that manifest only and drops a packaging comment", () => {
  // BL-257's own predicate, as that build had it (manifest + thumbnail hash; only approved / returned kinds).
  const bl257Approves = (dec: Record<string, unknown>, manifest: string, thumb: string) =>
    (dec.kind === "approved" || dec.kind === "returned") && dec.kind === "approved" && dec.manifestSha256 === manifest && dec.thumbnailSha256 !== null && dec.thumbnailSha256 === thumb;
  const approval = m("d1", A, "approved", "2026-11-15T10:00:00.000Z");
  assert.equal(bl257Approves(approval, A, T1), true);
  assert.equal(bl257Approves(approval, B, T1), false, "another manifest of the same mp4: not approved there (stricter)");
  const comment = m("c1", A, "packaging_comment", "2026-11-15T10:00:00.000Z");
  assert.equal(comment.kind === "approved" || comment.kind === "returned", false, "an unknown kind for BL-257 -- dropped");
  // a half media key (hash without size) is dropped: the decision stands for its manifest only
  const half = wellFormedDecision({ ...approval, videoSizeBytes: undefined });
  assert.equal(half !== null && "videoSha256" in half, false);
});

test("AC-PR-04: returned -> returned with its comment; a later approval of the same manifest -> ready; a later return after approval -> returned", () => {
  const returned = ownerReviewStateOf(snap(true, [d("d1", A, "returned", "2026-11-15T10:00:00.000Z")]));
  assert.deepEqual(ownerReviewProblemOf(returned, A), { code: "owner_review_returned", params: { comment: "fix d1" } });
  const thenApproved = ownerReviewStateOf(snap(true, [d("d1", A, "returned", "2026-11-15T10:00:00.000Z"), d("d2", A, "approved", "2026-11-15T11:00:00.000Z")]));
  assert.equal(ownerReviewProblemOf(thenApproved, A), null);
  const changedMind = ownerReviewStateOf(snap(true, [d("d2", A, "approved", "2026-11-15T11:00:00.000Z"), d("d3", A, "returned", "2026-11-15T12:00:00.000Z")]));
  assert.deepEqual(ownerReviewProblemOf(changedMind, A), { code: "owner_review_returned", params: { comment: "fix d3" } });
});

test("latest decision by time, ties by id; a malformed record never approves", () => {
  const sameTime = [d("x1", A, "returned", "2026-11-15T10:00:00.000Z"), d("x2", A, "approved", "2026-11-15T10:00:00.000Z")];
  assert.equal(latestOwnerDecision(A, sameTime)?.id, "x2");
  const forged = { ...d("z9", A, "approved", "2026-11-15T13:00:00.000Z"), by: "producer" };
  const bad = { id: "z8", manifestSha256: A, kind: "approved", by: "owner", at: "not a time", thumbnailSha256: T1 };
  const state = ownerReviewStateOf({ exists: true, required: { value: true, updatedAt: "", by: "owner", device: null }, decisions: { z9: forged as unknown as PackageReviewDecision, z8: bad as unknown as PackageReviewDecision } });
  assert.deepEqual(ownerReviewProblemOf(state, A), { code: "owner_review_pending" });
});

test("AC-MG-35: tried by media key -- a failed / unknown_outcome / after-approval cancelled row of V7's mp4 keeps it tried; all cancelled before YouTube and before the approval -> excused; an old row stays tried by its manifest only", () => {
  const before = Date.parse("2026-11-15T09:00:00.000Z");
  const after = Date.parse("2026-11-15T13:00:00.000Z");
  const state = ownerReviewStateOf(snap(true, [m("d1", A, "approved", "2026-11-15T12:00:00.000Z", { video: "V7" })]));
  const row = (over: Record<string, unknown>) => ({ manifestSha256: A, video: "V7", videoSha256: VS, sizeBytes: 1000, status: "cancelled", videoId: null, createdAtMs: before, ...over });
  const media = { video: "V7", videoSha256: VS, sizeBytes: 1000 };
  assert.deepEqual(triedKeysOf(state, [row({ status: "failed" })]).media, [media]);
  assert.deepEqual(triedKeysOf(state, [row({ status: "failed", errorCode: "unknown_outcome" })]).media, [media]);
  assert.deepEqual(triedKeysOf(state, [row({}), row({ createdAtMs: after })]).media, [media], "cancelled after the approval: tried");
  assert.deepEqual(triedKeysOf(state, [row({}), row({ manifestSha256: B })]).media, [], "every row cancelled before YouTube and the approval: excused");
  assert.deepEqual(triedKeysOf(state, [row({ videoId: "vid1" })]).media, [media], "reached YouTube: tried");
  // an old row (no frozen sha) is tried by its manifest only -- a re-package (new manifest) of it is not tried by it
  const old = triedKeysOf(state, [row({ videoSha256: null, status: "failed" })]);
  assert.deepEqual([[...old.manifests], old.media], [[A], []]);
  // gate off: no exception
  const off = ownerReviewStateOf(snap(false, [m("d1", A, "approved", "2026-11-15T12:00:00.000Z", { video: "V7" })]));
  assert.deepEqual(triedKeysOf(off, [row({})]).media, [media]);
});

test("ADR 0072 §6 (advisor-found regression guard): a cancelled row that froze the mp4 sha is excused by a BL-257 approval of the row's manifest", () => {
  const before = Date.parse("2026-11-15T09:00:00.000Z");
  const state = ownerReviewStateOf(snap(true, [d("d1", A, "approved", "2026-11-15T12:00:00.000Z")]));
  const tried = triedKeysOf(state, [{ manifestSha256: A, video: "V11", videoSha256: VS, sizeBytes: 1000, status: "cancelled", videoId: null, createdAtMs: before }]);
  assert.deepEqual([[...tried.manifests], tried.media], [[], []]);
});

test("AC-PR-11: only an approved manifest whose rows are ALL cancelled, without a video id, and made before the approval is excused", () => {
  const state = ownerReviewStateOf(snap(true, [d("d1", A, "approved", "2026-11-15T12:00:00.000Z"), d("d2", B, "approved", "2026-11-15T12:00:00.000Z")]));
  const before = Date.parse("2026-11-15T09:00:00.000Z");
  const after = Date.parse("2026-11-15T13:00:00.000Z");
  const C = "c".repeat(64);
  const rows = [
    { manifestSha256: A, status: "cancelled", videoId: null, createdAtMs: before },
    { manifestSha256: A, status: "cancelled", videoId: null, createdAtMs: before + 1 },
    { manifestSha256: B, status: "cancelled", videoId: null, createdAtMs: before },
    { manifestSha256: B, status: "failed", videoId: null, createdAtMs: before },
    // not approved in package review: never excused
    { manifestSha256: C, status: "cancelled", videoId: null, createdAtMs: before },
  ];
  assert.deepEqual([...triedExceptionsOf(state, rows)], [A]);
  // a cancelled row that reached YouTube (a video id) keeps it tried
  assert.deepEqual([...triedExceptionsOf(state, [{ manifestSha256: A, status: "cancelled", videoId: "vid1", createdAtMs: before }])], []);
  // a re-take after the approval, cancelled again, keeps it tried (no re-queue loop)
  assert.deepEqual([...triedExceptionsOf(state, [{ manifestSha256: A, status: "cancelled", videoId: null, createdAtMs: before }, { manifestSha256: A, status: "cancelled", videoId: null, createdAtMs: after }])], []);
  // a returned (latest) manifest is never excused
  const returned = ownerReviewStateOf(snap(true, [d("d1", A, "approved", "2026-11-15T12:00:00.000Z"), d("d3", A, "returned", "2026-11-15T12:30:00.000Z")]));
  assert.deepEqual([...triedExceptionsOf(returned, [{ manifestSha256: A, status: "cancelled", videoId: null, createdAtMs: before }])], []);
});

test("review L3: the tried exception applies only while the gate is on", () => {
  const off = ownerReviewStateOf(snap(false, [d("d1", A, "approved", "2026-11-15T12:00:00.000Z")]));
  assert.deepEqual([...triedExceptionsOf(off, [{ manifestSha256: A, status: "cancelled", videoId: null, createdAtMs: Date.parse("2026-11-15T09:00:00.000Z") }])], []);
});

test("review L1: the document's order (seq) beats the wall clock -- a later decision from a computer whose clock is behind still stands", () => {
  const macReturn = { ...d("m1", A, "returned", "2026-11-15T12:00:00.000Z"), seq: 1 };
  const windowsApproveSlowClock = { ...d("w1", A, "approved", "2026-11-15T11:00:00.000Z"), seq: 2 };
  assert.equal(latestOwnerDecision(A, [macReturn, windowsApproveSlowClock])?.id, "w1");
  // same seq (made offline at once): the time decides
  assert.equal(latestOwnerDecision(A, [{ ...macReturn, seq: 2 }, windowsApproveSlowClock])?.id, "m1");
});

test("TG 4584: carriedFrom (a recode's copy) is kept when it is a SHA-256 and dropped otherwise -- never a reason to refuse the decision", () => {
  const carried = { ...d("c1", B, "approved", "2026-11-15T12:00:00.000Z"), carriedFrom: A };
  assert.equal(wellFormedDecision(carried)?.carriedFrom, A);
  const malformed = wellFormedDecision({ ...carried, carriedFrom: "V11" });
  assert.notEqual(malformed, null);
  assert.equal("carriedFrom" in malformed!, false);
  assert.equal("carriedFrom" in wellFormedDecision(d("o1", A, "approved", "2026-11-15T12:00:00.000Z"))!, false, "an owner decision has none");
});
