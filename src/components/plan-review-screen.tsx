"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  entryWaits,
  historyEntryOfVerdict,
  mediaKindOf,
  pickTargetOf,
  forbidsPick,
  RECHECK_STAGE_ID,
  RECHECKS_WAVE,
  recheckEntry,
  validatorOfEntry,
  type PlanCheck,
  type PlanExistingVerdict,
  type PlanMarker,
  type PlanMarkerRegion,
  type PlanMediaKind,
  type PlanNoneFitsView,
  type PlanRecheck,
  type PlanRecheckEntry,
  type PlanReference,
  type PlanResultRow,
  type PlanReviewBatch,
  type PlanReviewClaim,
  type PlanReviewEntry,
} from "@/lib/generation-plans/contracts";
import { withSentPicks, type SentPickAction } from "@/lib/generation-plans/picks";
import type { SharedRecheck } from "@/lib/sync-gateway";
import { useAppChannel } from "./app-channel";
import { integratedLoudness, LOUDNESS_TARGET_LUFS, matchedVolume } from "./loudness";
import { MediaReviewPlayer, formatPlayerTime, type FrequencyMark, type ReviewMarker, type ReviewPlayerHandle } from "./media-review-player";
import { ToggleSwitch } from "./toggle-switch";
import { BlockingDialog } from "./blocking-dialog";
import { BusyOverlay, SkeletonLines, useBusyAction } from "./busy-feedback";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { Popover } from "./popover";
import { formatDisplayDate, formatDisplayDateTime } from "@/lib/shared-formatting";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import { useUiText } from "./ui-text-provider";
import { MediaImageViewer, type ImageViewerHandle, type ViewerPin } from "./media-image-viewer";
import { MediaVideoPlayer, type VideoMarker, type VideoPlayerHandle } from "./media-video-player";
import { VisualReviewLayer, type LayerEntry, type LayerHandle, type LayerMode } from "./visual-review-layer";
import { useDialogFocus } from "./use-dialog-focus";
import { attemptLabel, fpsFromMetrics, isVisual, loopFromMetrics, questionStart, sharedEntryMedia, totalFromContentRange, VISUAL_REASON_KEYS, visualKeyAction } from "./visual-review-model";
import { FeedPreview, SeamFrames } from "./visual-review-tools";
import { answersToSend, formSectionsFor, genreOf, genreTintStyle, missingRequired, NO_REVIEW_FORMS, reasonRowsFor, reviewFormsOfShared, tintOver, toggleAnswer, type ReviewFormsView } from "./genre-review-model";
import type { PlanAnswers, PlanGenre, PlanReviewField } from "@/lib/generation-plans/contracts";
import type { ReasonChips } from "./visual-review-model";

// BL-143 (MEDIA_REVIEW_TOOLS.md §2 group A + the owner's additions, msg 1939): the owner's listening review of a plan --
// a queue of attempts waiting for a verdict, the player with the waveform and the validator's time findings, keyboard
// shortcuts, Accept / Reject with reasons, a rating out of 10, time marks and a comment; blind mode hides the validator until
// the verdict. "Ask for a re-run" only records the request for the Factory Operator -- nothing is started here.

/**
 * The reasons from R-0001 (FO-MSG-0008 §6), the owner's starting list (msg 1933). These exact English values are what a
 * verdict records (the Factory Operator reads them); the buttons show them in the interface language (REVIEW_REASON_KEYS).
 */
// ui-text-ignore: verdict values sent to the API; shown through REVIEW_REASON_KEYS
export const REVIEW_REASONS = [
  "thin / sparse",
  "dropout / pause",
  "abrupt start",
  "dead tail / abrupt end",
  "ringing / whine",
  "wrong instrument",
  "stuck loop",
  "sounds like the others",
  "not melodic / boring",
  "unwanted beat / drums",
] as const;

const REVIEW_REASON_KEYS: Record<(typeof REVIEW_REASONS)[number], UiTextKey> = {
  "thin / sparse": "review.reason.thin",
  "dropout / pause": "review.reason.dropout",
  "abrupt start": "review.reason.abruptStart",
  "dead tail / abrupt end": "review.reason.deadTail",
  "ringing / whine": "review.reason.ringing",
  "wrong instrument": "review.reason.wrongInstrument",
  "stuck loop": "review.reason.stuckLoop",
  "sounds like the others": "review.reason.soundsLikeOthers",
  "not melodic / boring": "review.reason.notMelodic",
  "unwanted beat / drums": "review.reason.unwantedBeat",
};

/** BL-162 (owner, Telegram 2026-10-09 msg 2254 p.3): an icon per reason, so the buttons read at a glance. */
// ui-text-ignore: pictograms, not text
const REVIEW_REASON_ICONS: Record<(typeof REVIEW_REASONS)[number], string> = {
  "thin / sparse": "🕳️",
  "dropout / pause": "⏸️",
  "abrupt start": "⚡",
  "dead tail / abrupt end": "✂️",
  "ringing / whine": "🔔",
  "wrong instrument": "🎻",
  "stuck loop": "🔁",
  "sounds like the others": "👥",
  "not melodic / boring": "😴",
  "unwanted beat / drums": "🥁",
};

/** BL-175: a recorded reason in the interface language -- a music or picture default by its key, any other (a plan's own chip) as written. */
export function reasonLabel(t: Translate, reason: string): string {
  if (Object.hasOwn(REVIEW_REASON_KEYS, reason)) return t(REVIEW_REASON_KEYS[reason as (typeof REVIEW_REASONS)[number]]);
  if (Object.hasOwn(VISUAL_REASON_KEYS, reason)) return t(VISUAL_REASON_KEYS[reason as keyof typeof VISUAL_REASON_KEYS]);
  return reason;
}

/** A verdict / result in words (accepted, rejected); any other value shows as it is. */
export function resultLabel(t: Translate, result: unknown): string {
  if (result === "accepted") return t("plans.result.accepted");
  if (result === "rejected") return t("plans.result.rejected");
  if (result === "done") return t("plans.result.done");
  if (result === "failed") return t("plans.result.failed");
  return String(result);
}

/** What `peerQueue` writes as the note of a verdict sent from here and not yet applied there; shown translated. */
// ui-text-ignore: a marker in the verdict data, shown through review.sentWaitingFor
const SENT_NOTE_PREFIX = "sent, waiting for ";

export type ReviewKeyAction = "play" | "back" | "forward" | "accept" | "reject" | "keep" | "next" | "previous" | "mark" | "ab" | { rating: number };

/** The keyboard map (Space, ←/→, A, R, K, N, P, M, 1-9 and 0 for 10). Exported for its test. */
export function reviewKeyAction(key: string): ReviewKeyAction | null {
  switch (key) {
    case " ":
      return "play";
    case "ArrowLeft":
      return "back";
    case "ArrowRight":
      return "forward";
    case "a":
    case "A":
      return "accept";
    case "r":
    case "R":
      return "reject";
    // BL-173: keep the verdict -- the answer to a re-check's question.
    case "k":
    case "K":
      return "keep";
    case "n":
    case "N":
      return "next";
    case "p":
    case "P":
      return "previous";
    case "m":
    case "M":
      return "mark";
    case "b":
    case "B":
      return "ab";
    default:
      if (/^[0-9]$/.test(key)) return { rating: key === "0" ? 10 : Number(key) };
      return null;
  }
}

/** The next attempt still waiting after `from` (wrapping), else -1; `skip` (BL-157: claimed elsewhere) passes over one. Exported for its test. */
export function nextWaitingIndex<T extends { verdict: unknown }>(entries: T[], from: number, skip: (entry: T) => boolean = () => false): number {
  for (let step = 1; step <= entries.length; step++) {
    const i = (from + step) % entries.length;
    if (entryWaits(entries[i]) && !skip(entries[i])) return i;
  }
  return -1;
}

/** BL-157 (AC-TC-02): one step of the arrows/keys from `from` in `direction`, wrapping, passing over skipped entries; `from` when all are. Exported for its test. */
export function stepIndex<T>(entries: T[], from: number, direction: 1 | -1, skip: (entry: T) => boolean): number {
  const n = entries.length;
  for (let step = 1; step < n; step++) {
    const i = (((from + direction * step) % n) + n) % n;
    if (!skip(entries[i])) return i;
  }
  return from;
}

/** BL-157 (AC-TC-02, AC-WV-06): another device's live claim on this entry -- on the track itself or on its whole wave. Exported for its test. */
export function claimOf(entry: Pick<PlanReviewEntry, "itemKey" | "attemptRef" | "groupId">, claims: readonly PlanReviewClaim[], nowMs: number): PlanReviewClaim | null {
  return (
    claims.find(
      (c) => Date.parse(c.until) > nowMs && ((c.scope === "attempt" && c.itemKey === entry.itemKey && c.attemptRef === entry.attemptRef) || (c.scope === "group" && c.groupId !== null && c.groupId === entry.groupId))
    ) ?? null
  );
}

/** The loudness a validator's metrics give (`lufs`, `LUFS` or `integrated_lufs`), or null. */
function metricsLufs(metrics: Record<string, unknown>): number | null {
  const value = metrics.lufs ?? metrics.LUFS ?? metrics.integrated_lufs;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** AC-GP3-04: the loudness the validator measured for this attempt (the latest stage's `metrics.lufs`), or null. Exported for its test. */
export function reportedLufs(entry: Pick<PlanReviewEntry, "stages">): number | null {
  for (const stage of [...entry.stages].reverse()) {
    const value = metricsLufs(stage.metrics);
    if (value !== null) return value;
  }
  return null;
}

/**
 * BL-173 (PLAN_RECHECKS_PLAN.md §2.8): the loudness of what the entry plays -- a revision's own metrics (never the original's:
 * null makes the screen measure the fixed file), else what the validator said about the attempt. Exported for its test.
 */
export function playedLufs(entry: Pick<PlanReviewEntry, "stages" | "currentFile"> & { recheck?: Pick<PlanRecheck, "kind" | "metrics"> }): number | null {
  if (entry.recheck?.kind === "revision") return metricsLufs(entry.recheck.metrics);
  // Review round 1: a question on an attempt that plays an accepted revision -- that revision's loudness, or measured.
  const last = entry.stages.at(-1);
  if (last?.stageId === RECHECK_STAGE_ID) return metricsLufs(last.metrics);
  // A track of the queue that plays an accepted revision: measured, never the original's.
  if (entry.currentFile) return null;
  return reportedLufs(entry);
}

/**
 * BL-173: the loudness of what a revision is compared with ("Before") -- an earlier accepted revision's (`beforeRow`) when the
 * attempt plays one, else the attempt's own rows without the revision's. Exported for its test.
 */
export function beforeLufs(entry: Pick<PlanReviewEntry, "stages"> & { beforeRow?: Pick<PlanResultRow, "metrics"> }): number | null {
  if (entry.beforeRow) return metricsLufs(entry.beforeRow.metrics);
  return reportedLufs({ stages: entry.stages.filter((s) => s.stageId !== RECHECK_STAGE_ID) });
}

/** BL-173: the picker's re-checks line -- shown while any re-check is listed (or chosen), with the ones still open here. Exported for its test. */
export function recheckPickerOption(rechecks: ReadonlyArray<{ verdict: unknown }>, wave: string | null): { shown: boolean; open: number } {
  return { shown: rechecks.length > 0 || wave === RECHECKS_WAVE, open: rechecks.filter(entryWaits).length };
}

/** BL-173: one line of a track's verdict history -- a kept answer reads as a note, and an answer to a re-check names it. Exported for its test. */
export function historyLineOf(t: Translate, h: { result: string; rating: number | null; note: string | null; device: string; at: string; recheckId?: string; kept?: boolean }): { text: string; recheck: string | null } {
  const text = h.kept
    ? `${h.device} · ${formatDisplayDateTime(h.at)} · ${t("review.history.kept")}${h.note ? ` · ${h.note}` : ""}`
    : t("review.historyLine", { device: h.device, time: formatDisplayDateTime(h.at), result: resultLabel(t, h.result), rating: h.rating !== null ? ` ${h.rating}/10` : "", note: h.note ? ` · ${h.note}` : "" });
  return { text, recheck: h.recheckId ? t("review.history.recheck", { id: h.recheckId }) : null };
}

/** BL-173: a re-check's spots (the factory's markers) as waveform ranges of their own tone, labelled with their note. Exported for its test. */
export function recheckMarkers(recheck: Pick<PlanRecheck, "markers"> | undefined, fallbackLabel: string): ReviewMarker[] {
  return (recheck?.markers ?? []).map((m) => ({ start: m.start, end: m.end, label: m.note ?? fallbackLabel, tone: "question" as const }));
}

/**
 * FO-MSG-0009 §4: the frequencies the validator flagged -- steady artefact tones (a ringing check's `detail`, e.g.
 * "tones 2751, 8500 Hz") and a held note (`metrics.held_hz`) -- for the spectrogram. Exported for its test.
 */
export function frequencyMarksOf(t: Translate, entry: Pick<PlanReviewEntry, "stages">): FrequencyMark[] {
  const marks: FrequencyMark[] = [];
  for (const stage of entry.stages) {
    for (const check of stage.checks) {
      // A failed ringing check (ring_db, ringing...): only the numbers of its "... Hz" / "... kHz" list are frequencies.
      if (check.pass || !/(^|_)ring/i.test(check.id) || !check.detail) continue;
      for (const list of check.detail.matchAll(/((?:\d+(?:\.\d+)?\s*,\s*)*\d+(?:\.\d+)?)\s*(k?Hz)\b/gi)) {
        const factor = list[2].toLowerCase() === "khz" ? 1000 : 1;
        for (const n of list[1].split(",")) {
          const hz = Number(n.trim()) * factor;
          if (hz >= 20 && hz <= 24_000) marks.push({ hz, label: t("review.freq.ringing") });
        }
      }
    }
    const held = stage.metrics.held_hz;
    if (typeof held === "number" && held >= 20 && held <= 24_000) marks.push({ hz: held, label: t("review.freq.heldNote") });
  }
  return marks.filter((m, i) => marks.findIndex((x) => x.hz === m.hz && x.label === m.label) === i);
}

/**
 * The references to offer for A/B: this attempt's nearest ones first (`referenceIds` of its rows), then the plan's others.
 * BL-175 phase 2 (§E): of the kind the attempt is -- sound for music, pictures and clips for a picture or a clip.
 */
export function referencesFor(entry: Pick<PlanReviewEntry, "stages">, references: PlanReference[], kind: "audio" | "visual" = "audio"): Array<PlanReference & { nearest: boolean }> {
  const fits = references.filter((r) => isVisual(mediaKindOf(r.file)) === (kind === "visual"));
  const nearestIds = new Set(entry.stages.flatMap((s) => s.referenceIds ?? []));
  const nearest = fits.filter((r) => nearestIds.has(r.id)).map((r) => ({ ...r, nearest: true }));
  return [...nearest, ...fits.filter((r) => !nearestIds.has(r.id)).map((r) => ({ ...r, nearest: false }))];
}

/** The validator findings that have a time, as waveform ranges. Exported for its test. */
export function findingMarkers(entry: Pick<PlanReviewEntry, "stages">): ReviewMarker[] {
  return entry.stages.flatMap((stage) =>
    stage.checks.filter((c): c is PlanCheck & { atSeconds: [number, number] } => c.atSeconds !== null).map((c) => ({ start: c.atSeconds[0], end: c.atSeconds[1], label: c.label ?? c.id, tone: "finding" as const }))
  );
}

/** A refused request with its code and details (BL-157: `plan_verdict_exists` carries what is already there). */
class RequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly details: unknown
  ) {
    super(message);
  }
}

async function postJson(t: Translate, url: string, body: unknown, init: { keepalive?: boolean } = {}): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string; details?: unknown };
  if (!res.ok) throw new RequestError(data.message ?? t("review.requestFailed", { status: String(res.status) }), data.error ?? null, data.details);
  return data;
}

/**
 * BL-157 (AC-TC-01): how often the screen renews its claims and reads the other computers'. BL-162 (owner, msg 2263; §5.4): a
 * heartbeat every 30 s (a claim lives 90 s), and the other computers' claims read every 3 s from their small presence files.
 */
const CLAIM_HEARTBEAT_MS = 30_000;
const CLAIMS_REFRESH_MS = 3_000;
/** BL-162 (§5.4): how long after opening a track the "the other computer opened it first" move may still happen. */
const AUTO_MOVE_WINDOW_MS = 20_000;

/** BL-175 (§2.4): `pending` = a mark on a picture or clip waiting for its own note (typed when it is set). */
/** BL-229 part B: `answers` = the owner's answers to the review form (absent = none yet). */
type Draft = { reasons: string[]; rating: number | null; note: string; marks: PlanMarker[]; openMark: number | null; pending: PlanMarker | null; answers?: PlanAnswers };
const emptyDraft = (): Draft => ({ reasons: [], rating: null, note: "", marks: [], openMark: null, pending: null });
/** Nothing typed, chosen or marked yet. */
export const draftIsEmpty = (d: Draft) => d.reasons.length === 0 && d.rating === null && !d.note.trim() && d.marks.length === 0 && d.openMark === null && d.pending === null && Object.keys(d.answers ?? {}).length === 0;
/** BL-175 (review round 1): the mark waiting for its note as a verdict sends it -- with its note; "needs_note" while it has none. Exported for its test. */
export function pendingMarkOf(d: Pick<Draft, "pending">): PlanMarker | null | "needs_note" {
  if (!d.pending) return null;
  const note = d.pending.note?.trim() ?? "";
  return note ? { ...d.pending, note: note.slice(0, 200) } : "needs_note";
}

/** BL-153 (FO-REQ-0008): the review queue's filter by what the validator said. */
export type ReviewFilter = "all" | "passed" | "rejected";

/** The entries a filter shows, in the queue's order. Exported for its test. */
export function filterEntries<T extends Pick<PlanReviewEntry, "stages"> & { validator?: PlanReviewEntry["validator"] }>(entries: T[], filter: ReviewFilter): T[] {
  if (filter === "all") return entries;
  return entries.filter((e) => (validatorOfEntry(e) === "rejected") === (filter === "rejected"));
}

export type FailedCheck = { label: string; value: PlanCheck["value"]; threshold: PlanCheck["threshold"]; severity: "fail" | "warn"; atSeconds: [number, number] | null; offPercent: number | null };

/**
 * BL-153 AC-RR-07: a rejected attempt's failed checks for the line at the top -- `fail` first, then `warn` (each in the
 * validator's order) -- with how far the value is from the threshold, as a percentage of it, so near-misses stand out.
 * Exported for its test.
 */
