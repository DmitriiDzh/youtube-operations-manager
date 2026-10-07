"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanCheck, PlanMarker, PlanReviewEntry } from "@/lib/generation-plans/contracts";
import { MediaReviewPlayer, formatPlayerTime, type ReviewMarker, type ReviewPlayerHandle } from "./media-review-player";
import { ToggleSwitch } from "./toggle-switch";

// BL-143 (MEDIA_REVIEW_TOOLS.md §2 group A + the owner's additions, msg 1939): the owner's listening review of a plan --
// a queue of attempts waiting for a verdict, the player with the waveform and the validator's time findings, keyboard
// shortcuts, Accept / Reject with reasons, a rating out of 10, time marks and a comment; blind mode hides the validator until
// the verdict. "Ask for a re-run" only records the request for the Factory Operator -- nothing is started here.

/** The reasons from R-0001 (FO-MSG-0008 §6), the owner's starting list (msg 1933). */
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

export type ReviewKeyAction = "play" | "back" | "forward" | "accept" | "reject" | "next" | "previous" | "mark" | { rating: number };

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

/** The validator findings that have a time, as waveform ranges. Exported for its test. */
export function findingMarkers(entry: Pick<PlanReviewEntry, "stages">): ReviewMarker[] {
  return entry.stages.flatMap((stage) =>
    stage.checks.filter((c): c is PlanCheck & { atSeconds: [number, number] } => c.atSeconds !== null).map((c) => ({ start: c.atSeconds[0], end: c.atSeconds[1], label: c.label ?? c.id, tone: "finding" as const }))
  );
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `Request failed (${res.status})`);
  return data;
}

type Draft = { reasons: string[]; rating: number | null; note: string; marks: PlanMarker[]; openMark: number | null };
const emptyDraft = (): Draft => ({ reasons: [], rating: null, note: "", marks: [], openMark: null });

