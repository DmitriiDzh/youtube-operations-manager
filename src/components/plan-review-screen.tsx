"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanCheck, PlanMarker, PlanReference, PlanReviewEntry } from "@/lib/generation-plans/contracts";
import { integratedLoudness, LOUDNESS_TARGET_LUFS, matchedVolume } from "./loudness";
import { MediaReviewPlayer, formatPlayerTime, type FrequencyMark, type ReviewMarker, type ReviewPlayerHandle } from "./media-review-player";
import { ToggleSwitch } from "./toggle-switch";
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

/** The next attempt still waiting after `from` (wrapping), else -1. Exported for its test. */
export function nextWaitingIndex(entries: Array<{ verdict: unknown }>, from: number): number {
  for (let step = 1; step <= entries.length; step++) {
    const i = (from + step) % entries.length;
    if (entries[i].verdict === null) return i;
  }
  return -1;
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

async function postJson(t: Translate, url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message ?? t("review.requestFailed", { status: String(res.status) }));
  return data;
}

type Draft = { reasons: string[]; rating: number | null; note: string; marks: PlanMarker[]; openMark: number | null };
const emptyDraft = (): Draft => ({ reasons: [], rating: null, note: "", marks: [], openMark: null });

/** BL-143 phase 2: the queue of ANOTHER device's plan, from its report, with the verdicts sent from here still waiting. */
export type PeerReviewSource = { deviceId: string; hostname: string | null };

