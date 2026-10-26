// BL-227 (docs/roadmap/plans/LANGUAGES_REVIEW_PLAN.md §2/§6, ADR 0052): the review read model -- every change set's changes of one
// video merged into one row per language, with the app's own checks, the newest agent report, the agent's note, who made the set and
// whether the original changed since. Pure: the composition (`index.ts`) reads the stores. Nothing here approves, rejects or sends.

import { checkLocalizedField, type LocalizationCheck, type LocalizationCheckResult } from "@/lib/shared-localization-checks";
import { untitledTranslations } from "@/lib/shared-localization-merge";

export type ReviewVerdict = "pass" | "warn" | "fail";

export type ReviewChange = {
  id: string;
  videoId: string;
  language: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
  changeType: string;
  validationStatus: "valid" | "invalid";
  validationError: string | null;
  conflictStatus: "none" | "conflict";
  approvalStatus: "pending" | "approved" | "rejected";
};

export type ReviewReportEntry = {
  language: string;
  field: "title" | "description";
  verdict: ReviewVerdict;
  checks: Array<{ id: string; result: ReviewVerdict; detail: string }>;
  note: string | null;
  backTranslation: string | null;
};

export type ReviewSetInput = {
  changeSet: { id: string; source: string; createdAt: string };
  changes: ReviewChange[];
  details: { createdBy: string; notes: Record<string, string>; originals: Record<string, string> } | null;
  report: { id: string; reportedAt: string; reportedBy: string; entries: ReviewReportEntry[] } | null;
};

export type ReviewVideoInput = {
  video: { videoId: string; title: string; description: string; defaultLanguage: string | null; thumbnailUrl: string | null; publishedAt: string | null; privacyStatus: string | null };
  /** The video's own language for this review (the channel baseline when the video is read aligned or has none). */
  ownLanguage: string | null;
  trackedLanguages: readonly string[];
  /** The title the video has now in a language (synced copy, read against the baseline); "" when none. */
  currentTitle(language: string): string;
  /** The fingerprint of the video's original now (synced copy). */
  currentFingerprint: string;
  sets: ReviewSetInput[];
  writtenChangeIds: ReadonlySet<string>;
  upload: { video: string | null; slotId: string | null; publishAt: string | null } | null;
};

export type ReviewRow = {
  changeId: string;
  changeSetId: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
  approvalStatus: ReviewChange["approvalStatus"];
  validationStatus: ReviewChange["validationStatus"];
  validationError: string | null;
  conflictStatus: ReviewChange["conflictStatus"];
  written: boolean;
  checks: LocalizationCheck[];
  report: (Omit<ReviewReportEntry, "language" | "field"> & { reportId: string; reportedAt: string; reportedBy: string }) | null;
  note: string | null;
  createdBy: string | null;
  setCreatedAt: string;
  /** null when the set was made before fingerprints were kept. */
  originalChanged: boolean | null;
};

export type ReviewLanguage = {
  language: string;
  title: ReviewRow | null;
  description: ReviewRow | null;
  /** The worst of the app's checks, the report's verdicts and the title rule. */
  verdict: ReviewVerdict;
  /** No agent report covers this language's rows. */
  unchecked: boolean;
  /** BL-226: the description would go without a title. */
  untitled: boolean;
};

export type VideoReview = {
  video: ReviewVideoInput["video"] & { ownLanguage: string | null };
  upload: ReviewVideoInput["upload"];
  languages: ReviewLanguage[];
  counts: { pass: number; warn: number; fail: number; unchecked: number; pending: number; approvedNotWritten: number };
};

const RANK: Record<LocalizationCheckResult, number> = { pass: 0, warn: 1, fail: 2 };
const worst = (a: ReviewVerdict, b: ReviewVerdict): ReviewVerdict => (RANK[b] > RANK[a] ? b : a);

function rowVerdict(row: ReviewRow): ReviewVerdict {
  let verdict: ReviewVerdict = row.validationStatus === "invalid" ? "fail" : "pass";
  for (const check of row.checks) verdict = worst(verdict, check.result);
  if (row.report) verdict = worst(verdict, row.report.verdict);
  return verdict;
}

/** Which change of one (language, field) to show when several sets have one: the newest set's change that is not rejected, else the newest. */
function pick(candidates: Array<{ change: ReviewChange; set: ReviewSetInput }>): { change: ReviewChange; set: ReviewSetInput } | null {
  const sorted = [...candidates].sort((a, b) => (a.set.changeSet.createdAt < b.set.changeSet.createdAt ? 1 : a.set.changeSet.createdAt > b.set.changeSet.createdAt ? -1 : 0));
  return sorted.find((entry) => entry.change.approvalStatus !== "rejected") ?? sorted[0] ?? null;
}

