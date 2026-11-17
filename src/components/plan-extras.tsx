"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeatureErrorBoundary } from "./feature-error-boundary";
import { Popover } from "./popover";
import { PublishingPackages } from "./publishing-packages";
import { PublishingUploads, type UploadRow } from "./publishing-uploads";
import { useT } from "./ui-text-provider";
import { VideoProjectsPanel } from "./video-projects-panel";
import { startVisibleInterval } from "./visible-interval";
import { unslottedVideos, uploadQueueSummary, type PlanPackageRef, type PlanProjectRef } from "./plan-extras-model";
import type { UiTextKey } from "@/lib/ui-text";

// BL-266 (owner TG 4730/4732): the former «Ролики и релизы» tab, folded into «План» without losing a function. Three compact lines
// over the plan, each opening the existing UI it summarises: «Без слота: N» (the videos board, `VideoProjectsPanel`), «Очередь: …»
// (this channel's uploads, `PublishingUploads`) and «⋯» (the release packages with their manual upload, packaging and captions
// actions, `PublishingPackages`; the publishing settings and the local copy cleanup now in Settings → Channels). Every write stays in
// those components, behind the same routes and gates; this file only decides where they are shown. Each part in its own error
// boundary (AGENTS.md §M): the plan works if any of them fails.

/** What the slot cards need from the package scan: the uploaded package's packaging and captions actions. */
export type PlanPackageRow = PlanPackageRef & {
  manifestSha256: string | null;
  state: string;
  youtube: { videoId: string } | null;
  youtubeTextsDiffer?: Array<"title" | "description" | "tags"> | null;
  pkg: { slotId?: string | null; captions?: Array<{ file: string }> | null } | null;
};

const lineClass = "inline-flex max-w-full items-center gap-1.5 truncate rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-600";
const menuItemClass = "block w-full rounded-md px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800";

