"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpendHistoryJob, SpendHistoryPage, SpendHistoryRow, SpendSummary } from "@/lib/spend-analytics/contracts";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { InfoTooltip } from "./info-tooltip";
import { useT } from "./ui-text-provider";

// BL-219 (docs/roadmap/plans/SERVERS_ANALYTICS_PLAN.md; owner msgs 3411/3415): Servers → «Аналитика» -- what was generated, what it
// cost and what the money went on, on every computer. Read-only. Data loads when the tab is first opened (Servers keeps every tab
// mounted), and again on each filter change.

type Summary = SpendSummary & { channels: Array<{ channelId: string; title: string }> };
type Days = "7" | "30" | "90" | "all";
type Filters = { days: Days; channelId: string; device: "all" | "this"; who: "all" | "owner" | "factory" | "agent" };

const COLORS = { work: "#60a5fa", idle: "#475569", gemini: "#a78bfa", bad: "#f87171" };
const TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

/** Cents, except below a cent (a single cheap result) where a third digit tells amounts apart. */
function usd(value: number): string {
  if (value === 0) return "$0";
  return Math.abs(value) < 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}

const gpuName = (id: string) => id.replace(/^NVIDIA (GeForce )?/, "");
const dayLabel = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

function query(filters: Filters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ days: filters.days, device: filters.device, who: filters.who, tz: TZ, ...extra });
  if (filters.channelId) params.set("channelId", filters.channelId);
  return params.toString();
}

/** One horizontal bar row of a breakdown card. */
function BarRow({ label, note, value, max, color, emphasis }: { label: string; note?: string; value: number; max: number; color: string; emphasis?: boolean }) {
  const width = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_auto] items-center gap-2 py-1 text-xs">
      <span className={`truncate ${emphasis ? "text-amber-300" : "text-zinc-200"}`} title={label}>
        {label}
        {note && <span className="text-zinc-500"> · {note}</span>}
      </span>
      <span className="h-2 overflow-hidden rounded bg-zinc-800">
        <span className="block h-full rounded" style={{ width: `${width}%`, background: color }} />
      </span>
      <span className="w-14 text-right tabular-nums text-zinc-100">{usd(value)}</span>
    </div>
  );
}