export function buildVideoReview(input: ReviewVideoInput): VideoReview {
  const byTarget = new Map<string, Array<{ change: ReviewChange; set: ReviewSetInput }>>();
  for (const set of input.sets) {
    for (const change of set.changes) {
      if (change.videoId !== input.video.videoId) continue;
      const key = `${change.language.toLowerCase()}\u0000${change.field}`;
      byTarget.set(key, [...(byTarget.get(key) ?? []), { change, set }]);
    }
  }

  const toRow = (entry: { change: ReviewChange; set: ReviewSetInput } | null): ReviewRow | null => {
    if (!entry) return null;
    const { change, set } = entry;
    const reportEntry = set.report?.entries.find((candidate) => candidate.field === change.field && candidate.language.toLowerCase() === change.language.toLowerCase()) ?? null;
    const recorded = set.details?.originals[input.video.videoId];
    return {
      changeId: change.id,
      changeSetId: set.changeSet.id,
      field: change.field,
      baselineValue: change.baselineValue,
      proposedValue: change.proposedValue,
      approvalStatus: change.approvalStatus,
      validationStatus: change.validationStatus,
      validationError: change.validationError,
      conflictStatus: change.conflictStatus,
      written: input.writtenChangeIds.has(change.id),
      checks: checkLocalizedField({
        language: change.language,
        field: change.field,
        value: change.proposedValue,
        original: change.field === "title" ? input.video.title : input.video.description,
        ownLanguage: input.ownLanguage,
        trackedLanguages: input.trackedLanguages,
      }),
      report: reportEntry && set.report
        ? { verdict: reportEntry.verdict, checks: reportEntry.checks, note: reportEntry.note, backTranslation: reportEntry.backTranslation, reportId: set.report.id, reportedAt: set.report.reportedAt, reportedBy: set.report.reportedBy }
        : null,
      note: set.details?.notes[change.id] ?? null,
      createdBy: set.details?.createdBy ?? null,
      setCreatedAt: set.changeSet.createdAt,
      originalChanged: recorded === undefined ? null : recorded !== input.currentFingerprint,
    };
  };

  const languageKeys = new Map<string, string>();
  for (const candidates of byTarget.values()) {
    const language = candidates[0].change.language;
    if (!languageKeys.has(language.toLowerCase())) languageKeys.set(language.toLowerCase(), language);
  }

  // BL-226's rule over what this review would send: rows not rejected, valid, without a conflict, not written yet.
  const onTheirWay: Array<{ language: string; field: "title" | "description"; proposedValue: string; changeType?: "add" | "modify" | "unchanged" | "delete" }> = [];
  const rows = new Map<string, { title: ReviewRow | null; description: ReviewRow | null }>();
  for (const [key, language] of languageKeys) {
    const title = toRow(pick(byTarget.get(`${key}\u0000title`) ?? []));
    const description = toRow(pick(byTarget.get(`${key}\u0000description`) ?? []));
    rows.set(key, { title, description });
    for (const row of [title, description]) {
      if (row && row.approvalStatus !== "rejected" && row.validationStatus === "valid" && row.conflictStatus === "none" && !row.written) {
        onTheirWay.push({ language, field: row.field, proposedValue: row.proposedValue });
      }
    }
  }
  const untitled = new Set(
    untitledTranslations({ isOwnLanguage: (language) => input.ownLanguage !== null && language.toLowerCase() === input.ownLanguage.toLowerCase(), title: input.currentTitle }, onTheirWay).map((language) => language.toLowerCase())
  );

  const languages: ReviewLanguage[] = [...languageKeys].map(([key, language]) => {
    const { title, description } = rows.get(key)!;
    const present = [title, description].filter((row): row is ReviewRow => row !== null);
    let verdict: ReviewVerdict = "pass";
    for (const row of present) verdict = worst(verdict, rowVerdict(row));
    const isUntitled = untitled.has(key);
    if (isUntitled) verdict = "fail";
    return { language, title, description, verdict, unchecked: present.every((row) => row.report === null), untitled: isUntitled };
  });
  languages.sort((a, b) => a.language.localeCompare(b.language));

  const counts = { pass: 0, warn: 0, fail: 0, unchecked: 0, pending: 0, approvedNotWritten: 0 };
  for (const language of languages) {
    counts[language.verdict] += 1;
    if (language.unchecked) counts.unchecked += 1;
    for (const row of [language.title, language.description]) {
      if (!row || row.written) continue;
      if (row.approvalStatus === "pending") counts.pending += 1;
      if (row.approvalStatus === "approved") counts.approvedNotWritten += 1;
    }
  }

  return { video: { ...input.video, ownLanguage: input.ownLanguage }, upload: input.upload, languages, counts };
}

/** Whether a video belongs in the review queue: a change of it that is not rejected and not written yet. */
export function needsReview(review: Pick<VideoReview, "counts">): boolean {
  return review.counts.pending > 0 || review.counts.approvedNotWritten > 0;
}