export function failedChecksOf(entry: Pick<PlanReviewEntry, "stages">): FailedCheck[] {
  const row = [...entry.stages].reverse().find((s) => s.result === "rejected") ?? null;
  if (!row) return [];
  const failed = row.checks.filter((c) => !c.pass && (c.severity === "fail" || c.severity === "warn"));
  const order = (c: PlanCheck) => (c.severity === "fail" ? 0 : 1);
  return [...failed]
    .sort((a, b) => order(a) - order(b))
    .map((c) => ({
      label: c.label ?? c.id,
      value: c.value,
      threshold: c.threshold,
      severity: c.severity as "fail" | "warn",
      atSeconds: c.atSeconds,
      offPercent: typeof c.value === "number" && typeof c.threshold === "number" && c.threshold !== 0 ? Math.round((Math.abs(c.value - c.threshold) / Math.abs(c.threshold)) * 100) : null,
    }));
}

/** BL-157 (SERVERS_MEDIA_PLAN.md AC-WV-01/05): one wave of the queue -- how many of its entries wait (by the validator) and how many were reviewed. */
export type WaveSummary = {
  groupId: string;
  title: string;
  total: number;
  reviewed: number;
  waitingPassed: number;
  waitingRejected: number;
  /** The owner's verdicts in the wave, for the "wave done" summary. */
  accepted: number;
  rejected: number;
  /** Accepted although the validator rejected them. */
  overridesValidator: number;
};

/**
 * The waves that have entries, in the plan's wave order (`batches`), then any wave the batches do not name (an older
 * report), by first appearance. Entries in no wave are not a wave. Exported for its test.
 */
export function waveSummaries(entries: Array<Pick<PlanReviewEntry, "groupId" | "verdict" | "stages"> & { validator?: PlanReviewEntry["validator"] }>, batches: Array<Pick<PlanReviewBatch, "groupId" | "title">>): WaveSummary[] {
  const order = [...batches.map((b) => b.groupId), ...entries.map((e) => e.groupId).filter((g): g is string => g !== null)];
  const ids = [...new Set(order)].filter((id) => entries.some((e) => e.groupId === id));
  return ids.map((groupId) => {
    const mine = entries.filter((e) => e.groupId === groupId);
    const waiting = mine.filter(entryWaits);
    const reviewed = mine.filter((e) => !entryWaits(e));
    const accepted = reviewed.filter((e) => e.verdict?.result === "accepted");
    const rejectedByValidator = waiting.filter((e) => validatorOfEntry(e) === "rejected").length;
    return {
      groupId,
      title: batches.find((b) => b.groupId === groupId)?.title ?? groupId,
      total: mine.length,
      reviewed: reviewed.length,
      waitingPassed: waiting.length - rejectedByValidator,
      waitingRejected: rejectedByValidator,
      accepted: accepted.length,
      rejected: reviewed.filter((e) => e.verdict?.result === "rejected").length,
      overridesValidator: accepted.filter((e) => validatorOfEntry(e) === "rejected").length,
    };
  });
}

/**
 * AC-WV-02: when the chosen wave has nothing waiting, the next wave (in plan order, wrapping) that still has a waiting track
 * this computer may take -- review round 5 (AC-WV-06): one whose waiting tracks another computer has all claimed, or took
 * whole, is not offered (`skip` is the screen's claimed-elsewhere rule). Exported for its test.
 */
export function nextOpenWave<E extends Pick<PlanReviewEntry, "groupId" | "verdict">>(waves: WaveSummary[], chosen: WaveSummary | null, entries: E[], skip: (entry: E) => boolean): WaveSummary | null {
  if (!chosen || chosen.waitingPassed + chosen.waitingRejected > 0) return null;
  const at = waves.findIndex((w) => w.groupId === chosen.groupId);
  const open = (w: WaveSummary) => entries.some((e) => e.groupId === w.groupId && entryWaits(e) && !skip(e));
  return [...waves.slice(at + 1), ...waves.slice(0, at)].find((w) => w.waitingPassed + w.waitingRejected > 0 && open(w)) ?? null;
}

/** The entries the screen walks: the validator filter, then the chosen wave (null = all waves). Exported for its test. */
export function visibleEntries<T extends Pick<PlanReviewEntry, "stages" | "groupId"> & { validator?: PlanReviewEntry["validator"] }>(entries: T[], filter: ReviewFilter, wave: string | null): T[] {
  const filtered = filterEntries(entries, filter);
  return wave === null ? filtered : filtered.filter((e) => e.groupId === wave);
}

/** BL-162 (AC-UX-06): a stage's checks, the failed ones first (in the validator's order), then the passed ones. Exported for its test. */
export function splitChecks<C extends { pass: boolean }>(checks: readonly C[]): { failed: C[]; passed: C[] } {
  return { failed: checks.filter((c) => !c.pass), passed: checks.filter((c) => c.pass) };
}

/**
 * BL-162 (AC-UX-07): the waves the picker shows -- those with a waiting track and the chosen one, in the plan's order; the
 * fully reviewed ones only when the owner asks for them (`reviewed` counts those). Exported for its test.
 */
export function pickerWaves(waves: readonly WaveSummary[], chosen: string | null, showReviewed: boolean): { shown: WaveSummary[]; reviewed: number } {
  const open = (w: WaveSummary) => w.waitingPassed + w.waitingRejected > 0;
  return { shown: waves.filter((w) => showReviewed || open(w) || w.groupId === chosen), reviewed: waves.filter((w) => !open(w)).length };
}

/** BL-143 phase 2: the queue of ANOTHER device's plan, from its report, with the verdicts sent from here still waiting. */
export type PeerReviewSource = { deviceId: string; hostname: string | null };

type PeerQueueResponse = {
  /** BL-157 (AC-TC-02): the other devices' live claims, with the plan each is on. */
  claims?: Array<PlanReviewClaim & { ownerDeviceId: string; planId: string }>;
  devices: Array<{
    deviceId: string;
    hostname: string | null;
    plans: Array<{
      planId: string;
      review: PlanReviewEntry[];
      itemParams?: Record<string, PlanReviewEntry["params"]>;
      references?: PlanReference[];
      batches?: PlanReviewBatch[];
      /** BL-173 (report v4): the open re-checks and the items' waves. */
      rechecks?: SharedRecheck[];
      /** BL-175 (report v5): `mode`, `targetCount` and `pickTarget` decide when an item's picks settle it. */
      items?: Array<{ itemKey: string; groupId: string | null; mode?: "fixed" | "until_accepted"; targetCount?: number; pickTarget?: number }>;
      /** BL-175 (report v5): the active picks and "none fits", the pick actions that device weighed, the reason chips. */
      picks?: Array<{ itemKey: string; attemptRef: string; device: string; at: string; note: string | null }>;
      noneFits?: Array<{ itemKey: string; note: string | null; device: string; at: string; attempts: number }>;
      handledPicks?: string[];
      reviewReasons?: string[];
      groups?: Array<{ groupId: string; reviewReasons?: string[]; genre?: PlanGenre; reviewForm?: { fields: PlanReviewField[] } }>;
      /** BL-229 part B (report v6): the plan's general questions. */
      reviewForm?: { fields: PlanReviewField[] };
    }>;
  }>;
  /** BL-173: an answer to a re-check carries its `recheckId`; `kept` = the verdict kept with a note. */
  outgoing: Array<{ planId: string; ownerDeviceId: string; itemKey: string; attemptRef: string; result: "accepted" | "rejected"; rating: number | null; at: string; note?: string | null; recheckId?: string; kept?: boolean }>;
  /** BL-175: the pick actions sent from here (each weighed there once; until then they count here). */
  outgoingPicks?: Array<SentPickAction & { ownerDeviceId: string; planId: string }>;
};

/**
 * A peer plan's queue: the owning device's entries, where a verdict sent from here and not yet shown applied there counts as
 * given ("sent, waiting for <device>"). Exported for its test.
 */
export function peerQueue(data: PeerQueueResponse, source: PeerReviewSource, planId: string): Array<PlanReviewEntry & { pickSent?: true }> {
  const plan = data.devices.find((d) => d.deviceId === source.deviceId)?.plans.find((p) => p.planId === planId);
  if (!plan) return [];
  const device = source.hostname ?? source.deviceId;
  const withVerdicts = plan.review.map((raw) => {
    // The params travel once per item (the report's itemParams), not per entry. BL-175: the shared format carries no `media`.
    const params = plan.itemParams && Object.hasOwn(plan.itemParams, raw.itemKey) ? plan.itemParams[raw.itemKey] : raw.params;
    const entry = { ...raw, params, media: sharedEntryMedia(raw as Parameters<typeof sharedEntryMedia>[0]) };
    // BL-173: a kept re-check answer is a note, not a new verdict on the track.
    const sent = data.outgoing.filter((v) => v.ownerDeviceId === source.deviceId && v.planId === planId && v.itemKey === entry.itemKey && v.attemptRef === entry.attemptRef && v.kept !== true).at(-1);
    // A verdict sent from here that is newer than what that device shows is the one that counts (it is on its way).
    // Whole seconds: the owning device stores times to the second, so the applied copy of a verdict sent at …:12.345 reads …:12.000.
    if (!sent || (entry.verdict && Math.floor(Date.parse(entry.verdict.at) / 1000) >= Math.floor(Date.parse(sent.at) / 1000))) return entry;
    return { ...entry, verdict: { stageId: "owner_review", itemKey: entry.itemKey, attemptRef: entry.attemptRef, result: sent.result, reportedBy: "owner" as const, note: `${SENT_NOTE_PREFIX}${device}`, rating: sent.rating, reasons: [], markers: [], auditionFile: null, checks: [], metrics: {}, at: sent.at } };
  });
  // BL-175 (§2.6): picks sent from here and not yet weighed there already settle their attempts here.
  const sentPicks = (data.outgoingPicks ?? []).filter((a) => a.ownerDeviceId === source.deviceId && a.planId === planId);
  if (sentPicks.length === 0) return withVerdicts;
  const items = (plan.items ?? []).map((i) => ({ itemKey: i.itemKey, mode: i.mode ?? "fixed", targetCount: i.targetCount ?? 1, ...(typeof i.pickTarget === "number" ? { pickTarget: i.pickTarget } : {}) }));
  return withSentPicks({ items, picks: plan.picks, noneFits: plan.noneFits, handledPicks: plan.handledPicks }, withVerdicts, sentPicks, "");
}

/**
 * BL-173 (PLAN_RECHECKS_PLAN.md §2.7/§2.8): the open re-checks of ANOTHER device's plan, from its report (version 4) -- each
 * with the attempt's own entry when the report carries it; an answer sent from here and not yet applied there counts as given
 * ("sent, waiting for <device>"). Exported for its test.
 */
export function peerRecheckEntries(data: PeerQueueResponse, source: PeerReviewSource, planId: string): PlanRecheckEntry[] {
  const plan = data.devices.find((d) => d.deviceId === source.deviceId)?.plans.find((p) => p.planId === planId);
  if (!plan?.rechecks || plan.rechecks.length === 0) return [];
  const device = source.hostname ?? source.deviceId;
  const queue = peerQueue(data, source, planId);
  return plan.rechecks.map((shared) => {
    const recheck: PlanRecheck = {
      recheckId: shared.recheckId,
      itemKey: shared.itemKey,
      attemptRef: shared.attemptRef,
      kind: shared.kind,
      title: shared.title,
      note: shared.note,
      auditionFile: shared.auditionFile,
      markers: shared.markers,
      checks: shared.checks as unknown as PlanCheck[],
      metrics: shared.metrics as PlanRecheck["metrics"],
      previousVerdict: shared.previousVerdict,
      status: "open",
      openedAt: shared.openedAt,
      closedAt: null,
      answer: null,
      withdrawNote: null,
      closeReason: null,
    };
    const base = queue.find((e) => e.itemKey === shared.itemKey && e.attemptRef === shared.attemptRef) ?? null;
    const item = plan.items?.find((i) => i.itemKey === shared.itemKey);
    const params = plan.itemParams && Object.hasOwn(plan.itemParams, shared.itemKey) ? plan.itemParams[shared.itemKey] : {};
    const entry = recheckEntry(recheck, base, { groupId: item?.groupId ?? null, params }, (shared.extraStage as unknown as PlanResultRow | null) ?? null, null, (shared.beforeStage as unknown as PlanResultRow | null | undefined) ?? null);
    const sent = data.outgoing.filter((v) => v.ownerDeviceId === source.deviceId && v.planId === planId && v.recheckId === shared.recheckId).at(-1);
    if (!sent) return entry;
    return {
      ...entry,
      verdict: { stageId: "owner_review", itemKey: shared.itemKey, attemptRef: shared.attemptRef, result: sent.result, reportedBy: "owner" as const, note: `${SENT_NOTE_PREFIX}${device}`, rating: sent.rating, reasons: [], markers: [], auditionFile: null, checks: [], metrics: {}, at: sent.at },
      ...(sent.kept ? { pendingKept: true } : {}),
    };
  });
}

/** BL-173: the list the screen walks -- the open re-checks for the re-checks "wave", else the queue under the filter and wave. */
function walkOf<E extends PlanReviewEntry>(lists: { entries: E[]; rechecks: PlanRecheckEntry[] }, filter: ReviewFilter, wave: string | null): Array<E | PlanRecheckEntry> {
  return wave === RECHECKS_WAVE ? lists.rechecks : visibleEntries(lists.entries, filter, wave);
}

/** One entry of the screen: a track of the plan's queue, or an open re-check (`recheck`). BL-175: `pickSent` = picked from here, on its way. */
type ScreenEntry = PlanReviewEntry & { recheck?: PlanRecheck; pendingKept?: boolean; pickSent?: true };

/** BL-175 (review rounds 1 and 2): the pictures' kept drafts, each with the verdict time it was written against. */
export type KeptDrafts = Map<string, { draft: Draft; verdictAt: string | null }>;
type DraftOwner = { itemKey: string; attemptRef: string; verdict: { at: string } | null; recheck?: Pick<PlanRecheck, "recheckId"> };
/** Keeps the draft of the attempt the owner leaves (an empty one is forgotten). Exported for its test. */
export function keepDraft(kept: KeptDrafts, from: DraftOwner, draft: Draft): void {
  if (draftIsEmpty(draft)) kept.delete(draftKeyOf(from));
  else kept.set(draftKeyOf(from), { draft, verdictAt: from.verdict?.at ?? null });
}
/** The draft an attempt comes back with: its kept one, unless its verdict changed since (then a fresh one). Exported for its test. */
export function draftBack(kept: KeptDrafts, target: DraftOwner): Draft {
  const found = kept.get(draftKeyOf(target));
  if (!found) return emptyDraft();
  if (found.verdictAt !== (target.verdict?.at ?? null)) {
    kept.delete(draftKeyOf(target));
    return emptyDraft();
  }
  return found.draft;
}

/**
 * BL-175 phase 3 (FO-REQ-0018 §G): whether a second on screen counts as the owner's review time -- the tab is visible and the
 * owner is there: an input within the last 5 minutes, or sound playing (a track, the A/B reference; a clip loops by itself and
 * does not count -- review). Exported for its test.
 */
export const REVIEW_IDLE_MS = 5 * 60_000;
const secondsField = (reviewSeconds: number | undefined) => (reviewSeconds !== undefined ? { reviewSeconds } : {});
export function countsReviewTime(state: { visible: boolean; idleMs: number; playing: boolean }): boolean {
  return state.visible && (state.playing || state.idleMs < REVIEW_IDLE_MS);
}

/** An attempt's key on the screen: its item and attempt. */
/** BL-173: a re-check plays from its own route (the revised file, or the attempt's current one). */
function playedSrc(base: string, entry: Pick<ScreenEntry, "itemKey" | "attemptRef" | "recheck">): string {
  return entry.recheck
    ? `${base}/recheck-audition?recheckId=${encodeURIComponent(entry.recheck.recheckId)}`
    : `${base}/audition?itemKey=${encodeURIComponent(entry.itemKey)}&attemptRef=${encodeURIComponent(entry.attemptRef)}`;
}

function entryKey(e: { itemKey: string; attemptRef: string }): string {
  return `${e.itemKey}\u0000${e.attemptRef}`;
}

/** BL-175 (review round 2): the key a picture's kept draft is filed under -- an open re-check of the attempt has its own. */
function draftKeyOf(entry: { itemKey: string; attemptRef: string; recheck?: Pick<PlanRecheck, "recheckId"> }): string {
  return `${entry.itemKey}\u0000${entry.attemptRef}\u0000${entry.recheck?.recheckId ?? ""}`;
}

/** BL-175 (§2.1): what the screen shows for an entry -- a re-check's revised file decides for a revision, else the entry's own kind. */
export function screenMedia(entry: { media?: PlanMediaKind | null; recheck?: Pick<PlanRecheck, "kind" | "auditionFile"> }): PlanMediaKind | null {
  if (entry.recheck?.kind === "revision" && entry.recheck.auditionFile) return mediaKindOf(entry.recheck.auditionFile);
  return entry.media ?? null;
}

/** BL-175 (§2.2): an item's picks so far, how many it takes and its "none fits" -- for the screen's pick line. */
export type ItemPickInfo = { pickTarget: number; noneFits: (PlanNoneFitsView & { sent?: true }) | null };

/**
 * BL-175 (§2.2/§2.6): each item's pick target and "none fits" on another device's plan -- from its report, with a "none fits"
 * (or its withdrawal) sent from here and not yet weighed there taking effect at once. Exported for its test.
 */
export function peerPickItems(data: PeerQueueResponse, source: PeerReviewSource, planId: string): Map<string, ItemPickInfo> {
  const plan = data.devices.find((d) => d.deviceId === source.deviceId)?.plans.find((p) => p.planId === planId);
  const out = new Map<string, ItemPickInfo>();
  if (!plan) return out;
  const handled = new Set(plan.handledPicks ?? []);
  const sent = (data.outgoingPicks ?? []).filter((a) => a.ownerDeviceId === source.deviceId && a.planId === planId && !handled.has(a.pickId)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const item of plan.items ?? []) {
    const target = pickTargetOf({ mode: item.mode ?? "fixed", targetCount: item.targetCount ?? 1, ...(typeof item.pickTarget === "number" ? { pickTarget: item.pickTarget } : {}) });
    let noneFits: ItemPickInfo["noneFits"] = plan.noneFits?.find((n) => n.itemKey === item.itemKey) ?? null;
    for (const a of sent.filter((x) => x.itemKey === item.itemKey)) {
      if (a.action === "none_fits") noneFits = { note: a.note, device: "", at: a.at, attempts: 0, sent: true };
      else if (a.action === "clear_none_fits" || a.action === "pick") noneFits = null;
    }
    out.set(item.itemKey, { pickTarget: target, noneFits });
  }
  return out;
}

