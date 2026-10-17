"use client";

import { useEffect, useState } from "react";
import type { StoryboardVersion } from "@/lib/sync-gateway";
import type { RenderState, RenderView, StoryboardDetail } from "@/lib/storyboards";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { errorText } from "@/lib/ui-text";
import { BusyOverlay, StatusNotice, useBusyAction } from "./busy-feedback";
import { ConfirmDialog } from "./confirm-dialog";
import { MediaVideoPlayer } from "./media-video-player";
import { rendersOfVersion } from "./storyboard-model";
import { useT } from "./ui-text-provider";

// BL-189 (FO-REQ-0025 B, §3 step 3): the Operator's final files of the version shown -- the loop it assembled from one take per
// segment -- each played from this computer's copy of the channel folder (or located when the copy has not arrived yet), with the
// takes it uses, its notes and the owner's verdict: «Одобрить ролик» / «Запросить изменения».

type FileStatus = "ok" | "missing" | "differs";

const STATE_LABEL = {
  in_review: "storyboards.render.state.inReview",
  approved: "storyboards.render.state.approved",
  changes_requested: "storyboards.render.state.changesRequested",
} as const satisfies Record<RenderState, string>;

const STATE_TONE: Record<RenderState, string> = {
  in_review: "bg-amber-900/60 text-amber-100",
  approved: "bg-emerald-900/60 text-emerald-100",
  changes_requested: "bg-rose-900/60 text-rose-100",
};

export function StoryboardRenders({ channelId, storyboard, version, onDecided }: { channelId: string; storyboard: StoryboardDetail; version: StoryboardVersion; onDecided: () => void }) {
  const t = useT();
  const renders = rendersOfVersion(storyboard.renders, version);
  if (renders.length === 0) return <p className="rounded-lg border border-zinc-800 p-3 text-xs text-zinc-500">{t("storyboards.render.none")}</p>;
  return (
    <div className="space-y-3">
      {renders.map((render) => (
        <RenderCard key={render.renderId} channelId={channelId} storyboardId={storyboard.storyboardId} render={render} onDecided={onDecided} />
      ))}
    </div>
  );
}

function RenderCard({ channelId, storyboardId, render, onDecided }: { channelId: string; storyboardId: string; render: RenderView; onDecided: () => void }) {
  const t = useT();
  const base = `/api/channels/${encodeURIComponent(channelId)}/storyboards/${encodeURIComponent(storyboardId)}/renders/${encodeURIComponent(render.renderId)}`;
  const [status, setStatus] = useState<FileStatus | null>(null);
  const [dialog, setDialog] = useState<"approve" | "changes" | null>(null);
  const [note, setNote] = useState("");
  // BL-195 (UI_FEEDBACK_CLARITY_PLAN.md stage B): the verdict on the render runs behind the blocking window.
  const busyAction = useBusyAction();
  const busy = busyAction.busy;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(base)
      .then((response) => (response.ok ? (response.json() as Promise<{ status: FileStatus }>) : null))
      .then((data) => {
        if (!cancelled) setStatus(data?.status ?? "missing");
      })
      .catch(() => {
        if (!cancelled) setStatus("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [base, render.sha256]);

  async function decide(kind: "approved" | "changes_requested", text: string | null) {
    await busyAction.run(t("storyboards.busy.renderDecision"), async () => {
      try {
        const response = await fetch(`${base}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, note: text }) });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(errorText(t, body, t("storyboards.actionFailed"), { showErrorField: false }));
        setError(null);
        setNote("");
        onDecided();
      } catch (err) {
        setError(err instanceof Error ? err.message : t("storyboards.actionFailed"));
      }
    });
  }

  const device = render.device ?? t("storyboards.video.anotherComputer");
  const picks = Object.entries(render.picks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segmentId, take]) => `${segmentId}: ${take.jobId.slice(0, 8)}`)
    .join(" · ");
  const lastNote = [...render.decisions].reverse().find((d) => d.note)?.note ?? null;

  return (
    <article className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full px-2.5 py-0.5 font-medium ${STATE_TONE[render.state]}`}>{t(STATE_LABEL[render.state])}</span>
        <span className="text-zinc-400">{t("storyboards.render.meta", { when: formatDisplayDateTime(render.createdAt), device })}</span>
        {/* ui-text-ignore: the file's path in the channel folder (data) */}
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-500" title={render.file}>
          {render.file}
        </span>
      </div>
      {status === "ok" || status === "differs" ? (
        <>
          {status === "differs" ? <p className="text-xs text-amber-200">{t("storyboards.render.differs")}</p> : null}
          <MediaVideoPlayer src={`${base}/file`} markers={[]} fps={null} className="h-[46vh]" />
        </>
      ) : status === "missing" ? (
        <p className="flex h-24 items-center justify-center rounded bg-zinc-900 px-3 text-center text-xs text-sky-200">{t("storyboards.render.missing", { device })}</p>
      ) : (
        <p className="text-xs text-zinc-400">{t("common.loading")}</p>
      )}
      {picks ? <p className="font-mono text-[11px] text-zinc-400">{t("storyboards.render.picks", { list: picks })}</p> : null}
      {/* ui-text-ignore: the Operator's notes (data) */}
      {render.notes ? <p className="whitespace-pre-wrap text-xs text-zinc-300">{render.notes}</p> : null}
      {lastNote ? <p className="text-xs text-zinc-400">{t("storyboards.render.decisionNote", { note: lastNote })}</p> : null}
      <StatusNotice notice={error ? { tone: "error", text: error } : null} onClose={() => setError(null)} />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || render.state === "approved"} onClick={() => setDialog("approve")} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40">
          {t("storyboards.render.approve")}
        </button>
        <button type="button" disabled={busy} onClick={() => setDialog("changes")} className="rounded-md bg-zinc-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-600 disabled:opacity-40">
          {t("storyboards.render.requestChanges")}
        </button>
      </div>
      {dialog === "approve" ? (
        <ConfirmDialog
          title={t("storyboards.render.approveTitle")}
          description={t("storyboards.render.approveText")}
          confirmLabel={t("storyboards.render.approve")}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void decide("approved", null);
          }}
        />
      ) : null}
      {dialog === "changes" ? (
        <ConfirmDialog
          title={t("storyboards.render.changesTitle")}
          description={t("storyboards.render.changesText")}
          confirmLabel={t("storyboards.render.requestChanges")}
          confirmVariant="danger"
          confirmDisabled={!note.trim()}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void decide("changes_requested", note.trim());
          }}
        >
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={t("storyboards.render.notePlaceholder")}
            aria-label={t("storyboards.render.notePlaceholder")}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
          />
        </ConfirmDialog>
      ) : null}
      <BusyOverlay state={busyAction.overlay} />
    </article>
  );
}
