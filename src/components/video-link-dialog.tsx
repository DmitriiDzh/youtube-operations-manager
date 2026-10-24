"use client";

import { useEffect, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { errorText } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { formatDuration } from "./content-manager";
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";

// BL-221 «Привязать к видео» (CONTENT_UX_PLAN.md stage B; owner msgs 3448/3449/3451): for a number uploaded outside the app, the
// owner picks which synced video of the channel it became. Offered by the folder's date (published or scheduled that day), then
// every other unlinked video by the nearest date -- never matched by title. Confirming writes the folder's `Vn_youtube.json`
// (a local file; nothing goes to YouTube).

type Candidate = {
  videoId: string;
  title: string;
  publishedAt: string;
  publishAt: string | null;
  privacyStatus: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
};
type Suggestions = { video: { video: string; folder: string | null }; suggested: Candidate[]; others: Candidate[] };

export function VideoLinkDialog({ channelId, video, onCancel, onLinked }: { channelId: string; video: string; onCancel: () => void; onLinked: (videoId: string) => void }) {
  const { t } = useUiText();
  const [data, setData] = useState<Suggestions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [busy, setBusy] = useState(false);
  const url = `/api/channels/${encodeURIComponent(channelId)}/video-projects/${encodeURIComponent(video)}/link`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(url);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(errorText(t, body, t("pipeline.linkLoadFailed")));
        const result = body as Suggestions;
        setData(result);
        if (result.suggested.length === 1) setChosen(result.suggested[0].videoId);
        if (result.suggested.length === 0) setShowOthers(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : t("pipeline.linkLoadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, t]);

  async function link() {
    if (!chosen) return;
    setBusy(true);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ videoId: chosen }) });
      const body = await res.json();
      if (!res.ok) throw new Error(errorText(t, body, t("pipeline.linkFailed")));
      onLinked(chosen);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("pipeline.linkFailed"));
      setBusy(false);
    }
  }

  const row = (c: Candidate) => {
    const when = c.publishAt ?? c.publishedAt;
    return (
      <label key={c.videoId} className={`flex cursor-pointer items-center gap-3 rounded-md border p-2 ${chosen === c.videoId ? "border-sky-600 bg-sky-950/30" : "border-zinc-800 hover:bg-zinc-800/50"}`}>
        <input type="radio" name="link-video" checked={chosen === c.videoId} onChange={() => setChosen(c.videoId)} className="shrink-0" />
        {c.thumbnailUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.thumbnailUrl} alt="" className="h-9 w-16 shrink-0 rounded object-cover" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-100">{c.title}</span>
          <span className="block text-xs text-zinc-500">
            {[t(c.publishAt ? "pipeline.scheduled" : c.privacyStatus === "public" ? "pipeline.public" : c.privacyStatus === "unlisted" ? "pipeline.unlisted" : "pipeline.private"), formatDisplayDateTime(when), formatDuration(c.durationSeconds)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </label>
    );
  };

  return (
    <ConfirmDialog
      title={t("pipeline.linkTitle", { video })}
      description={t("pipeline.linkDescription", { video, folder: data?.video.folder ?? "—" })}
      confirmLabel={t("pipeline.linkConfirm")}
      confirmDisabled={!chosen || busy}
      confirmBusyLabel={busy ? t("pipeline.linking") : null}
      size="wide"
      onCancel={onCancel}
      onConfirm={() => void link()}
    >
      <div className="max-h-[55vh] space-y-2 overflow-y-auto">
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!data && !error && <LoadingIndicator className="text-sm text-zinc-400" />}
        {data && (
          <>
            <p className="text-xs font-medium text-zinc-300">{t("pipeline.linkSuggested")}</p>
            {data.suggested.length === 0 ? <p className="text-xs text-zinc-500">{t("pipeline.linkNoSuggestion")}</p> : data.suggested.map(row)}
            {data.others.length > 0 && (
              <button type="button" onClick={() => setShowOthers((x) => !x)} className="text-xs text-zinc-400 underline hover:text-zinc-200">
                {t(showOthers ? "pipeline.linkHideOthers" : "pipeline.linkShowOthers", { count: data.others.length })}
              </button>
            )}
            {showOthers && data.others.map(row)}
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