export function PlanReviewScreen({ planId, onClose, onChanged }: { planId: string; onClose: () => void; onChanged?: () => void }) {
  const [entries, setEntries] = useState<PlanReviewEntry[] | null>(null);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [blind, setBlind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const player = useRef<ReviewPlayerHandle | null>(null);
  const base = `/api/generation-plans/${encodeURIComponent(planId)}`;

  /** The queue, freshest from the server; `[]` (with the message shown) when it cannot be read. */
  const load = useCallback(
    (): Promise<PlanReviewEntry[]> =>
      fetch(`${base}/review`)
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as { entries?: PlanReviewEntry[]; message?: string };
          if (!res.ok) throw new Error(data.message ?? `Failed to load the review queue (${res.status})`);
          const list = data.entries ?? [];
          setEntries(list);
          return list;
        })
        .catch((error: unknown) => {
          setMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to load the review queue" });
          return [];
        }),
    [base]
  );

  useEffect(() => {
    void load().then((list) => setIndex(Math.max(0, list.findIndex((e) => e.verdict === null))));
  }, [load]);

  const entry = entries && entries.length > 0 ? entries[Math.min(index, entries.length - 1)] : null;
  const waiting = entries?.filter((e) => e.verdict === null).length ?? 0;

  const go = useCallback(
    (to: number) => {
      if (!entries || entries.length === 0) return;
      setIndex(((to % entries.length) + entries.length) % entries.length);
      setDraft(emptyDraft());
      setMessage(null);
    },
    [entries]
  );

  const submit = useCallback(
    async (result: "accepted" | "rejected") => {
      if (!entry || busy) return;
      setBusy(true);
      try {
        const marks = draft.openMark !== null ? [...draft.marks, { start: draft.openMark, end: null, note: null }] : draft.marks;
        await postJson(`${base}/verdict`, { itemKey: entry.itemKey, attemptRef: entry.attemptRef, result, ...(draft.rating !== null ? { rating: draft.rating } : {}), reasons: draft.reasons, markers: marks, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) });
        setMessage({ tone: "ok", text: `${entry.itemKey}: ${result}` });
        onChanged?.();
        // Auto-advance: the next attempt still waiting after this one, in the refreshed queue.
        const list = await load();
        const here = list.findIndex((e) => e.itemKey === entry.itemKey && e.attemptRef === entry.attemptRef);
        const next = nextWaitingIndex(list, here >= 0 ? here : index);
        setDraft(emptyDraft());
        setIndex(next >= 0 ? next : Math.max(0, here));
      } catch (error) {
        setMessage({ tone: "error", text: error instanceof Error ? error.message : "The verdict could not be saved" });
      } finally {
        setBusy(false);
      }
    },
    [base, busy, draft, entry, index, load, onChanged]
  );

  const mark = useCallback(() => {
    const t = Math.round((player.current?.currentTime() ?? 0) * 10) / 10;
    setDraft((d) => (d.openMark === null ? { ...d, openMark: t } : { ...d, openMark: null, marks: [...d.marks, { start: Math.min(d.openMark, t), end: Math.max(d.openMark, t), note: null }] }));
  }, []);

  const askRerun = async () => {
    if (!entry) return;
    try {
      await postJson(`${base}/rerun-request`, { itemKey: entry.itemKey, attemptRef: entry.attemptRef, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) });
      setMessage({ tone: "ok", text: `Re-run of ${entry.itemKey} asked; the Factory Operator sees it in the plan's events` });
      onChanged?.();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "The request could not be saved" });
    }
  };

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
      if (typeof action === "object") setDraft((d) => ({ ...d, rating: action.rating }));
      else if (action === "play") player.current?.togglePlay();
      else if (action === "back") player.current?.seekBy(-5);
      else if (action === "forward") player.current?.seekBy(5);
      else if (action === "accept") void submit("accepted");
      else if (action === "reject") void submit("rejected");
      else if (action === "next") go(index + 1);
      else if (action === "previous") go(index - 1);
      else if (action === "mark") mark();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, mark, submit]);

  const markers = useMemo<ReviewMarker[]>(() => {
    if (!entry) return [];
    const findings = blind && entry.verdict === null ? [] : findingMarkers(entry);
    const own = [...(entry.verdict?.markers ?? []), ...draft.marks].map((m) => ({ start: m.start, end: m.end, label: m.note, tone: "mark" as const }));
    return [...findings, ...own, ...(draft.openMark !== null ? [{ start: draft.openMark, end: null, label: "mark…", tone: "mark" as const }] : [])];
  }, [blind, draft.marks, draft.openMark, entry]);

  const src = entry ? `${base}/audition?itemKey=${encodeURIComponent(entry.itemKey)}&attemptRef=${encodeURIComponent(entry.attemptRef)}` : null;
  const hideFindings = blind && entry?.verdict === null;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold text-zinc-100">Review · {planId}</h3>
        <span className="text-xs text-zinc-400">{entries ? `${waiting} waiting · ${entries.length} in the queue` : "Loading…"}</span>
        <div className="ml-auto flex items-center gap-3">
          <ToggleSwitch label="Blind (hide the validator until my verdict)" checked={blind} onChange={setBlind} />
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700">
            Back to the plan
          </button>
        </div>
      </div>
      {entries && entries.length === 0 && <p className="text-sm text-zinc-500">Nothing to review yet: no attempt has passed the stage before your review.</p>}
      {entry && (
        <>
          <div className="flex flex-wrap items-baseline gap-2 text-sm">
            <button type="button" onClick={() => go(index - 1)} className="text-zinc-400 hover:text-zinc-100" aria-label="Previous (P)">
              ←
            </button>
            <span className="font-mono text-zinc-100">{entry.itemKey}</span>
            <span className="text-xs text-zinc-500">
              {entry.attemptRef}
              {entry.seed !== null ? ` · seed ${entry.seed}` : ""} · {index + 1} of {entries?.length}
            </span>
            <button type="button" onClick={() => go(index + 1)} className="text-zinc-400 hover:text-zinc-100" aria-label="Next (N)">
              →
            </button>
            {entry.verdict && (
              <span className={`ml-auto text-xs ${entry.verdict.result === "accepted" ? "text-emerald-400" : "text-red-400"}`}>
                {entry.verdict.reportedBy === "owner" ? "your" : "relayed"} verdict: {entry.verdict.result}
                {entry.verdict.rating !== null ? ` ${entry.verdict.rating}/10` : ""}
              </span>
            )}
          </div>
          {entry.playable && src ? <MediaReviewPlayer key={src} ref={player} src={src} markers={markers} /> : <p className="text-sm text-zinc-500">Nothing to play for this attempt on this device.</p>}

          <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {REVIEW_REASONS.map((reason) => {
                  const on = draft.reasons.includes(reason);
                  return (
                    <button key={reason} type="button" onClick={() => setDraft((d) => ({ ...d, reasons: on ? d.reasons.filter((r) => r !== reason) : [...d.reasons, reason] }))} className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-red-400 bg-red-500/20 text-red-200" : "border-zinc-700 text-zinc-400 hover:border-zinc-500"}`}>
                      {reason}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-1 text-xs text-zinc-400">
                Rating
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <button key={n} type="button" onClick={() => setDraft((d) => ({ ...d, rating: d.rating === n ? null : n }))} className={`h-6 w-6 rounded ${draft.rating === n ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}>
                    {n}
                  </button>
                ))}
                <span className="ml-1 text-zinc-500">/ 10</span>
              </div>
              <textarea value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} rows={2} maxLength={2000} placeholder="Comment for the Factory Operator (optional)" className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100" />
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <button type="button" onClick={mark} className="rounded-md border border-amber-500/60 px-2.5 py-1 text-amber-200 hover:bg-amber-500/10">
                  {draft.openMark === null ? "Mark at playhead (M)" : `End mark started at ${formatPlayerTime(draft.openMark)} (M)`}
                </button>
                {draft.marks.map((m, i) => (
                  <span key={i} className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-200">
                    {formatPlayerTime(m.start)}
                    {m.end !== null ? `–${formatPlayerTime(m.end)}` : ""}
                    <button type="button" onClick={() => setDraft((d) => ({ ...d, marks: d.marks.filter((_, j) => j !== i) }))} className="ml-1 text-amber-300 hover:text-white" aria-label="Remove mark">
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void submit("accepted")} className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                  Accept (A)
                </button>
                <button type="button" disabled={busy} onClick={() => void submit("rejected")} className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50">
                  Reject (R)
                </button>
                <button type="button" onClick={() => void askRerun()} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700">
                  Ask for a re-run
                </button>
              </div>
              <p className="text-xs text-zinc-500">Space play/pause · ←/→ 5 s · A accept · R reject · N/P next/previous · M mark · 1–9, 0 = 10 rating</p>
              {message && <p className={`text-xs ${message.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}>{message.text}</p>}
            </div>
            <div className="space-y-3 text-xs">
              {hideFindings ? (
                <p className="text-zinc-500">Blind mode: the validator&rsquo;s findings show after your verdict.</p>
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
                        {c.threshold !== null ? ` (limit ${String(c.threshold)})` : ""}
                        {c.atSeconds ? ` at ${formatPlayerTime(c.atSeconds[0])}` : ""}
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
                <div className="font-medium text-zinc-200">Generation</div>
                {Object.entries(entry.params).length === 0 ? <div className="text-zinc-500">No params recorded in the plan.</div> : Object.entries(entry.params).map(([k, v]) => <div key={k}>{k}: {String(v)}</div>)}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
