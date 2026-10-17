"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";
import { costUsd, VideoCostDialog, type CostTotalsView } from "./video-cost-dialog";
import { VideoCostsBackfill } from "./video-costs-backfill";
import { FeatureErrorBoundary } from "./feature-error-boundary";

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
};
export type VideoListView = { videos: VideoProjectView[]; workspace: "ok" | "not_configured" | "unavailable"; nextVideo: string | null };
/** BL-194 stage 3: the cost summary of the channel's videos (its own route; the list works without it). */
type VideoCostSummaryView = { videos: Array<{ video: string; totals: CostTotalsView }>; unlinked: CostTotalsView };

const STATE_STYLE: Record<VideoProjectView["state"], string> = {
  in_work: "bg-indigo-950/60 text-indigo-200",
  packaged: "bg-emerald-950/50 text-emerald-300",
  published: "bg-zinc-800 text-zinc-400",
  cancelled: "bg-zinc-800 text-zinc-500 line-through",
};

const computerName = (r: { hostName: string | null; deviceId: string | null }, fallback: string) => r.hostName ?? r.deviceId ?? fallback;

export function VideoProjectsPanel({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const { t } = useUiText();
  const [list, setList] = useState<VideoListView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
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

  useEffect(() => {
    if (visible) {
      void load();
      void loadCosts();
    }
  }, [visible, load, loadCosts]);

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
  // In work, plus every number in dispute whatever its state (both computers must see it).
  const shown = showAll ? videos : videos.filter((v) => v.state === "in_work" || v.conflict);
  const canCreate = list?.workspace === "ok" && Boolean(list.nextVideo);

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
          <button type="button" onClick={() => void Promise.all([load(), loadCosts()])} disabled={loading} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50">
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
      {list && shown.length === 0 && <p className="text-xs text-zinc-400">{t(showAll ? "videoProjects.emptyAll" : "videoProjects.empty")}</p>}
      {shown.length > 0 && (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {shown.map((v) => {
            const computer = computerName(v, t("videoProjects.unknownComputer"));
            const winner = v.conflict?.reservations.find((r) => r.deviceId === v.conflict?.winnerDeviceId);
            const others = v.conflict?.reservations.filter((r) => !r.thisComputer) ?? [];
            const cost = costs?.videos.find((c) => c.video === v.video)?.totals ?? null;
            return (
              <li key={v.video} className="space-y-1.5 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-zinc-100">{v.video}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATE_STYLE[v.state]}`}>{t(`videoProjects.state.${v.state}` as UiTextKey)}</span>
                  <span className={v.workingTitle ? "truncate text-zinc-200" : "text-zinc-500"}>{v.workingTitle ?? t("videoProjects.untitled")}</span>
                  {cost && (
                    <button
                      type="button"
                      onClick={() => setCostOf(v)}
                      title={t("videoCosts.chipTitle", { runpod: costUsd(cost.runpodUsd), gemini: costUsd(cost.geminiUsd), runs: cost.runs })}
                      className="ml-auto shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 font-mono text-[11px] text-zinc-200 hover:border-indigo-500 hover:bg-zinc-800"
                    >
                      {t(cost.estimated ? "videoCosts.chipEstimated" : "videoCosts.chip", { total: costUsd(cost.totalUsd) })}
                    </button>
                  )}
                </div>
                <p className="text-xs text-zinc-400">
                  {v.createdAt
                    ? t(v.thisComputer ? "videoProjects.reservedHere" : "videoProjects.reservedOn", { date: formatDisplayDateTime(v.createdAt), computer })
                    : t("videoProjects.fromWorkspace")}
                  {" · "}
                  {v.folder ? t("videoProjects.folder", { folder: v.folder }) : t("videoProjects.noFolder")}
                </p>
                {v.conflict && (
                  <div className="space-y-2 rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                    <p>
                      {t("videoProjects.conflict", {
                        video: v.video,
                        computers: (others.length > 0 ? others : v.conflict.reservations).map((r) => computerName(r, t("videoProjects.unknownComputer"))).join(", "),
                        winner: winner ? computerName(winner, t("videoProjects.unknownComputer")) : v.conflict.winnerDeviceId,
                      })}
                    </p>
                    <p>{t(v.conflict.thisComputerLoses ? "videoProjects.conflictLoses" : v.conflict.thisComputerInvolved ? "videoProjects.conflictKeeps" : "videoProjects.conflictElsewhere")}</p>
                    {v.conflict.thisComputerLoses && v.conflict.suggestedVideo && (
                      <button type="button" onClick={() => setRenumbering(v)} disabled={busy} className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50">
                        {t("videoProjects.takeNext", { video: v.conflict.suggestedVideo })}
                      </button>
                    )}
                  </div>
                )}
                {v.thisComputer && v.state === "in_work" && !v.conflict && (
                  <button type="button" onClick={() => setCancelling(v)} disabled={busy} className="text-xs text-zinc-500 underline hover:text-zinc-300 disabled:opacity-50">
                    {t("videoProjects.cancel")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {costs && costs.unlinked.runs > 0 && <p className="text-xs text-zinc-500">{t("videoCosts.unlinked", { total: `${costs.unlinked.estimated ? "≈" : ""}${costUsd(costs.unlinked.totalUsd)}`, runs: costs.unlinked.runs })}</p>}
      {videos.length > 0 && (
        <button type="button" onClick={() => setShowAll((x) => !x)} className="text-xs text-zinc-400 underline hover:text-zinc-200">
          {t(showAll ? "videoProjects.showInWork" : "videoProjects.showAll", { n: videos.length })}
        </button>
      )}

      {list && (
        // BL-194 stage 4: older runs, in their own boundary (a failure there never hides the list).
        <FeatureErrorBoundary label={t("videoCostsBackfill.title")}>
          <VideoCostsBackfill channelId={channelId} videos={videos} onChanged={() => void loadCosts()} />
        </FeatureErrorBoundary>
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
