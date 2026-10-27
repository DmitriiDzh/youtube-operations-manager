"use client";

import { Fragment, useEffect, useState } from "react";
import type { MusicBatchRow, MusicGenreRow, MusicLibraryResult, MusicLibraryView } from "@/lib/music-library/contracts";
import type { Translate } from "@/lib/ui-text";
import { useUiText } from "./ui-text-provider";

// BL-229 part A (FO-REQ-0043 §A, MUSIC_LIBRARY_PLAN.md §2): Media → «Музыка» → «Библиотека по жанрам». The factory's summary of
// the active channel's music, read-only: no control here changes anything (the factory owns genres, batches and tracks).

const POLL_MS = 60_000;
const DASH = "—";

export type MusicLibraryLoad = { state: "loading" } | { state: "failed" } | { state: "done"; result: MusicLibraryResult };

function ageText(t: Translate, minutes: number): string {
  if (minutes < 60) return t("musicLibrary.age.minutes", { count: minutes });
  if (minutes < 48 * 60) return t("musicLibrary.age.hours", { count: Math.floor(minutes / 60) });
  return t("musicLibrary.age.days", { count: Math.floor(minutes / (24 * 60)) });
}

export function MusicLibraryCard({ channelId, active }: { channelId: string | null; active: boolean }) {
  const { t } = useUiText();
  const [load, setLoad] = useState<MusicLibraryLoad>({ state: "loading" });

  useEffect(() => {
    if (!active || !channelId) return;
    let cancelled = false;
    const fetchOnce = () =>
      void fetch(`/api/channels/${encodeURIComponent(channelId)}/music-library`)
        .then((response) => (response.ok ? (response.json() as Promise<MusicLibraryResult>) : Promise.reject(new Error(String(response.status)))))
        .then(
          (result) => {
            if (!cancelled) setLoad({ state: "done", result });
          },
          () => {
            if (!cancelled) setLoad({ state: "failed" });
          }
        );
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, channelId]);

  if (!channelId) return null;
  return (
    <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-zinc-100">{t("musicLibrary.title")}</h3>
        {load.state === "done" && load.result.status === "ok" ? <MusicLibraryAge view={load.result.view} /> : null}
      </div>
      <p className="text-xs text-zinc-400">{t("musicLibrary.help")}</p>
      <MusicLibraryBody load={load} />
    </section>
  );
}

/** The snapshot's age, with the stale mark when it is older than 24 h (AC-ML-05). */
export function MusicLibraryAge({ view }: { view: Pick<MusicLibraryView, "generatedAt" | "ageMinutes" | "stale"> }) {
  const { t } = useUiText();
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
      <span title={view.generatedAt}>{ageText(t, view.ageMinutes)}</span>
      {view.stale ? <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-300">{t("musicLibrary.stale")}</span> : null}
    </span>
  );
}

