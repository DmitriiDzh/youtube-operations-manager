import assert from "node:assert/strict";
import test from "node:test";
import type { PackageReviewDecision, PackageReviewsSnapshot } from "./contracts";
import { latestOwnerDecision, ownerReviewProblemOf, ownerReviewStateOf, triedExceptionsOf, wellFormedDecision } from "./model";

// BL-257 (PACKAGE_REVIEW_PLAN.md AC-PR-01/03/04/07/11; ADR 0070 §1-§5). Expected values are written from the ADR's rules:
// no document = off; unreadable = on, nothing approved; the LATEST owner decision for a manifest stands; an approval covers one
// manifest and one thumbnail hash.

const A = "a".repeat(64);
const B = "b".repeat(64);
const T1 = "1".repeat(64);
const T2 = "2".repeat(64);

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
const snap = (required: boolean | null, decisions: PackageReviewDecision[]): PackageReviewsSnapshot => ({
  exists: true,
  required: required === null ? null : { value: required, updatedAt: "2026-11-15T08:00:00.000Z", by: "owner", device: "Mac" },
  decisions: Object.fromEntries(decisions.map((x) => [x.id, x])),
});

test("AC-PR-01: no document -> the gate is off and no problem is ever added", () => {
  const state = ownerReviewStateOf({ exists: false, required: null, decisions: {} });
  assert.equal(state.required, false);
  assert.equal(ownerReviewProblemOf(state, A, T1), null);
  assert.equal(ownerReviewProblemOf(state, null, null), null);
});

test("a document whose switch was never set, or is off, does not gate", () => {
  assert.equal(ownerReviewStateOf(snap(null, [])).required, false);
  assert.equal(ownerReviewStateOf(snap(false, [])).required, false);
  assert.equal(ownerReviewStateOf(snap(true, [])).required, true);
});

test("AC-PR-07: an unreadable document -> required, nothing approved: every package pending", () => {
  const state = ownerReviewStateOf("unreadable");
  assert.equal(state.required, true);
  assert.deepEqual(ownerReviewProblemOf(state, A, T1), { code: "owner_review_pending" });
});

test("AC-PR-02/03: gate on -- no decision pending; approved A + same thumbnail ready; B pending; changed thumbnail pending; no manifest hash pending", () => {
  const state = ownerReviewStateOf(snap(true, [d("d1", A, "approved", "2026-11-15T10:00:00.000Z", T1)]));
  assert.equal(ownerReviewProblemOf(state, A, T1), null);
  assert.deepEqual(ownerReviewProblemOf(state, B, T1), { code: "owner_review_pending" });
  assert.deepEqual(ownerReviewProblemOf(state, A, T2), { code: "owner_review_pending" });
  assert.deepEqual(ownerReviewProblemOf(state, A, null), { code: "owner_review_pending" });
  assert.deepEqual(ownerReviewProblemOf(state, null, T1), { code: "owner_review_pending" });
});

test("AC-PR-04: returned -> returned with its comment; a later approval of the same manifest -> ready; a later return after approval -> returned", () => {
  const returned = ownerReviewStateOf(snap(true, [d("d1", A, "returned", "2026-11-15T10:00:00.000Z")]));
  assert.deepEqual(ownerReviewProblemOf(returned, A, T1), { code: "owner_review_returned", params: { comment: "fix d1" } });
  const thenApproved = ownerReviewStateOf(snap(true, [d("d1", A, "returned", "2026-11-15T10:00:00.000Z"), d("d2", A, "approved", "2026-11-15T11:00:00.000Z")]));
  assert.equal(ownerReviewProblemOf(thenApproved, A, T1), null);
  const changedMind = ownerReviewStateOf(snap(true, [d("d2", A, "approved", "2026-11-15T11:00:00.000Z"), d("d3", A, "returned", "2026-11-15T12:00:00.000Z")]));
  assert.deepEqual(ownerReviewProblemOf(changedMind, A, T1), { code: "owner_review_returned", params: { comment: "fix d3" } });
});

test("latest decision by time, ties by id; a malformed record never approves", () => {
  const sameTime = [d("x1", A, "returned", "2026-11-15T10:00:00.000Z"), d("x2", A, "approved", "2026-11-15T10:00:00.000Z")];
  assert.equal(latestOwnerDecision(A, sameTime)?.id, "x2");
  const forged = { ...d("z9", A, "approved", "2026-11-15T13:00:00.000Z"), by: "producer" };
  const bad = { id: "z8", manifestSha256: A, kind: "approved", by: "owner", at: "not a time", thumbnailSha256: T1 };
  const state = ownerReviewStateOf({ exists: true, required: { value: true, updatedAt: "", by: "owner", device: null }, decisions: { z9: forged as unknown as PackageReviewDecision, z8: bad as unknown as PackageReviewDecision } });
  assert.deepEqual(ownerReviewProblemOf(state, A, T1), { code: "owner_review_pending" });
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
