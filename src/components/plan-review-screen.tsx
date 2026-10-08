"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validatorOfEntry, type PlanCheck, type PlanExistingVerdict, type PlanMarker, type PlanReference, type PlanReviewBatch, type PlanReviewClaim, type PlanReviewEntry } from "@/lib/generation-plans/contracts";
import { useAppChannel } from "./app-channel";
import { integratedLoudness, LOUDNESS_TARGET_LUFS, matchedVolume } from "./loudness";
import { MediaReviewPlayer, formatPlayerTime, type FrequencyMark, type ReviewMarker, type ReviewPlayerHandle } from "./media-review-player";
import { ToggleSwitch } from "./toggle-switch";
import { ConfirmDialog } from "./confirm-dialog";
import { formatDisplayDate, formatDisplayDateTime } from "@/lib/shared-formatting";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import { useUiText } from "./ui-text-provider";

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

export type ReviewKeyAction = "play" | "back" | "forward" | "accept" | "reject" | "next" | "previous" | "mark" | "ab" | { rating: number };

/** The keyboard map (Space, ←/→, A, R, N, P, M, 1-9 and 0 for 10). Exported for its test. */
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
    if (entries[i].verdict === null && !skip(entries[i])) return i;
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

/** AC-GP3-04: the loudness the validator measured for this attempt (the latest stage's `metrics.lufs`), or null. Exported for its test. */
export function reportedLufs(entry: Pick<PlanReviewEntry, "stages">): number | null {
  for (const stage of [...entry.stages].reverse()) {
    const value = stage.metrics.lufs ?? stage.metrics.LUFS ?? stage.metrics.integrated_lufs;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
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

/** The references to offer for A/B: this attempt's nearest ones first (`referenceIds` of its rows), then the plan's others. */
export function referencesFor(entry: Pick<PlanReviewEntry, "stages">, references: PlanReference[]): Array<PlanReference & { nearest: boolean }> {
  const nearestIds = new Set(entry.stages.flatMap((s) => s.referenceIds ?? []));
  const nearest = references.filter((r) => nearestIds.has(r.id)).map((r) => ({ ...r, nearest: true }));
  return [...nearest, ...references.filter((r) => !nearestIds.has(r.id)).map((r) => ({ ...r, nearest: false }))];
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

/** BL-157 (AC-TC-01): how often the screen renews its claims and reads the other computer's. */
const CLAIM_HEARTBEAT_MS = 60_000;
const CLAIMS_REFRESH_MS = 30_000;

type Draft = { reasons: string[]; rating: number | null; note: string; marks: PlanMarker[]; openMark: number | null };
const emptyDraft = (): Draft => ({ reasons: [], rating: null, note: "", marks: [], openMark: null });

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
    const waiting = mine.filter((e) => e.verdict === null);
    const reviewed = mine.filter((e) => e.verdict !== null);
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

/** The entries the screen walks: the validator filter, then the chosen wave (null = all waves). Exported for its test. */
export function visibleEntries<T extends Pick<PlanReviewEntry, "stages" | "groupId"> & { validator?: PlanReviewEntry["validator"] }>(entries: T[], filter: ReviewFilter, wave: string | null): T[] {
  const filtered = filterEntries(entries, filter);
  return wave === null ? filtered : filtered.filter((e) => e.groupId === wave);
}

/** BL-143 phase 2: the queue of ANOTHER device's plan, from its report, with the verdicts sent from here still waiting. */
export type PeerReviewSource = { deviceId: string; hostname: string | null };

type PeerQueueResponse = {
  /** BL-157 (AC-TC-02): the other devices' live claims, with the plan each is on. */
  claims?: Array<PlanReviewClaim & { ownerDeviceId: string; planId: string }>;
  devices: Array<{ deviceId: string; hostname: string | null; plans: Array<{ planId: string; review: PlanReviewEntry[]; itemParams?: Record<string, PlanReviewEntry["params"]>; references?: PlanReference[]; batches?: PlanReviewBatch[] }> }>;
  outgoing: Array<{ planId: string; ownerDeviceId: string; itemKey: string; attemptRef: string; result: "accepted" | "rejected"; rating: number | null; at: string }>;
};

/**
 * A peer plan's queue: the owning device's entries, where a verdict sent from here and not yet shown applied there counts as
 * given ("sent, waiting for <device>"). Exported for its test.
 */
export function peerQueue(data: PeerQueueResponse, source: PeerReviewSource, planId: string): PlanReviewEntry[] {
  const plan = data.devices.find((d) => d.deviceId === source.deviceId)?.plans.find((p) => p.planId === planId);
  if (!plan) return [];
  const device = source.hostname ?? source.deviceId;
  return plan.review.map((raw) => {
    // The params travel once per item (the report's itemParams), not per entry.
    const params = plan.itemParams && Object.hasOwn(plan.itemParams, raw.itemKey) ? plan.itemParams[raw.itemKey] : raw.params;
    const entry = { ...raw, params };
    const sent = data.outgoing.filter((v) => v.ownerDeviceId === source.deviceId && v.planId === planId && v.itemKey === entry.itemKey && v.attemptRef === entry.attemptRef).at(-1);
    // A verdict sent from here that is newer than what that device shows is the one that counts (it is on its way).
    // Whole seconds: the owning device stores times to the second, so the applied copy of a verdict sent at …:12.345 reads …:12.000.
    if (!sent || (entry.verdict && Math.floor(Date.parse(entry.verdict.at) / 1000) >= Math.floor(Date.parse(sent.at) / 1000))) return entry;
    return { ...entry, verdict: { stageId: "owner_review", itemKey: entry.itemKey, attemptRef: entry.attemptRef, result: sent.result, reportedBy: "owner" as const, note: `${SENT_NOTE_PREFIX}${device}`, rating: sent.rating, reasons: [], markers: [], auditionFile: null, checks: [], metrics: {}, at: sent.at } };
  });
}

export function PlanReviewScreen({ planId, onClose, onChanged, source }: { planId: string; onClose: () => void; onChanged?: () => void; source?: PeerReviewSource }) {
  const { t, formatNumber, language } = useUiText();
  const { channel } = useAppChannel();
  const [allEntries, setEntries] = useState<PlanReviewEntry[] | null>(null);
  const [filter, setFilter] = useState<ReviewFilter>("all");
  // BL-157 (AC-WV-01/02): the chosen wave (null = all waves) and each wave's context.
  const [wave, setWave] = useState<string | null>(null);
  const [batches, setBatches] = useState<PlanReviewBatch[]>([]);
  // BL-157 (AC-TC-01..04): the other computers' claims, whether claimed tracks are walked too, the wave this computer took,
  // and a verdict waiting for "Replace?".
  const [claims, setClaims] = useState<PlanReviewClaim[]>([]);
  const [showClaimed, setShowClaimed] = useState(false);
  const [waveTaken, setWaveTaken] = useState<string | null>(null);
  // The attempt the question is about travels with it: "Replace" confirms exactly that track (review round 3).
  const [confirmReplace, setConfirmReplace] = useState<{ result: "accepted" | "rejected"; existing: PlanExistingVerdict; itemKey: string; attemptRef: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const freshClaims = useRef<PlanReviewClaim[]>([]);
  // The list the player, the arrows and the keys walk: the queue under the chosen filter (BL-153 AC-RR-06) and wave (BL-157).
  const entries = useMemo(() => (allEntries ? visibleEntries(allEntries, filter, wave) : null), [allEntries, filter, wave]);
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const player = useRef<ReviewPlayerHandle | null>(null);
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

  /** The queue, freshest from the server; `[]` (with the message shown) when it cannot be read. */
  const load = useCallback(
    (): Promise<PlanReviewEntry[]> =>
      fetch(peerDevice ? "/api/generation-plans/peers" : `${base}/review`)
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as { entries?: PlanReviewEntry[]; references?: PlanReference[]; batches?: PlanReviewBatch[]; message?: string } & Partial<PeerQueueResponse>;
          if (!res.ok) throw new Error(errorText(t, data, t("review.loadFailedStatus", { status: String(res.status) }), { showErrorField: false }));
          const peerPlan = peerDevice ? data.devices?.find((d) => d.deviceId === peerDevice)?.plans.find((p) => p.planId === planId) : undefined;
          setReferences(peerDevice ? (peerPlan?.references ?? []) : (data.references ?? []));
          setBatches(peerDevice ? (peerPlan?.batches ?? []) : (data.batches ?? []));
          const fresh = claimsFrom(data);
          freshClaims.current = fresh;
          setClaims(fresh);
          setNowMs(Date.now());
          const list = peerDevice ? peerQueue({ devices: data.devices ?? [], outgoing: data.outgoing ?? [] }, { deviceId: peerDevice, hostname: peerName }, planId) : (data.entries ?? []);
          setEntries(list);
          return list;
        })
        .catch((error: unknown) => {
          setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.loadFailed") });
          return [];
        }),
    [base, claimsFrom, peerDevice, peerName, planId, t]
  );

  // A claimed track is passed over unless the owner asked to see claimed ones too (AC-TC-02).
  const skipClaimed = useCallback((e: PlanReviewEntry) => !showClaimed && e.verdict === null && claimOf(e, claims, nowMs) !== null, [claims, nowMs, showClaimed]);
  /** The same rule against the claims `load` just read -- the state above only catches up on the next render (review round 1). */
  const skipFresh = useCallback((e: PlanReviewEntry) => !showClaimed && e.verdict === null && claimOf(e, freshClaims.current, Date.now()) !== null, [showClaimed]);

  useEffect(() => {
    // First open: the first waiting track no other computer is on (its claims arrive with the same answer).
    void load().then((list) => setIndex(Math.max(0, list.findIndex((e) => e.verdict === null && claimOf(e, freshClaims.current, Date.now()) === null))));
  }, [load]);

  // BL-157 (AC-TC-02): the other computers' claims come and go while the screen is open -- read them again now and then
  // (only the claims: the queue itself is not reloaded under the owner's hands).
  useEffect(() => {
    const timer = setInterval(() => {
      void fetch(peerDevice ? "/api/generation-plans/peers" : `${base}/review`)
        .then(async (res) => (res.ok ? ((await res.json()) as { claims?: PeerQueueResponse["claims"] | PlanReviewClaim[] }) : null))
        .then((data) => {
          if (data) setClaims(claimsFrom(data));
          setNowMs(Date.now());
        })
        .catch(() => undefined);
    }, CLAIMS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [base, claimsFrom, peerDevice]);

  const entry = entries && entries.length > 0 ? entries[Math.min(index, entries.length - 1)] : null;
  const waiting = entries?.filter((e) => e.verdict === null).length ?? 0;

  /** Back to A whenever the attempt changes (the reference never keeps playing under another track). */
  const stopB = useCallback(() => {
    referenceAudio.current?.pause();
    setOnB(false);
  }, []);

  const go = useCallback(
    (to: number) => {
      if (!entries || entries.length === 0) return;
      stopB();
      setIndex(((to % entries.length) + entries.length) % entries.length);
      setDraft(emptyDraft());
      setMessage(null);
    },
    [entries, stopB]
  );

  const submit = useCallback(
    async (result: "accepted" | "rejected", replace = false) => {
      if (!entry || busy) return;
      // BL-157 (AC-TC-04): a track that already has a verdict asks first.
      if (!replace && entry.verdict) {
        const sentHere = entry.verdict.note?.startsWith(SENT_NOTE_PREFIX) ?? false;
        setConfirmReplace({
          result,
          itemKey: entry.itemKey,
          attemptRef: entry.attemptRef,
          existing: { result: entry.verdict.result, rating: entry.verdict.rating, device: entry.pendingFrom ?? (sentHere ? null : (entry.history?.at(-1)?.device ?? null)), at: entry.verdict.at },
        });
        return;
      }
      setBusy(true);
      try {
        const marks = draft.openMark !== null ? [...draft.marks, { start: draft.openMark, end: null, note: null }] : draft.marks;
        await postJson(t, `${base}/verdict`, {
          itemKey: entry.itemKey,
          attemptRef: entry.attemptRef,
          result,
          ...(replace ? { replace: true } : {}),
          ...(draft.rating !== null ? { rating: draft.rating } : {}),
          reasons: draft.reasons,
          markers: marks,
          ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
        });
        setMessage({ tone: "ok", text: t("review.verdictSaved", { item: entry.itemKey, result: resultLabel(t, result) }) });
        onChanged?.();
        // Auto-advance: the next attempt still waiting after this one, in the refreshed queue.
        const list = visibleEntries(await load(), filter, wave);
        const here = list.findIndex((e) => e.itemKey === entry.itemKey && e.attemptRef === entry.attemptRef);
        const next = nextWaitingIndex(list, here >= 0 ? here : index, skipFresh);
        setDraft(emptyDraft());
        stopB();
        setIndex(next >= 0 ? next : Math.max(0, here));
      } catch (error) {
        // The screen's data was stale: the server found a verdict there -- ask now (AC-TC-04).
        if (error instanceof RequestError && error.code === "plan_verdict_exists") {
          const existing = (error.details as { existing?: PlanExistingVerdict } | undefined)?.existing;
          if (existing) {
            setConfirmReplace({ result, existing, itemKey: entry.itemKey, attemptRef: entry.attemptRef });
            return;
          }
        }
        setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.saveFailed") });
      } finally {
        setBusy(false);
      }
    },
    [base, busy, draft, entry, filter, index, load, onChanged, skipFresh, stopB, t, wave]
  );

  // BL-157 (AC-TC-01): this computer claims the waiting track on screen (and the wave it took), renewed every minute;
  // moving on moves the claim, leaving the screen gives them up. Claims are advisory: a failure is ignored.
  const claimKey = entry && entry.verdict === null ? `${entry.itemKey}\u0000${entry.attemptRef}` : null;
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
  useEffect(() => {
    if (!waveTaken) return;
    const send = () => void postJson(t, `${base}/claim`, { scope: "group", groupId: waveTaken }).catch(() => undefined);
    const timer = setInterval(send, CLAIM_HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      void postJson(t, `${base}/claim`, { scope: "group", groupId: waveTaken, release: true }, { keepalive: true }).catch(() => undefined);
    };
  }, [base, t, waveTaken]);
  /** AC-WV-06: take the chosen wave on this computer (the other one skips it), or give it back. */
  const toggleWaveTaken = useCallback(async () => {
    if (!wave) return;
    if (waveTaken === wave) {
      setWaveTaken(null);
      return;
    }
    try {
      await postJson(t, `${base}/claim`, { scope: "group", groupId: wave });
      setWaveTaken(wave);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.saveFailed") });
    }
  }, [base, t, wave, waveTaken]);

  /** A filter shows its own first waiting attempt. */
  const chooseFilter = useCallback(
    (next: ReviewFilter) => {
      stopB();
      setFilter(next);
      setIndex(Math.max(0, visibleEntries(allEntries ?? [], next, wave).findIndex((e) => e.verdict === null && !skipClaimed(e))));
      setDraft(emptyDraft());
      setMessage(null);
    },
    [allEntries, skipClaimed, stopB, wave]
  );
  /** BL-157 (AC-WV-02): a wave shows its own first waiting attempt; null = all waves. */
  const chooseWave = useCallback(
    (next: string | null) => {
      stopB();
      setWave(next);
      setIndex(Math.max(0, visibleEntries(allEntries ?? [], filter, next).findIndex((e) => e.verdict === null && !skipClaimed(e))));
      setDraft(emptyDraft());
      setMessage(null);
    },
    [allEntries, filter, skipClaimed, stopB]
  );
  const waves = useMemo(() => waveSummaries(allEntries ?? [], batches), [allEntries, batches]);
  const chosenWave = wave === null ? null : (waves.find((w) => w.groupId === wave) ?? null);
  const chosenBatch = wave === null ? null : (batches.find((b) => b.groupId === wave) ?? null);
  // AC-WV-02: when the chosen wave has nothing waiting, the next wave (in plan order, wrapping) that still has something.
  const nextWave = useMemo(() => {
    if (!chosenWave || chosenWave.waitingPassed + chosenWave.waitingRejected > 0) return null;
    const at = waves.findIndex((w) => w.groupId === chosenWave.groupId);
    return [...waves.slice(at + 1), ...waves.slice(0, at)].find((w) => w.waitingPassed + w.waitingRejected > 0) ?? null;
  }, [chosenWave, waves]);
  const entryWaveTitle = (groupId: string | null) => (groupId === null ? null : (batches.find((b) => b.groupId === groupId)?.title ?? groupId));
  const filterCounts = useMemo(() => {
    const list = wave === null ? (allEntries ?? []) : (allEntries ?? []).filter((e) => e.groupId === wave);
    const waitingIn = (f: ReviewFilter) => filterEntries(list, f).filter((e) => e.verdict === null).length;
    return { all: waitingIn("all"), passed: waitingIn("passed"), rejected: waitingIn("rejected"), anyRejected: list.some((e) => validatorOfEntry(e) === "rejected") };
  }, [allEntries, wave]);

  const mark = useCallback(() => {
    const at = Math.round((player.current?.currentTime() ?? 0) * 10) / 10;
    setDraft((d) => (d.openMark === null ? { ...d, openMark: at } : { ...d, openMark: null, marks: [...d.marks, { start: Math.min(d.openMark, at), end: Math.max(d.openMark, at), note: null }] }));
  }, []);

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

  const offered = entry ? referencesFor(entry, references) : [];
  const chosen = offered.find((r) => r.id === referenceId) ?? offered[0] ?? null;

  /**
   * FO-MSG-0009 / AC-GP3-07: A/B -- switch between the track (A) and the chosen reference (B) at the same position, each at its
   * matched loudness (the reference's own LUFS when given).
   */
  const toggleAB = useCallback(() => {
    const audio = referenceAudio.current;
    if (!audio || !chosen) return;
    if (!onB) {
      const at = player.current?.currentTime() ?? 0;
      player.current?.pause();
      audio.currentTime = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.min(at, audio.duration) : at;
      audio.volume = matchLoudness ? matchedVolume(chosen.lufs) : 1;
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
  }, [chosen, matchLoudness, onB, t]);

  // Keyboard shortcuts, except while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // BL-157 (AC-TC-04): while "Replace?" is open, the dialog has the keyboard.
      if (confirmReplace) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const action = reviewKeyAction(event.key);
      if (!action) return;
      // A focused button or switch keeps Space/Enter (review B7); a held key never decides the next attempt too.
      if (action === "play" && target?.closest("button, [role=switch], a")) return;
      if (event.repeat && (action === "accept" || action === "reject" || action === "next" || action === "previous")) return;
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
        else player.current?.seekBy(-5);
      } else if (action === "forward") {
        if (b) b.currentTime = Math.min(b.duration || b.currentTime + 5, b.currentTime + 5);
        else player.current?.seekBy(5);
      }
      else if (action === "accept") void submit("accepted");
      else if (action === "reject") void submit("rejected");
      else if (action === "next") go(stepIndex(entries ?? [], index, 1, skipClaimed));
      else if (action === "previous") go(stepIndex(entries ?? [], index, -1, skipClaimed));
      else if (action === "mark") mark();
      else if (action === "ab") toggleAB();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmReplace, entries, go, index, mark, skipClaimed, submit, toggleAB, onB]);

  // The reference's volume follows the loudness switch while it plays.
  useEffect(() => {
    const audio = referenceAudio.current;
    if (audio && chosen) audio.volume = matchLoudness ? matchedVolume(chosen.lufs) : 1;
  }, [matchLoudness, chosen, onB]);

  const savedMarkers = useMemo<ReviewMarker[]>(() => {
    if (!entry) return [];
    const findings = blind && entry.verdict === null ? [] : findingMarkers(entry);
    const own = [...(entry.verdict?.markers ?? []), ...draft.marks].map((m) => ({ start: m.start, end: m.end, label: m.note, tone: "mark" as const }));
    return [...findings, ...own];
  }, [blind, draft.marks, entry]);
  // The open mark's label is rebuilt on a language switch (`t` itself keeps one identity, so `language` is in the deps).
  const markers = useMemo<ReviewMarker[]>(
    () => (entry && draft.openMark !== null ? [...savedMarkers, { start: draft.openMark, end: null, label: t("review.openMark"), tone: "mark" as const }] : savedMarkers),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `language` re-builds the label after a language switch
    [savedMarkers, draft.openMark, entry, t, language],
  );

  const lufsOf = entry ? (reportedLufs(entry) ?? (measured && entry && measured.src === `${base}/audition?itemKey=${encodeURIComponent(entry.itemKey)}&attemptRef=${encodeURIComponent(entry.attemptRef)}` ? measured.lufs : null)) : null;
  const src = entry ? `${base}/audition?itemKey=${encodeURIComponent(entry.itemKey)}&attemptRef=${encodeURIComponent(entry.attemptRef)}` : null;
  const hideFindings = blind && entry?.verdict === null;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold text-zinc-100">
          {/* BL-157 (AC-SM-07): "<channel> · Review · <plan> · <wave>" -- whose track this is, at a glance. */}
          {channel?.title ? <span className="text-zinc-300">{t("review.titleChannel", { channel: channel.title })}</span> : null}
          {t("review.title", { plan: planId })}
          {entry && entryWaveTitle(entry.groupId) ? <span className="text-zinc-300">{t("review.titleWave", { wave: entryWaveTitle(entry.groupId) ?? "" })}</span> : null}
          {source ? <span className="ml-2 text-xs font-normal text-zinc-400">{t("review.onDevice", { device: source.hostname ?? source.deviceId })}</span> : null}
        </h3>
        <span className="text-xs text-zinc-400">{entries ? t("review.queueCounts", { waiting, total: entries.length }) : t("common.loading")}</span>
        <div className="ml-auto flex items-center gap-3">
          <ToggleSwitch label={t("review.matchLoudness")} checked={matchLoudness} onChange={setMatchLoudness} />
          <ToggleSwitch label={t("review.spectrogram")} checked={showSpectrogram} onChange={setShowSpectrogram} />
          <ToggleSwitch label={t("review.blind")} checked={blind} onChange={setBlind} />
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700">
            {t("review.backToPlan")}
          </button>
        </div>
      </div>
      {/* BL-157 (AC-WV-01): the plan's waves that have entries -- pick one to review it alone. */}
      {waves.length > 0 && (
        <div className="flex flex-wrap gap-1 rounded-lg bg-zinc-950 p-1" role="tablist" aria-label={t("review.wave.label")}>
          <button
            type="button"
            role="tab"
            aria-selected={wave === null}
            onClick={() => chooseWave(null)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${wave === null ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            {t("review.wave.all")}
          </button>
          {waves.map((w) => (
            <button
              key={w.groupId}
              type="button"
              role="tab"
              aria-selected={wave === w.groupId}
              onClick={() => chooseWave(w.groupId)}
              title={t("review.wave.progress", { reviewed: w.reviewed, total: w.total })}
              className={`rounded-md px-3 py-1 text-left text-xs transition-colors ${wave === w.groupId ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              <span className="font-medium">{w.title}</span>
              {claims.some((c) => c.scope === "group" && c.groupId === w.groupId && Date.parse(c.until) > nowMs) ? <span className="ml-1 text-sky-300">{t("review.wave.takenMark")}</span> : null}
              <span className="ml-1.5 text-[11px] text-zinc-500">
                {w.waitingPassed + w.waitingRejected > 0
                  ? t("review.wave.waiting", { waiting: w.waitingPassed + w.waitingRejected, passed: w.waitingPassed, rejected: w.waitingRejected, reviewed: w.reviewed, total: w.total })
                  : t("review.wave.progress", { reviewed: w.reviewed, total: w.total })}
              </span>
            </button>
          ))}
        </div>
      )}
      {/* AC-WV-03: the chosen wave's context. */}
      {chosenWave && (
        <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-zinc-100">{chosenWave.title}</p>
            {/* AC-WV-06: a wave another computer took; or take this one here. */}
            {(() => {
              const other = claims.find((c) => c.scope === "group" && c.groupId === chosenWave.groupId && Date.parse(c.until) > nowMs);
              return other ? <span className="text-sky-200">{t("review.wave.takenBy", { device: other.device, time: formatDisplayDateTime(other.since) })}</span> : null;
            })()}
            <button type="button" onClick={() => void toggleWaveTaken()} className="ml-auto rounded-md border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-200 hover:border-zinc-500">
              {waveTaken === chosenWave.groupId ? t("review.wave.release") : t("review.wave.take")}
            </button>
          </div>
          {chosenBatch?.note && <p className="whitespace-pre-wrap text-zinc-300">{chosenBatch.note}</p>}
          {chosenBatch?.ownerNote && <p className="whitespace-pre-wrap text-amber-200">{t("plans.ownerNote", { note: chosenBatch.ownerNote })}</p>}
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
            <ul className="space-y-0.5 text-zinc-400">
              {chosenBatch.differingParams.map((p) => (
                <li key={p.name}>
                  <span className="font-mono text-zinc-300">{p.name}</span>: {p.values.map((v) => String(v)).join(" | ")}
                </li>
              ))}
            </ul>
          )}
          {/* AC-WV-05: the wave is done -- its summary, and the next wave that still waits. */}
          {chosenWave.waitingPassed + chosenWave.waitingRejected === 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-emerald-900/60 bg-emerald-950/30 px-2 py-1.5 text-emerald-200">
              <span>{t("review.wave.done", { accepted: chosenWave.accepted, rejected: chosenWave.rejected, overrides: chosenWave.overridesValidator })}</span>
              {nextWave && (
                <button type="button" onClick={() => chooseWave(nextWave.groupId)} className="rounded-md bg-indigo-600 px-2.5 py-0.5 text-xs font-medium text-white hover:bg-indigo-500">
                  {t("review.wave.next", { wave: nextWave.title, count: nextWave.waitingPassed + nextWave.waitingRejected })}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {/* Kept while a filter other than All is chosen, so a queue whose rejects went away never hides its way back. */}
      {(filterCounts.anyRejected || filter !== "all") && (
        <div className="inline-flex gap-1 rounded-lg bg-zinc-950 p-1" role="tablist" aria-label={t("review.filter.label")}>
          {(["all", "passed", "rejected"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => chooseFilter(f)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${filter === f ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              {t(f === "all" ? "review.filter.all" : f === "passed" ? "review.filter.passed" : "review.filter.rejected", { count: filterCounts[f] })}
            </button>
          ))}
        </div>
      )}
      {/* BL-157 (AC-TC-02): tracks another computer is reviewing are passed over -- unless the owner wants them too. */}
      {(() => {
        const claimed = (entries ?? []).filter((e) => e.verdict === null && claimOf(e, claims, nowMs) !== null).length;
        return claimed > 0 || showClaimed ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-sky-200">
            <span>{t("review.claimedCount", { count: claimed })}</span>
            <ToggleSwitch label={t("review.showClaimed")} checked={showClaimed} onChange={setShowClaimed} />
          </div>
        ) : null;
      })()}
      {entries && entries.length === 0 && <p className="text-sm text-zinc-500">{t("review.empty")}</p>}
      {entry && (
        <>
          <div className="flex flex-wrap items-baseline gap-2 text-sm">
            <button type="button" onClick={() => go(stepIndex(entries ?? [], index, -1, skipClaimed))} className="text-zinc-400 hover:text-zinc-100" aria-label={t("review.previous")}>
              ←
            </button>
            <span className="font-mono text-zinc-100">{entry.itemKey}</span>
            <span className="text-xs text-zinc-500">
              {entry.seed !== null
                ? t("review.attemptMetaSeed", { attempt: entry.attemptRef, seed: String(entry.seed), index: index + 1, total: entries?.length ?? 0 })
                : t("review.attemptMeta", { attempt: entry.attemptRef, index: index + 1, total: entries?.length ?? 0 })}
            </span>
            <button type="button" onClick={() => go(stepIndex(entries ?? [], index, 1, skipClaimed))} className="text-zinc-400 hover:text-zinc-100" aria-label={t("review.next")}>
              →
            </button>
            {entry.verdict && (
              <span className={`ml-auto text-xs ${entry.verdict.result === "accepted" ? "text-emerald-400" : "text-red-400"}`}>
                {entry.verdict.reportedBy === "owner" ? t("review.verdictYour", { result: resultLabel(t, entry.verdict.result) }) : t("review.verdictRelayed", { result: resultLabel(t, entry.verdict.result) })}
                {entry.verdict.note?.startsWith(SENT_NOTE_PREFIX) ? ` · ${t("review.sentWaitingFor", { device: entry.verdict.note.slice(SENT_NOTE_PREFIX.length) })}` : ""}
                {entry.pendingFrom ? ` · ${t("review.beingApplied", { device: entry.pendingFrom })}` : ""}
                {entry.verdict.rating !== null ? ` ${entry.verdict.rating}/10` : ""}
              </span>
            )}
          </div>
          {/* BL-157 (AC-TC-02): another computer is on this track (or its wave) right now. */}
          {(() => {
            const claim = claimOf(entry, claims, nowMs);
            return claim && entry.verdict === null ? (
              <p className="rounded-md border border-sky-900/60 bg-sky-950/30 px-3 py-1.5 text-xs text-sky-200">{t("review.claimedBy", { device: claim.device, time: formatDisplayDateTime(claim.since) })}</p>
            ) : null;
          })()}
          {/* BL-157 (AC-TC-05): every verdict of this track, with the computer and the time. */}
          {entry.history && entry.history.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-zinc-500">
              {entry.history.map((h, i) => (
                <li key={`${h.at}-${i}`}>
                  {t("review.historyLine", { device: h.device, time: formatDisplayDateTime(h.at), result: resultLabel(t, h.result), rating: h.rating !== null ? ` ${h.rating}/10` : "", note: h.note ? ` · ${h.note}` : "" })}
                </li>
              ))}
            </ul>
          )}
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
          {entry.playable && src ? (
            <>
              <MediaReviewPlayer
                key={src}
                ref={player}
                src={src}
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
                  // Measured only when the validator gave no LUFS (AC-GP3-04).
                  if (reportedLufs(entry) === null) setMeasured({ src, lufs: integratedLoudness(audio.channels, audio.sampleRate) });
                }}
              />
              <p className="text-xs text-zinc-500">
                {lufsOf === null
                  ? t("review.loudnessUnknown")
                  : t(reportedLufs(entry) !== null ? "review.loudnessValidator" : "review.loudnessMeasured", { lufs: formatNumber(lufsOf, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
                {matchLoudness && lufsOf !== null ? ` · ${t("review.playedAt", { percent: Math.round(matchedVolume(lufsOf) * 100), target: LOUDNESS_TARGET_LUFS })}` : ""}
              </p>
              {chosen && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                  <span>{t("review.compareWith")}</span>
                  <select
                    value={chosen.id}
                    onChange={(e) => {
                      stopB();
                      setReferenceId(e.target.value);
                    }}
                    className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                  >
                    {offered.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.nearest ? "★ " : ""}
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={toggleAB} className={`rounded-md border px-2.5 py-1 ${onB ? "border-amber-400 bg-amber-500/20 text-amber-200" : "border-zinc-700 text-zinc-200 hover:bg-zinc-800"}`}>
                    {onB ? t("review.abOnB", { label: chosen.label }) : t("review.ab")}
                  </button>
                  {offered.some((r) => r.nearest) && <span className="text-zinc-500">{t("review.nearestHint")}</span>}
                  {matchLoudness && chosen.lufs === null && <span className="text-amber-300">{t("review.referenceNoLufs")}</span>}
                  <audio
                    ref={referenceAudio}
                    src={`${base}/reference?id=${encodeURIComponent(chosen.id)}`}
                    preload="metadata"
                    onEnded={() => {
                      // The reference ran out: back to A where it would be.
                      const at = referenceAudio.current?.currentTime ?? 0;
                      setOnB(false);
                      player.current?.playFrom(at);
                    }}
                    className="hidden"
                  />
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-zinc-500">{t("review.nothingToPlay")}</p>
          )}

          <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {REVIEW_REASONS.map((reason) => {
                  const on = draft.reasons.includes(reason);
                  return (
                    <button key={reason} type="button" onClick={() => setDraft((d) => ({ ...d, reasons: on ? d.reasons.filter((r) => r !== reason) : [...d.reasons, reason] }))} className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-red-400 bg-red-500/20 text-red-200" : "border-zinc-700 text-zinc-400 hover:border-zinc-500"}`}>
                      {t(REVIEW_REASON_KEYS[reason])}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-1 text-xs text-zinc-400">
                {t("review.rating")}
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <button key={n} type="button" onClick={() => setDraft((d) => ({ ...d, rating: d.rating === n ? null : n }))} className={`h-6 w-6 rounded ${draft.rating === n ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}>
                    {n}
                  </button>
                ))}
                <span className="ml-1 text-zinc-500">/ 10</span>
              </div>
              <textarea value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} rows={2} maxLength={2000} placeholder={t("review.notePlaceholder")} className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100" />
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <button type="button" onClick={mark} className="rounded-md border border-amber-500/60 px-2.5 py-1 text-amber-200 hover:bg-amber-500/10">
                  {draft.openMark === null ? t("review.markAtPlayhead") : t("review.endMark", { time: formatPlayerTime(draft.openMark) })}
                </button>
                {draft.marks.map((m, i) => (
                  <span key={i} className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-200">
                    {formatPlayerTime(m.start)}
                    {m.end !== null ? `–${formatPlayerTime(m.end)}` : ""}
                    <button type="button" onClick={() => setDraft((d) => ({ ...d, marks: d.marks.filter((_, j) => j !== i) }))} className="ml-1 text-amber-300 hover:text-white" aria-label={t("review.removeMark")}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void submit("accepted")} className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                  {t("review.accept")}
                </button>
                <button type="button" disabled={busy} onClick={() => void submit("rejected")} className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50">
                  {t("review.reject")}
                </button>
                {!source && (
                  <button type="button" onClick={() => void askRerun()} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700">
                    {t("review.askRerun")}
                  </button>
                )}
              </div>
              <p className="text-xs text-zinc-500">{t("review.shortcuts")}</p>
              {message && <p className={`text-xs ${message.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}>{message.text}</p>}
            </div>
            <div className="space-y-3 text-xs">
              {hideFindings ? (
                <p className="text-zinc-500">{t("review.blindNote")}</p>
              ) : (
                entry.stages.map((stage) => (
                  <div key={stage.stageId} className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 p-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-200">{stage.stageId}</span>
                      <span className={stage.result === "accepted" || stage.result === "done" ? "text-emerald-400" : "text-red-400"}>{resultLabel(t, stage.result)}</span>
                    </div>
                    {stage.checks.map((c) => (
                      <div key={c.id} className={c.pass ? "text-zinc-400" : "text-red-300"}>
                        {c.pass ? "✓" : "✗"} {c.label ?? c.id}: {c.value === null ? "—" : String(c.value)}
                        {c.unit ? ` ${c.unit}` : ""}
                        {c.threshold !== null ? ` ${t("review.limit", { value: String(c.threshold) })}` : ""}
                        {c.atSeconds ? ` ${t("review.atTime", { time: formatPlayerTime(c.atSeconds[0]) })}` : ""}
                        {c.detail ? ` · ${c.detail}` : ""}
                      </div>
                    ))}
                    {Object.keys(stage.metrics).length > 0 && (
                      <div className="text-zinc-500">
                        {Object.entries(stage.metrics)
                          .map(([k, v]) => `${k} ${String(v)}`)
                          .join(" · ")}
                      </div>
                    )}
                    {stage.note && <div className="text-zinc-400">{stage.note}</div>}
                  </div>
                ))
              )}
              <div className="space-y-0.5 rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-zinc-400">
                <div className="font-medium text-zinc-200">{t("review.generation")}</div>
                {Object.entries(entry.params).length === 0 ? <div className="text-zinc-500">{t("review.noParams")}</div> : Object.entries(entry.params).map(([k, v]) => <div key={k}>{k}: {String(v)}</div>)}
              </div>
            </div>
          </div>
        </>
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
            const { result, itemKey, attemptRef } = confirmReplace;
            setConfirmReplace(null);
            // Only the track the question named; if the screen moved meanwhile, nothing is sent.
            if (entry?.itemKey === itemKey && entry.attemptRef === attemptRef) void submit(result, true);
          }}
        />
      )}
    </div>
  );
}
