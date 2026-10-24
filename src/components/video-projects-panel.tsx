"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDisplayDate, formatDisplayDateTime, resolvePublishDate } from "@/lib/shared-formatting";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";
import { costUsd, VideoCostDialog, type CostTotalsView } from "./video-cost-dialog";
import { VideoCostsBackfill } from "./video-costs-backfill";
import { FeatureErrorBoundary } from "./feature-error-boundary";
import { canLink, PIPELINE_PHASES, pipelinePhase, type PipelinePhase } from "./video-pipeline";
import { VideoLinkDialog } from "./video-link-dialog";

// BL-194 stage 1 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 "UI", ADR 0040): Content → «Публикация» starts with the channel's videos
// in work. «Новый ролик» reserves the next number (with an optional working title); a number two computers took at once is shown
// on both, and only the computer that lost is offered the next free number -- in a dialog, never by itself.

export type VideoReservationView = { deviceId: string; hostName: string | null; thisComputer: boolean; reservedAt: string; workingTitle: string | null };
export type VideoProjectView = {
  video: string;
  workingTitle: string | null;
  state: "in_work" | "packaged" | "published" | "cancelled";
  folder: string | null;
  createdAt: string | null;
  hostName: string | null;
  deviceId: string | null;
  thisComputer: boolean;
  conflict: { reservations: VideoReservationView[]; winnerDeviceId: string; thisComputerInvolved: boolean; thisComputerLoses: boolean; suggestedVideo: string | null } | null;
  /** BL-221: the YouTube video this number became (null while unknown). */
  youtubeVideoId?: string | null;
  /** BL-221: the folder holds the release video file. */
  hasVideoFile?: boolean;
};
export type VideoListView = { videos: VideoProjectView[]; workspace: "ok" | "not_configured" | "unavailable"; nextVideo: string | null };
/** BL-194 stage 3: the cost summary of the channel's videos (its own route; the list works without it). */
type VideoCostSummaryView = { videos: Array<{ video: string; totals: CostTotalsView }>; unlinked: CostTotalsView };

/** BL-221: the synced videos the board reads (a local read): the linked video's title, access, date and views. */
type SyncedVideoLite = { videoId: string; title: string; privacyStatus: string; publishAt: string | null; publishedAt: string; viewCount: number | null };

const PHASE_TITLE: Record<PipelinePhase, UiTextKey> = {
  prep: "pipeline.phase.prep",
  edit: "pipeline.phase.edit",
  package: "pipeline.phase.package",
  youtube: "pipeline.phase.youtube",
  published: "pipeline.phase.published",
};
const PHASE_HINT: Record<PipelinePhase, UiTextKey> = {
  prep: "pipeline.phaseHint.prep",
  edit: "pipeline.phaseHint.edit",
  package: "pipeline.phaseHint.package",
  youtube: "pipeline.phaseHint.youtube",
  published: "pipeline.phaseHint.published",
};
const PHASE_ACCENT: Record<PipelinePhase, string> = {
  prep: "border-t-indigo-500",
  edit: "border-t-sky-500",
  package: "border-t-violet-500",
  youtube: "border-t-amber-500",
  published: "border-t-emerald-500",
};
/** The «Опубликовано» column shows the newest few until the owner opens it. */
const PUBLISHED_SHOWN = 6;

const computerName = (r: { hostName: string | null; deviceId: string | null }, fallback: string) => r.hostName ?? r.deviceId ?? fallback;

