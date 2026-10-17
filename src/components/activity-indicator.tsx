"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityItem, ActivitySource, ActivitySummary } from "@/lib/activity-summary/contracts";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { UiTextKey } from "@/lib/ui-text";
import { Spinner } from "./operation-progress/spinner";
import { useT } from "./ui-text-provider";
import { useChannelNames } from "./use-channel-names";

// BL-195 stage D (UI_FEEDBACK_CLARITY_PLAN.md §3, AC-FB-09): the header's Activity centre -- a spinning ring with the number of
// things running in the background (hidden at 0); a click lists them grouped by kind, each with its state, its start and a link
// to its tab. Long work never blocks a screen: it is followed here. Polled every 10 s while the page is visible.

const POLL_MS = 10_000;

const SOURCE_TITLE: Record<ActivitySource, UiTextKey> = {
  operations: "activity.group.operations",
  media_jobs: "activity.group.mediaJobs",
  uploads: "activity.group.uploads",
  live_streams: "activity.group.liveStreams",
};

const SOURCE_HREF: Record<ActivitySource, string> = {
  operations: "/content/videos",
  media_jobs: "/servers/sessions",
  uploads: "/content/publishing",
  live_streams: "/content/streams",
};

const OPERATION_TEXT: Record<string, UiTextKey> = {
  "channel-sync": "activity.op.channelSync",
  "analytics-collect": "activity.op.analyticsCollect",
  "analytics-backfill": "activity.op.analyticsBackfill",
  "ai-generation": "activity.op.aiGeneration",
};

const OPERATION_HREF: Record<string, string> = {
  "analytics-collect": "/analytics",
  "analytics-backfill": "/analytics",
  "ai-generation": "/languages",
};

const UPLOAD_TEXT: Record<string, UiTextKey> = {
  queued: "publishingUploads.status.queued",
  uploading: "publishingUploads.status.uploading",
  processing: "publishingUploads.status.processing",
  finishing: "publishingUploads.status.finishing",
  paused: "publishingUploads.status.paused",
};

const STREAM_TEXT: Record<string, UiTextKey> = {
  starting: "live.state.starting",
  live: "live.state.live",
  replaying: "live.state.replaying",
  no_source: "live.state.noSource",
  reconnecting: "live.state.reconnecting",
};

/** Statuses a media job waits in before it runs (RunPod and Gemini). */
const JOB_WAITING = new Set(["queued", "pending", "waiting", "submitting"]);

const since = (iso: string | null) => (iso ? formatDisplayDateTime(new Date(iso)) : "");

export function ActivityIndicator() {
  const t = useT();
  const { nameOf } = useChannelNames();
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/activity", { cache: "no-store" });
      if (res.ok) setSummary((await res.json()) as ActivitySummary);
    } catch {
      // A missed poll keeps the last state; the next one catches up.
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void load();
      timer = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items = summary?.items ?? [];
  const unavailable = summary ? (Object.entries(summary.sources) as Array<[ActivitySource, string]>).filter(([, s]) => s === "unavailable").map(([s]) => s) : [];
  if (items.length === 0 && !open) return null;

  const row = (item: ActivityItem): { key: string; title: string; detail: string; href: string } => {
    switch (item.source) {
      case "operations":
        return {
          key: `op:${item.id}`,
          title: t(OPERATION_TEXT[item.kind] ?? "activity.op.other"),
          detail: [item.status === "cancelling" ? t("common.stopping") : t("activity.state.running"), item.total > 0 ? `${item.done} / ${item.total}` : null, t("activity.since", { time: since(item.startedAt) })].filter(Boolean).join(" · "),
          href: OPERATION_HREF[item.kind] ?? SOURCE_HREF.operations,
        };
      case "media_jobs":
        return {
          key: `job:${item.id}`,
          // ui-text-ignore: the provider's name and the template/model label are data
          title: `${item.provider === "runpod" ? "RunPod" : "Gemini"} · ${item.label}`,
          detail: [JOB_WAITING.has(item.status) ? t("activity.state.waiting") : t("activity.state.running"), item.device ? t("activity.onDevice", { device: item.device }) : null, t("activity.since", { time: since(item.createdAt) })].filter(Boolean).join(" · "),
          // A Gemini job lives on its kind's Media tab, a RunPod job under its session.
          href: item.provider === "gemini" ? "/media" : SOURCE_HREF.media_jobs,
        };
      case "uploads":
        return {
          key: `upload:${item.id}`,
          title: t("activity.upload.title", { video: item.video }),
          detail: t(UPLOAD_TEXT[item.status] ?? "publishingUploads.status.queued", { percent: item.totalBytes > 0 ? Math.floor((item.storedBytes / item.totalBytes) * 100) : 0 }),
          href: SOURCE_HREF.uploads,
        };
      case "live_streams":
        return {
          key: `live:${item.channelId}`,
          title: t("activity.stream.title", { channel: nameOf(item.channelId) }),
          detail: [t(STREAM_TEXT[item.state] ?? "live.state.live"), item.since ? t("activity.since", { time: since(item.since) }) : null].filter(Boolean).join(" · "),
          href: SOURCE_HREF.live_streams,
        };
    }
  };

  const groups = (Object.keys(SOURCE_TITLE) as ActivitySource[]).map((source) => ({ source, rows: items.filter((i) => i.source === source).map(row) })).filter((g) => g.rows.length > 0);

  return (
    <div className="relative" ref={panel}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("activity.label", { count: items.length })}
        title={t("activity.label", { count: items.length })}
        className="flex h-9 items-center gap-2 rounded-full border border-border px-3 text-xs font-medium text-zinc-200 transition-colors hover:border-accent hover:text-white"
      >
        <Spinner className="h-3.5 w-3.5" />
        <span className="tabular-nums">{items.length}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 max-h-[80vh] w-96 space-y-3 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
          <h3 className="text-sm font-semibold text-zinc-100">{t("activity.title")}</h3>
          {groups.length === 0 && <p className="text-xs text-zinc-400">{t("activity.nothing")}</p>}
          {groups.map((g) => (
            <div key={g.source} className="space-y-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{t(SOURCE_TITLE[g.source])}</p>
              {g.rows.map((r) => (
                <Link key={r.key} href={r.href} onClick={() => setOpen(false)} className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 hover:border-zinc-600">
                  <Spinner className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-zinc-100">{r.title}</span>
                    <span className="block text-xs text-zinc-400">{r.detail}</span>
                  </span>
                </Link>
              ))}
            </div>
          ))}
          {unavailable.length > 0 && <p className="text-xs text-amber-300">{t("activity.unavailable", { sources: unavailable.map((s) => t(SOURCE_TITLE[s])).join(", ") })}</p>}
        </div>
      )}
    </div>
  );
}