export function MusicLibraryBody({ load }: { load: MusicLibraryLoad }) {
  const { t } = useUiText();
  if (load.state === "loading") return <p className="text-sm text-zinc-500">{t("musicLibrary.loading")}</p>;
  if (load.state === "failed") return <p className="text-sm text-red-300">{t("musicLibrary.loadFailed")}</p>;
  const result = load.result;
  if (result.status === "no_workspace") return <Empty text={t("musicLibrary.noWorkspace")} />;
  if (result.status === "workspace_unavailable") return <Empty text={t("musicLibrary.workspaceUnavailable", { reason: result.reason })} />;
  if (result.status === "no_file") return <Empty text={t("musicLibrary.noFile")} />;
  if (result.status === "unreadable") return <Empty tone="warn" text={t("musicLibrary.unreadable", { reason: result.reason })} />;
  const { genres, withoutGenre } = result.view;
  return (
    <div className="space-y-3">
      {genres.length === 0 ? <Empty text={t("musicLibrary.noGenres")} /> : <GenreTable genres={genres} />}
      {withoutGenre ? (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <p className="text-sm font-medium text-amber-200">{t("musicLibrary.withoutGenre", { count: withoutGenre.tracks })}</p>
          <p className="text-xs text-amber-200/80">{t("musicLibrary.withoutGenre.help")}</p>
          {withoutGenre.batchRows.length > 0 ? <MusicBatchTable rows={withoutGenre.batchRows} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function Empty({ text, tone = "plain" }: { text: string; tone?: "plain" | "warn" }) {
  return <p className={`rounded-lg border px-3 py-2 text-sm ${tone === "warn" ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-zinc-800 bg-zinc-950 text-zinc-400"}`}>{text}</p>;
}

function GenreTable({ genres }: { genres: MusicGenreRow[] }) {
  const { t, formatNumber } = useUiText();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const hours = (value: number) => t("musicLibrary.hours", { hours: formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  const th = "px-2 py-1.5 text-left font-medium";
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-zinc-950 text-xs text-zinc-400">
          <tr>
            <th className={th}>{t("musicLibrary.col.genre")}</th>
            <th className={th}>{t("musicLibrary.col.playlist")}</th>
            <th className={th}>{t("musicLibrary.col.status")}</th>
            <th className={`${th} text-right`}>{t("musicLibrary.col.batches")}</th>
            <th className={`${th} text-right`}>{t("musicLibrary.col.tracks")}</th>
            <th className={`${th} text-right`}>{t("musicLibrary.col.hours")}</th>
            <th className={`${th} text-right`}>{t("musicLibrary.col.neverUsed")}</th>
            <th className={`${th} text-right`}>{t("musicLibrary.col.daysLeft")}</th>
          </tr>
        </thead>
        <tbody>
          {genres.map((genre) => {
            const expanded = open[genre.id] === true;
            return (
              <Fragment key={genre.id}>
                <tr className="border-t border-zinc-800 text-zinc-200">
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-label={t(expanded ? "musicLibrary.hideBatches" : "musicLibrary.showBatches", { genre: genre.title })}
                      onClick={() => setOpen((prev) => ({ ...prev, [genre.id]: !expanded }))}
                      className="flex items-center gap-2 text-left hover:text-white"
                    >
                      <span aria-hidden="true" className="w-3 text-xs text-zinc-500">{expanded ? "▾" : "▸"}</span>
                      <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full border border-zinc-600" style={genre.color ? { backgroundColor: genre.color, borderColor: genre.color } : undefined} />
                      {genre.label ? <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] font-semibold text-zinc-200">{genre.label}</span> : null}
                      <span className="font-medium">{genre.title}</span>
                    </button>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs text-zinc-400">{genre.playlist ?? DASH}</td>
                  <td className="px-2 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${genre.status === "active" ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-300"}`}>
                      {t(genre.status === "active" ? "musicLibrary.status.active" : "musicLibrary.status.stub")}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(genre.batches)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(genre.tracks)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{hours(genre.hours)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{hours(genre.neverUsedHours)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{genre.daysLeft === null ? DASH : t("musicLibrary.days", { count: genre.daysLeft })}</td>
                </tr>
                {expanded ? (
                  <tr className="bg-zinc-950/60">
                    <td colSpan={8} className="px-2 py-2">
                      {genre.batchRows.length === 0 ? <p className="text-xs text-zinc-500">{t("musicLibrary.noBatches")}</p> : <MusicBatchTable rows={genre.batchRows} />}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function MusicBatchTable({ rows }: { rows: MusicBatchRow[] }) {
  const { t, formatNumber } = useUiText();
  const th = "px-2 py-1 text-left font-medium";
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] text-xs">
        <thead className="text-zinc-500">
          <tr>
            <th className={th}>{t("musicLibrary.batch.number")}</th>
            <th className={th}>{t("musicLibrary.batch.playlist")}</th>
            <th className={th}>{t("musicLibrary.batch.brief")}</th>
            <th className={`${th} text-right`}>{t("musicLibrary.batch.tracks")}</th>
            <th className={th}>{t("musicLibrary.batch.date")}</th>
            <th className={th}>{t("musicLibrary.batch.source")}</th>
            <th className={`${th} text-right`}>{t("musicLibrary.batch.accepted")}</th>
          </tr>
        </thead>
        <tbody className="text-zinc-300">
          {rows.map((row) => (
            <tr key={row.batch} className="border-t border-zinc-800/70">
              <td className="px-2 py-1 font-mono">{row.batch}</td>
              <td className="px-2 py-1 font-mono text-zinc-400">{row.playlist ?? DASH}</td>
              <td className="px-2 py-1">{row.briefVersion ?? DASH}</td>
              <td className="px-2 py-1 text-right tabular-nums">{formatNumber(row.tracks)}</td>
              <td className="px-2 py-1">{row.date ?? DASH}</td>
              <td className="px-2 py-1">{row.source ?? DASH}</td>
              <td className="px-2 py-1 text-right tabular-nums">
                {row.acceptancePercent === null || row.accepted === null || row.reviewed === null
                  ? DASH
                  : t("musicLibrary.batch.acceptance", { accepted: row.accepted, reviewed: row.reviewed, percent: row.acceptancePercent })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