type PeerQueueResponse = {
  devices: Array<{ deviceId: string; hostname: string | null; plans: Array<{ planId: string; review: PlanReviewEntry[]; itemParams?: Record<string, PlanReviewEntry["params"]>; references?: PlanReference[] }> }>;
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
  const { t, formatNumber } = useUiText();
  const [entries, setEntries] = useState<PlanReviewEntry[] | null>(null);
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

  /** The queue, freshest from the server; `[]` (with the message shown) when it cannot be read. */
  const load = useCallback(
    (): Promise<PlanReviewEntry[]> =>
      fetch(peerDevice ? "/api/generation-plans/peers" : `${base}/review`)
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as { entries?: PlanReviewEntry[]; references?: PlanReference[]; message?: string } & Partial<PeerQueueResponse>;
          if (!res.ok) throw new Error(data.message ?? t("review.loadFailedStatus", { status: String(res.status) }));
          setReferences(peerDevice ? (data.devices?.find((d) => d.deviceId === peerDevice)?.plans.find((p) => p.planId === planId)?.references ?? []) : (data.references ?? []));
          const list = peerDevice ? peerQueue({ devices: data.devices ?? [], outgoing: data.outgoing ?? [] }, { deviceId: peerDevice, hostname: peerName }, planId) : (data.entries ?? []);
          setEntries(list);
          return list;
        })
        .catch((error: unknown) => {
          setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.loadFailed") });
          return [];
        }),
    [base, peerDevice, peerName, planId, t]
  );

  useEffect(() => {
    void load().then((list) => setIndex(Math.max(0, list.findIndex((e) => e.verdict === null))));
  }, [load]);

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
    async (result: "accepted" | "rejected") => {
      if (!entry || busy) return;
      setBusy(true);
      try {
        const marks = draft.openMark !== null ? [...draft.marks, { start: draft.openMark, end: null, note: null }] : draft.marks;
        await postJson(t, `${base}/verdict`, { itemKey: entry.itemKey, attemptRef: entry.attemptRef, result, ...(draft.rating !== null ? { rating: draft.rating } : {}), reasons: draft.reasons, markers: marks, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) });
        setMessage({ tone: "ok", text: t("review.verdictSaved", { item: entry.itemKey, result: resultLabel(t, result) }) });
        onChanged?.();
        // Auto-advance: the next attempt still waiting after this one, in the refreshed queue.
        const list = await load();
        const here = list.findIndex((e) => e.itemKey === entry.itemKey && e.attemptRef === entry.attemptRef);
        const next = nextWaitingIndex(list, here >= 0 ? here : index);
        setDraft(emptyDraft());
        stopB();
        setIndex(next >= 0 ? next : Math.max(0, here));
      } catch (error) {
        setMessage({ tone: "error", text: error instanceof Error ? error.message : t("review.saveFailed") });
      } finally {
        setBusy(false);
      }
    },
    [base, busy, draft, entry, index, load, onChanged, stopB, t]
  );

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
      else if (action === "next") go(index + 1);
      else if (action === "previous") go(index - 1);
      else if (action === "mark") mark();
      else if (action === "ab") toggleAB();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, mark, submit, toggleAB, onB]);

  // The reference's volume follows the loudness switch while it plays.
  useEffect(() => {
    const audio = referenceAudio.current;
    if (audio && chosen) audio.volume = matchLoudness ? matchedVolume(chosen.lufs) : 1;
  }, [matchLoudness, chosen, onB]);

  const markers = useMemo<ReviewMarker[]>(() => {
    if (!entry) return [];
    const findings = blind && entry.verdict === null ? [] : findingMarkers(entry);
    const own = [...(entry.verdict?.markers ?? []), ...draft.marks].map((m) => ({ start: m.start, end: m.end, label: m.note, tone: "mark" as const }));
    return [...findings, ...own, ...(draft.openMark !== null ? [{ start: draft.openMark, end: null, label: t("review.openMark"), tone: "mark" as const }] : [])];
  }, [blind, draft.marks, draft.openMark, entry, t]);

  const lufsOf = entry ? (reportedLufs(entry) ?? (measured && entry && measured.src === `${base}/audition?itemKey=${encodeURIComponent(entry.itemKey)}&attemptRef=${encodeURIComponent(entry.attemptRef)}` ? measured.lufs : null)) : null;
  const src = entry ? `${base}/audition?itemKey=${encodeURIComponent(entry.itemKey)}&attemptRef=${encodeURIComponent(entry.attemptRef)}` : null;
  const hideFindings = blind && entry?.verdict === null;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold text-zinc-100">
          {t("review.title", { plan: planId })}
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
      {entries && entries.length === 0 && <p className="text-sm text-zinc-500">{t("review.empty")}</p>}
      {entry && (
        <>
          <div className="flex flex-wrap items-baseline gap-2 text-sm">
            <button type="button" onClick={() => go(index - 1)} className="text-zinc-400 hover:text-zinc-100" aria-label={t("review.previous")}>
              ←
            </button>
            <span className="font-mono text-zinc-100">{entry.itemKey}</span>
            <span className="text-xs text-zinc-500">
              {entry.seed !== null
                ? t("review.attemptMetaSeed", { attempt: entry.attemptRef, seed: String(entry.seed), index: index + 1, total: entries?.length ?? 0 })
                : t("review.attemptMeta", { attempt: entry.attemptRef, index: index + 1, total: entries?.length ?? 0 })}
            </span>
            <button type="button" onClick={() => go(index + 1)} className="text-zinc-400 hover:text-zinc-100" aria-label={t("review.next")}>
              →
            </button>
            {entry.verdict && (
              <span className={`ml-auto text-xs ${entry.verdict.result === "accepted" ? "text-emerald-400" : "text-red-400"}`}>
                {entry.verdict.reportedBy === "owner" ? t("review.verdictYour", { result: resultLabel(t, entry.verdict.result) }) : t("review.verdictRelayed", { result: resultLabel(t, entry.verdict.result) })}
                {entry.verdict.note?.startsWith(SENT_NOTE_PREFIX) ? ` · ${t("review.sentWaitingFor", { device: entry.verdict.note.slice(SENT_NOTE_PREFIX.length) })}` : ""}
                {entry.verdict.rating !== null ? ` ${entry.verdict.rating}/10` : ""}
              </span>
            )}
          </div>
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
                      <span className={stage.result === "accepted" || stage.result === "done" ? "text-emerald-400" : "text-red-400"}>{stage.result}</span>
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
    </div>
  );
}
