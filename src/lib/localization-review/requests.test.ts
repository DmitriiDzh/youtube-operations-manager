import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { DraftTranslationRequest } from "@/lib/sync-gateway";
import { createRequestInputSchema, parseOrRefuse, toRequestView } from "./requests";

// BL-227 stage 2 (LANGUAGES_REVIEW_PLAN.md §7a, AC-LR-23/26). Expected by hand from FO-MSG-0025 §1: overdue after 3 h unclaimed, or 3 h
// after the claim without a result; a finished request is never overdue.

const base = (over: Partial<DraftTranslationRequest>): DraftTranslationRequest => ({
  id: "q-1",
  videoIdsJson: '["v1"]',
  languagesJson: '["it"]',
  mode: "fill_missing",
  fields: "both",
  note: null,
  redoOfChangeId: null,
  originalsJson: "{}",
  status: "requested",
  claimedBy: null,
  claimedAt: null,
  resultJson: "[]",
  failReason: null,
  createdAt: "2026-10-26T10:00:00.000Z",
  updatedAt: "2026-10-26T10:00:00.000Z",
  ...over,
});
const at = (iso: string) => Date.parse(iso);

test("AC-LR-23: unclaimed for 3 h + 1 min is overdue; claimed 1 h ago is not; claimed 3 h + 1 min ago is; done never is", () => {
  assert.equal(toRequestView(base({}), at("2026-10-26T13:01:00.000Z")).overdue, true);
  assert.equal(toRequestView(base({}), at("2026-10-26T12:59:00.000Z")).overdue, false);
  const claimed = base({ status: "in_progress", claimedBy: "worker", claimedAt: "2026-10-26T12:00:00.000Z" });
  assert.equal(toRequestView(claimed, at("2026-10-26T13:00:00.000Z")).overdue, false);
  assert.equal(toRequestView(claimed, at("2026-10-26T15:01:00.000Z")).overdue, true);
  assert.equal(toRequestView(base({ status: "done" }), at("2026-10-27T10:00:00.000Z")).overdue, false);
});

test("AC-LR-26: a redo request keeps its change id, mode and language; defaults are fill_missing and both fields", () => {
  const redo = parseOrRefuse(createRequestInputSchema, { videoIds: ["v1"], languages: ["it"], mode: "redo", fields: "title", note: "shorter", redoOfChangeId: "c-9" }, "request");
  assert.deepEqual([redo.mode, redo.fields, redo.redoOfChangeId, redo.languages], ["redo", "title", "c-9", ["it"]]);
  const plain = parseOrRefuse(createRequestInputSchema, { videoIds: ["v1"], languages: ["de"] }, "request");
  assert.deepEqual([plain.mode, plain.fields], ["fill_missing", "both"]);
  assert.throws(() => parseOrRefuse(createRequestInputSchema, { videoIds: [], languages: ["de"] }, "request"), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
});