export function VideoProjectsPanel({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const { t } = useUiText();
  const [list, setList] = useState<VideoListView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishedOpen, setPublishedOpen] = useState(false);
  const [synced, setSynced] = useState<Map<string, SyncedVideoLite> | null>(null);
  const [linking, setLinking] = useState<VideoProjectView | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [renumbering, setRenumbering] = useState<VideoProjectView | null>(null);
  const [cancelling, setCancelling] = useState<VideoProjectView | null>(null);
  const [costs, setCosts] = useState<VideoCostSummaryView | null>(null);
  const [costsFailed, setCostsFailed] = useState(false);
  const [costOf, setCostOf] = useState<VideoProjectView | null>(null);

  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/video-projects` : null;

  const load = useCallback(async () => {
    if (!base) return;
    setLoading(true);
    try {
      const res = await fetch(base);
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(t, data, t("videoProjects.loadFailed")));
      setList(data as VideoListView);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("videoProjects.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [base, t]);

  // BL-194 stage 3: the costs come from their own route, after the list; a failure there is one line, never the list's error.
  const loadCosts = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/video-costs`);
      if (!res.ok) throw new Error("bad status"); // ui-text-ignore: internal, never shown
      setCosts((await res.json()) as VideoCostSummaryView);
      setCostsFailed(false);
    } catch {
      setCostsFailed(true);
    }
  }, [channelId]);

  // BL-221: the channel's synced videos (local), for the linked video's title, access and date. A failure leaves them out.
  const loadSynced = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/videos`);
      if (!res.ok) return;
      const data = (await res.json()) as { videos: SyncedVideoLite[] };
      setSynced(new Map(data.videos.map((v) => [v.videoId, v])));
    } catch {
      // the board works without them
    }
  }, [channelId]);

  useEffect(() => {
    if (visible) {
      void load();
      void loadCosts();
      void loadSynced();
    }
  }, [visible, load, loadCosts, loadSynced]);

  async function act(url: string, body: unknown, success: (data: { video: VideoProjectView; replaced?: string }) => string) {
    setBusy(true);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(t, data, t("videoProjects.actionFailed")));
      setNotice(success(data));
      setError(null);
    } catch (e) {
      setNotice(null);
      setError(e instanceof Error ? e.message : t("videoProjects.actionFailed"));
    } finally {
      setBusy(false);
      await load();
    }
  }

  if (!channelId) return null;
  const videos = list?.videos ?? [];
  const canCreate = list?.workspace === "ok" && Boolean(list.nextVideo);
  const syncedOf = (v: VideoProjectView) => (v.youtubeVideoId ? synced?.get(v.youtubeVideoId) ?? null : null);
  const columns = new Map<PipelinePhase, VideoProjectView[]>(PIPELINE_PHASES.map((phase) => [phase, []]));
  for (const v of videos) {
    const phase = pipelinePhase(v, syncedOf(v));
    if (phase) columns.get(phase)!.push(v);
  }
  const cancelledCount = videos.filter((v) => v.state === "cancelled").length;
  const linkable = videos.filter((v) => canLink(v) && (v.hasVideoFile || v.state !== "in_work")).length;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-medium text-zinc-100">{t("videoProjects.title")}</h3>
          <p className="mt-1 max-w-3xl text-xs text-zinc-400">{t("videoProjects.intro")}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => {
              setTitle("");
              setCreating(true);
            }}
            disabled={!canCreate || busy}
            title={canCreate ? undefined : t("videoProjects.newDisabled")}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {t("videoProjects.new")}
          </button>
          <button type="button" onClick={() => void Promise.all([load(), loadCosts(), loadSynced()])} disabled={loading} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50">
            {t("videoProjects.refresh")}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="rounded-lg border border-emerald-800/60 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200">{notice}</p>}
      {!list && !error && <LoadingIndicator className="text-xs text-zinc-400" />}
      {list && list.workspace !== "ok" && (
        <p className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
          {t(list.workspace === "not_configured" ? "videoProjects.noWorkspace" : "videoProjects.workspaceUnavailable")}
        </p>
      )}
      {costsFailed && <p className="text-xs text-amber-300/80">{t("videoCosts.loadFailed")}</p>}
      {costs && costs.unlinked.runs > 0 && (
        <p className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
          {t("videoCosts.unlinked", { total: `${costs.unlinked.estimated ? "≈" : ""}${costUsd(costs.unlinked.totalUsd)}`, runs: costs.unlinked.runs })}
        </p>
      )}
      {linkable > 0 && <p className="text-xs text-zinc-400">{t("pipeline.linkHint", { count: linkable })}</p>}
      {list && videos.length === 0 && <p className="text-xs text-zinc-400">{t("videoProjects.emptyAll")}</p>}
      {videos.length > 0 && (
        // BL-221 (CONTENT_UX_PLAN.md stage B): one board by phase instead of one list; each number in exactly one column.
        <div className="overflow-x-auto">
          <div className="grid min-w-[1000px] grid-cols-5 gap-3">
            {PIPELINE_PHASES.map((phase) => {
              const items = columns.get(phase)!;
              const visibleItems = phase === "published" && !publishedOpen ? items.slice(0, PUBLISHED_SHOWN) : items;
              return (
                <section key={phase} className={`flex min-w-0 flex-col gap-2 rounded-lg border border-zinc-800 border-t-2 bg-zinc-950/40 p-2 ${PHASE_ACCENT[phase]}`}>
                  <header className="px-1" title={t(PHASE_HINT[phase])}>
                    <h4 className="flex items-center justify-between text-xs font-medium text-zinc-300">
                      <span>{t(PHASE_TITLE[phase])}</span>
                      <span className="rounded-full bg-zinc-800 px-1.5 text-[11px] text-zinc-400">{items.length}</span>
                    </h4>
                  </header>
                  {items.length === 0 && <p className="px-1 text-[11px] text-zinc-600">{t("pipeline.columnEmpty")}</p>}
                  {visibleItems.map((v) => {
                    const yt = syncedOf(v);
                    const cost = costs?.videos.find((c) => c.video === v.video)?.totals ?? null;
                    const computer = computerName(v, t("videoProjects.unknownComputer"));
                    const winner = v.conflict?.reservations.find((r) => r.deviceId === v.conflict?.winnerDeviceId);
                    const others = v.conflict?.reservations.filter((r) => !r.thisComputer) ?? [];
                    const date = yt ? resolvePublishDate(yt) : null;
                    return (
                      <article key={v.video} className="space-y-1 rounded-md border border-zinc-800 bg-zinc-900 p-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-zinc-100">{v.video}</span>
                          {cost && cost.runs > 0 && (
                            <button
                              type="button"
                              onClick={() => setCostOf(v)}
                              title={t("videoCosts.chipTitle", { runpod: costUsd(cost.runpodUsd), gemini: costUsd(cost.geminiUsd), runs: cost.runs })}
                              className="ml-auto shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200 hover:border-indigo-500 hover:bg-zinc-800"
                            >
                              {t(cost.estimated && !costUsd(cost.totalUsd).startsWith("<") ? "videoCosts.chipEstimated" : "videoCosts.chip", { total: costUsd(cost.totalUsd) })}
                            </button>
                          )}
                        </div>
                        {(yt || v.workingTitle || !v.folder) && (
                          <p className={`line-clamp-2 ${yt || v.workingTitle ? "text-zinc-200" : "text-zinc-500"}`} title={yt?.title ?? v.workingTitle ?? undefined}>
                            {yt?.title ?? v.workingTitle ?? t("videoProjects.untitled")}
                          </p>
                        )}
                        <p className="text-zinc-500">
                          {phase === "published" || phase === "youtube"
                            ? yt
                              ? [
                                  t(yt.privacyStatus === "public" ? "pipeline.public" : yt.publishAt ? "pipeline.scheduled" : yt.privacyStatus === "unlisted" ? "pipeline.unlisted" : "pipeline.private"),
                                  date ? formatDisplayDate(date) : null,
                                  yt.viewCount !== null ? t("pipeline.views", { count: yt.viewCount }) : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : t(v.youtubeVideoId ? "pipeline.notSyncedYet" : "pipeline.publishedNoVideo")
                            : v.folder
                              ? v.folder.slice(v.folder.lastIndexOf("/") + 1)
                              : v.createdAt
                                ? t(v.thisComputer ? "videoProjects.reservedHere" : "videoProjects.reservedOn", { date: formatDisplayDateTime(v.createdAt), computer })
                                : t("videoProjects.noFolder")}
                        </p>
                        {v.conflict && (
                          <div className="space-y-1.5 rounded border border-amber-800/60 bg-amber-950/20 p-1.5 text-amber-200">
                            <p>
                              {t("videoProjects.conflict", {
                                video: v.video,
                                computers: (others.length > 0 ? others : v.conflict.reservations).map((r) => computerName(r, t("videoProjects.unknownComputer"))).join(", "),
                                winner: winner ? computerName(winner, t("videoProjects.unknownComputer")) : v.conflict.winnerDeviceId,
                              })}
                            </p>
                            <p>{t(v.conflict.thisComputerLoses ? "videoProjects.conflictLoses" : v.conflict.thisComputerInvolved ? "videoProjects.conflictKeeps" : "videoProjects.conflictElsewhere")}</p>
                            {v.conflict.thisComputerLoses && v.conflict.suggestedVideo && (
                              <button type="button" onClick={() => setRenumbering(v)} disabled={busy} className="rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-500 disabled:opacity-50">
                                {t("videoProjects.takeNext", { video: v.conflict.suggestedVideo })}
                              </button>
                            )}
                          </div>
                        )}
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          {canLink(v) && (phase !== "prep" || v.hasVideoFile) && (
                            <button type="button" onClick={() => setLinking(v)} disabled={busy} className="text-sky-400 underline hover:text-sky-300 disabled:opacity-50">
                              {t("pipeline.link")}
                            </button>
                          )}
                          {v.youtubeVideoId && (
                            // ui-text-ignore: a link label made of the video id (data)
                            <a href={`https://studio.youtube.com/video/${encodeURIComponent(v.youtubeVideoId)}/edit`} target="_blank" rel="noreferrer" className="text-zinc-400 underline hover:text-zinc-200">
                              {t("pipeline.studio")}
                            </a>
                          )}
                          {v.thisComputer && v.state === "in_work" && !v.conflict && (
                            <button type="button" onClick={() => setCancelling(v)} disabled={busy} className="text-zinc-500 underline hover:text-zinc-300 disabled:opacity-50">
                              {t("videoProjects.cancel")}
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                  {phase === "published" && items.length > PUBLISHED_SHOWN && (
                    <button type="button" onClick={() => setPublishedOpen((x) => !x)} className="px-1 text-left text-[11px] text-zinc-400 underline hover:text-zinc-200">
                      {publishedOpen ? t("pipeline.showFewer") : t("pipeline.showMore", { count: items.length - PUBLISHED_SHOWN })}
                    </button>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}
      {cancelledCount > 0 && <p className="text-[11px] text-zinc-600">{t("pipeline.cancelledCount", { count: cancelledCount })}</p>}

      {list && (
        // BL-194 stage 4: older runs, in their own boundary (a failure there never hides the list).
        <FeatureErrorBoundary label={t("videoCostsBackfill.title")}>
          <VideoCostsBackfill channelId={channelId} videos={videos} onChanged={() => void loadCosts()} />
        </FeatureErrorBoundary>
      )}
      {linking && (
        <VideoLinkDialog
          channelId={channelId}
          video={linking.video}
          onCancel={() => setLinking(null)}
          onLinked={(videoId) => {
            setLinking(null);
            setNotice(t("pipeline.linked", { video: linking.video, videoId }));
            setError(null);
            void load();
          }}
        />
      )}
      {costOf && <VideoCostDialog channelId={channelId} video={costOf.video} workingTitle={costOf.workingTitle} onClose={() => setCostOf(null)} />}
      {creating && list?.nextVideo && (
        <ConfirmDialog
          title={t("videoProjects.newTitle")}
          description={t("videoProjects.newDescription", { video: list.nextVideo })}
          confirmLabel={t("videoProjects.newConfirm", { video: list.nextVideo })}
          confirmDisabled={busy || title.trim().length > 200}
          onCancel={() => setCreating(false)}
          onConfirm={() => {
            setCreating(false);
            void act(base!, { workingTitle: title.trim() === "" ? null : title.trim() }, (data) => t("videoProjects.created", { video: data.video.video }));
          }}
        >
          <label className="block space-y-1 text-xs text-zinc-400">
            <span>{t("videoProjects.workingTitle")}</span>
            <input
              type="text"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("videoProjects.workingTitlePlaceholder")}
              className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
            />
          </label>
        </ConfirmDialog>
      )}
      {renumbering?.conflict?.suggestedVideo && (
        <ConfirmDialog
          title={t("videoProjects.renumberTitle", { video: renumbering.video })}
          description={t("videoProjects.renumberDescription", {
            video: renumbering.video,
            next: renumbering.conflict.suggestedVideo,
            winner: computerName(renumbering.conflict.reservations[0], t("videoProjects.unknownComputer")),
          })}
          confirmLabel={t("videoProjects.takeNext", { video: renumbering.conflict.suggestedVideo })}
          onCancel={() => setRenumbering(null)}
          onConfirm={() => {
            const target = renumbering;
            setRenumbering(null);
            void act(`${base}/${encodeURIComponent(target.video)}/renumber`, {}, (data) => t("videoProjects.renumbered", { from: data.replaced ?? target.video, to: data.video.video }));
          }}
        />
      )}
      {cancelling && (
        <ConfirmDialog
          title={t("videoProjects.cancelTitle", { video: cancelling.video })}
          description={t("videoProjects.cancelDescription", { video: cancelling.video })}
          confirmLabel={t("videoProjects.cancelConfirm")}
          confirmVariant="danger"
          onCancel={() => setCancelling(null)}
          onConfirm={() => {
            const target = cancelling;
            setCancelling(null);
            void act(`${base}/${encodeURIComponent(target.video)}/cancel`, {}, () => t("videoProjects.cancelled", { video: target.video }));
          }}
        />
      )}
    </div>
  );
}
