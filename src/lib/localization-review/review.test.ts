import assert from "node:assert/strict";
import test from "node:test";
import { buildVideoReview, needsReview, type ReviewChange, type ReviewSetInput, type ReviewVideoInput } from "./review";

// BL-227 (LANGUAGES_REVIEW_PLAN.md AC-LR-09/10, mockup approved in owner msg 3581). Expected values by hand: one row per language with
// title and description together, merged across sets; a language's verdict is the worst of the app's checks, the report and the
// title rule; "unchecked" when no report covers it; the original-changed flag from the fingerprint kept with the set.

const change = (id: string, language: string, field: "title" | "description", value: string, over: Partial<ReviewChange> = {}): ReviewChange => ({
  id,
  videoId: "v1",
  language,
  field,
  baselineValue: "",
  proposedValue: value,
  changeType: "add",
  validationStatus: "valid",
  validationError: null,
  conflictStatus: "none",
  approvalStatus: "pending",
  ...over,
});

const set = (id: string, createdAt: string, changes: ReviewChange[], over: Partial<ReviewSetInput> = {}): ReviewSetInput => ({
  changeSet: { id, source: "ai_localization", createdAt },
  changes,
  details: { createdBy: "agent", notes: {}, originals: { v1: "fp-A" } },
  report: null,
  ...over,
});

const input = (sets: ReviewSetInput[], over: Partial<ReviewVideoInput> = {}): ReviewVideoInput => ({
  video: { videoId: "v1", title: "A Mushroom Hut | 3 Hours", description: "Painting.\n00:00 Dawn", defaultLanguage: "en", thumbnailUrl: null, publishedAt: null, privacyStatus: "private" },
  ownLanguage: "en",
  trackedLanguages: ["de", "it", "ja"],
  currentTitle: () => "",
  currentFingerprint: "fp-A",
  sets,
  writtenChangeIds: new Set(),
  upload: null,
  ...over,
});

test("AC-LR-10: a language's title from set B and description from set A show as one row", () => {
  const review = buildVideoReview(
    input([
      set("A", "2026-10-26T11:31:00Z", [change("a-it-d", "it", "description", "Dipingo.\n00:00 Alba"), change("a-it-t", "it", "title", "x".repeat(116), { approvalStatus: "rejected", validationStatus: "invalid" })]),
      set("B", "2026-10-26T11:32:00Z", [change("b-it-t", "it", "title", "Una capanna | 3 ore")]),
    ])
  );
  assert.equal(review.languages.length, 1);
  const it = review.languages[0];
  assert.deepEqual([it.title?.changeId, it.title?.changeSetId, it.description?.changeId], ["b-it-t", "B", "a-it-d"]);
  assert.equal(it.untitled, false);
});

test("BL-226 on the review: a description whose title is rejected everywhere, with no title on the video, is a fail", () => {
  const review = buildVideoReview(
    input([set("A", "2026-10-26T11:31:00Z", [change("d", "it", "description", "Dipingo.\n00:00 Alba"), change("t", "it", "title", "x".repeat(116), { approvalStatus: "rejected", validationStatus: "invalid" })])])
  );
  assert.equal(review.languages[0].untitled, true);
  assert.equal(review.languages[0].verdict, "fail");
  // With an Italian title on the video already, the description alone is fine.
  const withTitle = buildVideoReview(
    input([set("A", "2026-10-26T11:31:00Z", [change("d", "it", "description", "Dipingo.\n00:00 Alba")])], { currentTitle: (language) => (language === "it" ? "Titolo" : "") })
  );
  assert.equal(withTitle.languages[0].untitled, false);
});

test("the verdict is the worst of the app's checks and the report; unchecked until a report covers the language", () => {
  const changes = [change("t", "de", "title", "Eine Pilzhütte | 3 Stunden"), change("d", "de", "description", "Ich male.\n00:00 Morgen")];
  const unchecked = buildVideoReview(input([set("A", "2026-10-26T11:31:00Z", changes)]));
  assert.deepEqual([unchecked.languages[0].verdict, unchecked.languages[0].unchecked], ["pass", true]);

  const report = { id: "r-1", reportedAt: "2026-10-26T11:40:00Z", reportedBy: "worker", entries: [{ language: "de", field: "title" as const, verdict: "warn" as const, checks: [{ id: "tone", result: "warn" as const, detail: "literal" }], note: "check tone", backTranslation: "A mushroom hut" }] };
  const reported = buildVideoReview(input([set("A", "2026-10-26T11:31:00Z", changes, { report })]));
  const de = reported.languages[0];
  assert.deepEqual([de.verdict, de.unchecked], ["warn", false]);
  assert.deepEqual([de.title?.report?.note, de.title?.report?.backTranslation, de.title?.report?.reportId], ["check tone", "A mushroom hut", "r-1"]);
  assert.equal(de.description?.report, null);

  // The app's own fail (a ja title in Latin letters) wins over a report's pass.
  const ja = buildVideoReview(
    input([set("A", "2026-10-26T11:31:00Z", [change("j", "ja", "title", "Mushroom hut | 3 Hours")], { report: { ...report, entries: [{ ...report.entries[0], language: "ja", verdict: "pass" }] } })])
  );
  assert.equal(ja.languages[0].verdict, "fail");
});

test("AC-LR-09 (read half): original changed after the set when its fingerprint differs; unknown (null) for a set without one", () => {
  const changes = [change("t", "de", "title", "Titel")];
  assert.equal(buildVideoReview(input([set("A", "2026-10-26T11:31:00Z", changes)])).languages[0].title?.originalChanged, false);
  assert.equal(buildVideoReview(input([set("A", "2026-10-26T11:31:00Z", changes)], { currentFingerprint: "fp-B" })).languages[0].title?.originalChanged, true);
  assert.equal(buildVideoReview(input([set("A", "2026-10-26T11:31:00Z", changes, { details: null })], { currentFingerprint: "fp-B" })).languages[0].title?.originalChanged, null);
});

test("AC-LR-12 (read half) and counts: the agent's note and author show; written changes leave the queue", () => {
  const changes = [change("t", "de", "title", "Titel", { approvalStatus: "approved" }), change("d", "de", "description", "Text")];
  const review = buildVideoReview(input([set("A", "2026-10-26T11:31:00Z", changes, { details: { createdBy: "agent", notes: { t: "shortened" }, originals: {} } })]));
  assert.deepEqual([review.languages[0].title?.note, review.languages[0].title?.createdBy, review.languages[0].description?.note], ["shortened", "agent", null]);
  assert.deepEqual([review.counts.pending, review.counts.approvedNotWritten], [1, 1]);
  assert.equal(needsReview(review), true);
  const written = buildVideoReview(input([set("A", "2026-10-26T11:31:00Z", changes)], { writtenChangeIds: new Set(["t", "d"]) }));
  assert.equal(needsReview(written), false);
});

test("review finding 1: a proposed deletion of a language is not a fail -- its empty text is not checked and it is not 'untitled'", () => {
  const review = buildVideoReview(
    input([set("D", "2026-10-26T11:31:00Z", [change("t", "it", "title", "", { changeType: "delete" }), change("d", "it", "description", "", { changeType: "delete" })])])
  );
  const it = review.languages[0];
  assert.deepEqual([it.verdict, it.untitled, it.title?.checks, it.title?.changeType], ["pass", false, [], "delete"]);
});