export function PlanReviewScreen({
  planId,
  onClose,
  onChanged,
  source,
  initialWave = null,
}: {
  planId: string;
  onClose: () => void;
  onChanged?: () => void;
  source?: PeerReviewSource;
  /** BL-162 (AC-UX-09): open on this wave (`?wave=`); its first waiting, unclaimed track is on screen. */
  initialWave?: string | null;
}) {
  const { t, formatNumber, language } = useUiText();
  const { channel } = useAppChannel();
  const [allEntries, setEntries] = useState<PlanReviewEntry[] | null>(null);
  // BL-173 (PLAN_RECHECKS_PLAN.md §2.8): the plan's open re-checks -- their own "wave", never mixed into the queue.
  const [recheckEntries, setRecheckEntries] = useState<PlanRecheckEntry[]>([]);
  const [filter, setFilter] = useState<ReviewFilter>("all");
  // BL-157 (AC-WV-01/02): the chosen wave (null = all waves) and each wave's context.
  const [wave, setWave] = useState<string | null>(null);
  const [batches, setBatches] = useState<PlanReviewBatch[]>([]);
  // BL-157 (AC-TC-01..04): the other computers' claims and a verdict waiting for "Replace?". BL-162 (owner, msg 2254 p.5 / 2263):
  // what is "in work" follows what is open -- no "take this wave" and no "show claimed ones too"; a claimed track is still
  // opened by a click in the queue.
  const [claims, setClaims] = useState<PlanReviewClaim[]>([]);
  // The attempt the question is about travels with it: "Replace" confirms exactly that track (review round 3).
  const [confirmReplace, setConfirmReplace] = useState<{ result: "accepted" | "rejected"; existing: PlanExistingVerdict; itemKey: string; attemptRef: string; pickedConfirmed?: boolean } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const freshClaims = useRef<PlanReviewClaim[]>([]);
  // The list the player, the arrows and the keys walk: the queue under the chosen filter (BL-153 AC-RR-06) and wave (BL-157).
  // BL-173: the re-checks "wave" walks the open re-checks instead.
  const entries = useMemo<ScreenEntry[] | null>(() => (allEntries ? walkOf({ entries: allEntries, rechecks: recheckEntries }, filter, wave) : null), [allEntries, recheckEntries, filter, wave]);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [blind, setBlind] = useState(false);
  // BL-143 phase 3: loudness-matched playback (on by default), the spectrogram (off), and the loudness measured here.
  const [matchLoudness, setMatchLoudness] = useState(true);
  const [showSpectrogram, setShowSpectrogram] = useState(false);
  const [measured, setMeasured] = useState<{ src: string; lufs: number | null } | null>(null);
  // BL-143 phase 3 (FO-MSG-0009): the plan's reference tracks and the A/B state (B = the chosen reference is playing).
  const [references, setReferences] = useState<PlanReference[]>([]);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [onB, setOnB] = useState(false);
  const referenceAudio = useRef<HTMLAudioElement | null>(null);
  // Owner, Telegram msg 2916; BL-195 (UI_FEEDBACK_CLARITY_PLAN.md stage B): a request runs behind the shared blocking window, and
  // after a verdict the next track is awaited behind it too (`awaitingSrc`, held until its waveform is ready or 20 s).
  const busyAction = useBusyAction();
  const { busy, run: runBusy, hold, release } = busyAction;
  const [awaitingSrc, setAwaitingSrc] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // BL-162: "copied" after the attempt's id went to the clipboard.
  const [copied, setCopied] = useState(false);
  const player = useRef<ReviewPlayerHandle | null>(null);
  // BL-175 (VISUAL_REVIEW_PLAN.md §2.9): pictures -- the image viewer, the clip player (also `player` for the shared keys), the
  // whole-window layer (grid / loupe / compare), the second attempt chosen for compare, the reason chips and the items' picks.
  const imageViewer = useRef<ImageViewerHandle | null>(null);
  const videoPlayer = useRef<VideoPlayerHandle | null>(null);
  const layerRef = useRef<LayerHandle | null>(null);
  const [layer, setLayer] = useState<LayerMode | null>(null);
  // Review round 1 (§B): the loupe or compare opened from the grid goes back to it on Esc; opened from the screen, Esc closes.
  const [layerBack, setLayerBack] = useState<LayerMode | null>(null);
  const [gridScope, setGridScope] = useState<"item" | "wave">("item");
  // BL-175 phase 2 (§E/§F): compare against a plan reference or «Было» (not an attempt), the chosen picture/clip reference,
  // «Как в ленте», and the loop tools (the seam window, the seam frames).
  const [against, setAgainst] = useState<"reference" | "before" | null>(null);
  const [visualRefId, setVisualRefId] = useState<string | null>(null);
  const [feedOn, setFeedOn] = useState(false);
  const [seamOn, setSeamOn] = useState(false);
  const [seamFramesOn, setSeamFramesOn] = useState(false);
  const [compareKey, setCompareKey] = useState<string | null>(null);
  const [reviewReasons, setReviewReasons] = useState<{ plan: string[] | null; groups: Record<string, string[]> }>({ plan: null, groups: {} });
  // BL-229 part B: the plan's questions and each wave's genre and questions.
  const [reviewForms, setReviewForms] = useState<ReviewFormsView>(NO_REVIEW_FORMS);
  const [pickItems, setPickItems] = useState<Map<string, ItemPickInfo>>(new Map());
  const [noneFitsDraft, setNoneFitsDraft] = useState<{ itemKey: string; note: string; rerun: boolean } | null>(null);
  const noneFitsForm = useRef<HTMLFormElement | null>(null);
  const noteBoxForm = useRef<HTMLFormElement | null>(null);
  const [confirmRejectPicked, setConfirmRejectPicked] = useState(false);
  const [imageBytes, setImageBytes] = useState<{ src: string; bytes: number | null } | null>(null);
  // BL-162 (AC-UX-15): the queue keeps the open track in view.
  const currentRow = useRef<HTMLButtonElement | null>(null);
  const peerDevice = source?.deviceId;
  const peerName = source?.hostname ?? null;
  const base = peerDevice ? `/api/generation-plans/peers/${encodeURIComponent(peerDevice)}/${encodeURIComponent(planId)}` : `/api/generation-plans/${encodeURIComponent(planId)}`;

  /** BL-157 (AC-TC-02): the other computers' claims on THIS plan, from either answer. */
  const claimsFrom = useCallback(
    (data: { claims?: PeerQueueResponse["claims"] | PlanReviewClaim[] }): PlanReviewClaim[] =>
      peerDevice
        ? ((data.claims ?? []) as NonNullable<PeerQueueResponse["claims"]>).filter((c) => c.ownerDeviceId === peerDevice && c.planId === planId)
        : ((data.claims ?? []) as PlanReviewClaim[]),
    [peerDevice, planId]
  );

  /** The queue and the open re-checks, freshest from the server; empty (with the message shown) when they cannot be read. */
  const load = useCallback(
    (): Promise<{ entries: PlanReviewEntry[]; rechecks: PlanRecheckEntry[] }> =>
      fetch(peerDevice ? "/api/generation-plans/peers" : `${base}/review`)
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as { entries?: PlanReviewEntry[]; rechecks?: PlanRecheckEntry[]; references?: PlanReference[]; batches?: PlanReviewBatch[]; message?: string } & Partial<PeerQueueResponse>;
          if (!res.ok) throw new Error(errorText(t, data, t("review.loadFailedStatus", { status: String(res.status) }), { showErrorField: false }));
          const peerPlan = peerDevice ? data.devices?.find((d) => d.deviceId === peerDevice)?.plans.find((p) => p.planId === planId) : undefined;
          setReferences(peerDevice ? (peerPlan?.references ?? []) : (data.references ?? []));
          setBatches(peerDevice ? (peerPlan?.batches ?? []) : (data.batches ?? []));
          // BL-175 (§2.5/§2.2): the reason chips of the plan and its waves, and each item's pick target and "none fits".
          const own = data as { reviewReasons?: { plan: string[] | null; groups: Record<string, string[]> }; pickItems?: Array<{ itemKey: string } & ItemPickInfo>; reviewForms?: ReviewFormsView };
          setReviewForms(peerDevice ? reviewFormsOfShared(peerPlan) : (own.reviewForms ?? NO_REVIEW_FORMS));
          if (peerDevice) {
            const groups: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
            for (const g of peerPlan?.groups ?? []) if (g.reviewReasons && g.reviewReasons.length > 0) groups[g.groupId] = g.reviewReasons;
            setReviewReasons({ plan: peerPlan?.reviewReasons && peerPlan.reviewReasons.length > 0 ? peerPlan.reviewReasons : null, groups });
            setPickItems(peerPickItems({ devices: data.devices ?? [], outgoing: data.outgoing ?? [], outgoingPicks: data.outgoingPicks ?? [] }, { deviceId: peerDevice, hostname: peerName }, planId));
          } else {
            setReviewReasons(own.reviewReasons ?? { plan: null, groups: {} });
            setPickItems(new Map((own.pickItems ?? []).map((i) => [i.itemKey, { pickTarget: i.pickTarget, noneFits: i.noneFits }])));
          }
          const fresh = claimsFrom(data);
          freshClaims.current = fresh;
          setClaims(fresh);
          setNowMs(Date.now());
          const peerData = { devices: data.devices ?? [], outgoing: data.outgoing ?? [], outgoingPicks: data.outgoingPicks ?? [] };
          const peerSource = { deviceId: peerDevice ?? "", hostname: peerName };
          const list = peerDevice ? peerQueue(peerData, peerSource, planId) : (data.entries ?? []);
          const rechecks = peerDevice ? peerRecheckEntries(peerData, peerSource, planId) : (data.rechecks ?? []);
          setEntries(list);
          setRecheckEntries(rechecks);
          return { entries: list, rechecks };
        })
        .catch((error: unknown) => {
          setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.loadFailed") });
          return { entries: [], rechecks: [] };
        }),
    [base, claimsFrom, peerDevice, peerName, planId, t]
  );

  // A track another computer is on is passed over by the arrows and auto-advance (AC-TC-02); the queue still opens it on a click.
  const skipClaimed = useCallback((e: PlanReviewEntry) => entryWaits(e) && claimOf(e, claims, nowMs) !== null, [claims, nowMs]);
  /** The same rule against the claims `load` just read -- the state above only catches up on the next render (review round 1). */
  const skipFresh = useCallback((e: PlanReviewEntry) => entryWaits(e) && claimOf(e, freshClaims.current, Date.now()) !== null, []);

  useEffect(() => {
    // First open: the first waiting track no other computer is on (its claims arrive with the same answer). BL-162 (AC-UX-09):
    // with `?wave=`, that wave is chosen first -- after the queue arrived, so the same rule picks its track.
    void load().then(({ entries: list, rechecks }) => {
      // BL-173: `?wave=~rechecks` opens on the first open re-check no other computer is on (or says none is open).
      if (initialWave === RECHECKS_WAVE) {
        setWave(RECHECKS_WAVE);
        setIndex(Math.max(0, rechecks.findIndex((e) => entryWaits(e) && claimOf(e, freshClaims.current, Date.now()) === null)));
        return;
      }
      const start = initialWave !== null && list.some((e) => e.groupId === initialWave) ? initialWave : null;
      if (start !== null) setWave(start);
      const walk = start === null ? list : list.filter((e) => e.groupId === start);
      setIndex(Math.max(0, walk.findIndex((e) => entryWaits(e) && claimOf(e, freshClaims.current, Date.now()) === null)));
    });
  }, [initialWave, load]);

  // BL-157 (AC-TC-02): the other computers' claims come and go while the screen is open -- read them again now and then
  // (only the claims: the queue itself is not reloaded under the owner's hands).
  useEffect(() => {
    // BL-162 (§5.4): only the claims, from the light `claim` route -- not the whole queue -- so it can run every few seconds.
    const timer = setInterval(() => {
      void fetch(`${base}/claim`)
        .then(async (res) => (res.ok ? ((await res.json()) as { claims?: PlanReviewClaim[] }) : null))
        .then((data) => {
          if (data?.claims) setClaims(data.claims);
          setNowMs(Date.now());
        })
        .catch(() => undefined);
    }, CLAIMS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [base]);

  const entry: ScreenEntry | null = entries && entries.length > 0 ? entries[Math.min(index, entries.length - 1)] : null;
  // Review round 1: the attempt on screen now, for an answer that arrives after the owner moved on.
  const onScreen = useRef<string | null>(null);
  useEffect(() => {
    onScreen.current = entry ? `${entry.itemKey}\u0000${entry.attemptRef}` : null;
  });
  // BL-175 (§2.1): what the entry on screen shows -- a player for audio (unchanged), a picture or a clip.
  const currentMedia = entry ? screenMedia(entry) : null;
  const visualEntry = isVisual(currentMedia);
  useEffect(() => {
    currentRow.current?.scrollIntoView({ block: "nearest" });
  }, [index, entries]);

  /** Back to A whenever the attempt changes (the reference never keeps playing under another track). */
  const stopB = useCallback(() => {
    referenceAudio.current?.pause();
    setOnB(false);
  }, []);

  // BL-175 phase 3 (§G): the owner's review time per attempt (a re-check apart) -- counted each second the attempt is on screen
  // and the owner is there (`countsReviewTime`); sent with the decision, then counted again from zero.
  const reviewMs = useRef(new Map<string, number>());
  const lastInput = useRef(Date.now());
  useEffect(() => {
    const seen = () => {
      lastInput.current = Date.now();
    };
    const kinds = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const kind of kinds) window.addEventListener(kind, seen, { passive: true });
    return () => {
      for (const kind of kinds) window.removeEventListener(kind, seen);
    };
  }, []);
  const clockKey = entries && entries.length > 0 ? draftKeyOf(entries[Math.min(index, entries.length - 1)]) : null;
  useEffect(() => {
    if (!clockKey) return;
    const timer = setInterval(() => {
      // Sound playing -- the track (the player's own state: wavesurfer keeps its audio out of reach) or the A/B reference. A clip
      // loops by itself, muted (§A), so it is no sign the owner is there: for a picture or clip, an input in the last minutes is.
      const playing = (!isVisual(currentMedia) && Boolean(player.current?.isPlaying())) || Boolean(referenceAudio.current && !referenceAudio.current.paused);
      if (countsReviewTime({ visible: document.visibilityState === "visible", idleMs: Date.now() - lastInput.current, playing })) {
        reviewMs.current.set(clockKey, (reviewMs.current.get(clockKey) ?? 0) + 1000);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [clockKey, currentMedia]);
  /** The whole seconds counted on these attempts (absent when none was counted), at most a day. */
  const reviewSecondsOf = useCallback((keys: readonly string[]): number | undefined => {
    const counted = keys.map((k) => reviewMs.current.get(k)).filter((ms): ms is number => ms !== undefined);
    return counted.length > 0 ? Math.min(86_400, Math.round(counted.reduce((a, b) => a + b, 0) / 1000)) : undefined;
  }, []);
  /** An item's own attempts' keys counted so far (a pick or "none fits" decides the item). */
  const itemClockKeys = useCallback((itemKey: string) => [...reviewMs.current.keys()].filter((k) => k.startsWith(`${itemKey}\u0000`) && k.endsWith("\u0000")), []);

  // BL-175 (review round 1): a picture's draft (pins with notes, chips, rating) waits for the owner when another attempt is opened
  // from the grid or the strip, and comes back with its attempt. Music keeps a fresh draft per track, as before.
  // Review round 2: every move to another attempt keeps and brings back drafts the same way (the arrows, auto-advance, filters,
  // waves); a draft written before the attempt's verdict changed (a verdict from the other computer, an answered re-check) is
  // dropped rather than shown again.
  const visualDrafts = useRef<KeptDrafts>(new Map());
  const stashDraft = useCallback(() => {
    const from = entries?.[Math.min(index, entries.length - 1)];
    if (from && isVisual(screenMedia(from))) keepDraft(visualDrafts.current, from, draft);
  }, [draft, entries, index]);
  const draftFor = useCallback((target: ScreenEntry | undefined): Draft => (target ? draftBack(visualDrafts.current, target) : emptyDraft()), []);
  const go = useCallback(
    (to: number) => {
      if (!entries || entries.length === 0) return;
      stopB();
      const next = ((to % entries.length) + entries.length) % entries.length;
      stashDraft();
      setIndex(next);
      setDraft(draftFor(entries[next]));
      setMessage(null);
    },
    [draftFor, entries, stashDraft, stopB]
  );

  /**
   * BL-173 (PLAN_RECHECKS_PLAN.md §2.3): the answer to the open re-check on screen -- a verdict, or "keep" (a question only). No
   * "Replace?" question: the re-check is the request. Then on to the next open re-check.
   */
  /** Owner, msg 2916: a verdict that moves to another audio track waits for its waveform behind the loading window. */
  const awaitTrack = useCallback(
    (from: ScreenEntry, to: ScreenEntry | undefined) => {
      if (to && entryKey(to) !== entryKey(from) && to.playable && !isVisual(screenMedia(to))) setAwaitingSrc(playedSrc(base, to));
    },
    [base]
  );

  const answerRecheck = useCallback(
    async (answer: "accepted" | "rejected" | "kept") => {
      const recheck = entry?.recheck;
      if (!entry || !recheck || busy || entry.verdict !== null) return;
      if (answer === "kept" && recheck.kind !== "question") return;
      const pending = pendingMarkOf(draft);
      if (pending === "needs_note") {
        setMessage({ tone: "error", text: t("review.pin.saveFirst") });
        return;
      }
      await runBusy(t("review.advancing.saving"), async () => {
        try {
          const marks = [...(draft.openMark !== null ? [...draft.marks, { start: draft.openMark, end: null, note: null }] : draft.marks), ...(pending ? [pending] : [])];
          await postJson(t, `${base}/recheck`, {
            recheckId: recheck.recheckId,
            ...(answer === "kept" ? { kept: true } : { result: answer, ...(draft.rating !== null ? { rating: draft.rating } : {}), reasons: draft.reasons, markers: marks }),
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
            ...secondsField(reviewSecondsOf([draftKeyOf(entry)])),
          });
          reviewMs.current.delete(draftKeyOf(entry));
          setMessage({ tone: "ok", text: t("review.recheck.answered", { item: entry.itemKey }) });
          onChanged?.();
          const list = walkOf(await load(), filter, wave);
          visualDrafts.current.delete(draftKeyOf(entry));
          // The owner moved on while the answer was on its way: stay there, with its draft (review round 3).
          if (onScreen.current !== entryKey(entry)) {
            const there = list.findIndex((e) => entryKey(e) === onScreen.current);
            if (there >= 0) setIndex(there);
            return;
          }
          // An answered re-check leaves the list here (on another computer's plan it stays, "sent"): look on from where it was.
          const here = list.findIndex((e) => (e as ScreenEntry).recheck?.recheckId === recheck.recheckId);
          const next = nextWaitingIndex(list, here >= 0 ? here : index - 1, skipFresh);
          const to = next >= 0 ? next : Math.max(0, Math.min(here >= 0 ? here : index, list.length - 1));
          setDraft(draftFor(list[to] as ScreenEntry | undefined));
          stopB();
          awaitTrack(entry, list[to] as ScreenEntry | undefined);
          setIndex(to);
        } catch (error) {
          setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.saveFailed") });
        }
      });
    },
    [awaitTrack, base, busy, draft, draftFor, entry, filter, index, load, onChanged, reviewSecondsOf, runBusy, skipFresh, stopB, t, wave]
  );

  const submit = useCallback(
    async (result: "accepted" | "rejected", replace = false, pickedConfirmed = false) => {
      if (!entry || busy) return;
      if (entry.recheck) {
        void answerRecheck(result);
        return;
      }
      // Review round 1: a mark still waiting for its note is never dropped -- kept with the note typed so far, else asked for
      // (review round 2: before any question, so the owner is not asked twice and then told the note is missing).
      const pending = pendingMarkOf(draft);
      if (pending === "needs_note") {
        setMessage({ tone: "error", text: t("review.pin.saveFirst") });
        return;
      }
      // BL-229 part B: the required questions first, for an accept and a reject alike (A / R say so too).
      const sections = formSectionsFor(reviewForms, entry.groupId);
      const formFields = [...sections.general, ...sections.genre];
      const unanswered = missingRequired(formFields, draft.answers);
      if (unanswered.length > 0) {
        setMessage({ tone: "error", text: t("review.form.requiredFirst", { count: unanswered.length }) });
        return;
      }
      const answers = answersToSend(formFields, draft.answers);
      // BL-175 (§2.2): rejecting the picked attempt withdraws its pick -- asked first.
      if (result === "rejected" && entry.picked && !pickedConfirmed) {
        setConfirmRejectPicked(true);
        return;
      }
      // BL-157 (AC-TC-04): a track that already has a verdict asks first. A verdict sent from this computer is asked about by
      // the server (its 409 names this computer, which the screen cannot name itself -- review round 6).
      const sentHere = entry.verdict?.note?.startsWith(SENT_NOTE_PREFIX) ?? false;
      if (!replace && entry.verdict && !sentHere) {
        setConfirmReplace({
          result,
          itemKey: entry.itemKey,
          attemptRef: entry.attemptRef,
          existing: { result: entry.verdict.result, rating: entry.verdict.rating, device: entry.pendingFrom ?? historyEntryOfVerdict(entry.history, entry.verdict)?.device ?? null, at: entry.verdict.at },
          // Review round 1: "Reject the picked attempt?" was already answered -- "Replace?" must not ask it again.
          pickedConfirmed,
        });
        return;
      }
      await runBusy(t("review.advancing.saving"), async () => {
        try {
          const marks = [...(draft.openMark !== null ? [...draft.marks, { start: draft.openMark, end: null, note: null }] : draft.marks), ...(pending ? [pending] : [])];
          await postJson(t, `${base}/verdict`, {
            itemKey: entry.itemKey,
            attemptRef: entry.attemptRef,
            result,
            ...(replace ? { replace: true } : {}),
            ...(draft.rating !== null ? { rating: draft.rating } : {}),
            reasons: draft.reasons,
            markers: marks,
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
            ...secondsField(reviewSecondsOf([draftKeyOf(entry)])),
            ...(answers ? { answers } : {}),
          });
          reviewMs.current.delete(draftKeyOf(entry));
          setMessage({ tone: "ok", text: t("review.verdictSaved", { item: entry.itemKey, result: resultLabel(t, result) }) });
          visualDrafts.current.delete(draftKeyOf(entry));
          onChanged?.();
          // Auto-advance: the next attempt still waiting after this one, in the refreshed queue.
          const list = visibleEntries((await load()).entries, filter, wave);
          // The owner moved on while the verdict was on its way: stay there, with its draft (review round 3).
          if (onScreen.current !== entryKey(entry)) {
            const there = list.findIndex((e) => entryKey(e) === onScreen.current);
            if (there >= 0) setIndex(there);
            return;
          }
          const here = list.findIndex((e) => e.itemKey === entry.itemKey && e.attemptRef === entry.attemptRef);
          const next = nextWaitingIndex(list, here >= 0 ? here : index, skipFresh);
          const to = next >= 0 ? next : Math.max(0, here);
          setDraft(draftFor(list[to] as ScreenEntry | undefined));
          stopB();
          awaitTrack(entry, list[to] as ScreenEntry | undefined);
          setIndex(to);
        } catch (error) {
          // The screen's data was stale: the server found a verdict there -- ask now (AC-TC-04).
          if (error instanceof RequestError && error.code === "plan_verdict_exists") {
            const existing = (error.details as { existing?: PlanExistingVerdict } | undefined)?.existing;
            if (existing) {
              setConfirmReplace({ result, existing, itemKey: entry.itemKey, attemptRef: entry.attemptRef, pickedConfirmed });
              return;
            }
          }
          setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.saveFailed") });
        }
      });
    },
    [answerRecheck, awaitTrack, base, busy, draft, draftFor, entry, filter, index, load, onChanged, reviewForms, reviewSecondsOf, runBusy, skipFresh, stopB, t, wave]
  );

  // BL-157 (AC-TC-01): this computer claims the waiting track on screen (and the wave it took), renewed every minute;
  // moving on moves the claim, leaving the screen gives them up. Claims are advisory: a failure is ignored.
  // Always claimed while open and waiting, whatever the other computer claims (review round 6: dropping a claim already held
  // when the other computer's claim arrives let both walk onto the same track). Claim ids are per device, so they never
  // collide; the "next wave" offer already avoids leading onto another computer's tracks (`nextOpenWave`).
  const claimKey = entry && entryWaits(entry) ? `${entry.itemKey}\u0000${entry.attemptRef}` : null;
  useEffect(() => {
    if (!claimKey) return;
    const [itemKey, attemptRef] = claimKey.split("\u0000");
    const send = () => void postJson(t, `${base}/claim`, { scope: "attempt", itemKey, attemptRef }).catch(() => undefined);
    send();
    const timer = setInterval(send, CLAIM_HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      void postJson(t, `${base}/claim`, { scope: "attempt", itemKey, attemptRef, release: true }, { keepalive: true }).catch(() => undefined);
    };
  }, [base, claimKey, t]);
  // BL-162 (§5.4 point 5, owner msg 2263): two computers opened the same track within the same seconds -- the one that opened it
  // first keeps it and this screen moves on to the next free track, but only while nothing was marked or written here yet.
  const openedAt = useRef<{ key: string; at: number } | null>(null);
  // A track the owner opened by hand from the queue -- knowing another computer is on it -- is never moved away from.
  const pickedByHand = useRef<string | null>(null);
  useEffect(() => {
    if (claimKey) openedAt.current = { key: claimKey, at: Date.now() };
    if (pickedByHand.current !== claimKey) pickedByHand.current = null;
  }, [claimKey]);
  useEffect(() => {
    if (!entry || !entryWaits(entry) || !entries || !claimKey) return;
    const claim = claimOf(entry, claims, nowMs);
    const opened = openedAt.current;
    // Only in the first seconds after opening (review): a claim that arrives later (an older build's report) never pulls a track
    // away from the owner mid-listen -- the "being reviewed on" line says it instead.
    if (!claim || claim.scope !== "attempt" || !opened || opened.key !== claimKey || pickedByHand.current === claimKey || nowMs - opened.at > AUTO_MOVE_WINDOW_MS || !(Date.parse(claim.since) < opened.at)) return;
    // Review round 2: a mark waiting for its note counts as touched too (the note box keeps its place).
    if (!draftIsEmpty(draft)) return;
    const next = nextWaitingIndex(entries, index, skipClaimed);
    if (next < 0 || next === index) return;
    go(next);
    setMessage({ tone: "ok", text: t("review.claimedMoved", { device: claim.device }) });
  }, [claimKey, claims, draft, entries, entry, go, index, nowMs, skipClaimed, t]);

  /** A filter shows its own first waiting attempt. */
  const chooseFilter = useCallback(
    (next: ReviewFilter) => {
      stopB();
      setCompareKey(null);
      stashDraft();
      const list = visibleEntries(allEntries ?? [], next, wave);
      const to = Math.max(0, list.findIndex((e) => entryWaits(e) && !skipClaimed(e)));
      setFilter(next);
      setIndex(to);
      setDraft(draftFor(list[to] as ScreenEntry | undefined));
      setMessage(null);
    },
    [allEntries, draftFor, skipClaimed, stashDraft, stopB, wave]
  );
  /** BL-157 (AC-WV-02): a wave shows its own first waiting attempt; null = all waves. */
  const chooseWave = useCallback(
    (next: string | null) => {
      stopB();
      setCompareKey(null);
      // BL-173: the re-checks have no validator filter of their own.
      const nextFilter = next === RECHECKS_WAVE ? "all" : filter;
      stashDraft();
      const list = walkOf({ entries: allEntries ?? [], rechecks: recheckEntries }, nextFilter, next);
      const to = Math.max(0, list.findIndex((e) => entryWaits(e) && !skipClaimed(e)));
      setFilter(nextFilter);
      setWave(next);
      setIndex(to);
      setDraft(draftFor(list[to]));
      setMessage(null);
    },
    [allEntries, draftFor, filter, recheckEntries, skipClaimed, stashDraft, stopB]
  );
  const waves = useMemo(() => waveSummaries(allEntries ?? [], batches), [allEntries, batches]);
  const chosenWave = wave === null ? null : (waves.find((w) => w.groupId === wave) ?? null);
  const chosenBatch = wave === null ? null : (batches.find((b) => b.groupId === wave) ?? null);
  // AC-WV-02: when the chosen wave has nothing waiting, the next wave (in plan order, wrapping) that still has something.
  const nextWave = useMemo(() => nextOpenWave(waves, chosenWave, allEntries ?? [], skipClaimed), [allEntries, chosenWave, skipClaimed, waves]);
  // Owner, Telegram msgs 2918/2923: the moment the chosen wave's last waiting track is reviewed here, a window over the
  // blurred screen gives its summary and offers the next wave; a quiet cross closes it (the summary stays above the queue).
  // Opening a wave that was already done shows no window -- only the change from "something waits" to "nothing waits".
  const [waveDoneFor, setWaveDoneFor] = useState<string | null>(null);
  const waitingBefore = useRef<{ groupId: string; waiting: number } | null>(null);
  useEffect(() => {
    const waiting = chosenWave ? chosenWave.waitingPassed + chosenWave.waitingRejected : null;
    const before = waitingBefore.current;
    if (chosenWave && waiting === 0 && before && before.groupId === chosenWave.groupId && before.waiting > 0) setWaveDoneFor(chosenWave.groupId);
    waitingBefore.current = chosenWave && waiting !== null ? { groupId: chosenWave.groupId, waiting } : null;
  }, [chosenWave]);
  const waveDone = waveDoneFor !== null && chosenWave?.groupId === waveDoneFor ? chosenWave : null;
  /** AC-WV-05: a done wave's summary -- BL-175: a wave of pictures is looked at, and its picks are what it decided. */
  const waveDoneText = (w: WaveSummary) =>
    (allEntries ?? []).some((e) => e.groupId === w.groupId && isVisual(screenMedia(e)))
      ? t("review.wave.doneVisual", { picked: (allEntries ?? []).filter((e) => e.groupId === w.groupId && e.picked).length, accepted: w.accepted, rejected: w.rejected })
      : t("review.wave.done", { accepted: w.accepted, rejected: w.rejected, overrides: w.overridesValidator });
  const filterCounts = useMemo(() => {
    const list = wave === null ? (allEntries ?? []) : (allEntries ?? []).filter((e) => e.groupId === wave);
    const waitingIn = (f: ReviewFilter) => filterEntries(list, f).filter(entryWaits).length;
    return { all: waitingIn("all"), passed: waitingIn("passed"), rejected: waitingIn("rejected"), anyRejected: list.some((e) => validatorOfEntry(e) === "rejected") };
  }, [allEntries, wave]);

  /** M: opens a range at the playhead, then closes it. BL-175 (§2.4): on a clip (`withNote`) the closed range waits for its own note. */
  const mark = useCallback((withNote = false) => {
    const at = Math.round((player.current?.currentTime() ?? 0) * 10) / 10;
    setDraft((d) => {
      if (d.openMark === null) return { ...d, openMark: at };
      const range = { start: Math.min(d.openMark, at), end: Math.max(d.openMark, at), note: null };
      return withNote ? { ...d, openMark: null, pending: range } : { ...d, openMark: null, marks: [...d.marks, range] };
    });
  }, []);

  /** BL-175 (§2.4): a pin set on the picture (or the paused frame at `atSeconds`) waits for its own note. */
  const addPin = useCallback((region: PlanMarkerRegion, atSeconds = 0) => {
    setDraft((d) => ({ ...d, openMark: null, pending: { start: Math.round(atSeconds * 10) / 10, end: null, note: null, region } }));
  }, []);
  const savePending = useCallback(() => {
    setDraft((d) => (d.pending && d.pending.note?.trim() ? { ...d, marks: [...d.marks, { ...d.pending, note: d.pending.note.trim().slice(0, 200) }], pending: null } : d));
  }, []);
  const cancelPending = useCallback(() => setDraft((d) => ({ ...d, pending: null })), []);

  /**
   * BL-175 (§2.2): pick an attempt, withdraw a pick, mark an item "none fits" or take that back -- then the queue again, staying on
   * the same attempt (its place in the queue moves: a picked or not-chosen attempt no longer waits). Not a verdict.
   */
  const pickAction = useCallback(
    async (target: { itemKey: string; attemptRef?: string }, action: "pick" | "unpick" | "none_fits" | "clear_none_fits", note?: string | null): Promise<boolean> => {
      if (busy) return false;
      return runBusy(t("common.saving"), async () => {
        try {
          // A pick or "none fits" decides the item: it carries the seconds spent on the item's attempts since its last decision.
          const decides = action === "pick" || action === "none_fits";
          const clock = decides ? itemClockKeys(target.itemKey) : [];
          await postJson(t, `${base}/pick`, { itemKey: target.itemKey, ...(target.attemptRef && (action === "pick" || action === "unpick") ? { attemptRef: target.attemptRef } : {}), action, ...(note && note.trim() ? { note: note.trim() } : {}), ...secondsField(reviewSecondsOf(clock)) });
          for (const k of clock) reviewMs.current.delete(k);
          const done = action === "pick" ? "review.pick.done" : action === "unpick" ? "review.pick.withdrawn" : action === "none_fits" ? "review.noneFits.done" : "review.noneFits.cleared";
          setMessage({ tone: "ok", text: t(done, { item: target.itemKey }) });
          onChanged?.();
          const list = walkOf(await load(), filter, wave);
          // The queue moved (a picked or not-chosen attempt no longer waits): keep the attempt that is on screen NOW on screen --
          // the one the owner moved on to meanwhile, never back to the picked one (review round 1).
          const now = onScreen.current;
          const here = now !== null ? list.findIndex((e) => `${e.itemKey}\u0000${e.attemptRef}` === now) : -1;
          if (here >= 0) setIndex(here);
          return true;
        } catch (error) {
          setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.saveFailed") });
          return false;
        }
      });
    },
    [base, busy, filter, itemClockKeys, load, onChanged, reviewSecondsOf, runBusy, t, wave]
  );
  /** S: the entry on screen picked, or its pick withdrawn. */
  const togglePick = useCallback(
    (target: ScreenEntry | null) => {
      if (!target || target.recheck || !isVisual(screenMedia(target))) return;
      if (!target.picked && forbidsPick(target.verdict?.result)) {
        setMessage({ tone: "error", text: t("review.pick.rejectedHint") });
        return;
      }
      // The comment field belongs to the attempt on screen: a pick of another card in the grid takes no note (review round 1).
      const isCurrent = entry !== null && entry.itemKey === target.itemKey && entry.attemptRef === target.attemptRef;
      void pickAction(target, target.picked ? "unpick" : "pick", target.picked || !isCurrent ? null : draft.note);
    },
    [draft.note, entry, pickAction, t]
  );

  const askRerun = async () => {
    if (!entry) return;
    try {
      await postJson(t, `${base}/rerun-request`, { itemKey: entry.itemKey, attemptRef: entry.attemptRef, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) });
      setMessage({ tone: "ok", text: t("review.rerunAsked", { item: entry.itemKey }) });
      onChanged?.();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.rerunFailed") });
    }
  };

  // BL-173 (§2.8): a revision is compared with the attempt's own file ("Before"), not with a reference track.
  const isRevision = entry?.recheck?.kind === "revision";
  const offered = entry && !isRevision && !visualEntry ? referencesFor(entry, references) : [];
  // Phase 2 (§E): the plan's picture and clip references for a picture or clip on screen (a revision compares with «Было»).
  const visualOffered = entry && !isRevision && visualEntry ? referencesFor(entry, references, "visual") : [];
  const chosenVisual = visualOffered.find((r) => r.id === visualRefId) ?? visualOffered[0] ?? null;
  const visualRevision = isRevision && visualEntry && Boolean(entry?.playable);
  // Phase 2 (§F): a clip its rows say is meant to loop.
  const loopClip = currentMedia === "video" && entry !== null && loopFromMetrics(entry.stages);
  const chosen = offered.find((r) => r.id === referenceId) ?? offered[0] ?? null;
  const abSource = useMemo(
    () =>
      entry && isRevision
        ? { src: `${base}/audition?itemKey=${encodeURIComponent(entry.itemKey)}&attemptRef=${encodeURIComponent(entry.attemptRef)}`, label: t("review.recheck.before"), lufs: beforeLufs(entry) }
        : chosen
          ? { src: `${base}/reference?id=${encodeURIComponent(chosen.id)}`, label: chosen.label, lufs: chosen.lufs }
          : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `language` re-builds the label after a language switch
    [base, chosen, entry, isRevision, t, language]
  );

  /**
   * FO-MSG-0009 / AC-GP3-07: A/B -- switch between the track (A) and the chosen reference (B) at the same position, each at its
   * matched loudness (the reference's own LUFS when given). BL-173: for a revision, B is the attempt's own file.
   */
  const toggleAB = useCallback(() => {
    const audio = referenceAudio.current;
    if (!audio || !abSource) return;
    if (!onB) {
      const at = player.current?.currentTime() ?? 0;
      player.current?.pause();
      audio.currentTime = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.min(at, audio.duration) : at;
      audio.volume = matchLoudness ? matchedVolume(abSource.lufs) : 1;
      setOnB(true);
      audio.play().catch((error: unknown) => {
        // A quick B-then-A pauses before play() settled (AbortError): not a failure.
        if (error instanceof DOMException && error.name === "AbortError") return;
        setOnB(false);
        setMessage({ tone: "error", text: t("review.referenceFailed") });
      });
    } else {
      const at = audio.currentTime;
      audio.pause();
      player.current?.playFrom(at);
      setOnB(false);
    }
  }, [abSource, matchLoudness, onB, t]);

  /** The visual attempts of the walk, stable (item, then attempt): the grid never reorders under the owner's hands. */
  const visualWalk = (entries ?? [])
    .filter((e) => !e.recheck && e.playable && isVisual(screenMedia(e)))
    .sort((a, b) => a.itemKey.localeCompare(b.itemKey, undefined, { numeric: true }) || attemptLabel(a).localeCompare(attemptLabel(b), undefined, { numeric: true }));
  // Review round 2: one rule for compare, the C key and the button alike -- a second picture or clip of the walk is chosen.
  const comparable = entry !== null && compareKey !== null && compareKey !== entryKey(entry) && visualWalk.some((e) => entryKey(e) === compareKey);
  // Review round 2: an open re-check shows its own file on the screen only -- the grid, the loupe and compare never open on it.
  const layerable = visualEntry && Boolean(entry?.playable) && !entry?.recheck;

  // Keyboard shortcuts, except while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // BL-157 (AC-TC-04): while "Replace?" is open, the dialog has the keyboard. BL-175: so do the other dialogs and a pin's note box.
      // Owner, msg 2916: nothing acts while a verdict is saved and the next track loads.
      if (waveDone) {
        if (event.key === "Escape") setWaveDoneFor(null);
        return;
      }
      if (busy || confirmReplace || confirmRejectPicked || noneFitsDraft || draft.pending) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // BL-175 (§2.9): the keys only pictures have, first -- for a picture or clip on screen, or while the layer is open.
      if (layer !== null || visualEntry) {
        const v = visualKeyAction(event.key);
        // Enter on a focused button, switch or link keeps its own meaning.
        const opensLayer = v === "grid" || v === "loupe" || v === "compare";
        // Phase 2: «Было / Исправлено» of a re-check is compare only -- no grid, no loupe.
        if (v && !(v === "loupe" && target?.closest("button, [role=switch], [role=button], a")) && !(v === "close" && layer === null) && !(opensLayer && ((layer === null && !layerable) || against === "before"))) {
          event.preventDefault();
          // A held key never picks and unpicks, nor flickers the grid or the zoom (review rounds 1 and 2); frames step while held.
          if (event.repeat && v !== "frameBack" && v !== "frameForward") return;
          if (v === "close") {
            setLayer(layer !== "grid" && layerBack === "grid" ? "grid" : null);
            setLayerBack(null);
          }
          else if (v === "zoom") {
            if (layer) layerRef.current?.zoom();
            else imageViewer.current?.toggleActual();
          } else if (v === "frameBack" || v === "frameForward") {
            const direction = v === "frameBack" ? -1 : 1;
            if (layer) layerRef.current?.frame(direction);
            else videoPlayer.current?.stepFrame(direction);
          } else if (v === "grid") setLayer((l) => (l === "grid" ? null : "grid"));
          else if (v === "loupe") {
            if (layerable) {
              // Esc goes back to the grid when the layer started there -- also after loupe <-> compare (review round 2).
              setLayerBack(layer === "grid" ? "grid" : layer !== null ? layerBack : null);
              setLayer("loupe");
            }
          } else if (v === "compare") {
            if (comparable) {
              setLayerBack(layer === "grid" ? "grid" : layer !== null ? layerBack : null);
              setLayer("compare");
            } else setMessage({ tone: "ok", text: t("review.layer.compareNeedsTwo") });
          } else if (v === "pick") togglePick(entry);
          return;
        }
      }
      const action = reviewKeyAction(event.key);
      if (!action) return;
      // A focused button or switch keeps Space (review B7) -- also inside the layer (review round 1).
      if (action === "play" && target?.closest("button, [role=switch], a")) return;
      // In the layer only playback and moving between attempts act; a verdict is given on the screen itself.
      if (layer !== null) {
        if (action === "play" || action === "back" || action === "forward" || action === "next" || action === "previous") event.preventDefault();
        // A held N/P never runs through the attempts (review round 2, as on the screen).
        if (event.repeat && (action === "next" || action === "previous")) return;
        if (action === "play") layerRef.current?.togglePlay();
        else if (action === "back") layerRef.current?.seekBy(-1);
        else if (action === "forward") layerRef.current?.seekBy(1);
        else if (action === "next" || action === "previous") {
          const direction = action === "next" ? 1 : -1;
          // In compare, never onto the compared attempt itself (it would compare with itself): one step further.
          let to = stepIndex(entries ?? [], index, direction, skipClaimed);
          const at = (entries ?? [])[to];
          // Comparing with a reference or «Было», no attempt is the other side: nothing to skip.
          const skipCompared = layer === "compare" && against === null;
          if (skipCompared && at && entryKey(at) === compareKey) to = stepIndex(entries ?? [], to, direction, skipClaimed);
          const landed = (entries ?? [])[to];
          // Nowhere else to go (two attempts, the other one compared): stay (review round 3).
          if (!(skipCompared && landed && entryKey(landed) === compareKey)) go(to);
        }
        return;
      }
      // A picture has no A/B and no playhead; a clip seeks a second at a time and marks with a note.
      if (visualEntry && (action === "ab" || (currentMedia === "image" && (action === "play" || action === "back" || action === "forward" || action === "mark")))) return;
      const step = currentMedia === "video" ? 1 : 5;
      // A focused button or switch keeps Space/Enter (review B7); a held key never decides the next attempt too.
      if (action === "play" && target?.closest("button, [role=switch], a")) return;
      if (event.repeat && (action === "accept" || action === "reject" || action === "keep" || action === "next" || action === "previous")) return;
      event.preventDefault();
      const b = onB ? referenceAudio.current : null;
      if (typeof action === "object") setDraft((d) => ({ ...d, rating: action.rating }));
      // While the reference (B) plays, play/seek act on it -- A and B never sound together.
      else if (action === "play") {
        if (b) {
          if (b.paused) b.play().catch(() => undefined);
          else b.pause();
        }
        else player.current?.togglePlay();
      } else if (action === "back") {
        if (b) b.currentTime = Math.max(0, b.currentTime - 5);
        else player.current?.seekBy(-step);
      } else if (action === "forward") {
        if (b) b.currentTime = Math.min(b.duration || b.currentTime + 5, b.currentTime + 5);
        else player.current?.seekBy(step);
      }
      else if (action === "accept") void submit("accepted");
      else if (action === "reject") void submit("rejected");
      // BL-173: only a re-check's question takes "keep" (answerRecheck ignores it anywhere else).
      else if (action === "keep") void answerRecheck("kept");
      else if (action === "next") go(stepIndex(entries ?? [], index, 1, skipClaimed));
      else if (action === "previous") go(stepIndex(entries ?? [], index, -1, skipClaimed));
      else if (action === "mark") mark(visualEntry);
      else if (action === "ab") toggleAB();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [against, answerRecheck, busy, waveDone, comparable, compareKey, confirmRejectPicked, confirmReplace, currentMedia, draft.pending, entries, entry, go, index, layer, layerBack, layerable, mark, noneFitsDraft, skipClaimed, submit, t, toggleAB, togglePick, onB, visualEntry]);
  // Phase 2: compare against «Было» ends where the attempt on screen is no revision of a picture or clip (N/P moved on); a
  // closed layer forgets what it compared against.
  useEffect(() => {
    // Review: any way out of compare (Esc, G, Enter, a button) forgets the reference or «Было» -- C then compares attempts again.
    if (layer !== "compare") {
      if (against !== null) setAgainst(null);
    } else if (against === "before" && !visualRevision) {
      setLayer(null);
      setAgainst(null);
    }
  }, [against, layer, visualRevision]);

  // The reference's volume follows the loudness switch while it plays.
  useEffect(() => {
    const audio = referenceAudio.current;
    if (audio && abSource) audio.volume = matchLoudness ? matchedVolume(abSource.lufs) : 1;
  }, [matchLoudness, abSource, onB]);

  const savedMarkers = useMemo<ReviewMarker[]>(() => {
    if (!entry) return [];
    const findings = blind && entryWaits(entry) ? [] : findingMarkers(entry);
    // BL-173: the spots a re-check asks about, and the marks of the verdict it re-checks.
    const asked = recheckMarkers(entry.recheck, t("review.recheck.spot"));
    const previous = (entry.recheck?.previousVerdict?.markers ?? []).map((m) => ({ start: m.start, end: m.end, label: m.note, tone: "mark" as const }));
    const own = [...(entry.verdict?.markers ?? []), ...draft.marks].map((m) => ({ start: m.start, end: m.end, label: m.note, tone: "mark" as const }));
    return [...findings, ...asked, ...previous, ...own];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `language` re-builds the labels after a language switch
  }, [blind, draft.marks, entry, t, language]);
  // The open mark's label is rebuilt on a language switch (`t` itself keeps one identity, so `language` is in the deps).
  const markers = useMemo<ReviewMarker[]>(
    () => (entry && draft.openMark !== null ? [...savedMarkers, { start: draft.openMark, end: null, label: t("review.openMark"), tone: "mark" as const }] : savedMarkers),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `language` re-builds the label after a language switch
    [savedMarkers, draft.openMark, entry, t, language],
  );

  const src = entry ? playedSrc(base, entry) : null;
  // Owner, msg 2916: the track a verdict moved to is held behind the window until its waveform is ready (the shared hold's 20 s
  // cap keeps a stalled load from blocking the screen for good); another track on screen ends the wait.
  useEffect(() => {
    if (awaitingSrc === null) return;
    if (awaitingSrc !== src) {
      setAwaitingSrc(null);
      return;
    }
    hold(t("review.advancing.loading"));
    return release;
  }, [awaitingSrc, hold, release, src, t]);
  const ownLufs = entry ? playedLufs(entry) : null;
  const lufsOf = entry ? (ownLufs ?? (measured && measured.src === src ? measured.lufs : null)) : null;
  const hideFindings = blind && entry !== null && entryWaits(entry);
  // BL-175 (§A): an image's size in bytes -- one byte asked for, the total read from Content-Range.
  useEffect(() => {
    if (!src || currentMedia !== "image") return;
    let cancelled = false;
    void fetch(src, { headers: { range: "bytes=0-0" } })
      .then((res) => {
        if (!cancelled) setImageBytes({ src, bytes: totalFromContentRange(res.headers.get("content-range")) });
        void res.body?.cancel();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [src, currentMedia]);

  const segment = (selected: boolean) => `rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${selected ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`;
  const toolButton = "flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800/60 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700";
  const picker = pickerWaves(waves, wave, true);
  const allWaiting = (allEntries ?? []).filter(entryWaits).length;
  // BL-173: open re-checks still waiting for an answer here (one answered elsewhere and on its way is not).
  const recheckOption = recheckPickerOption(recheckEntries, wave);
  const rechecksOpen = recheckOption.open;
  const reviewedHere = (entries ?? []).filter((e) => !entryWaits(e)).length;
  const takenElsewhere = (groupId: string) => claims.find((c) => c.scope === "group" && c.groupId === groupId && Date.parse(c.until) > nowMs) ?? null;
  const device = source ? (source.hostname ?? source.deviceId) : null;
  /** The item key without the chosen wave's prefix ("C14/V04" → "V04" inside C14). */
  const shortKey = (itemKey: string) => (wave !== null && itemKey.startsWith(`${wave}/`) ? itemKey.slice(wave.length + 1) : itemKey);
  const copyAttempt = (attemptRef: string) => {
    void navigator.clipboard?.writeText(attemptRef).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined
    );
  };
  const allChecks = entry ? entry.stages.flatMap((st) => st.checks) : [];

  // -- BL-175 (VISUAL_REVIEW_PLAN.md §2.9): pictures and clips ---------------------------------------------------------------
  const auditionSrc = (e: { itemKey: string; attemptRef: string }) => `${base}/audition?itemKey=${encodeURIComponent(e.itemKey)}&attemptRef=${encodeURIComponent(e.attemptRef)}`;
  /** The pins an entry shows: its verdict's (numbered), the draft's and the one waiting for its note on screen, a re-check's spots. */
  const pinsOf = (e: ScreenEntry, current: boolean): ViewerPin[] => {
    const own = [...(e.verdict?.markers ?? []), ...(current ? draft.marks : [])];
    const pins: ViewerPin[] = own.flatMap((m, i) => (m.region ? [{ region: m.region, label: String(i + 1), tone: "mark" as const, title: m.note }] : []));
    for (const m of e.recheck?.markers ?? []) if (m.region) pins.push({ region: m.region, label: "?", tone: "question", title: m.note });
    for (const m of e.recheck?.previousVerdict?.markers ?? []) if (m.region) pins.push({ region: m.region, label: "·", tone: "previous", title: m.note });
    if (current && draft.pending?.region) pins.push({ region: draft.pending.region, label: String(own.length + 1), tone: "draft" });
    return pins;
  };
  /** A clip's markers on its timeline: the validator's findings (unless blind), the verdict's and the draft's (numbered, with pins). */
  const videoMarkersOf = (e: ScreenEntry, current: boolean): VideoMarker[] => {
    const findings = blind && entryWaits(e) ? [] : findingMarkers(e).map((m) => ({ start: m.start, end: m.end, label: m.label, tone: "finding" as const }));
    const own = [...(e.verdict?.markers ?? []), ...(current ? draft.marks : [])].map((m, i) => ({ start: m.start, end: m.end, label: m.note ? `${i + 1}. ${m.note}` : String(i + 1), tone: "mark" as const, ...(m.region ? { region: m.region } : {}) }));
    const asked = (e.recheck?.markers ?? []).map((m) => ({ start: m.start, end: m.end, label: m.note, tone: "question" as const, ...(m.region ? { region: m.region } : {}) }));
    const open = current && draft.openMark !== null ? [{ start: draft.openMark, end: null, label: t("review.openMark"), tone: "mark" as const }] : [];
    const pending = current && draft.pending ? [{ start: draft.pending.start, end: draft.pending.end, label: String(own.length + 1), tone: "mark" as const, ...(draft.pending.region ? { region: draft.pending.region } : {}) }] : [];
    return [...findings, ...asked, ...own, ...open, ...pending];
  };
  const layerEntryOf = (e: ScreenEntry): LayerEntry => {
    const current = entry !== null && entryKey(e) === entryKey(entry);
    const media = screenMedia(e) as "image" | "video";
    return {
      key: entryKey(e),
      itemKey: e.itemKey,
      attemptRef: e.attemptRef,
      seed: e.seed,
      media,
      ...(e.picked ? { picked: e.picked } : {}),
      ...(e.pickSent ? { pickSent: true } : {}),
      ...(e.notChosen ? { notChosen: true } : {}),
      verdict: e.verdict ? { result: e.verdict.result, rating: e.verdict.rating } : null,
      validator: validatorOfEntry(e),
      fullSrc: auditionSrc(e),
      previewSrc: media === "image" ? `${base}/preview?itemKey=${encodeURIComponent(e.itemKey)}&attemptRef=${encodeURIComponent(e.attemptRef)}` : null,
      fps: fpsFromMetrics(e.stages),
      pins: pinsOf(e, current),
      markers: videoMarkersOf(e, current),
    };
  };
  const itemPickInfo = (itemKey: string) => ({
    picked: (allEntries ?? []).filter((e) => e.itemKey === itemKey && e.picked).length,
    target: pickItems.get(itemKey)?.pickTarget ?? 1,
    noneFits: Boolean(pickItems.get(itemKey)?.noneFits),
  });
  const itemStrip = entry && visualEntry ? visualWalk.filter((e) => e.itemKey === entry.itemKey) : [];
  const currentNoneFits = entry ? (pickItems.get(entry.itemKey)?.noneFits ?? null) : null;
  const currentPickTarget = entry ? (pickItems.get(entry.itemKey)?.pickTarget ?? 1) : 1;
  // BL-229 part B (AC-MR-09/10): a wave with a genre -- its header and colour, two rows of chips, and its questions.
  const reasonRows = entry ? reasonRowsFor(currentMedia, entry.groupId, reviewReasons, REVIEW_REASONS, reviewForms) : null;
  const screenGenre = genreOf(reviewForms, entry?.groupId ?? (wave !== null && wave !== RECHECKS_WAVE ? wave : null));
  const tint = genreTintStyle(screenGenre);
  const formSections = entry && !entry.recheck ? formSectionsFor(reviewForms, entry.groupId) : { general: [], genre: [] };
  const unanswered = missingRequired([...formSections.general, ...formSections.genre], draft.answers);
  const verdictBlocked = unanswered.length > 0;
  const toggleReason = (reason: string) => setDraft((d) => ({ ...d, reasons: d.reasons.includes(reason) ? d.reasons.filter((r) => r !== reason) : [...d.reasons, reason] }));
  /** One row of reason chips (a plan's or wave's own, the image / video defaults, or music's ten with their icons). */
  const chipButtons = (chips: ReasonChips) =>
    chips.source === "audio"
      ? REVIEW_REASONS.map((reason) => {
          const on = draft.reasons.includes(reason);
          return (
            <button key={reason} type="button" aria-pressed={on} onClick={() => toggleReason(reason)} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors ${on ? "border-red-400 bg-red-500/25 text-red-100" : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500"}`}>
              <span aria-hidden="true">{REVIEW_REASON_ICONS[reason]}</span>
              {t(REVIEW_REASON_KEYS[reason])}
            </button>
          );
        })
      : chips.values.map((reason) => {
          const on = draft.reasons.includes(reason);
          return (
            <button key={reason} type="button" aria-pressed={on} onClick={() => toggleReason(reason)} className={`rounded-full border px-3 py-1 text-sm transition-colors ${on ? "border-red-400 bg-red-500/25 text-red-100" : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500"}`}>
              {chips.source === "custom" ? reason : reasonLabel(t, reason)}
            </button>
          );
        });
  const openLayer = (mode: LayerMode, fromLayer = false) => {
    setAgainst(null);
    if (mode === "compare" && !comparable) {
      setMessage({ tone: "ok", text: t("review.layer.compareNeedsTwo") });
      setLayer("grid");
      return;
    }
    setLayerBack(fromLayer && mode !== "grid" ? (layer === "grid" ? "grid" : layerBack) : null);
    setLayer(mode);
  };
  /** Phase 2 (§E): compare the picture or clip on screen with a plan reference, or a revision with «Было». */
  const openAgainst = (kind: "reference" | "before") => {
    setAgainst(kind);
    setLayerBack(null);
    setLayer("compare");
  };
  /** The second side of compare when it is not an attempt: the chosen reference, or the attempt's file before this revision. */
  const againstEntry: LayerEntry | null = (() => {
    if (!entry || layer !== "compare") return null;
    const blank = { itemKey: entry.itemKey, seed: null, verdict: null, validator: null, previewSrc: null, fps: null, pins: [], markers: [], noPick: true };
    if (against === "reference" && chosenVisual) {
      const media = mediaKindOf(chosenVisual.file) === "video" ? "video" : "image";
      return { ...blank, key: `~reference\u0000${chosenVisual.id}`, attemptRef: chosenVisual.id, media, fullSrc: `${base}/reference?id=${encodeURIComponent(chosenVisual.id)}`, caption: t("review.compare.reference", { label: chosenVisual.label }) };
    }
    if (against === "before" && visualRevision) {
      // «Было» plays the attempt's current file (an earlier accepted revision, else the original), as the music A/B does.
      const media = (isVisual(entry.media) ? entry.media : currentMedia) === "video" ? "video" : "image";
      return { ...blank, key: `~before\u0000${entry.attemptRef}`, attemptRef: entry.attemptRef, media, fullSrc: auditionSrc(entry), caption: t("review.recheck.before") };
    }
    return null;
  })();
  /** BL-175 (§C): the note of the mark just set -- typed when it is set (Enter keeps it, Esc drops the mark). Floating over the layer. */
  const pendingNoteBox = (floating: boolean) =>
    draft.pending ? (
      <>
        {/* Review round 2: over the layer it holds the focus (Tab stays in it; the layer's own hold steps aside). */}
        {floating ? <HoldFocus formRef={noteBoxForm} /> : null}
        <form
          ref={floating ? noteBoxForm : undefined}
          onSubmit={(event) => {
            event.preventDefault();
            savePending();
          }}
          className={`flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/60 bg-zinc-900 p-2 shadow-lg ${floating ? "fixed bottom-6 left-1/2 z-[55] w-[min(40rem,90vw)] -translate-x-1/2" : ""}`}
        >
          <span className="text-xs text-amber-200">{t("review.pin.noteLabel", { number: (entry?.verdict?.markers.length ?? 0) + draft.marks.length + 1 })}</span>
          <input
            autoFocus
            value={draft.pending.note ?? ""}
            maxLength={200}
            placeholder={t("review.pin.notePlaceholder")}
            onChange={(event) => {
              const note = event.target.value;
              setDraft((d) => (d.pending ? { ...d, pending: { ...d.pending, note } } : d));
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelPending();
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
          />
          <button type="submit" disabled={!draft.pending.note?.trim()} className="rounded-md bg-amber-500/80 px-3 py-1 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-40">
            {t("review.pin.save")}
          </button>
          <button type="button" onClick={cancelPending} className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
            {t("review.pin.cancel")}
          </button>
        </form>
      </>
    ) : null;
  /** BL-175 (§B): "none of these fits", with the owner's note -- and, on this computer's own plan, a request to generate again. */
  const submitNoneFits = async () => {
    const d = noneFitsDraft;
    if (!d || !d.note.trim()) return;
    const ok = await pickAction({ itemKey: d.itemKey }, "none_fits", d.note);
    if (!ok) return;
    setNoneFitsDraft(null);
    if (d.rerun && device === null) {
      await postJson(t, `${base}/rerun-request`, { itemKey: d.itemKey, note: d.note.trim() })
        .then(() => setMessage({ tone: "ok", text: t("review.noneFits.doneRerun", { item: d.itemKey }) }))
        .catch((error: unknown) => setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.rerunFailed") }));
    }
  };

  // BL-162 (MEDIA_UX_REDESIGN_PLAN.md §2.1, owner msgs 2254/2263): a review workstation -- one toolbar, then three columns that
  // fill the screen and scroll on their own: the player with the verdict under it, the auto-check, and the wave's queue (owner,
  // msg 2276: the queue on the right).
  return (
    <div style={tint ? { ...tint, borderColor: "var(--genre-color)" } : undefined} className="flex h-[calc(100vh-6.25rem)] min-h-[34rem] flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      {/* BL-229 part B (AC-MR-10): the wave's genre, obvious at the top, in its colour. */}
      {screenGenre && <GenreHeader genre={screenGenre} />}
      {/* The toolbar (AC-UX-04): back, whose plan, the wave picker, progress, the validator filter, the wave's details, View. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <button type="button" onClick={onClose} className={toolButton}>
          ← {t("review.backToPlan")}
        </button>
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          {channel?.title ? <span className="max-w-40 truncate text-zinc-500">{channel.title}</span> : null}
          <span className="font-mono text-zinc-300">{planId}</span>
          <span className="text-zinc-600">›</span>
          {/* AC-UX-07: the waves as a list -- those with tracks waiting first, the reviewed ones under them. */}
          <Popover
            trigger={
              <>
                <span className="font-medium text-white">{wave === RECHECKS_WAVE ? t("review.rechecks.wave") : (wave ?? t("review.wave.all"))}</span>
                <span className="text-zinc-400">{wave === RECHECKS_WAVE ? rechecksOpen : wave === null ? allWaiting : (chosenWave ? chosenWave.waitingPassed + chosenWave.waitingRejected : 0)}</span>
                <span className="text-zinc-500">▾</span>
              </>
            }
            triggerClassName={toolButton}
            label={t("review.wave.label")}
            panelClassName="max-h-[60vh] w-80 overflow-y-auto p-1"
          >
            {(close) => {
              const option = (w: WaveSummary | null) => {
                const id = w?.groupId ?? null;
                const left = w ? w.waitingPassed + w.waitingRejected : allWaiting;
                return (
                  <button
                    key={id ?? "all"}
                    type="button"
                    onClick={() => {
                      chooseWave(id);
                      close();
                    }}
                    title={w?.title}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${wave === id ? "bg-violet-500/20 text-white" : "text-zinc-200 hover:bg-zinc-800"}`}
                  >
                    <span className="w-14 shrink-0 font-mono">{id ?? t("review.wave.all")}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{w && w.title !== w.groupId ? w.title : ""}</span>
                    {w && takenElsewhere(w.groupId) ? <span className="text-xs text-sky-300">{t("review.wave.takenMark")}</span> : null}
                    {left > 0 ? <span className="rounded bg-amber-500/15 px-1.5 text-xs text-amber-300">{left}</span> : <span className="text-xs text-emerald-400">✓</span>}
                  </button>
                );
              };
              const open = picker.shown.filter((w) => w.waitingPassed + w.waitingRejected > 0);
              const done = picker.shown.filter((w) => w.waitingPassed + w.waitingRejected === 0);
              return (
                <>
                  {/* BL-173 (§2.8): the re-checks, above the waves and apart from them. */}
                  {recheckOption.shown && (
                    <button
                      type="button"
                      onClick={() => {
                        chooseWave(RECHECKS_WAVE);
                        close();
                      }}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${wave === RECHECKS_WAVE ? "bg-violet-500/20 text-white" : "text-sky-200 hover:bg-zinc-800"}`}
                    >
                      <span className="min-w-0 flex-1 truncate">↺ {t("review.rechecks.wave")}</span>
                      {rechecksOpen > 0 ? <span className="rounded bg-sky-500/15 px-1.5 text-xs text-sky-300">{rechecksOpen}</span> : <span className="text-xs text-emerald-400">✓</span>}
                    </button>
                  )}
                  {option(null)}
                  {open.map(option)}
                  {done.length > 0 && <p className="px-2 pb-1 pt-2 text-[11px] uppercase tracking-wide text-zinc-500">{t("review.wave.reviewedGroup")}</p>}
                  {done.map(option)}
                </>
              );
            }}
          </Popover>
        </div>
        {entries && entries.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <div className="h-1.5 w-24 overflow-hidden rounded bg-zinc-800">
              <div className="h-full bg-emerald-500" style={{ width: `${Math.round((reviewedHere / entries.length) * 100)}%`, ...(tint ? { backgroundColor: "var(--genre-color)" } : {}) }} />
            </div>
            {t("review.progress", { reviewed: reviewedHere, total: entries.length })}
          </div>
        )}
        {wave !== RECHECKS_WAVE && (filterCounts.anyRejected || filter !== "all") && (
          <div className="inline-flex gap-1 rounded-lg bg-zinc-950 p-1" role="tablist" aria-label={t("review.filter.label")}>
            {(["all", "passed", "rejected"] as const).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => chooseFilter(f)} className={segment(filter === f)}>
                {t(f === "all" ? "review.filter.all" : f === "passed" ? "review.filter.passed" : "review.filter.rejected", { count: filterCounts[f] })}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {device && <span className="rounded-full border border-sky-900 px-2 py-0.5 text-xs text-sky-200">{t("review.onDevice", { device })}</span>}
          {/* AC-UX-03: the wave's details on request. */}
          {chosenWave && (
            <Popover trigger={<>ⓘ {t("review.wave.about")}</>} triggerClassName={toolButton} align="right" panelClassName="max-h-[70vh] w-[32rem] max-w-[80vw] space-y-2 overflow-y-auto p-3 text-xs text-zinc-300">
              <p className="text-sm font-medium text-zinc-100">{chosenWave.title}</p>
              {chosenBatch?.ownerNote && <p className="whitespace-pre-wrap text-amber-200">{t("plans.ownerNote", { note: chosenBatch.ownerNote })}</p>}
              {chosenBatch?.note && <p className="whitespace-pre-wrap">{chosenBatch.note}</p>}
              <p className="text-zinc-400">
                {[
                  chosenBatch?.firstAt ? t("review.wave.date", { date: formatDisplayDate(chosenBatch.firstAt) }) : null,
                  chosenBatch && chosenBatch.templates.length > 0 ? t("review.wave.templates", { templates: chosenBatch.templates.join(", ") }) : null,
                  chosenBatch && chosenBatch.validator.passed + chosenBatch.validator.rejected > 0
                    ? t("review.wave.passRate", {
                        passed: chosenBatch.validator.passed,
                        total: chosenBatch.validator.passed + chosenBatch.validator.rejected,
                        percent: Math.round((chosenBatch.validator.passed / (chosenBatch.validator.passed + chosenBatch.validator.rejected)) * 100),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {chosenBatch && chosenBatch.differingParams.length > 0 && (
                <ul className="max-h-64 space-y-1 overflow-y-auto text-zinc-400">
                  {chosenBatch.differingParams.map((p) => (
                    <li key={p.name}>
                      <span className="font-mono text-zinc-300">{p.name}</span>: {p.values.map((v) => String(v)).join(" | ")}
                    </li>
                  ))}
                </ul>
              )}
            </Popover>
          )}
          {/* AC-UX-01: the view switches, each with its caption, in one place. */}
          <Popover trigger={<>{t("review.view.label")} ▾</>} triggerClassName={toolButton} align="right" panelClassName="w-80 space-y-3 p-3 text-sm text-zinc-200">
            <label className="flex cursor-pointer items-center gap-3">
              <ToggleSwitch tone="violet" label={t("review.matchLoudness")} checked={matchLoudness} onChange={setMatchLoudness} />
              <span>{t("review.matchLoudness")}</span>
            </label>
            <label className="flex cursor-pointer items-center gap-3">
              <ToggleSwitch tone="violet" label={t("review.spectrogram")} checked={showSpectrogram} onChange={setShowSpectrogram} />
              <span>{t("review.spectrogram")}</span>
            </label>
            <div className="space-y-1">
              <label className="flex cursor-pointer items-center gap-3">
                <ToggleSwitch tone="violet" label={t("review.blind")} checked={blind} onChange={setBlind} />
                <span>{t("review.blindShort")}</span>
              </label>
              <p className="pl-14 text-xs text-zinc-500">{t("review.blindInfo")}</p>
            </div>
          </Popover>
        </div>
      </div>

      {/* Review: the first load still running, or failed -- said, not three empty columns. */}
      {entries === null ? (
        message?.tone === "error" ? (
          <p className="p-6 text-sm text-red-400">{message.text}</p>
        ) : (
          // BL-195 stage E: placeholders where the player and the queue will be.
          <SkeletonLines lines={6} className="p-6" />
        )
      ) : entries.length === 0 ? (
        <p className="p-6 text-sm text-zinc-500">{wave === RECHECKS_WAVE ? t("review.rechecks.none") : t("review.empty")}</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_19rem_16rem] divide-x divide-zinc-800">
          {/* Left: the track, the player and the verdict right under it. */}
          <div className="min-h-0 overflow-y-auto p-4">
            {entry && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h2 className="font-mono text-xl font-semibold text-white">{entry.itemKey}</h2>
                  <span className="text-sm text-zinc-500">
                    {entry.seed !== null ? t("review.trackMeta", { seed: String(entry.seed), index: index + 1, total: entries?.length ?? 0 }) : t("review.trackMetaNoSeed", { index: index + 1, total: entries?.length ?? 0 })}
                  </span>
                  {/* BL-175: a picture names its attempt (several attempts of one item look alike), and says whether it is picked. */}
                  {visualEntry && entry.seed === null ? (
                    <span className="font-mono text-xs text-zinc-400" title={entry.attemptRef}>
                      {attemptLabel(entry)}
                    </span>
                  ) : null}
                  {entry.picked ? (
                    <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-200" title={entry.picked.device ? t("review.pick.by", { device: entry.picked.device, time: formatDisplayDateTime(entry.picked.at) }) : undefined}>
                      ★ {t("review.pick.picked")}
                      {entry.pickSent && device ? ` · ${t("review.sentWaitingFor", { device })}` : ""}
                    </span>
                  ) : entry.notChosen ? (
                    <span className="rounded-full bg-zinc-700/70 px-2 py-0.5 text-xs text-zinc-300">{t("review.pick.notChosen")}</span>
                  ) : null}
                  <span className="flex items-center gap-1">
                    <button type="button" onClick={() => go(stepIndex(entries ?? [], index, -1, skipClaimed))} className="rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label={t("review.previous")} title={t("review.previous")}>
                      ←
                    </button>
                    <button type="button" onClick={() => go(stepIndex(entries ?? [], index, 1, skipClaimed))} className="rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label={t("review.next")} title={t("review.next")}>
                      →
                    </button>
                  </span>
                  {/* AC-UX-05: the attempt's id is copied, not shown. */}
                  <button type="button" onClick={() => copyAttempt(entry.attemptRef)} title={`${t("review.copyId")}: ${entry.attemptRef}`} className="rounded border border-zinc-800 px-1.5 text-[11px] text-zinc-500 hover:border-zinc-600 hover:text-zinc-200">
                    {copied ? t("review.copied") : t("review.copyIdShort")}
                  </button>
                  {entry.verdict && (
                    <span className={`ml-auto rounded-full px-2.5 py-0.5 text-xs ${entry.verdict.result === "accepted" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                      {entry.pendingKept
                        ? t("review.recheck.keptBadge", { result: resultLabel(t, entry.verdict.result) })
                        : entry.verdict.reportedBy === "owner"
                          ? t("review.verdictYour", { result: resultLabel(t, entry.verdict.result) })
                          : t("review.verdictRelayed", { result: resultLabel(t, entry.verdict.result) })}
                      {entry.verdict.note?.startsWith(SENT_NOTE_PREFIX) ? ` · ${t("review.sentWaitingFor", { device: entry.verdict.note.slice(SENT_NOTE_PREFIX.length) })}` : ""}
                      {entry.pendingFrom ? ` · ${t("review.beingApplied", { device: entry.pendingFrom })}` : ""}
                      {entry.verdict.rating !== null ? ` ${entry.verdict.rating}/10` : ""}
                    </span>
                  )}
                </div>
                {/* BL-157 (AC-TC-02): another computer is on this track (or its wave) right now. */}
                {(() => {
                  const claim = claimOf(entry, claims, nowMs);
                  return claim && entryWaits(entry) ? (
                    <p className="rounded-md border border-sky-900/60 bg-sky-950/30 px-3 py-1.5 text-xs text-sky-200">{t("review.claimedBy", { device: claim.device, time: formatDisplayDateTime(claim.since) })}</p>
                  ) : null;
                })()}
                {/* BL-153 AC-RR-07: a rejected attempt's failed checks in one line by the player -- fail before warn, with the miss. */}
                {!hideFindings && validatorOfEntry(entry) === "rejected" && failedChecksOf(entry).length > 0 && (
                  <p className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-xs text-red-200">
                    <span className="font-medium">{t("review.failedChecks")}</span>{" "}
                    {failedChecksOf(entry)
                      .map((c) =>
                        [
                          t(c.severity === "fail" ? "review.failedCheck.fail" : "review.failedCheck.warn", { label: c.label, value: String(c.value ?? "—"), threshold: String(c.threshold ?? "—") }),
                          c.offPercent !== null ? t("review.failedCheck.off", { percent: String(c.offPercent) }) : null,
                          c.atSeconds ? t("review.atRange", { start: formatPlayerTime(c.atSeconds[0]), end: formatPlayerTime(c.atSeconds[1]) }) : null,
                        ]
                          .filter(Boolean)
                          .join(" ")
                      )
                      .join(" · ")}
                  </p>
                )}
                {/* BL-173 (§2.8): what the Operator sends back, why, and the verdict it re-checks. */}
                {entry.recheck && (
                  <section className="space-y-1.5 rounded-xl border border-sky-800/60 bg-sky-950/25 px-3 py-2 text-sm">
                    <p className="font-medium text-sky-100">{t(entry.recheck.kind === "revision" ? "review.recheck.revisionTitle" : "review.recheck.questionTitle", { title: entry.recheck.title })}</p>
                    <p className="whitespace-pre-wrap text-zinc-300">{entry.recheck.note}</p>
                    {entry.recheck.previousVerdict && (
                      <div className="space-y-0.5 text-xs text-zinc-400">
                        <p>
                          {t("review.recheck.previous", {
                            result: resultLabel(t, entry.recheck.previousVerdict.result),
                            rating: entry.recheck.previousVerdict.rating !== null ? ` ${entry.recheck.previousVerdict.rating}/10` : "",
                            device: entry.recheck.previousVerdict.device ?? "—",
                            time: formatDisplayDateTime(entry.recheck.previousVerdict.at),
                          })}
                        </p>
                        {entry.recheck.previousVerdict.reasons.length > 0 && (
                          <p>{t("review.recheck.previousReasons", { reasons: entry.recheck.previousVerdict.reasons.map((r) => reasonLabel(t, r)).join(", ") })}</p>
                        )}
                        {entry.recheck.previousVerdict.note && <p className="whitespace-pre-wrap">{t("review.recheck.previousNote", { note: entry.recheck.previousVerdict.note })}</p>}
                      </div>
                    )}
                    {entry.recheck.markers.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {entry.recheck.markers.map((m, i) => (
                          <button key={i} type="button" onClick={() => player.current?.playFrom(m.start)} title={m.note ?? undefined} className="rounded-md border border-sky-700 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-900/40">
                            ▶ {t("review.recheck.goTo", { time: formatPlayerTime(m.start) })}
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                )}
                {entry.playable && src && visualEntry ? (
                  <div className="space-y-2">
                    {currentMedia === "image" ? (
                      <MediaImageViewer key={src} ref={imageViewer} src={src} pins={pinsOf(entry, true)} onAddPin={entry.recheck ? undefined : (region) => addPin(region)} bytes={imageBytes && imageBytes.src === src ? imageBytes.bytes : null} />
                    ) : (
                      <MediaVideoPlayer
                        key={src}
                        ref={(h) => {
                          videoPlayer.current = h;
                          player.current = h;
                        }}
                        src={src}
                        markers={videoMarkersOf(entry, true)}
                        fps={fpsFromMetrics(entry.stages)}
                        onAddPin={entry.recheck ? undefined : addPin}
                        initialTime={questionStart(entry.recheck)}
                        seam={seamOn && loopClip}
                      />
                    )}
                    {layer === null && draft.pending ? pendingNoteBox(false) : null}
                    {/* The item's attempts side by side: the quickest "one of N" (§B); the grid shows them large. */}
                    {itemStrip.length > 1 && (
                      <ul className="flex gap-2 overflow-x-auto pb-1" aria-label={t("review.strip.label")}>
                        {itemStrip.map((e) => {
                          const k = entryKey(e);
                          const isCurrent = k === entryKey(entry);
                          const i = (entries ?? []).findIndex((x) => entryKey(x) === k);
                          return (
                            <li key={k} className="shrink-0">
                              <button
                                type="button"
                                onClick={(event) => {
                                  if (event.shiftKey || event.metaKey || event.ctrlKey) setCompareKey((c) => (c === k ? null : k));
                                  else if (!isCurrent && i >= 0) {
                                    pickedByHand.current = k;
                                    go(i);
                                  }
                                }}
                                title={e.attemptRef}
                                className={`relative block h-16 w-24 overflow-hidden rounded-md border bg-black ${isCurrent ? "border-violet-400 ring-2 ring-violet-400/60" : compareKey === k ? "border-sky-400" : e.picked ? "border-amber-400" : "border-zinc-700 hover:border-zinc-500"} ${e.notChosen ? "opacity-50" : ""}`}
                              >
                                {screenMedia(e) === "image" ? (
                                  // eslint-disable-next-line @next/next/no-img-element -- a local preview of this computer's file
                                  <img src={`${base}/preview?itemKey=${encodeURIComponent(e.itemKey)}&attemptRef=${encodeURIComponent(e.attemptRef)}`} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                                ) : (
                                  <video src={auditionSrc(e)} preload="metadata" muted playsInline className="h-full w-full object-cover" />
                                )}
                                {e.picked ? <span className="absolute right-0.5 top-0.5 rounded bg-black/70 px-1 text-[11px] text-amber-300">★</span> : null}
                                {e.verdict ? <span className={`absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[11px] ${e.verdict.result === "accepted" ? "text-emerald-300" : "text-rose-300"}`}>{e.verdict.result === "accepted" ? "✓" : "✗"}</span> : null}
                                <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-[10px] text-zinc-200">{attemptLabel(e)}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {/* Review round 2: an open re-check shows its own file here only -- no grid, loupe or compare on it. */}
                    {layerable && (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <button type="button" onClick={() => openLayer("grid")} className={toolButton}>
                          {t("review.layer.grid")}
                          {/* ui-text-ignore: a keyboard key */}
                          <kbd className="text-[10px] text-zinc-500">G</kbd>
                        </button>
                        <button type="button" onClick={() => openLayer("loupe")} className={toolButton}>
                          {t("review.layer.loupe")}
                          {/* ui-text-ignore: a keyboard key */}
                          <kbd className="text-[10px] text-zinc-500">Enter</kbd>
                        </button>
                        <button type="button" onClick={() => openLayer("compare")} className={toolButton}>
                          {t("review.layer.compare")}
                          {/* ui-text-ignore: a keyboard key */}
                          <kbd className="text-[10px] text-zinc-500">C</kbd>
                        </button>
                        <span className="text-zinc-500">{t("review.strip.compareHint")}</span>
                      </div>
                    )}
                    {/* Phase 2 (§E/§F): «Было / Исправлено», references, «Как в ленте», the loop tools. */}
                    {visualRevision && (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <button type="button" onClick={() => openAgainst("before")} className={toolButton}>
                          {t("review.compare.beforeAfter")}
                        </button>
                        <span className="text-zinc-500">{t("review.compare.beforeAfterHint")}</span>
                      </div>
                    )}
                    {layerable && visualOffered.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <label className="flex items-center gap-2 text-zinc-400">
                          <span>{t("review.compare.referenceLabel")}</span>
                          <select value={chosenVisual?.id ?? ""} onChange={(event) => setVisualRefId(event.target.value)} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100">
                            {visualOffered.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.nearest ? t("review.compare.referenceNearest", { label: r.label }) : r.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button type="button" disabled={!chosenVisual} onClick={() => openAgainst("reference")} className={toolButton}>
                          {t("review.compare.withReference")}
                        </button>
                      </div>
                    )}
                    {currentMedia === "image" && (
                      <label className="flex items-center gap-2 text-xs text-zinc-300">
                        <ToggleSwitch tone="violet" label={t("review.feed.toggle")} checked={feedOn} onChange={setFeedOn} />
                        <span>{t("review.feed.toggle")}</span>
                      </label>
                    )}
                    {feedOn && currentMedia === "image" ? <FeedPreview src={src} /> : null}
                    {loopClip && (
                      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-300">
                        <span className="font-medium text-zinc-400">{t("review.loop.title")}</span>
                        <label className="flex items-center gap-2">
                          <ToggleSwitch tone="violet" label={t("review.loop.seam")} checked={seamOn} onChange={setSeamOn} />
                          <span>{t("review.loop.seam")}</span>
                        </label>
                        <button type="button" onClick={() => videoPlayer.current?.playTimes(5)} className={toolButton}>
                          {t("review.loop.fiveTimes")}
                        </button>
                        <label className="flex items-center gap-2">
                          <ToggleSwitch tone="violet" label={t("review.loop.frames")} checked={seamFramesOn} onChange={setSeamFramesOn} />
                          <span>{t("review.loop.frames")}</span>
                        </label>
                      </div>
                    )}
                    {loopClip && seamFramesOn ? <SeamFrames key={`seam:${src}`} src={src} fps={fpsFromMetrics(entry.stages)} /> : null}
                  </div>
                ) : entry.playable && src ? (
                  <div className="space-y-1.5">
                    <MediaReviewPlayer
                      key={src}
                      ref={player}
                      src={src}
                      height={160}
                      onSettled={() => setAwaitingSrc((waiting) => (waiting === src ? null : waiting))}
                      markers={markers}
                      spectrogram={showSpectrogram}
                      onPlayStart={() => {
                        // Starting A (its own Play button) stops B.
                        if (referenceAudio.current && !referenceAudio.current.paused) referenceAudio.current.pause();
                        setOnB(false);
                      }}
                      frequencyMarks={hideFindings ? [] : frequencyMarksOf(t, entry)}
                      volume={matchLoudness ? matchedVolume(lufsOf) : 1}
                      onDecoded={(audio) => {
                        // Measured only when the validator gave no LUFS (AC-GP3-04); BL-173: a revision's own, never the original's.
                        if (playedLufs(entry) === null) setMeasured({ src, lufs: integratedLoudness(audio.channels, audio.sampleRate) });
                        // BL-173 (§2.8): a re-check's question opens at its first spot.
                        const first = entry.recheck?.kind === "question" ? entry.recheck.markers[0] : undefined;
                        if (first) player.current?.seekBy(first.start - (player.current?.currentTime() ?? 0));
                      }}
                      toolbar={
                        abSource ? (
                          <>
                            {isRevision || !chosen ? (
                              <span>{t("review.recheck.compare")}</span>
                            ) : (
                              <>
                                <span>{t("review.compareWith")}</span>
                                <select
                                  value={chosen.id}
                                  onChange={(e) => {
                                    stopB();
                                    setReferenceId(e.target.value);
                                  }}
                                  title={offered.some((r) => r.nearest) ? t("review.nearestHint") : undefined}
                                  className="max-w-56 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                                >
                                  {offered.map((r) => (
                                    <option key={r.id} value={r.id}>
                                      {r.nearest ? "★ " : ""}
                                      {r.label}
                                    </option>
                                  ))}
                                </select>
                              </>
                            )}
                            <button type="button" onClick={toggleAB} className={`rounded-md border px-2.5 py-1 ${onB ? "border-amber-400 bg-amber-500/20 text-amber-200" : "border-zinc-700 text-zinc-200 hover:bg-zinc-800"}`}>
                              {onB ? t("review.abOnB", { label: abSource.label }) : t("review.ab")}
                            </button>
                            <audio
                              ref={referenceAudio}
                              src={abSource.src}
                              preload="metadata"
                              onEnded={() => {
                                // The reference ran out: back to A where it would be.
                                const at = referenceAudio.current?.currentTime ?? 0;
                                setOnB(false);
                                player.current?.playFrom(at);
                              }}
                              className="hidden"
                            />
                          </>
                        ) : undefined
                      }
                    />
                    <p className="text-[11px] text-zinc-500">
                      {lufsOf === null
                        ? t("review.loudnessUnknown")
                        : t(ownLufs !== null ? "review.loudnessValidator" : "review.loudnessMeasured", { lufs: formatNumber(lufsOf, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
                      {matchLoudness && lufsOf !== null ? ` · ${t("review.playedAt", { percent: Math.round(matchedVolume(lufsOf) * 100), target: LOUDNESS_TARGET_LUFS })}` : ""}
                      {matchLoudness && abSource && abSource.lufs === null ? <span className="ml-2 text-amber-300">{t("review.referenceNoLufs")}</span> : null}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-500">{t("review.nothingToPlay")}</p>
                )}

                {/* The verdict, right under the player (AC-UX-02): the two decisions first, then rating, reasons, comment. */}
                <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
                  {/* BL-175 (§B): one of N -- pick this attempt, or say none of the item's attempts fits. Not a verdict. */}
                  {visualEntry && !entry.recheck && (
                    <div className="space-y-2 border-b border-zinc-800 pb-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          disabled={busy || (!entry.picked && forbidsPick(entry.verdict?.result))}
                          title={!entry.picked && forbidsPick(entry.verdict?.result) ? t("review.pick.rejectedHint") : entry.picked ? t("review.pick.withdrawHint") : undefined}
                          onClick={() => togglePick(entry)}
                          className={`flex items-center gap-2 rounded-lg border px-5 py-2.5 text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${entry.picked ? "border-amber-400 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30" : "border-amber-500/50 bg-amber-500/10 text-amber-100 hover:border-amber-400"}`}
                        >
                          <span aria-hidden="true">★</span>
                          {entry.picked ? t("review.pick.unpick") : t("review.pick.pick")}
                          {/* ui-text-ignore: a keyboard key */}
                          <kbd className="ml-1 rounded border border-amber-500/40 px-1.5 text-xs font-normal text-amber-300/80">S</kbd>
                        </button>
                        <span className="text-xs text-zinc-400">{t("review.pick.count", { picked: itemPickInfo(entry.itemKey).picked, target: currentPickTarget })}</span>
                        {currentNoneFits ? (
                          <span className="ml-auto flex flex-wrap items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300">
                            {t("review.noneFits.marked")}
                            {currentNoneFits.note ? ` · ${currentNoneFits.note}` : ""}
                            {currentNoneFits.sent && device ? ` · ${t("review.sentWaitingFor", { device })}` : currentNoneFits.device ? ` · ${currentNoneFits.device}` : ""}
                            <button type="button" disabled={busy} onClick={() => void pickAction({ itemKey: entry.itemKey }, "clear_none_fits")} className="rounded border border-zinc-600 px-1.5 hover:bg-zinc-800 disabled:opacity-50">
                              {t("review.noneFits.clear")}
                            </button>
                          </span>
                        ) : (
                          <button type="button" disabled={busy} onClick={() => setNoneFitsDraft({ itemKey: entry.itemKey, note: "", rerun: device === null })} className="ml-auto rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
                            {t("review.noneFits.button")}
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-500">{t("review.pick.info")}</p>
                    </div>
                  )}
                  {/* BL-173 (§2.3): a question is answered by keeping the verdict (with a note), or by changing it below. */}
                  {entry.recheck?.kind === "question" && (
                    <div className="flex flex-wrap items-center gap-3">
                      <button type="button" disabled={busy || entry.verdict !== null} onClick={() => void answerRecheck("kept")} className="flex items-center gap-2 rounded-lg border border-sky-500/50 bg-sky-500/10 px-5 py-2.5 text-base font-medium text-sky-100 transition-colors hover:border-sky-400/70 hover:bg-sky-500/20 disabled:opacity-50">
                        <span aria-hidden="true">=</span>
                        {t("review.recheck.keep")}
                        {/* ui-text-ignore: a keyboard key */}
                        <kbd className="ml-1 rounded border border-sky-500/40 px-1.5 text-xs font-normal text-sky-300/80">K</kbd>
                      </button>
                      <span className="text-xs text-zinc-500">{t("review.recheck.orChange")}</span>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    {/* Owner, msg 2269 p.4: calm tinted decisions with their key, not two loud fills. */}
                    <button type="button" disabled={busy || verdictBlocked || (entry.recheck !== undefined && entry.verdict !== null)} onClick={() => void submit("accepted")} style={tint ? { borderColor: "var(--genre-color)", backgroundColor: tintOver("var(--genre-color)", 22) } : undefined} className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-5 py-2.5 text-base font-medium text-emerald-200 transition-colors hover:border-emerald-400/70 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50">
                      <span aria-hidden="true">✓</span>
                      {t("review.accept")}
                      {/* ui-text-ignore: a keyboard key */}
                      <kbd className="ml-1 rounded border border-emerald-500/40 px-1.5 text-xs font-normal text-emerald-300/80">A</kbd>
                    </button>
                    <button type="button" disabled={busy || verdictBlocked || (entry.recheck !== undefined && entry.verdict !== null)} onClick={() => void submit("rejected")} style={tint ? { borderColor: "var(--genre-color)" } : undefined} className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-5 py-2.5 text-base font-medium text-rose-200 transition-colors hover:border-rose-400/70 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50">
                      <span aria-hidden="true">✗</span>
                      {t("review.reject")}
                      {/* ui-text-ignore: a keyboard key */}
                      <kbd className="ml-1 rounded border border-rose-500/40 px-1.5 text-xs font-normal text-rose-300/80">R</kbd>
                    </button>
                    <div className="ml-auto flex flex-wrap items-center gap-1 text-xs text-zinc-400">
                      <span className="mr-1">{t("review.rating")}</span>
                      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                        <button key={n} type="button" onClick={() => setDraft((d) => ({ ...d, rating: d.rating === n ? null : n }))} className={`h-8 w-8 rounded-md text-sm ${draft.rating === n ? "bg-violet-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}>
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                  {verdictBlocked && (
                    <p className="text-xs text-amber-300" role="status">
                      {t("review.form.requiredHint", { count: unanswered.length })}
                    </p>
                  )}
                  {/* BL-229 part B: the review form under the verdict -- the general questions, then the genre's. */}
                  {(formSections.general.length > 0 || formSections.genre.length > 0) && (
                    <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                      <ReviewFormSection title={t("review.form.general")} fields={formSections.general} answers={draft.answers} onAnswer={(id, value) => setDraft((d) => ({ ...d, answers: toggleAnswer(d.answers, id, value) }))} />
                      <ReviewFormSection title={t("review.form.genre", { genre: screenGenre?.title ?? "" })} fields={formSections.genre} answers={draft.answers} onAnswer={(id, value) => setDraft((d) => ({ ...d, answers: toggleAnswer(d.answers, id, value) }))} />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <p className="text-xs text-zinc-400">
                      {t("review.reasons.label")} <span className="text-zinc-600">· {t("review.reasons.hint")}</span>
                    </p>
                    {/* BL-175 (§D): a plan's or wave's own chips, or the image / video defaults; music keeps its ten. BL-229 part B: a wave
                        with a genre shows the general chips, then the genre's, each row named. */}
                    {reasonRows?.kind === "genre" ? (
                      <div className="space-y-2">
                        <div className="space-y-1">
                          <p className="text-[11px] uppercase tracking-wide text-zinc-500">{t("review.genre.generalReasons")}</p>
                          <div className="flex flex-wrap gap-2">{chipButtons(reasonRows.general)}</div>
                        </div>
                        {reasonRows.genre.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-[11px] uppercase tracking-wide text-zinc-500">{t("review.genre.genreReasons", { genre: screenGenre?.title ?? "" })}</p>
                            <div className="flex flex-wrap gap-2">{chipButtons({ source: "custom", values: reasonRows.genre })}</div>
                          </div>
                        )}
                      </div>
                    ) : reasonRows ? (
                      <div className="flex flex-wrap gap-2">{chipButtons(reasonRows.chips)}</div>
                    ) : null}
                  </div>
                  <textarea value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} rows={3} maxLength={2000} placeholder={t("review.notePlaceholder")} className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100" />
                  <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
                    {currentMedia === "image" ? (
                      <span className="text-zinc-500">{t("review.visual.pinHint")}</span>
                    ) : (
                      <button type="button" onClick={() => mark(visualEntry)} className="rounded-md border border-amber-500/60 px-2.5 py-1 text-amber-200 hover:bg-amber-500/10">
                        {draft.openMark === null ? t("review.markAtPlayhead") : t("review.endMark", { time: formatPlayerTime(draft.openMark) })}
                      </button>
                    )}
                    {draft.marks.map((m, i) => (
                      <span key={i} className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-200">
                        {/* BL-175: a picture's marks are numbered like its pins, with their own notes. */}
                        {visualEntry ? `${(entry.verdict?.markers.length ?? 0) + i + 1}. ` : ""}
                        {currentMedia === "image" ? "" : formatPlayerTime(m.start)}
                        {currentMedia !== "image" && m.end !== null ? `–${formatPlayerTime(m.end)}` : ""}
                        {visualEntry && m.note ? ` ${m.note}` : ""}
                        <button type="button" onClick={() => setDraft((d) => ({ ...d, marks: d.marks.filter((_, j) => j !== i) }))} className="ml-1 text-amber-300 hover:text-white" aria-label={t("review.removeMark")}>
                          ×
                        </button>
                      </span>
                    ))}
                    {/* AC-UX-13: on another device's plan this is asked for there -- shown, not hidden. Owner, msg 2255: say what it does.
                        BL-173: a re-check is not an item to generate again. */}
                    {!entry.recheck && (
                    <span className="flex items-center gap-1">
                      <button type="button" disabled={device !== null} onClick={() => void askRerun()} className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50">
                        <span aria-hidden="true">↻</span>
                        {device !== null ? t("review.rerunOnDevice", { device }) : t("review.askRerun")}
                      </button>
                      <InfoTooltip>{t("review.askRerunInfo")}</InfoTooltip>
                    </span>
                    )}
                    <span className="ml-auto flex items-center gap-1 text-zinc-500">
                      {t("review.shortcutsTitle")}
                      <InfoTooltip>{visualEntry ? t("review.shortcutsVisual") : t("review.shortcuts")}</InfoTooltip>
                    </span>
                  </div>
                  {message && <p className={`text-xs ${message.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}>{message.text}</p>}
                </section>

                {/* BL-157 (AC-TC-05): every verdict of this track, with the computer and the time. */}
                {entry.history && entry.history.length > 0 && (
                  <details className="text-xs text-zinc-500">
                    <summary className="cursor-pointer">{t("review.history.title", { count: entry.history.length })}</summary>
                    <ul className="mt-1 space-y-0.5">
                      {entry.history.map((h, i) => (
                        <li key={`${h.at}-${i}`}>
                          {historyLineOf(t, h).text}
                          {/* BL-173: an answer to a re-check names it. */}
                          {h.recheckId ? <span className="text-sky-400/80"> · {historyLineOf(t, h).recheck}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>

          {/* Middle: the auto-check, always in view (owner, msg 2254 p.2) -- the failed checks first (AC-UX-06). */}
          <aside className="min-h-0 space-y-3 overflow-y-auto p-3">
            <h4 className="flex items-baseline justify-between gap-2 text-sm font-medium text-zinc-200">
              {t("review.why.validator")}
              {!hideFindings && allChecks.length > 0 && <span className="text-xs font-normal text-zinc-500">{t("review.checks.passed", { passed: allChecks.filter((c) => c.pass).length, total: allChecks.length })}</span>}
            </h4>
            {!entry ? null : hideFindings ? (
              <p className="text-xs text-zinc-500">{t("review.blindNote")}</p>
            ) : (
              entry.stages.map((stage) => {
                const { failed, passed } = splitChecks(stage.checks);
                const ok = stage.result === "accepted" || stage.result === "done";
                return (
                  <div key={stage.stageId} className="space-y-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-zinc-400">{stage.stageId === RECHECK_STAGE_ID ? t("review.recheck.revisionChecks") : stage.stageId}</span>
                      <span className={`rounded-full px-2 py-0.5 ${ok ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{resultLabel(t, stage.result)}</span>
                    </div>
                    {[...failed, ...passed].map((c) => (
                      <div key={c.id} className={`flex items-start gap-2 rounded-md px-2 py-1 ${c.pass ? "" : "bg-red-500/10 ring-1 ring-red-500/40"}`}>
                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${c.pass ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500 text-white"}`}>{c.pass ? "✓" : "✗"}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2 text-sm">
                            <span className={c.pass ? "text-zinc-300" : "font-medium text-red-200"}>{c.label ?? c.id}</span>
                            <span className={`shrink-0 font-mono text-xs ${c.pass ? "text-zinc-400" : "text-red-200"}`}>
                              {c.value === null ? "—" : String(c.value)}
                              {c.unit ? ` ${c.unit}` : ""}
                            </span>
                          </div>
                          {(c.threshold !== null || c.atSeconds || c.detail) && (
                            <div className="text-[11px] text-zinc-500">
                              {c.threshold !== null ? t("review.limit", { value: String(c.threshold) }) : ""}
                              {c.atSeconds ? (
                                <>
                                  {" "}
                                  <button type="button" onClick={() => c.atSeconds && player.current?.playFrom(c.atSeconds[0])} className="underline decoration-dotted underline-offset-2 hover:text-white">
                                    {t("review.atTime", { time: formatPlayerTime(c.atSeconds[0]) })}
                                  </button>
                                </>
                              ) : null}
                              {c.detail ? ` · ${c.detail}` : ""}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {Object.keys(stage.metrics).length > 0 && (
                      <p className="px-2 text-[11px] text-zinc-500">
                        <span className="text-zinc-400">{t("review.checks.metrics")}: </span>
                        {Object.entries(stage.metrics)
                          .map(([k, v]) => `${k} ${String(v)}`)
                          .join(" · ")}
                      </p>
                    )}
                    {stage.note && <p className="px-2 text-xs text-zinc-400">{stage.note}</p>}
                  </div>
                );
              })
            )}
            {entry && (
              <details className="border-t border-zinc-800 pt-2 text-xs text-zinc-400">
                <summary className="cursor-pointer text-zinc-300">{t("review.generationDetails")}</summary>
                <div className="mt-1 space-y-0.5">
                  {Object.entries(entry.params).length === 0 ? (
                    <div className="text-zinc-500">{t("review.noParams")}</div>
                  ) : (
                    Object.entries(entry.params).map(([k, v]) => (
                      <div key={k} className="break-words">
                        <span className="font-mono text-zinc-300">{k}</span>: {String(v)}
                      </div>
                    ))
                  )}
                </div>
              </details>
            )}
          </aside>
          {/* The queue, rightmost (owner, msg 2276) (AC-UX-15) -- every track of the walk with its state; a click opens it. */}
          <div className="flex min-h-0 flex-col">
            {/* AC-WV-05: the wave is done -- its summary, and the next wave that still waits. */}
            {chosenWave && chosenWave.waitingPassed + chosenWave.waitingRejected === 0 && (
              <div className="space-y-1.5 border-b border-zinc-800 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
                <p>{waveDoneText(chosenWave)}</p>
                {nextWave && (
                  <button type="button" onClick={() => chooseWave(nextWave.groupId)} className="rounded-md bg-violet-600 px-2.5 py-1 font-medium text-white hover:bg-violet-500">
                    {t("review.wave.next", { wave: nextWave.groupId, count: nextWave.waitingPassed + nextWave.waitingRejected })}
                  </button>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {(() => {
                const row = (e: ScreenEntry, i: number) => {
                  const claim = entryWaits(e) ? claimOf(e, claims, nowMs) : null;
                  const current = i === index;
                  const auto = validatorOfEntry(e);
                  return (
                    <li key={`${e.itemKey}\u0000${e.attemptRef}`}>
                      <button
                        type="button"
                        ref={current ? currentRow : undefined}
                        onClick={() => {
                          // The open track again: nothing to do (review: `go` would clear the verdict being written).
                          if (i === index) return;
                          pickedByHand.current = `${e.itemKey}\u0000${e.attemptRef}`;
                          go(i);
                        }}
                        title={claim ? t("review.claimedBy", { device: claim.device, time: formatDisplayDateTime(claim.since) }) : undefined}
                        className={`w-full border-l-2 px-3 py-2 text-left transition-colors ${current ? "border-violet-400 bg-zinc-800" : "border-transparent hover:bg-zinc-800/50"}`}
                      >
                        <span className="flex items-center gap-2">
                          <span className={`min-w-0 truncate text-sm font-medium ${current ? "text-white" : "text-zinc-200"}`}>{shortKey(e.itemKey)}</span>
                          {e.verdict ? (
                            <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] ${e.verdict.result === "accepted" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
                              {e.verdict.result === "accepted" ? "✓" : "✗"}
                              {e.verdict.rating !== null ? ` ${e.verdict.rating}/10` : ""}
                            </span>
                          ) : e.picked ? (
                            // BL-175: picked or not chosen -- settled without a verdict (they are in the reviewed group).
                            <span className="ml-auto shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">★ {t("review.pick.picked")}</span>
                          ) : e.notChosen ? (
                            <span className="ml-auto shrink-0 rounded-full bg-zinc-700/70 px-2 py-0.5 text-[11px] text-zinc-300">{t("review.pick.notChosen")}</span>
                          ) : claim ? (
                            <span className="ml-auto shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-300">{t("review.queue.claimed", { device: claim.device })}</span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 whitespace-nowrap text-xs text-zinc-500">
                          {/* BL-173: a re-check says what it is instead of its seed. */}
                          {e.recheck ? (
                            <span className="min-w-0 truncate text-sky-300/90">{t(e.recheck.kind === "revision" ? "review.recheck.revisionTitle" : "review.recheck.questionTitle", { title: e.recheck.title })}</span>
                          ) : e.seed !== null ? (
                            <span>{t("review.queue.seed", { seed: String(e.seed) })}</span>
                          ) : isVisual(screenMedia(e)) ? (
                            // BL-175: an attempt made outside the app has no seed -- its ref tells the attempts of one item apart.
                            <span className="min-w-0 truncate font-mono" title={e.attemptRef}>
                              {attemptLabel(e)}
                            </span>
                          ) : null}
                          {/* Blind mode keeps the queue blind too. */}
                          {!blind && auto !== null ? <span className={`ml-auto ${auto === "rejected" ? "text-amber-400" : "text-emerald-500/80"}`}>{auto === "rejected" ? t("review.queue.autoFailed") : t("review.queue.autoPassed")}</span> : null}
                        </span>
                      </button>
                    </li>
                  );
                };
                const all = (entries ?? []).map((e, i) => ({ e, i }));
                const open = all.filter(({ e }) => entryWaits(e));
                const done = all.filter(({ e }) => !entryWaits(e));
                const heading = (text: string) => <p className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{text}</p>;
                return (
                  <>
                    {open.length > 0 && (
                      <section>
                        {heading(t("review.queue.waitingGroup", { count: open.length }))}
                        <ul>{open.map(({ e, i }) => row(e, i))}</ul>
                      </section>
                    )}
                    {done.length > 0 && (
                      <section>
                        {heading(t("review.queue.reviewedGroup", { count: done.length }))}
                        <ul>{done.map(({ e, i }) => row(e, i))}</ul>
                      </section>
                    )}
                  </>
                );
              })()}
            </div>
          </div>

        </div>
      )}
      {confirmReplace && (
        <ConfirmDialog
          title={t("review.replace.title")}
          description={t(confirmReplace.existing.device ? "review.replace.descriptionDevice" : "review.replace.description", {
            device: confirmReplace.existing.device ?? "",
            time: formatDisplayDateTime(confirmReplace.existing.at),
            result: resultLabel(t, confirmReplace.existing.result),
            rating: confirmReplace.existing.rating !== null ? ` ${confirmReplace.existing.rating}/10` : "",
          })}
          confirmLabel={t("review.replace.confirm")}
          onCancel={() => setConfirmReplace(null)}
          onConfirm={() => {
            const { result, itemKey, attemptRef, pickedConfirmed } = confirmReplace;
            setConfirmReplace(null);
            // Only the track the question named; if the screen moved meanwhile, nothing is sent.
            if (entry?.itemKey === itemKey && entry.attemptRef === attemptRef) void submit(result, true, pickedConfirmed === true);
          }}
        />
      )}
      {/* BL-175 (§2.2): an attempt is never both picked and rejected -- rejecting the picked one withdraws its pick. */}
      {confirmRejectPicked && entry && (
        <ConfirmDialog
          title={t("review.pick.rejectTitle")}
          description={t("review.pick.rejectDescription", { item: entry.itemKey })}
          confirmLabel={t("review.pick.rejectConfirm")}
          confirmVariant="danger"
          onCancel={() => setConfirmRejectPicked(false)}
          onConfirm={() => {
            setConfirmRejectPicked(false);
            void submit("rejected", false, true);
          }}
        />
      )}
      {noneFitsDraft && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="presentation">
          <HoldFocus formRef={noneFitsForm} />
          <form
            ref={noneFitsForm}
            role="dialog"
            aria-modal="true"
            aria-label={t("review.noneFits.title")}
            onSubmit={(event) => {
              event.preventDefault();
              void submitNoneFits();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setNoneFitsDraft(null);
              }
            }}
            className="w-full max-w-lg space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
          >
            <h3 className="text-base font-semibold text-white">{t("review.noneFits.title")}</h3>
            <p className="text-sm text-zinc-400">{t("review.noneFits.description", { item: noneFitsDraft.itemKey })}</p>
            <textarea
              value={noneFitsDraft.note}
              maxLength={2000}
              rows={3}
              placeholder={t("review.noneFits.placeholder")}
              onChange={(event) => {
                const note = event.target.value;
                setNoneFitsDraft((d) => (d ? { ...d, note } : d));
              }}
              className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
            />
            <label className={`flex items-center gap-3 text-sm ${device !== null ? "text-zinc-500" : "text-zinc-200"}`}>
              <ToggleSwitch tone="violet" label={t("review.noneFits.rerun")} checked={noneFitsDraft.rerun && device === null} disabled={device !== null} onChange={(rerun) => setNoneFitsDraft((d) => (d ? { ...d, rerun } : d))} />
              <span>{device !== null ? t("review.rerunOnDevice", { device }) : t("review.noneFits.rerun")}</span>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setNoneFitsDraft(null)} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">
                {t("review.pin.cancel")}
              </button>
              <button type="submit" disabled={busy || !noneFitsDraft.note.trim()} className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                {t("review.noneFits.confirm")}
              </button>
            </div>
          </form>
        </div>
      )}
      {/* BL-175 (§B): the grid, the loupe and compare, over the whole window. */}
      {layer !== null && entry && (
        <VisualReviewLayer
          ref={layerRef}
          mode={layer}
          scope={gridScope}
          onScope={setGridScope}
          entries={
            against === "before" && src
              ? // Phase 2: a re-check's «Исправлено» is the revised file; nothing to pick.
                [{ ...layerEntryOf(entry), fullSrc: src, previewSrc: null, caption: t("review.compare.after"), noPick: true }]
              : (layer === "grid" && gridScope === "item" ? visualWalk.filter((e) => e.itemKey === entry.itemKey) : visualWalk).map(layerEntryOf)
          }
          currentKey={entryKey(entry)}
          compareKey={compareKey}
          canCompare={comparable || againstEntry !== null}
          against={againstEntry}
          defaultCompareView={against === "before" ? "wipe" : "side"}
          compareOnly={against === "before"}
          againstFirst={against === "before"}
          blind={blind}
          shortKey={shortKey}
          itemPicks={itemPickInfo}
          pickBlocked={(e) => (forbidsPick(e.verdict?.result) ? t("review.pick.rejectedHint") : null)}
          busy={busy}
          message={message}
          onSelect={(e) => {
            const i = (entries ?? []).findIndex((x) => entryKey(x) === e.key);
            if (i >= 0 && i !== index) {
              pickedByHand.current = e.key;
              go(i);
            }
          }}
          onToggleCompare={(e) => setCompareKey((c) => (c === e.key ? null : e.key))}
          onMode={(mode) => openLayer(mode, true)}
          onPick={(e) => {
            const target = (entries ?? []).find((x) => entryKey(x) === e.key);
            if (target) togglePick(target);
          }}
          onNoneFits={(itemKey) => setNoneFitsDraft({ itemKey, note: "", rerun: device === null })}
          onClose={() => {
            setLayer(null);
            setLayerBack(null);
          }}
          onAddPin={(region, at) => addPin(region, at)}
        />
      )}
      {layer !== null ? pendingNoteBox(true) : null}
      {waveDone && !busy && (
        <BlockingDialog label={t("review.wave.doneTitle")} maxWidthClass="max-w-md">
          <div className="relative space-y-3">
            <button
              type="button"
              onClick={() => setWaveDoneFor(null)}
              aria-label={t("common.close")}
              title={t("common.close")}
              className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              <span aria-hidden>✕</span>
            </button>
            <h2 className="pr-8 text-base font-semibold text-zinc-100">{t("review.wave.doneTitle")}</h2>
            <p className="text-sm text-zinc-400">{waveDone.title}</p>
            <p className="text-sm text-zinc-200">{waveDoneText(waveDone)}</p>
            {nextWave ? (
              <button
                type="button"
                autoFocus
                onClick={() => {
                  setWaveDoneFor(null);
                  chooseWave(nextWave.groupId);
                }}
                className="w-full rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500"
              >
                {t("review.wave.next", { wave: nextWave.title, count: nextWave.waitingPassed + nextWave.waitingRejected })}
              </button>
            ) : (
              <p className="text-sm text-zinc-400">{t("review.wave.noneLeft")}</p>
            )}
          </div>
        </BlockingDialog>
      )}
      <BusyOverlay state={busyAction.overlay} />
    </div>
  );
}

/** BL-175 (review rounds 1 and 2): the "none fits" dialog and a pin's note box over the layer hold the focus like ConfirmDialog (mounted only while open). */
function HoldFocus({ formRef }: { formRef: React.RefObject<HTMLFormElement | null> }) {
  useDialogFocus(formRef);
  return null;
}

// ui-text-ignore: a CSS variable with its fallback colour
const GENRE_COLOR_VAR = "var(--genre-color, #3f3f46)";

/** BL-229 part B (AC-MR-10): the genre of the wave on screen -- its icon and title on a band of its colour. */
export function GenreHeader({ genre }: { genre: PlanGenre }) {
  const { t } = useUiText();
  return (
    <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5" style={{ backgroundColor: tintOver(GENRE_COLOR_VAR, 22, "#18181b") }} aria-label={t("review.genre.label", { genre: genre.title })}>
      <span aria-hidden="true" className="text-lg leading-none">{genre.icon}</span>
      {/* ui-text-ignore: the genre's own title (data) */}
      <span className="text-sm font-semibold text-zinc-50">{genre.title}</span>
      <span className="text-[11px] uppercase tracking-wide text-zinc-300">{t("review.genre.caption")}</span>
    </div>
  );
}

/** BL-229 part B: one section of the review form -- yes/no as two buttons, a scale as 10, a choice as one per option. */
export function ReviewFormSection({ title, fields, answers, onAnswer }: { title: string; fields: PlanReviewField[]; answers: PlanAnswers | undefined; onAnswer: (fieldId: string, value: boolean | number | string) => void }) {
  const { t } = useUiText();
  if (fields.length === 0) return null;
  const option = (field: PlanReviewField, value: boolean | number | string, label: string, wide = true) => {
    const on = answers?.[field.id] === value;
    return (
      <button
        key={String(value)}
        type="button"
        aria-pressed={on}
        onClick={() => onAnswer(field.id, value)}
        className={`rounded-md border text-sm transition-colors ${wide ? "px-3 py-1" : "h-8 w-8"} ${on ? "border-sky-400 bg-sky-500/25 text-sky-50" : "border-zinc-700 bg-zinc-950 text-zinc-200 hover:border-zinc-500"}`}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{title}</p>
      {fields.map((field) => {
        const missing = field.required === true && !Object.hasOwn(answers ?? {}, field.id);
        return (
          <div key={field.id} className="flex flex-wrap items-center gap-2">
            <span className={`min-w-0 text-sm ${missing ? "text-amber-200" : "text-zinc-200"}`}>
              {/* ui-text-ignore: the factory's own question (data) */}
              {field.question}
              {field.required ? (
                <span className="ml-1 text-amber-300" title={t("review.form.required")} aria-label={t("review.form.required")}>
                  *
                </span>
              ) : null}
            </span>
            <span className="flex flex-wrap gap-1">
              {field.type === "yes_no"
                ? [option(field, true, t("review.form.yes")), option(field, false, t("review.form.no"))]
                : field.type === "scale_1_10"
                  ? Array.from({ length: 10 }, (_, i) => option(field, i + 1, String(i + 1), false))
                  : (field.options ?? []).map((o) => option(field, o, o))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
