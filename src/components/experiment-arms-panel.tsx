"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { formatDisplayDate } from "@/lib/shared-formatting";
import type { ExperimentStatus } from "@/lib/decision-engine/status";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";

// BL-170 (docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md): the selected experiment's videos by arm. The owner links a video of the
// experiment's channel to an arm (`control`, `A`, ...) and removes it while the experiment is proposed/approved/running; after that the
// block is the test's history, read-only. The server re-checks every rule; this panel only avoids offering what would be refused.

type ArmVideo = { videoId: string; linkedAt: string; linkedBy: string; linkedVia: "web_ui" | "producer_proposal" };
type Arm = { arm: string; videos: ArmVideo[] };
type ChannelVideo = { videoId: string; title: string; publishedAt: string; privacyStatus: string };

const LINKABLE: ExperimentStatus[] = ["proposed", "approved", "running"];
const SUGGESTED_ARMS = ["control", "A", "B", "C", "D"];

export function ExperimentArmsPanel({
  experimentId,
  status,
  hypothesisChannelId,
  activeChannelId,
}: {
  experimentId: string;
  status: ExperimentStatus;
  /** The hypothesis's channel; null for a new-channel concept, which cannot have videos. */
  hypothesisChannelId: string | null;
  activeChannelId: string | null;
}) {
  const t = useT();
  const [arms, setArms] = useState<Arm[] | null>(null);
  const [videos, setVideos] = useState<ChannelVideo[]>([]);
  const [videoInput, setVideoInput] = useState("");
  const [armInput, setArmInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onActiveChannel = hypothesisChannelId !== null && hypothesisChannelId === activeChannelId;
  const editable = onActiveChannel && LINKABLE.includes(status);

  const load = useCallback(async () => {
    if (hypothesisChannelId === null) return;
    const res = await fetch(`/api/decision-engine/experiments/${encodeURIComponent(experimentId)}/arms`);
    const data = await res.json();
    if (!res.ok) {
      setError(errorText(t, data, t("decisions.arms.error.load"), { showErrorField: false }));
      return;
    }
    setArms(data.arms as Arm[]);
  }, [experimentId, hypothesisChannelId, t]);

  useEffect(() => {
    setArms(null);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!editable || hypothesisChannelId === null) return;
    void (async () => {
      const res = await fetch(`/api/channels/${encodeURIComponent(hypothesisChannelId)}/videos`);
      if (!res.ok) return;
      const data = await res.json();
      setVideos(((data.videos ?? []) as ChannelVideo[]).slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)));
    })();
  }, [editable, hypothesisChannelId]);

  const titleOf = useMemo(() => new Map(videos.map((video) => [video.videoId, video])), [videos]);
  const linkedIds = useMemo(() => new Set((arms ?? []).flatMap((arm) => arm.videos.map((video) => video.videoId))), [arms]);
  const options = videos.filter((video) => !linkedIds.has(video.videoId));
  /** The picked video: an option's "title · id" text, or a bare id. */
  const pickedVideoId = useMemo(() => {
    const text = videoInput.trim();
    const byLabel = options.find((video) => `${video.title} · ${video.videoId}` === text);
    return byLabel?.videoId ?? (options.some((video) => video.videoId === text) ? text : null);
  }, [videoInput, options]);

  async function link() {
    if (!pickedVideoId || !armInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/decision-engine/experiments/${encodeURIComponent(experimentId)}/arms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: pickedVideoId, arm: armInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("decisions.arms.error.link"), { showErrorField: false }));
        return;
      }
      setArms(data.arms as Arm[]);
      setVideoInput("");
    } finally {
      setBusy(false);
    }
  }

  async function unlink(videoId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/decision-engine/experiments/${encodeURIComponent(experimentId)}/arms/${encodeURIComponent(videoId)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("decisions.arms.error.unlink"), { showErrorField: false }));
        return;
      }
      setArms(data.arms as Arm[]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-4 rounded border border-zinc-700 p-3" aria-labelledby={`arms-${experimentId}`}>
      <h4 id={`arms-${experimentId}`} className="mb-1 font-medium">
        {t("decisions.arms.title")}
      </h4>
      <p className="mb-2 text-xs text-zinc-400">{t("decisions.arms.intro")}</p>

      {hypothesisChannelId === null ? (
        <p className="text-sm text-zinc-400">{t("decisions.arms.noChannel")}</p>
      ) : arms === null && !error ? (
        <LoadingIndicator className="text-sm text-zinc-400" />
      ) : (
        <>
          {arms && arms.length === 0 && <p className="text-sm text-zinc-400">{t("decisions.arms.empty")}</p>}
          {arms && arms.length > 0 && (
            <ul className="space-y-2">
              {arms.map((arm) => (
                <li key={arm.arm}>
                  <div className="text-xs font-medium text-zinc-300">{t("decisions.arms.armLabel", { arm: arm.arm, count: arm.videos.length })}</div>
                  <ul className="mt-1 space-y-1">
                    {arm.videos.map((video) => {
                      const known = titleOf.get(video.videoId);
                      return (
                        <li key={video.videoId} className="flex items-center justify-between gap-2 rounded bg-zinc-800 px-2 py-1 text-sm">
                          <span className="min-w-0 truncate">
                            {known ? known.title : video.videoId}
                            <span className="ml-2 text-xs text-zinc-500">
                              {known ? `${video.videoId} · ${formatDisplayDate(known.publishedAt)}` : ""}
                              {video.linkedVia === "producer_proposal" ? ` · ${t("decisions.arms.viaProducer")}` : ""}
                            </span>
                          </span>
                          {editable && (
                            <button
                              className="shrink-0 rounded border border-zinc-600 px-2 py-0.5 text-xs disabled:opacity-50"
                              disabled={busy}
                              onClick={() => void unlink(video.videoId)}
                              aria-label={t("decisions.arms.removeAria", { video: known?.title ?? video.videoId })}
                            >
                              {t("decisions.arms.remove")}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}

          {editable ? (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-zinc-400">
                {t("decisions.arms.videoField")}
                <input
                  className="rounded border border-zinc-700 bg-zinc-800 p-1.5 text-sm text-zinc-100"
                  list={`arm-videos-${experimentId}`}
                  placeholder={t("decisions.arms.videoPlaceholder")}
                  value={videoInput}
                  onChange={(e) => setVideoInput(e.target.value)}
                />
                <datalist id={`arm-videos-${experimentId}`}>
                  {options.map((video) => (
                    <option key={video.videoId} value={`${video.title} · ${video.videoId}`} />
                  ))}
                </datalist>
              </label>
              <label className="flex w-32 flex-col gap-1 text-xs text-zinc-400">
                {t("decisions.arms.armField")}
                <input
                  className="rounded border border-zinc-700 bg-zinc-800 p-1.5 text-sm text-zinc-100"
                  list={`arm-labels-${experimentId}`}
                  placeholder={t("decisions.arms.armPlaceholder")}
                  maxLength={32}
                  value={armInput}
                  onChange={(e) => setArmInput(e.target.value)}
                />
                <datalist id={`arm-labels-${experimentId}`}>
                  {[...new Set([...SUGGESTED_ARMS, ...(arms ?? []).map((arm) => arm.arm)])].map((label) => (
                    <option key={label} value={label} />
                  ))}
                </datalist>
              </label>
              <button
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                disabled={busy || !pickedVideoId || !armInput.trim()}
                onClick={() => void link()}
              >
                {t("decisions.arms.add")}
              </button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-zinc-500">
              {!onActiveChannel ? t("decisions.arms.otherChannel") : t("decisions.arms.frozen")}
            </p>
          )}
        </>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