export function PlanExtras({
  channelId,
  visible,
  onUploads,
  onPackages,
  packagesRefreshKey = 0,
}: {
  channelId: string | null;
  visible: boolean;
  /** This channel's upload rows, each time they are read (the slot cards' percent). */
  onUploads?: (rows: UploadRow[]) => void;
  /** The package scan rows, each time they are read (the slot cards' packaging actions). */
  onPackages?: (rows: PlanPackageRow[]) => void;
  /** Bumped by the plan after a packaging change on a card: read the packages again. */
  packagesRefreshKey?: number;
}) {
  const t = useT();
  const [projects, setProjects] = useState<PlanProjectRef[] | null>(null);
  const [packages, setPackages] = useState<PlanPackageRow[] | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [uploadsKey, setUploadsKey] = useState(0);
  const [open, setOpen] = useState<"unslotted" | "queue" | "packages" | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Refs, so a new callback from the parent never makes a new read function (and a read loop).
  const onUploadsRef = useRef(onUploads);
  const onPackagesRef = useRef(onPackages);
  useEffect(() => {
    onUploadsRef.current = onUploads;
    onPackagesRef.current = onPackages;
  }, [onUploads, onPackages]);

  /** The two reads behind «Без слота» (no state set here; a failed read is null). */
  const fetchCounts = useCallback(async () => {
    if (!channelId) return { list: null, scan: null };
    const base = `/api/channels/${encodeURIComponent(channelId)}`;
    const get = async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await fetch(url);
        return res.ok ? ((await res.json()) as T) : null;
      } catch {
        return null;
      }
    };
    const [list, scan] = await Promise.all([get<{ videos: PlanProjectRef[] }>(`${base}/video-projects`), get<{ status: string; packages?: PlanPackageRow[] }>(`${base}/publishing/packages`)]);
    return { list, scan };
  }, [channelId]);
  const applyCounts = useCallback(({ list, scan }: { list: { videos: PlanProjectRef[] } | null; scan: { packages?: PlanPackageRow[] } | null }) => {
    // A failed read keeps what was shown (never a wrong count from half the data).
    if (list) setProjects(list.videos);
    if (scan) {
      const rows = scan.packages ?? [];
      setPackages(rows);
      onPackagesRef.current?.(rows);
    }
  }, []);
  const readCounts = useCallback(() => fetchCounts().then(applyCounts), [fetchCounts, applyCounts]);

  useEffect(() => {
    if (!visible || !channelId) return;
    let cancelled = false;
    const read = () => {
      void fetchCounts().then((answer) => {
        if (!cancelled) applyCounts(answer);
      });
    };
    read();
    const stop = startVisibleInterval(read, 60_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [visible, channelId, fetchCounts, applyCounts, packagesRefreshKey]);

  const unslotted = useMemo(() => (projects && packages ? unslottedVideos(projects, packages) : null), [projects, packages]);
  const unslottedSet = useMemo(() => new Set(unslotted ?? []), [unslotted]);
  const queue = uploadQueueSummary(uploads);
  const handleRows = useCallback((rows: UploadRow[]) => {
    setUploads(rows);
    onUploadsRef.current?.(rows);
  }, []);
  const toggle = (part: "unslotted" | "queue" | "packages") => setOpen((current) => (current === part ? null : part));

  if (!channelId) return null;

  const queueText = queue.current
    ? `${t("planExtras.queue.line", { count: queue.active })} · ${queue.current.video} ${queue.current.status === "uploading" ? `${queue.current.percent}%` : t(`publishingUploads.status.${queue.current.status}` as UiTextKey, { percent: queue.current.percent })}`
    : t("planExtras.queue.empty");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FeatureErrorBoundary label={t("videoProjects.title")}>
          <button type="button" aria-expanded={open === "unslotted"} onClick={() => toggle("unslotted")} title={t("planExtras.unslotted.hint")} className={lineClass}>
            <span className={unslotted && unslotted.length > 0 ? "text-amber-200" : undefined}>{t("planExtras.unslotted.line", { count: unslotted === null ? "…" : unslotted.length })}</span>
            <span aria-hidden>{open === "unslotted" ? "▴" : "▾"}</span>
          </button>
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={t("publishingUploads.title")}>
          <button type="button" aria-expanded={open === "queue"} onClick={() => toggle("queue")} title={t("planExtras.queue.hint")} className={lineClass}>
            <span className="truncate">{queueText}</span>
            {queue.needsDecision > 0 && <span className="text-amber-300">· {t("planExtras.queue.needsDecision", { count: queue.needsDecision })}</span>}
            <span aria-hidden>{open === "queue" ? "▴" : "▾"}</span>
          </button>
        </FeatureErrorBoundary>
        {open === "packages" && (
          <button type="button" aria-expanded onClick={() => toggle("packages")} className={lineClass}>
            <span className="truncate">{t("planExtras.packages.close")}</span>
            <span aria-hidden>▴</span>
          </button>
        )}
        <div className="ml-auto">
          <Popover trigger="⋯" label={t("planExtras.more")} align="right" triggerClassName="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-600" panelClassName="w-72 max-w-[calc(100vw-2rem)] p-1">
            {(close) => (
              <div role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => {
                    setOpen("packages");
                    close();
                  }}
                >
                  {t("planExtras.more.packages")}
                </button>
                <Link role="menuitem" href="/settings/channels" className={menuItemClass} onClick={close}>
                  {t("planExtras.more.publishingSettings")}
                </Link>
                <Link role="menuitem" href="/settings/channels" className={menuItemClass} onClick={close}>
                  {t("planExtras.more.cleanup")}
                </Link>
              </div>
            )}
          </Popover>
        </div>
      </div>

      {open === "unslotted" && (
        <FeatureErrorBoundary label={t("videoProjects.title")}>
          <div className="space-y-2">
            <button type="button" onClick={() => setShowAll((x) => !x)} className="text-xs text-zinc-400 underline hover:text-zinc-200">
              {t(showAll ? "planExtras.unslotted.onlyUnslotted" : "planExtras.unslotted.showAll")}
            </button>
            <VideoProjectsPanel channelId={channelId} visible={visible} onlyVideos={showAll ? null : unslottedSet} onChanged={() => void readCounts()} />
          </div>
        </FeatureErrorBoundary>
      )}

      {/* Always mounted while «План» is shown: its rows drive the queue line and the slot cards' percent; the list itself only when open. */}
      <FeatureErrorBoundary label={t("publishingUploads.title")}>
        <div className={open === "queue" ? "rounded-xl border border-zinc-800 bg-zinc-900 p-4" : "hidden"}>
          <PublishingUploads channelId={channelId} visible={visible} refreshKey={uploadsKey} onRows={handleRows} />
        </div>
      </FeatureErrorBoundary>

      {open === "packages" && (
        <FeatureErrorBoundary label={t("publishingPackages.title")}>
          <PublishingPackages
            channelId={channelId}
            visible={visible}
            showUploads={false}
            onQueued={() => {
              setUploadsKey((k) => k + 1);
              void readCounts();
            }}
          />
        </FeatureErrorBoundary>
      )}
    </div>
  );
}
