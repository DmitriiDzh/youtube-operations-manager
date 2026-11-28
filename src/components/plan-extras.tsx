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
import { unslottedVideos, uploadQueueSummary, type PlanPackageRef } from "./plan-extras-model";
import type { ContentProjectsList } from "./content-tab-badges";
import type { VideoListView } from "./video-projects-panel";
import { LoadingIndicator } from "./operation-progress";
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
  problems?: Array<{ code: string }>;
  pkg: { slotId?: string | null; captions?: Array<{ file: string }> | null } | null;
};

type Part = "unslotted" | "queue" | "packages";
const markClass = "rounded bg-amber-500/90 px-1.5 text-[10px] font-semibold text-zinc-950";
const lineClass = "inline-flex max-w-full items-center gap-1.5 truncate rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-600";
const menuItemClass = "block w-full rounded-md px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800";

export function PlanExtras({
  channelId,
  visible,
  projects,
  onProjects,
  onUploads,
  onPackages,
  packagesRefreshKey = 0,
}: {
  channelId: string | null;
  visible: boolean;
  /** The channel's video-projects list, read once a minute by the tab badges (BL-266 review: one read, shared); null until read. */
  projects: ContentProjectsList | null;
  /** A list the open videos board read: replaces the shared one at once. */
  onProjects?: (list: ContentProjectsList) => void;
  /** This channel's upload rows, each time they are read (the slot cards' percent). */
  onUploads?: (rows: UploadRow[]) => void;
  /** The package scan rows, each time they are read with the workspace available (the slot cards' packaging actions). */
  onPackages?: (rows: PlanPackageRow[]) => void;
  /** Bumped by the plan after a packaging change on a card: read the packages again. */
  packagesRefreshKey?: number;
}) {
  const t = useT();
  const [packages, setPackages] = useState<PlanPackageRow[] | null>(null);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [unlinkedRuns, setUnlinkedRuns] = useState(0);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [uploadsKey, setUploadsKey] = useState(0);
  // Each part opens on its own; once opened it stays mounted (hidden when closed), so the packages keep their selection and typed dates.
  const [open, setOpen] = useState<Record<Part, boolean>>({ unslotted: false, queue: false, packages: false });
  const [opened, setOpened] = useState<Record<Part, boolean>>({ unslotted: false, queue: false, packages: false });
  const [showAll, setShowAll] = useState(false);
  // Refs, so a new callback from the parent never makes a new read function (and a read loop).
  const onUploadsRef = useRef(onUploads);
  const onPackagesRef = useRef(onPackages);
  const onProjectsRef = useRef(onProjects);
  useEffect(() => {
    onUploadsRef.current = onUploads;
    onPackagesRef.current = onPackages;
    onProjectsRef.current = onProjects;
  }, [onUploads, onPackages, onProjects]);

  /** The package scan and the cost summary (no state set here; a failed read is null). */
  const fetchExtras = useCallback(async () => {
    if (!channelId) return { scan: null, costs: null };
    const base = `/api/channels/${encodeURIComponent(channelId)}`;
    const get = async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await fetch(url);
        return res.ok ? ((await res.json()) as T) : null;
      } catch {
        return null;
      }
    };
    const [scan, costs] = await Promise.all([get<{ status: string; packages?: PlanPackageRow[] }>(`${base}/publishing/packages`), get<{ unlinked?: { runs?: number } }>(`${base}/video-costs`)]);
    return { scan, costs };
  }, [channelId]);
  const applyExtras = useCallback(({ scan, costs }: { scan: { status: string; packages?: PlanPackageRow[] } | null; costs: { unlinked?: { runs?: number } } | null }) => {
    if (scan) {
      setScanStatus(scan.status);
      // Only a scan of an available workspace replaces the rows: an unmounted disk never inflates «Без слота» nor drops the cards' buttons.
      if (scan.status === "ok") {
        const rows = scan.packages ?? [];
        setPackages(rows);
        onPackagesRef.current?.(rows);
      }
    }
    if (costs) setUnlinkedRuns(costs.unlinked?.runs ?? 0);
  }, []);

  useEffect(() => {
    if (!visible || !channelId) return;
    let cancelled = false;
    const read = () => {
      void fetchExtras().then((answer) => {
        if (!cancelled) applyExtras(answer);
      });
    };
    read();
    const stop = startVisibleInterval(read, 60_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [visible, channelId, fetchExtras, applyExtras, packagesRefreshKey]);
  const readExtras = useCallback(() => fetchExtras().then(applyExtras), [fetchExtras, applyExtras]);

  const videos = projects?.videos ?? null;
  const unslotted = useMemo(() => (videos && packages ? unslottedVideos(videos, packages) : null), [videos, packages]);
  const disputed = useMemo(() => (videos ?? []).filter((v) => v.conflict).map((v) => v.video), [videos]);
  // The board shows the numbers without a slot and every number in dispute (its conflict and «take the next number» live on the board).
  const boardFilter = useMemo(() => (unslotted ? new Set([...unslotted, ...disputed]) : null), [unslotted, disputed]);
  const workspaceProblem = (projects?.workspace !== undefined && projects.workspace !== "ok") || (scanStatus !== null && scanStatus !== "ok");
  const queue = uploadQueueSummary(uploads);
  const handleRows = useCallback((rows: UploadRow[]) => {
    setUploads(rows);
    onUploadsRef.current?.(rows);
  }, []);
  const handleList = useCallback((list: VideoListView) => onProjectsRef.current?.(list), []);
  const toggle = (part: Part, to?: boolean) => {
    setOpen((current) => ({ ...current, [part]: to ?? !current[part] }));
    setOpened((current) => ({ ...current, [part]: true }));
  };

  if (!channelId) return null;

  const queueText = queue.current
    ? `${t("planExtras.queue.line", { count: queue.active })} · ${queue.current.video} ${queue.current.status === "uploading" ? `${queue.current.percent}%` : t(`publishingUploads.status.${queue.current.status}` as UiTextKey, { percent: queue.current.percent })}`
    : t("planExtras.queue.empty");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FeatureErrorBoundary label={t("videoProjects.title")}>
          <button type="button" aria-expanded={open.unslotted} onClick={() => toggle("unslotted")} title={t("planExtras.unslotted.hint")} className={lineClass}>
            <span className={unslotted && unslotted.length > 0 ? "text-amber-200" : undefined}>{t("planExtras.unslotted.line", { count: unslotted === null ? "…" : unslotted.length })}</span>
            {/* BL-266 review: what used to be visible on the board without opening anything. */}
            {disputed.length > 0 && (
              <span className={markClass} title={t("planExtras.mark.dispute", { count: disputed.length })} aria-label={t("planExtras.mark.dispute", { count: disputed.length })}>
                {t("planExtras.mark.disputeShort", { count: disputed.length })}
              </span>
            )}
            {workspaceProblem && (
              <span className={markClass} title={t("planExtras.mark.workspace")} aria-label={t("planExtras.mark.workspace")}>
                {t("planExtras.mark.workspaceShort")}
              </span>
            )}
            {unlinkedRuns > 0 && (
              <span className={markClass} title={t("planExtras.mark.unlinkedCost", { count: unlinkedRuns })} aria-label={t("planExtras.mark.unlinkedCost", { count: unlinkedRuns })}>
                {t("planExtras.mark.unlinkedCostShort")}
              </span>
            )}
            <span aria-hidden>{open.unslotted ? "▴" : "▾"}</span>
          </button>
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={t("publishingUploads.title")}>
          <button type="button" aria-expanded={open.queue} onClick={() => toggle("queue")} title={t("planExtras.queue.hint")} className={lineClass}>
            <span className="truncate">{queueText}</span>
            {queue.needsDecision > 0 && <span className="text-amber-300">· {t("planExtras.queue.needsDecision", { count: queue.needsDecision })}</span>}
            <span aria-hidden>{open.queue ? "▴" : "▾"}</span>
          </button>
        </FeatureErrorBoundary>
        {open.packages && (
          <button type="button" aria-expanded onClick={() => toggle("packages", false)} className={lineClass}>
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
                    toggle("packages", true);
                    close();
                  }}
                >
                  {t("planExtras.more.packages")}
                </button>
                <Link role="menuitem" href={`/home#${PUBLISHING_SETTINGS_ANCHOR}`} className={menuItemClass} onClick={close}>
                  {t("planExtras.more.publishingSettings")}
                </Link>
                <Link role="menuitem" href={`/home#${LOCAL_CLEANUP_ANCHOR}`} className={menuItemClass} onClick={close}>
                  {t("planExtras.more.cleanup")}
                </Link>
              </div>
            )}
          </Popover>
        </div>
      </div>

      {opened.unslotted && (
        <FeatureErrorBoundary label={t("videoProjects.title")}>
          <div className={open.unslotted ? "space-y-2" : "hidden"}>
            <button type="button" onClick={() => setShowAll((x) => !x)} className="text-xs text-zinc-400 underline hover:text-zinc-200">
              {t(showAll ? "planExtras.unslotted.onlyUnslotted" : "planExtras.unslotted.showAll")}
            </button>
            {/* Never «every video has a slot» before the data is in: the filtered board waits for the count. */}
            {!showAll && boardFilter === null ? (
              <LoadingIndicator className="text-xs text-zinc-400" />
            ) : (
              <VideoProjectsPanel channelId={channelId} visible={visible && open.unslotted} onlyVideos={showAll ? null : boardFilter} onList={handleList} />
            )}
          </div>
        </FeatureErrorBoundary>
      )}

      {/* Always mounted while «План» is shown: its rows drive the queue line and the slot cards' percent; the list itself only when open. */}
      <FeatureErrorBoundary label={t("publishingUploads.title")}>
        <div className={open.queue ? "rounded-xl border border-zinc-800 bg-zinc-900 p-4" : "hidden"}>
          <PublishingUploads channelId={channelId} visible={visible} refreshKey={uploadsKey} onRows={handleRows} />
        </div>
      </FeatureErrorBoundary>

      {opened.packages && (
        <FeatureErrorBoundary label={t("publishingPackages.title")}>
          <div className={open.packages ? undefined : "hidden"}>
            <PublishingPackages
              channelId={channelId}
              visible={visible && open.packages}
              showUploads={false}
              onQueued={() => {
                setUploadsKey((k) => k + 1);
                void readExtras();
              }}
            />
          </div>
        </FeatureErrorBoundary>
      )}
    </div>
  );
}

/** BL-266 review: where the «⋯» links land in Settings → Channels (the ids of the moved cards' wrappers). */
export const PUBLISHING_SETTINGS_ANCHOR = "publishing-settings";
export const LOCAL_CLEANUP_ANCHOR = "local-video-cleanup";
