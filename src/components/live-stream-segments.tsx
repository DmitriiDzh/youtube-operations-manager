"use client";

import { useEffect, useRef, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { SEGMENT_DEFAULT_MINUTES, SEGMENT_MAX_MINUTES, SEGMENT_MIN_MINUTES } from "@/lib/live-streams/fields";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-205 (FO-REQ-0032, docs/roadmap/plans/LIVE_SEGMENTS_PLAN.md §2.4): «Перезапуск эфира» -- the stream as segments under 12 h so
// YouTube keeps each recording. Saving is local; while it is on, the server switches the broadcast itself (ADR 0044).

export type SegmentsViewData = {
  enabled: boolean;
  lengthMinutes: number;
  switchHourUtc: number | null;
  recordingsPlaylist: { id: string; title: string } | null;
  current: { broadcastId: string; startedAt: string; switchDueAt: string | null } | null;
  segments: Array<{ broadcastId: string; startedAt: string; endedAt: string | null; overlapMs: number | null; rotation: string[]; recording: string; playlist: string }>;
  failures: Array<{ at: string; stage: string }>;
};

type Form = { enabled: boolean; hours: string; minutes: string; switchHourUtc: number | null; recordingsPlaylist: { id: string; title: string } | null };

const cardClass = "space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const inputClass = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const primaryClass = "rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50";

function formOf(view: SegmentsViewData | null): Form {
  const minutes = view?.lengthMinutes ?? SEGMENT_DEFAULT_MINUTES;
  return {
    enabled: view?.enabled ?? false,
    hours: String(Math.floor(minutes / 60)),
    minutes: String(minutes % 60),
    switchHourUtc: view?.switchHourUtc ?? null,
    recordingsPlaylist: view?.recordingsPlaylist ?? null,
  };
}

export function LiveStreamSegmentsCard({ base, view, onChanged }: { base: string; view: SegmentsViewData | null; onChanged: () => Promise<void> }) {
  const t = useT();
  const savedKey = JSON.stringify(formOf(view));
  const [form, setForm] = useState<Form>(formOf(view));
  const [playlists, setPlaylists] = useState<Array<{ id: string; title: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = JSON.stringify(form) !== savedKey;
  useEffect(() => {
    if (!dirtyRef.current) setForm(JSON.parse(savedKey) as Form);
  }, [savedKey]);

  // The channel's playlists (the same cached list the stream's video settings use).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/youtube/playlists")
      .then(async (res) => (res.ok ? ((await res.json()) as Array<{ id: string; title: string }>) : []))
      .then(
        (list) => !cancelled && setPlaylists(list.map((p) => ({ id: p.id, title: p.title }))),
        () => !cancelled && setPlaylists([])
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const lengthMinutes = Number(form.hours) * 60 + Number(form.minutes);
  const lengthOk = Number.isInteger(lengthMinutes) && lengthMinutes >= SEGMENT_MIN_MINUTES && lengthMinutes <= SEGMENT_MAX_MINUTES;

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${base}/segments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: form.enabled, lengthMinutes, switchHourUtc: form.switchHourUtc, recordingsPlaylist: form.recordingsPlaylist }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorText(t, body, t("live.segments.saveFailed"), { showErrorField: false }));
      setNotice(t("live.segments.saved"));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("live.segments.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const time = (iso: string) => new Date(iso).toLocaleString(t.language);
  const lastFailure = view?.failures[0];

  return (
    <div className={cardClass}>
      <div className="space-y-1">
        <h3 className="text-base font-medium text-zinc-100">{t("live.segments.title")}</h3>
        <p className="text-xs text-zinc-400">{t("live.segments.intro")}</p>
      </div>

      {view?.current && (
        <p className="text-xs text-zinc-300">
          {view.current.switchDueAt
            ? t("live.segments.current", { since: time(view.current.startedAt), next: time(view.current.switchDueAt) })
            : t("live.segments.currentOff", { since: time(view.current.startedAt) })}
        </p>
      )}
      {lastFailure && <p className="text-xs text-amber-300">{t("live.segments.lastFailure", { at: time(lastFailure.at), stage: lastFailure.stage })}</p>}

      <div className="flex items-center gap-3">
        <ToggleSwitch checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} disabled={busy} label={t("live.segments.toggle")} />
        <span className="text-sm text-zinc-200">{t("live.segments.toggle")}</span>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("live.segments.length")}
          <span className="flex items-center gap-1">
            <input inputMode="numeric" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value.replace(/\D/g, "") })} disabled={busy} className={`${inputClass} w-14`} aria-label={t("live.segments.hours")} />
            <span className="text-zinc-400">{t("live.segments.hoursShort")}</span>
            <input inputMode="numeric" value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value.replace(/\D/g, "") })} disabled={busy} className={`${inputClass} w-14`} aria-label={t("live.segments.minutes")} />
            <span className="text-zinc-400">{t("live.segments.minutesShort")}</span>
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("live.segments.quietHour")}
          <select
            value={form.switchHourUtc === null ? "" : String(form.switchHourUtc)}
            onChange={(e) => setForm({ ...form, switchHourUtc: e.target.value === "" ? null : Number(e.target.value) })}
            disabled={busy}
            className={inputClass}
          >
            <option value="">{t("live.segments.quietHourNone")}</option>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {`${String(h).padStart(2, "0")}:00 UTC`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("live.segments.playlist")}
          <select
            value={form.recordingsPlaylist?.id ?? ""}
            onChange={(e) => {
              const picked = playlists?.find((p) => p.id === e.target.value) ?? null;
              setForm({ ...form, recordingsPlaylist: picked });
            }}
            disabled={busy || playlists === null}
            className={`${inputClass} max-w-64`}
          >
            <option value="">{t("live.segments.playlistNone")}</option>
            {form.recordingsPlaylist && !playlists?.some((p) => p.id === form.recordingsPlaylist!.id) && <option value={form.recordingsPlaylist.id}>{form.recordingsPlaylist.title}</option>}
            {(playlists ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!lengthOk && <p className="text-xs text-amber-300">{t("live.segments.lengthProblem")}</p>}
      <p className="text-xs text-zinc-500">{t("live.segments.notes")}</p>

      <div className="flex items-center gap-3">
        <button onClick={() => void save()} disabled={busy || !lengthOk || !dirtyRef.current} className={primaryClass}>
          {busy ? t("live.segments.saving") : t("live.segments.save")}
        </button>
        {notice && <span className="text-xs text-emerald-300">{notice}</span>}
        {error && <span className="text-xs text-red-300">{error}</span>}
      </div>

      {view && view.segments.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1 pr-3 font-normal">{t("live.segments.col.started")}</th>
                <th className="py-1 pr-3 font-normal">{t("live.segments.col.ended")}</th>
                <th className="py-1 pr-3 font-normal">{t("live.segments.col.overlap")}</th>
                <th className="py-1 pr-3 font-normal">{t("live.segments.col.recording")}</th>
                <th className="py-1 pr-3 font-normal">{t("live.segments.col.playlist")}</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {view.segments.map((s) => (
                <tr key={s.broadcastId} className="border-t border-zinc-800">
                  <td className="py-1 pr-3">{time(s.startedAt)}</td>
                  <td className="py-1 pr-3">{s.endedAt ? time(s.endedAt) : t("live.segments.running")}</td>
                  <td className="py-1 pr-3">{s.overlapMs === null ? "—" : t("live.segments.seconds", { seconds: String(Math.round(s.overlapMs / 1000)) })}</td>
                  {/* ui-text-ignore: status codes (data) */}
                  <td className="py-1 pr-3">{s.recording}</td>
                  {/* ui-text-ignore: status codes (data) */}
                  <td className="py-1 pr-3">{s.playlist}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
