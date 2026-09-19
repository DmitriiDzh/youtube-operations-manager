import assert from "node:assert/strict";
import test from "node:test";
import type { Change, StoredVideoRecord } from "./contracts";
import {
  classifyFieldChange,
  computeChangeSetStatus,
  computeConflictStatus,
  currentRemoteValueFor,
  isValidLanguageCode,
  revalidateChangeAgainstCurrentRemote,
} from "./diff";

function makeVideo(overrides: Partial<StoredVideoRecord> = {}): StoredVideoRecord {
  return {
    videoId: "v1",
    channelId: "UC_TEST",
    title: "EN Title",
    description: "EN Description",
    publishedAt: "2026-01-01T00:00:00.000Z",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    thumbnails: {},
    existingLocalizations: { es: { title: "Titulo ES", description: "Descripcion ES" } },
    etag: "etag-v1",
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function makeChange(overrides: Partial<Change> = {}): Change {
  return {
    id: "c1",
    changeSetId: "cs1",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Baseline",
    proposedValue: "Proposed",
    changeType: "modify",
    validationStatus: "valid",
    validationError: null,
    conflictStatus: "none",
    approvalStatus: "pending",
    approvedValue: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("classifyFieldChange: blank current remote + non-blank proposed is ADD", () => {
  assert.equal(classifyFieldChange("", "Nuevo titulo"), "add");
});

test("classifyFieldChange: differing non-blank values is MODIFY", () => {
  assert.equal(classifyFieldChange("Viejo", "Nuevo"), "modify");
});

test("classifyFieldChange: identical values is UNCHANGED", () => {
  assert.equal(classifyFieldChange("Igual", "Igual"), "unchanged");
});

test("computeConflictStatus: baseline equal to current remote is NONE", () => {
  assert.equal(computeConflictStatus("Cuban Jazz", "Cuban Jazz"), "none");
});

test("computeConflictStatus: baseline differs from current remote is CONFLICT", () => {
  assert.equal(computeConflictStatus("Cuban Jazz", "Changed In Studio"), "conflict");
});

test("isValidLanguageCode accepts simple and region-tagged codes, rejects garbage", () => {
  assert.equal(isValidLanguageCode("es"), true);
  assert.equal(isValidLanguageCode("pt-BR"), true);
  assert.equal(isValidLanguageCode("zh-Hans"), true);
  assert.equal(isValidLanguageCode(""), false);
  assert.equal(isValidLanguageCode("   "), false);
  assert.equal(isValidLanguageCode("!!"), false);
});

test("computeChangeSetStatus: empty change list is in_review", () => {
  assert.equal(computeChangeSetStatus([]), "in_review");
});

test("computeChangeSetStatus: all pending is in_review", () => {
  const changes = [makeChange({ approvalStatus: "pending" }), makeChange({ id: "c2", approvalStatus: "pending" })];
  assert.equal(computeChangeSetStatus(changes), "in_review");
});

test("computeChangeSetStatus: all actionable changes approved is approved", () => {
  const changes = [makeChange({ approvalStatus: "approved" }), makeChange({ id: "c2", approvalStatus: "approved" })];
  assert.equal(computeChangeSetStatus(changes), "approved");
});

test("computeChangeSetStatus: mix of approved and rejected is partially_approved", () => {
  const changes = [makeChange({ approvalStatus: "approved" }), makeChange({ id: "c2", approvalStatus: "rejected" })];
  assert.equal(computeChangeSetStatus(changes), "partially_approved");
});

test("computeChangeSetStatus: all actionable rejected is rejected", () => {
  const changes = [makeChange({ approvalStatus: "rejected" }), makeChange({ id: "c2", approvalStatus: "rejected" })];
  assert.equal(computeChangeSetStatus(changes), "rejected");
});

test("computeChangeSetStatus: an invalid or conflicting change keeps the set in_review even if everything else is approved", () => {
  const changes = [
    makeChange({ approvalStatus: "approved" }),
    makeChange({ id: "c2", validationStatus: "invalid" }),
  ];
  assert.equal(computeChangeSetStatus(changes), "in_review");

  const conflicted = [
    makeChange({ approvalStatus: "approved" }),
    makeChange({ id: "c3", conflictStatus: "conflict" }),
  ];
  assert.equal(computeChangeSetStatus(conflicted), "in_review");
});

test("revalidateChangeAgainstCurrentRemote: no-op when current remote still matches baseline", () => {
  const change = makeChange({ conflictStatus: "none" });
  const result = revalidateChangeAgainstCurrentRemote(change, "Baseline");
  assert.equal(result, change); // same reference: nothing changed
});

test("revalidateChangeAgainstCurrentRemote: flags a new conflict when remote drifted from baseline", () => {
  const change = makeChange({ conflictStatus: "none", approvalStatus: "pending" });
  const result = revalidateChangeAgainstCurrentRemote(change, "Changed In Studio");
  assert.equal(result.conflictStatus, "conflict");
});

test("revalidateChangeAgainstCurrentRemote: invalidates a prior approval when the remote value changed after approval", () => {
  const approved = makeChange({
    conflictStatus: "none",
    approvalStatus: "approved",
    approvedValue: "Proposed",
  });
  const result = revalidateChangeAgainstCurrentRemote(approved, "Changed In Studio");
  assert.equal(result.conflictStatus, "conflict");
  assert.equal(result.approvalStatus, "pending");
  assert.equal(result.approvedValue, null);
});

test("revalidateChangeAgainstCurrentRemote: treats a video missing from synced data as a conflict", () => {
  const change = makeChange({ conflictStatus: "none" });
  const result = revalidateChangeAgainstCurrentRemote(change, null);
  assert.equal(result.conflictStatus, "conflict");
});

test("revalidateChangeAgainstCurrentRemote: does not disturb an already-rejected change's approvalStatus", () => {
  const rejected = makeChange({ conflictStatus: "none", approvalStatus: "rejected", approvedValue: null });
  const result = revalidateChangeAgainstCurrentRemote(rejected, "Changed In Studio");
  assert.equal(result.conflictStatus, "conflict");
  assert.equal(result.approvalStatus, "rejected");
});

// (independent review, second cycle): previously duplicated (and each copy missing this
// defaultLanguage special-case) across changesets/import.ts, changesets/services.ts, and
// ai-localization/services.ts -- a change targeting a video's default language was diffed
// against an empty string instead of its real current value in all three.
test("currentRemoteValueFor reads snippet title/description for the video's own defaultLanguage, not existingLocalizations", () => {
  const video = makeVideo();
  assert.equal(currentRemoteValueFor(video, "en", "title"), "EN Title");
  assert.equal(currentRemoteValueFor(video, "en", "description"), "EN Description");
});

test("currentRemoteValueFor reads existingLocalizations for a non-default language", () => {
  const video = makeVideo();
  assert.equal(currentRemoteValueFor(video, "es", "title"), "Titulo ES");
});

test("currentRemoteValueFor returns empty string for a non-default language with no existing localization", () => {
  const video = makeVideo();
  assert.equal(currentRemoteValueFor(video, "de", "title"), "");
});

test("currentRemoteValueFor falls back to existingLocalizations when defaultLanguage is null", () => {
  const video = makeVideo({ defaultLanguage: null, existingLocalizations: { en: { title: "Not the primary", description: "" } } });
  assert.equal(currentRemoteValueFor(video, "en", "title"), "Not the primary");
});
