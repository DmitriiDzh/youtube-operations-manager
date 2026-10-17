"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDisplayDate, formatDisplayDateTime } from "@/lib/shared-formatting";
import type { UiTextKey } from "@/lib/ui-text";
import { SkeletonLines } from "./busy-feedback";
import { useRecentSyncConfirm } from "./recent-sync-confirm";
import { entriesByDay, gapDays, localDayKey, monthWeeks, type GridEntry } from "./publishing-calendar-grid";
import { useT } from "./ui-text-provider";
import { VideoDetailModal } from "./video-detail-modal";
import { VideoDetailsPanel } from "./video-details-panel";

// BL-182 stage 1 (FO-REQ-0023 §4 C; PUBLISHING_PLAN.md §2 stage 1): Content → «Календарь». The questions the owner asks of it, in
// order: until when is the channel covered (and is that soon), which days of the next two weeks have no video, what is waiting
// without a date. The month grid answers the middle one at a glance; the summary on top answers the first; the lists below the
// last. A video opens its Details (the same card as «Видео»), where a scheduled, still-private video's date can be changed. Times
// are the viewer's own, with UTC on hover. Data age and "Sync" are always visible: a stale copy is never shown as current.

type CalendarResponse = {
  channelId: string;
  lastSyncedAt: string | null;
  entries: Array<GridEntry & { privacyStatus: string }>;
  coverage: { coveredThrough: string | null; scheduledCount: number; unscheduledCount: number; daysCovered: number; due: boolean; thresholdDays: number };
};

const KIND_STYLES: Record<GridEntry["kind"], string> = {
  published: "border-emerald-800 bg-emerald-950/60 text-emerald-200",
  scheduled: "border-sky-800 bg-sky-950/60 text-sky-200",
  overdue: "border-amber-700 bg-amber-950/60 text-amber-200",
  unscheduled: "border-zinc-700 bg-zinc-900 text-zinc-300",
  package: "border-dashed border-violet-700 bg-violet-950/30 text-violet-200",
};