function Card({ title, hint, info, children, className = "" }: { title: string; hint?: string; info?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 ${className}`}>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-100">
        {title}
        {hint && <span className="font-normal text-zinc-500">{hint}</span>}
        {info && <InfoTooltip>{info}</InfoTooltip>}
      </h3>
      {children}
    </section>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: React.ReactNode; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${accent ? "text-amber-300" : "text-zinc-50"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

/** Stacked daily bars: GPU work, GPU idle/start, Gemini. Hover shows the day; a click filters the history to it. */
function DailyChart({ daily, selected, onSelect }: { daily: SpendSummary["daily"]; selected: string | null; onSelect: (day: string | null) => void }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const totals = daily.map((d) => d.runpodWorkUsd + d.runpodIdleUsd + d.geminiUsd);
  const max = Math.max(0.01, ...totals);
  const width = 640;
  const height = 170;
  const left = 34;
  const slot = (width - left) / Math.max(1, daily.length);
  const bar = Math.max(2, Math.min(28, slot * 0.7));
  const y = (value: number) => (value / max) * (height - 20);
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(daily.length / 10);
  const shown = hover !== null ? daily[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height + 18}`} className="w-full" role="img" aria-label={t("serversAnalytics.daily.title")}>
        {ticks.map((tick, i) => (
          <g key={i}>
            <line x1={left} x2={width} y1={height - y(tick)} y2={height - y(tick)} stroke="#27272a" />
            <text x={0} y={height - y(tick) + 3} fontSize="9" fill="#71717a">
              {usd(Math.round(tick * 100) / 100)}
            </text>
          </g>
        ))}
        {daily.map((d, i) => {
          const x = left + i * slot + (slot - bar) / 2;
          let top = height;
          const parts = [
            { v: d.runpodWorkUsd, c: COLORS.work },
            { v: d.runpodIdleUsd, c: COLORS.idle },
            { v: d.geminiUsd, c: COLORS.gemini },
          ];
          const dim = selected !== null && selected !== d.day;
          return (
            <g
              key={d.day}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect(selected === d.day ? null : d.day)}
              className="cursor-pointer"
              opacity={dim ? 0.35 : 1}
            >
              <rect x={left + i * slot} y={0} width={slot} height={height} fill="transparent" />
              {parts.map((p, k) => {
                if (p.v <= 0) return null;
                const h = Math.max(1, y(p.v));
                top -= h;
                return <rect key={k} x={x} y={top} width={bar} height={h} fill={p.c} rx={2} />;
              })}
              {i % labelEvery === 0 && (
                <text x={x + bar / 2} y={height + 13} fontSize="9" fill="#71717a" textAnchor="middle">
                  {dayLabel(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {shown && (
        <div className="pointer-events-none absolute right-2 top-0 rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-xs shadow-lg">
          <div className="mb-1 font-medium text-zinc-100">{dayLabel(shown.day)}</div>
          <div className="text-zinc-400">
            {t("serversAnalytics.legend.work")}: <span className="text-zinc-100">{usd(shown.runpodWorkUsd)}</span>
          </div>
          <div className="text-zinc-400">
            {t("serversAnalytics.legend.idle")}: <span className="text-zinc-100">{usd(shown.runpodIdleUsd)}</span>
          </div>
          <div className="text-zinc-400">
            {t("serversAnalytics.legend.gemini")}: <span className="text-zinc-100">{usd(shown.geminiUsd)}</span>
          </div>
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: COLORS.work }} />
          {t("serversAnalytics.legend.work")}
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: COLORS.idle }} />
          {t("serversAnalytics.legend.idle")}
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: COLORS.gemini }} />
          {t("serversAnalytics.legend.gemini")}
        </span>
        <span className="ml-auto">{t("serversAnalytics.daily.hint")}</span>
      </div>
    </div>
  );
}

function Preview({ source, jobId, count }: { source: "runpod" | "gemini"; jobId: string; count: number }) {
  if (count === 0) return null;
  return (
    <span className="flex gap-1">
      {Array.from({ length: Math.min(count, 4) }, (_, i) => (
        // eslint-disable-next-line @next/next/no-img-element -- a local preview route, not an optimisable remote image.
        <img
          key={i}
          src={`/api/servers/analytics/preview?source=${source}&jobId=${encodeURIComponent(jobId)}&index=${i}`}
          alt=""
          loading="lazy"
          className="h-6 w-9 rounded object-cover ring-1 ring-zinc-700"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ))}
    </span>
  );
}

/** A session's jobs grouped by template / model (one line per kind of work), most expensive first. */
function groupJobs(jobs: SpendHistoryJob[]) {
  const groups = new Map<string, { label: string; planId: string | null; videos: Set<string>; done: number; failed: number; gpuSeconds: number; timed: number; usd: number; previews: Array<{ jobId: string }> }>();
  for (const job of jobs) {
    const key = `${job.label ?? "—"}|${job.planId ?? ""}`;
    const group = groups.get(key) ?? { label: job.label ?? "—", planId: job.planId, videos: new Set<string>(), done: 0, failed: 0, gpuSeconds: 0, timed: 0, usd: 0, previews: [] };
    if (job.video) group.videos.add(job.video);
    if (job.status === "done") group.done += 1;
    if (job.status === "failed" || job.status === "cancelled") group.failed += 1;
    if (job.gpuSeconds !== null) {
      group.gpuSeconds += job.gpuSeconds;
      group.timed += 1;
    }
    group.usd += job.usd;
    if (job.images > 0 && group.previews.length < 4) group.previews.push({ jobId: job.jobId });
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.usd - a.usd);
}

function statusClass(status: string): string {
  return status === "failed" || status === "cancelled" ? "text-red-400" : status === "done" ? "text-emerald-400" : "text-zinc-400";
}

function HistoryCard({ filters, day, channelTitle }: { filters: Filters; day: string | null; channelTitle: (id: string) => string }) {
  const t = useT();
  const [kind, setKind] = useState<"all" | "runpod" | "gemini">("all");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [rows, setRows] = useState<SpendHistoryRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      const request = ++latest.current;
      setFailed(false);
      try {
        const res = await fetch(`/api/servers/analytics/history?${query(filters, { kind, errors: errorsOnly ? "1" : "0", ...(day ? { day } : {}), ...(cursor ? { cursor } : {}) })}`);
        if (!res.ok) throw new Error("load failed");
        const page = (await res.json()) as SpendHistoryPage;
        if (request !== latest.current) return;
        setRows((previous) => (cursor && previous ? [...previous, ...page.rows] : page.rows));
        setTotal(page.total);
        setNext(page.nextCursor);
      } catch {
        if (request === latest.current) setFailed(true);
      }
    },
    [filters, kind, errorsOnly, day]
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const whoLabel = (who: string) => t(`serversAnalytics.who.${who}` as never);
  const visible = rows ?? [];
  const chip = (active: boolean) => `rounded-full border px-2.5 py-0.5 text-xs ${active ? "border-zinc-500 bg-zinc-800 text-zinc-100" : "border-zinc-800 text-zinc-400 hover:text-zinc-200"}`;

  return (
    <Card title={t("serversAnalytics.history.title")} hint={day ? t("serversAnalytics.history.day", { day: dayLabel(day) }) : t("serversAnalytics.history.hint")}>
      <div className="mb-2 flex flex-wrap gap-2">
        {(["all", "runpod", "gemini"] as const).map((value) => (
          <button key={value} onClick={() => setKind(value)} className={chip(kind === value)}>
            {t(`serversAnalytics.history.kind.${value}` as never)}
          </button>
        ))}
        <button onClick={() => setErrorsOnly((v) => !v)} className={chip(errorsOnly)}>
          {t("serversAnalytics.history.errorsOnly")}
        </button>
      </div>
      {failed && <p className="text-xs text-red-400">{t("serversAnalytics.loadFailed")}</p>}
      {rows === null && !failed && <p className="text-xs text-zinc-500">{t("common.loading")}</p>}
      {rows !== null && visible.length === 0 && <p className="text-xs text-zinc-500">{t("serversAnalytics.history.empty")}</p>}
      {visible.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-500">
                <th className="py-1.5 pr-2 font-normal">{t("serversAnalytics.history.col.when")}</th>
                <th className="py-1.5 pr-2 font-normal">{t("serversAnalytics.history.col.what")}</th>
                <th className="py-1.5 pr-2 font-normal">{t("serversAnalytics.history.col.channel")}</th>
                <th className="py-1.5 pr-2 font-normal">{t("serversAnalytics.history.col.who")}</th>
                <th className="py-1.5 pr-2 text-right font-normal">{t("serversAnalytics.history.col.results")}</th>
                <th className="py-1.5 pr-2 font-normal">{t("serversAnalytics.history.col.previews")}</th>
                <th className="py-1.5 text-right font-normal">{t("serversAnalytics.history.col.cost")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const when = formatDisplayDateTime(row.at);
                if (row.type === "session") {
                  const isOpen = open.has(row.id);
                  const toggle = () =>
                    setOpen((prev) => {
                      const nextSet = new Set(prev);
                      if (isOpen) nextSet.delete(row.id);
                      else nextSet.add(row.id);
                      return nextSet;
                    });
                  const failedStart = row.status === "failed" && row.jobs.length === 0;
                  return (
                    <Fragment key={row.id}>
                      <tr className="border-b border-zinc-900 align-middle">
                        <td className="whitespace-nowrap py-1.5 pr-2 text-zinc-400">{when}</td>
                        <td className="py-1.5 pr-2">
                          <button onClick={toggle} disabled={row.jobs.length === 0} className="text-left text-zinc-100 disabled:cursor-default">
                            <span className="mr-1 rounded bg-blue-950 px-1.5 py-px text-[10px] text-blue-300">{t("serversAnalytics.badge.gpu")}</span>
                            {row.jobs.length > 0 && <span className="mr-1 text-zinc-500">{isOpen ? "▾" : "▸"}</span>}
                            {failedStart
                              ? t("serversAnalytics.history.failedStart", { gpu: gpuName(row.gpuTypeId ?? "GPU") })
                              : t("serversAnalytics.history.session", { gpu: gpuName(row.gpuTypeId ?? "GPU"), jobs: String(row.jobs.length) })}
                          </button>
                          {row.error && <div className="mt-0.5 text-[11px] text-red-400">{row.error.code ?? row.error.text}</div>}
                        </td>
                        <td className="py-1.5 pr-2 text-zinc-300">
                          {channelTitle(row.channelId)}
                          {row.videos.length > 0 && <span className="text-zinc-500"> · {row.videos.join(", ")}</span>}
                        </td>
                        <td className="py-1.5 pr-2 text-zinc-400">{whoLabel(row.who)}</td>
                        <td className={`py-1.5 pr-2 text-right tabular-nums ${failedStart ? "text-red-400" : "text-emerald-400"}`}>{row.results}</td>
                        <td className="py-1.5 pr-2">
                          <Preview source="runpod" jobId={row.jobs.find((job) => job.images > 0)?.jobId ?? ""} count={Math.min(3, row.jobs.find((job) => job.images > 0)?.images ?? 0)} />
                        </td>
                        <td className={`py-1.5 text-right tabular-nums ${failedStart ? "text-red-400" : "text-zinc-100"}`}>{usd(row.usd)}</td>
                      </tr>
                      {isOpen &&
                        groupJobs(row.jobs).map((group) => (
                          <tr key={`${group.label}|${group.planId ?? ""}`} className="bg-zinc-950/60 text-zinc-400">
                            <td />
                            <td className="py-1 pr-2 pl-6">
                              ↳ {group.label}
                              <span className="text-zinc-500"> × {group.done + group.failed}</span>
                              {group.planId && <span className="text-zinc-500"> · {group.planId}</span>}
                              {group.failed > 0 && <span className="ml-1 text-red-400">{t("serversAnalytics.history.failedCount", { count: String(group.failed) })}</span>}
                            </td>
                            <td className="py-1 pr-2">{[...group.videos].join(", ")}</td>
                            <td className="py-1 pr-2">{group.timed > 0 ? t("serversAnalytics.history.gpuAverage", { seconds: String(Math.round(group.gpuSeconds / group.timed)) }) : ""}</td>
                            <td className="py-1 pr-2 text-right tabular-nums text-emerald-400">{group.done}</td>
                            <td className="py-1 pr-2">
                              <span className="flex gap-1">
                                {group.previews.map((preview) => (
                                  <Preview key={preview.jobId} source="runpod" jobId={preview.jobId} count={1} />
                                ))}
                              </span>
                            </td>
                            <td className="py-1 text-right tabular-nums">{usd(group.usd)}</td>
                          </tr>
                        ))}
                      {isOpen && row.idleUsd > 0 && (
                        <tr className="bg-zinc-950/60 text-zinc-500">
                          <td />
                          <td className="py-1 pr-2 pl-6" colSpan={5}>
                            ↳ {t("serversAnalytics.history.idle")}
                          </td>
                          <td className="py-1 text-right tabular-nums">{usd(row.idleUsd)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                }
                const isGemini = row.type === "gemini" || row.source === "gemini";
                return (
                  <tr key={row.id} className="border-b border-zinc-900 align-middle">
                    <td className="whitespace-nowrap py-1.5 pr-2 text-zinc-400">{when}</td>
                    <td className="py-1.5 pr-2 text-zinc-100">
                      <span className={`mr-1 rounded px-1.5 py-px text-[10px] ${isGemini ? "bg-violet-950 text-violet-300" : "bg-blue-950 text-blue-300"}`}>{isGemini ? t("serversAnalytics.badge.gemini") : t("serversAnalytics.badge.gpu")}</span>
                      {row.label ?? "—"}
                      <span className={`ml-1 ${statusClass(row.status)}`}>{t(`serversAnalytics.status.${row.status}` as never)}</span>
                      {row.type === "gemini" && row.errorCode && <div className="mt-0.5 text-[11px] text-red-400">{row.errorCode}</div>}
                    </td>
                    <td className="py-1.5 pr-2 text-zinc-300">
                      {channelTitle(row.channelId)}
                      {row.video && <span className="text-zinc-500"> · {row.video}</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-zinc-400">{row.type === "gemini" ? whoLabel(row.who) : t("serversAnalytics.who.otherComputerNamed", { computer: row.computer ?? "?" })}</td>
                    <td className={`py-1.5 pr-2 text-right tabular-nums ${statusClass(row.status)}`}>{row.status === "done" ? 1 : 0}</td>
                    <td className="py-1.5 pr-2">{row.type === "gemini" && <Preview source="gemini" jobId={row.id} count={row.images} />}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-100">{usd(row.usd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows !== null && (
        <div className="mt-2 flex items-center gap-3 text-xs text-zinc-500">
          <span>{t("serversAnalytics.history.shown", { shown: String(rows.length), total: String(total) })}</span>
          {next && (
            <button onClick={() => void load(next)} className="text-zinc-300 underline hover:text-zinc-100">
              {t("serversAnalytics.history.more")}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function csvOf(summary: Summary, channelTitle: (id: string) => string): string {
  const lines = [["section", "key", "usd", "count"].join(",")];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  for (const d of summary.daily) lines.push(["day", d.day, String(d.runpodWorkUsd + d.runpodIdleUsd + d.geminiUsd), ""].join(","));
  for (const l of summary.byLabel) lines.push(["model", esc(l.label), String(l.usd), String(l.runs)].join(","));
  for (const v of summary.byVideo.videos) lines.push(["video", esc(`${channelTitle(v.channelId)} ${v.video}`), String(v.usd), String(v.runs)].join(","));
  lines.push(["video", "unlinked", String(summary.byVideo.unlinkedUsd), ""].join(","));
  for (const c of summary.byChannel) lines.push(["channel", esc(channelTitle(c.channelId)), String(c.usd), ""].join(","));
  for (const g of summary.byGpu) lines.push(["gpu", esc(g.gpuTypeId), String(g.usd), String(g.sessions)].join(","));
  return lines.join("\n");
}

export function ServersAnalyticsPanel({ active }: { active: boolean }) {
  const t = useT();
  const [filters, setFilters] = useState<Filters>({ days: "30", channelId: "", device: "all", who: "all" });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  const [day, setDay] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);

  useEffect(() => {
    if (!opened) return;
    const request = ++latest.current;
    setFailed(false);
    setDay(null);
    void (async () => {
      try {
        const res = await fetch(`/api/servers/analytics?${query(filters)}`);
        if (!res.ok) throw new Error("load failed");
        const data = (await res.json()) as Summary;
        if (request === latest.current) setSummary(data);
      } catch {
        if (request === latest.current) setFailed(true);
      }
    })();
  }, [filters, opened]);

  const titles = useMemo(() => new Map((summary?.channels ?? []).map((c) => [c.channelId, c.title])), [summary]);
  const channelTitle = useCallback((id: string) => titles.get(id) ?? id, [titles]);

  if (!opened) return null;

  const select = "rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-200";
  const s = summary;
  const losses = s ? [
    { key: "idle", label: t("serversAnalytics.losses.idle"), ...s.losses.idle, color: COLORS.idle, showCount: false },
    { key: "failedJobs", label: t("serversAnalytics.losses.failedJobs"), ...s.losses.failedJobs, color: COLORS.bad, showCount: true },
    { key: "failedGemini", label: t("serversAnalytics.losses.failedGemini"), ...s.losses.failedGemini, color: COLORS.bad, showCount: true },
    { key: "failedStarts", label: t("serversAnalytics.losses.failedStarts"), ...s.losses.failedStarts, color: COLORS.bad, showCount: true },
  ] : [];
  const total = s?.totals.totalUsd ?? 0;
  const change = s && s.totals.previousTotalUsd !== null && s.totals.previousTotalUsd > 0 ? Math.round(((total - s.totals.previousTotalUsd) / s.totals.previousTotalUsd) * 100) : null;
  const unlinkedShare = s && total > 0 ? Math.round((s.byVideo.unlinkedUsd / total) * 100) : 0;
  const idleShare = s && s.losses.totalUsd > 0 ? Math.round((s.losses.idle.usd / s.losses.totalUsd) * 100) : 0;
  const kindPrice = (k: "image" | "video" | "audio") => (s && s.results.byKind[k].count > 0 ? usd(s.results.byKind[k].usd / s.results.byKind[k].count) : null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-zinc-800 text-xs">
          {(["7", "30", "90", "all"] as const).map((value) => (
            <button key={value} onClick={() => setFilters((f) => ({ ...f, days: value }))} className={`px-3 py-1 ${filters.days === value ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>
              {t(`serversAnalytics.period.${value}` as never)}
            </button>
          ))}
        </div>
        <select aria-label={t("serversAnalytics.filter.channel")} className={select} value={filters.channelId} onChange={(e) => setFilters((f) => ({ ...f, channelId: e.target.value }))}>
          <option value="">{t("serversAnalytics.filter.allChannels")}</option>
          {(s?.channels ?? []).map((c) => (
            <option key={c.channelId} value={c.channelId}>
              {c.title}
            </option>
          ))}
        </select>
        <select aria-label={t("serversAnalytics.filter.computer")} className={select} value={filters.device} onChange={(e) => setFilters((f) => ({ ...f, device: e.target.value as Filters["device"] }))}>
          <option value="all">{t("serversAnalytics.filter.allComputers")}</option>
          <option value="this">{t("serversAnalytics.filter.thisComputer")}</option>
        </select>
        <select aria-label={t("serversAnalytics.filter.who")} className={select} value={filters.who} onChange={(e) => setFilters((f) => ({ ...f, who: e.target.value as Filters["who"] }))}>
          <option value="all">{t("serversAnalytics.filter.everyone")}</option>
          <option value="owner">{t("serversAnalytics.who.owner")}</option>
          <option value="factory">{t("serversAnalytics.who.factory")}</option>
          <option value="agent">{t("serversAnalytics.who.agent")}</option>
        </select>
        {s && (
          <button
            onClick={() => {
              const url = URL.createObjectURL(new Blob([csvOf(s, channelTitle)], { type: "text/csv" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = `spend-${s.period.firstDay}-${s.period.lastDay}.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="ml-auto rounded-lg border border-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:text-zinc-100"
          >
            {t("serversAnalytics.csv")}
          </button>
        )}
      </div>

      {failed && <p className="text-sm text-red-400">{t("serversAnalytics.loadFailed")}</p>}
      {!s && !failed && <p className="text-sm text-zinc-500">{t("common.loading")}</p>}

      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Kpi
              label={`${t("serversAnalytics.kpi.spent")} · ${dayLabel(s.period.firstDay)}–${dayLabel(s.period.lastDay)}`}
              value={usd(total)}
              sub={
                <>
                  {t("serversAnalytics.badge.gpu")} <span className="text-zinc-200">{usd(s.totals.runpodUsd)}</span> · {t("serversAnalytics.badge.gemini")}{" "}
                  <span className="text-zinc-200">{usd(s.totals.geminiUsd)}</span>
                  {change !== null && <span className={change > 0 ? " text-red-400" : " text-emerald-400"}> · {change > 0 ? "+" : ""}{change}%</span>}
                </>
              }
            />
            <Kpi label={t("serversAnalytics.kpi.results")} value={String(s.results.done)} sub={t("serversAnalytics.kpi.errors", { count: String(s.results.failed) })} />
            <Kpi
              label={t("serversAnalytics.kpi.perResult")}
              value={s.costPerResultUsd !== null ? (s.costPerResultUsd < 0.1 ? `$${s.costPerResultUsd.toFixed(3)}` : usd(s.costPerResultUsd)) : "—"}
              sub={[kindPrice("image") && `${t("serversAnalytics.kind.image")} ${kindPrice("image")}`, kindPrice("video") && `${t("serversAnalytics.kind.video")} ${kindPrice("video")}`, kindPrice("audio") && `${t("serversAnalytics.kind.audio")} ${kindPrice("audio")}`].filter(Boolean).join(" · ")}
            />
            <Kpi label={t("serversAnalytics.kpi.gpuHours")} value={t("serversAnalytics.hours", { hours: String(s.gpu.paidHours ?? s.gpu.workHours) })} sub={t("serversAnalytics.kpi.gpuWork", { hours: String(s.gpu.workHours) })} />
            <Kpi label={t("serversAnalytics.kpi.losses")} value={usd(s.losses.totalUsd)} accent={s.losses.totalUsd > 0} sub={total > 0 ? t("serversAnalytics.kpi.lossesShare", { share: String(Math.round((s.losses.totalUsd / total) * 100)) }) : undefined} />
          </div>

          <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
            <Card title={t("serversAnalytics.daily.title")} info={s.totals.estimated ? t("serversAnalytics.estimated") : undefined}>
              <DailyChart daily={s.daily} selected={day} onSelect={setDay} />
            </Card>
            <Card title={t("serversAnalytics.losses.title")} hint={t("serversAnalytics.losses.hint")}>
              {losses.map((l) => (
                <BarRow key={l.key} label={l.label} note={l.showCount && l.count > 0 ? String(l.count) : undefined} value={l.usd} max={Math.max(...losses.map((x) => x.usd))} color={l.color} />
              ))}
              {s.losses.totalUsd > 0 && idleShare >= 50 && <p className="mt-2 border-t border-dashed border-zinc-800 pt-2 text-xs text-zinc-500">{t("serversAnalytics.losses.idleTip", { share: String(idleShare) })}</p>}
            </Card>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <Card title={t("serversAnalytics.byLabel.title")} hint={t("serversAnalytics.byLabel.hint")}>
              {s.byLabel.length === 0 && <p className="text-xs text-zinc-500">{t("serversAnalytics.empty")}</p>}
              {s.byLabel.slice(0, 7).map((l) => (
                <BarRow key={`${l.source}|${l.label}`} label={l.label} note={String(l.runs)} value={l.usd} max={s.byLabel[0]?.usd ?? 0} color={l.source === "gemini" ? COLORS.gemini : COLORS.work} />
              ))}
              {s.byLabel.length > 7 && <BarRow label={t("serversAnalytics.more", { count: String(s.byLabel.length - 7) })} value={s.byLabel.slice(7).reduce((sum, l) => sum + l.usd, 0)} max={s.byLabel[0].usd} color="#52525b" />}
            </Card>
            <Card title={t("serversAnalytics.byVideo.title")} hint={t("serversAnalytics.byVideo.hint")}>
              {s.byVideo.videos.slice(0, 6).map((v) => (
                <BarRow key={`${v.channelId}|${v.video}`} label={v.video} note={filters.channelId ? undefined : channelTitle(v.channelId)} value={v.usd} max={Math.max(s.byVideo.videos[0]?.usd ?? 0, s.byVideo.unlinkedUsd)} color={COLORS.work} />
              ))}
              <BarRow label={t("serversAnalytics.byVideo.unlinked")} value={s.byVideo.unlinkedUsd} max={Math.max(s.byVideo.videos[0]?.usd ?? 0, s.byVideo.unlinkedUsd)} color="#52525b" emphasis={unlinkedShare >= 50} />
              {unlinkedShare >= 50 && <p className="mt-2 border-t border-dashed border-zinc-800 pt-2 text-xs text-zinc-500">{t("serversAnalytics.byVideo.tip", { share: String(unlinkedShare) })}</p>}
            </Card>
            <Card title={t("serversAnalytics.byWho.title")} hint={t("serversAnalytics.byWho.hint")}>
              {s.byChannel.map((c) => (
                <BarRow key={c.channelId} label={channelTitle(c.channelId)} value={c.usd} max={s.byChannel[0]?.usd ?? 0} color={COLORS.work} />
              ))}
              <div className="my-1 border-t border-zinc-800" />
              {s.byWho.map((w) => (
                <BarRow key={w.who} label={t(`serversAnalytics.who.${w.who}` as never)} value={w.usd} max={s.byWho[0]?.usd ?? 0} color="#94a3b8" />
              ))}
              {s.byGpu.length > 0 && <div className="my-1 border-t border-zinc-800" />}
              {s.byGpu.slice(0, 4).map((g) => (
                <BarRow key={g.gpuTypeId} label={gpuName(g.gpuTypeId)} note={t("serversAnalytics.sessions", { count: String(g.sessions) })} value={g.usd} max={s.byGpu[0]?.usd ?? 0} color={COLORS.idle} />
              ))}
            </Card>
          </div>
        </>
      )}

      <HistoryCard filters={filters} day={day} channelTitle={channelTitle} />
    </div>
  );
}