/** A ready package on its planned day: shown for planning, not a video yet (its id is the manifest path). */
type PackageEntry = GridEntry & { kind: "package" };

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function timeOf(iso: string): string {
  const at = new Date(iso);
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** The UTC date and time (the date can differ from the local one near midnight). */
function utcTimeOf(iso: string): string {
  const at = new Date(iso);
  return `${pad2(at.getUTCDate())}.${pad2(at.getUTCMonth() + 1)} ${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())}`;
}

export function PublishingCalendar({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const t = useT();
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [open, setOpen] = useState<{ videoId: string; title: string } | null>(null);
  const [packageEntries, setPackageEntries] = useState<PackageEntry[]>([]);
  const packagesReadAt = useRef(0);
  const [detailsDirty, setDetailsDirty] = useState(false);

  const load = useCallback(async () => {
    if (!channelId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/publishing/calendar`);
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as CalendarResponse);
      // BL-182 stage 2: the ready packages on their planned days (the folder is read at most every 5 minutes; a failed read only
      // leaves them out).
      if (Date.now() - packagesReadAt.current > 5 * 60_000) {
        packagesReadAt.current = Date.now();
        const base = `/api/channels/${encodeURIComponent(channelId)}`;
        const [packagesRes, settingsRes] = await Promise.all([fetch(`${base}/publishing/packages`), fetch(`${base}/publishing-settings`)]);
        if (packagesRes.ok && settingsRes.ok) {
          const scanned = (await packagesRes.json()) as { status: string; packages?: Array<{ manifestPath: string; video: string | null; title: string | null; plannedPublishDate: string | null; state: string }> };
          const time = ((await settingsRes.json()) as { settings?: { publishTimeUtc?: string } }).settings?.publishTimeUtc ?? "12:00";
          setPackageEntries(
            (scanned.packages ?? [])
              .filter((p) => p.state === "ready" && p.plannedPublishDate)
              .map((p) => ({ videoId: p.manifestPath, title: `${p.video ?? ""} ${p.title ?? ""}`.trim(), kind: "package" as const, at: `${p.plannedPublishDate}T${time}:00Z` }))
          );
        }
      }
    } catch {
      setError(t("publishingCalendar.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [channelId, t]);

  // While visible: load, then every minute (a local read) -- so the copy «Видео» refreshes in the background, a date changed
  // elsewhere and the day turning over all show without a reload (review).
  useEffect(() => {
    if (!visible) return;
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [visible, load]);

  async function sync() {
    if (!channelId) return;
    setSyncing(true);
    setSyncError(null);
    setSyncNotice(null);
    try {
      const res = await fetch("/api/channels/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channelId }) });
      if (res.status === 409) {
        // A sync of this channel is already running (e.g. «Видео» refreshing in the background): the minute refresh picks it up.
        setSyncNotice(t("publishingCalendar.syncAlreadyRunning"));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      await load();
    } catch {
      setSyncError(t("publishingCalendar.syncFailed"));
    } finally {
      setSyncing(false);
    }
  }

  const recentSync = useRecentSyncConfirm(data?.lastSyncedAt, () => void sync());
  const now = useMemo(() => new Date(), [data]); // eslint-disable-line react-hooks/exhaustive-deps -- "now" moves with each load
  const byDay = useMemo(() => entriesByDay([...(data?.entries ?? []), ...packageEntries]), [data, packageEntries]);
  const gaps = useMemo(() => gapDays(now, byDay), [now, byDay]);
  const weeks = useMemo(() => monthWeeks(cursor.year, cursor.month), [cursor]);
  const todayKey = localDayKey(now);
  const undated = (data?.entries ?? []).filter((entry) => entry.kind === "unscheduled");
  const overdue = (data?.entries ?? []).filter((entry) => entry.kind === "overdue");

  function shiftMonth(delta: number) {
    setCursor((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }

  function closeDetails() {
    setOpen(null);
    void load(); // a date change in the card shows at once
  }

  if (!channelId) return null;
  if (!data) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">
        {error ?? <SkeletonLines lines={5} />}
      </div>
    );
  }

  const { coverage } = data;
  if (!data.lastSyncedAt) {
    // Never synced on this computer: "nothing is scheduled" would be a false alarm (the reminder route gives no alert here either).
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-300">
        <span>{t("publishingCalendar.notSynced")}</span>
        <button type="button" onClick={() => void sync()} disabled={syncing} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          {syncing ? t("publishingCalendar.syncing") : t("publishingCalendar.sync")}
        </button>
        {syncError && <p className="w-full text-sm text-red-400">{syncError}</p>}
        {syncNotice && <p className="w-full text-sm text-zinc-400">{syncNotice}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <section className={`rounded-xl border p-4 ${coverage.due ? "border-amber-700 bg-amber-950/30" : "border-zinc-800 bg-zinc-900"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-base font-medium text-zinc-100">
              {coverage.coveredThrough
                ? t("publishingCalendar.coveredThrough", {
                    date: `${formatDisplayDate(coverage.coveredThrough)} ${timeOf(coverage.coveredThrough)}`,
                    days: coverage.daysCovered,
                  })
                : t("publishingCalendar.nothingScheduled")}
            </p>
            {coverage.due && <p className="text-sm text-amber-300">{t("publishingCalendar.reminder", { threshold: coverage.thresholdDays })}</p>}
            <p className="text-xs text-zinc-500">
              {coverage.unscheduledCount > 0 && <span className="mr-3">{t("publishingCalendar.unscheduledCount", { count: coverage.unscheduledCount })}</span>}
              {overdue.length > 0 && <span>{t("publishingCalendar.overdueCount", { count: overdue.length })}</span>}
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            {data.lastSyncedAt && <span>{t("publishingCalendar.dataAge", { time: formatDisplayDateTime(data.lastSyncedAt) })}</span>}
            {recentSync.dialog}
            <button
              type="button"
              onClick={recentSync.request}
              disabled={syncing || loading}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              {syncing ? t("publishingCalendar.syncing") : t("publishingCalendar.sync")}
            </button>
          </div>
        </div>
        {syncError && <p className="mt-2 text-sm text-red-400">{syncError}</p>}
        {syncNotice && <p className="mt-2 text-sm text-zinc-400">{syncNotice}</p>}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button type="button" aria-label={t("publishingCalendar.previousMonth")} onClick={() => shiftMonth(-1)} className="rounded-md px-2 py-1 text-zinc-300 hover:bg-zinc-800">
              ‹
            </button>
            <h3 className="min-w-40 text-center text-base font-medium text-zinc-100">
              {t(`publishingCalendar.month.${cursor.month + 1}` as UiTextKey)} {cursor.year}
            </h3>
            <button type="button" aria-label={t("publishingCalendar.nextMonth")} onClick={() => shiftMonth(1)} className="rounded-md px-2 py-1 text-zinc-300 hover:bg-zinc-800">
              ›
            </button>
            <button
              type="button"
              onClick={() => setCursor({ year: now.getFullYear(), month: now.getMonth() })}
              className="ml-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              {t("publishingCalendar.today")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-600" />{t("publishingCalendar.legend.published")}</span>
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-sky-600" />{t("publishingCalendar.legend.scheduled")}</span>
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-600" />{t("publishingCalendar.legend.overdue")}</span>
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-violet-600" />{t("publishingCalendar.legend.package")}</span>
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-red-600" />{t("publishingCalendar.legend.gap")}</span>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1 text-xs">
          {[1, 2, 3, 4, 5, 6, 7].map((day) => (
            <div key={day} className="px-1 pb-1 text-center font-medium text-zinc-500">
              {t(`publishingCalendar.weekday.${day}` as UiTextKey)}
            </div>
          ))}
          {weeks.flat().map((day) => {
            const key = localDayKey(day);
            const inMonth = day.getMonth() === cursor.month;
            const entries = byDay.get(key) ?? [];
            const isGap = gaps.has(key);
            const isToday = key === todayKey;
            return (
              <div
                key={key}
                aria-current={isToday ? "date" : undefined}
                className={`min-h-24 rounded-md border p-1 ${isGap ? "border-dashed border-red-700/80" : "border-zinc-800"} ${inMonth ? "bg-zinc-950" : "bg-zinc-950/40 opacity-60"} ${isToday ? "ring-1 ring-sky-700" : ""}`}
              >
                <div className={`mb-1 text-right text-[11px] ${isToday ? "font-semibold text-sky-300" : "text-zinc-500"}`}>{day.getDate()}</div>
                <div className="space-y-1">
                  {entries.map((entry) =>
                    entry.kind === "package" ? (
                      <span
                        key={entry.videoId}
                        title={`${entry.title}\n${t("publishingCalendar.packageHint")}`}
                        className={`block w-full truncate rounded border px-1 py-0.5 text-left text-[11px] ${KIND_STYLES.package}`}
                      >
                        {entry.at ? `${timeOf(entry.at)} ` : ""}
                        {entry.title}
                      </span>
                    ) : (
                    <button
                      key={entry.videoId}
                      type="button"
                      onClick={() => setOpen({ videoId: entry.videoId, title: entry.title })}
                      title={entry.at ? `${entry.title}\n${t("publishingCalendar.timeHint", { local: timeOf(entry.at), utc: utcTimeOf(entry.at) })}` : entry.title}
                      aria-label={entry.at ? `${entry.title}. ${t("publishingCalendar.timeHint", { local: timeOf(entry.at), utc: utcTimeOf(entry.at) })}` : entry.title}
                      className={`block w-full truncate rounded border px-1 py-0.5 text-left text-[11px] ${KIND_STYLES[entry.kind]}`}
                    >
                      {entry.at ? `${timeOf(entry.at)} ` : ""}
                      {entry.title}
                    </button>
                    )
                  )}
                  {isGap && entries.length === 0 && <div className="text-center text-[10px] text-red-400/80">{t("publishingCalendar.gap")}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {(undated.length > 0 || overdue.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {undated.length > 0 && (
            <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <h3 className="mb-2 text-sm font-medium text-zinc-200">{t("publishingCalendar.undated.title")}</h3>
              <ul className="space-y-1">
                {undated.map((entry) => (
                  <li key={entry.videoId}>
                    <button type="button" onClick={() => setOpen({ videoId: entry.videoId, title: entry.title })} className="w-full truncate text-left text-sm text-zinc-300 hover:text-white">
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {overdue.length > 0 && (
            <section className="rounded-xl border border-amber-800 bg-zinc-900 p-4">
              <h3 className="mb-1 text-sm font-medium text-amber-200">{t("publishingCalendar.overdue.title")}</h3>
              <p className="mb-2 text-xs text-zinc-400">{t("publishingCalendar.overdue.hint")}</p>
              <ul className="space-y-1">
                {overdue.map((entry) => (
                  <li key={entry.videoId}>
                    <button type="button" onClick={() => setOpen({ videoId: entry.videoId, title: entry.title })} className="w-full truncate text-left text-sm text-zinc-300 hover:text-white">
                      {entry.at ? `${formatDisplayDate(entry.at)} ${timeOf(entry.at)} · ` : ""}
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {open && (
        <VideoDetailModal title={open.title} thumbnailUrl={null} onClose={closeDetails} hasUnsavedChanges={detailsDirty}>
          <VideoDetailsPanel channelId={channelId} videoId={open.videoId} onDirtyChange={setDetailsDirty} />
        </VideoDetailModal>
      )}
    </div>
  );
}
