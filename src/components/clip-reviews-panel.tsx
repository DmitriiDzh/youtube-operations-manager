"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UiTextKey } from "@/lib/ui-text";
import { ActionButton, SkeletonLines } from "./busy-feedback";
import { canApprove, rangeOf, returnCommentReady, videoSrcOf, type ClipDto, type ClipStatus } from "./clip-reviews-model";
import { useT, useUiText } from "./ui-text-provider";
import { useUserTimezone } from "./use-user-timezone";

// BL-241 (CLIP_REVIEWS_PLAN.md item 5, ADR 0061; owner msgs 4010/4011): Контент → «Клипы». The questions the owner brings, in order:
// does anything wait for me (the line on top and the waiting rows first), what is this clip about (scene and the Producer's note on
// one compact row), and what does it look like (the row opens an inline player on this computer's copy, at the Producer's range).
// He answers in the row: «Одобрить» (a comment optional) or «Вернуть» (a comment required), each confirmed in the row itself --
// never a browser dialog. Answered clips stay below, folded into the same compact rows.

const STATUS_STYLES: Record<ClipStatus, string> = {
  pending: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  approved: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  returned: "bg-red-500/15 text-red-300 ring-red-500/30",
  withdrawn: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
};
const STATUS_KEYS: Record<ClipStatus, UiTextKey> = {
  pending: "clipReviews.status.pending",
  approved: "clipReviews.status.approved",
  returned: "clipReviews.status.returned",
  withdrawn: "clipReviews.status.withdrawn",
};
const DECIDED_KEYS: Record<Exclude<ClipStatus, "pending">, UiTextKey> = {
  approved: "clipReviews.decided.approved",
  returned: "clipReviews.decided.returned",
  withdrawn: "clipReviews.decided.withdrawn",
};
const ERROR_KEYS: Record<string, UiTextKey> = {
  clip_review_not_pending: "clipReviews.error.not_pending",
  clip_review_file_missing: "clipReviews.error.file_missing",
  clip_review_file_changed: "clipReviews.error.file_changed",
};

type Confirm = { clipId: string; action: "approve" | "return" } | null;

export function ClipReviewsPanel({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const t = useT();
  const { language, formatNumber } = useUiText();
  const ownerZone = useUserTimezone();
  const [clips, setClips] = useState<ClipDto[] | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ clipId: string; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/clip-reviews` : null;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const res = await fetch(base);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { clips: ClipDto[]; waiting: number };
      setClips(body.clips);
      setWaiting(body.waiting);
      setError(null);
    } catch {
      setError(t("clipReviews.loadFailed"));
    }
  }, [base, t]);

  // While visible: now, then every minute (the Producer's clips and the other computer's answers arrive by sync).
  useEffect(() => {
    if (!visible) return;
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [visible, load]);

  const at = useCallback(
    (iso: string) => {
      try {
        return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short", ...(ownerZone ? { timeZone: ownerZone } : {}) }).format(new Date(iso));
      } catch {
        return iso;
      }
    },
    [language, ownerZone]
  );

  function ask(clipId: string, action: "approve" | "return") {
    setConfirm({ clipId, action });
    setComment("");
    setActionError(null);
  }

  async function decide(clip: ClipDto, action: "approve" | "return") {
    if (!base) return;
    setBusy(clip.clipId);
    setActionError(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(clip.clipId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, comment: comment.trim() || null }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        const key = body.error ? ERROR_KEYS[body.error] : undefined;
        setActionError({ clipId: clip.clipId, text: key ? t(key) : t("clipReviews.error.generic", { message: body.message ?? body.error ?? String(res.status) }) });
        await load();
        return;
      }
      setConfirm(null);
      setComment("");
      await load();
    } catch {
      setActionError({ clipId: clip.clipId, text: t("clipReviews.error.generic", { message: "network" }) });
    } finally {
      setBusy(null);
    }
  }

  if (!channelId) return null;

  const pending = (clips ?? []).filter((c) => c.status === "pending");
  const answered = (clips ?? []).filter((c) => c.status !== "pending");

  const renderRow = (clip: ClipDto) => {
    const expanded = open === clip.clipId;
    const range = rangeOf(clip);
    const confirming = confirm?.clipId === clip.clipId ? confirm.action : null;
    const rowBusy = busy === clip.clipId;
    return (
      <li key={clip.clipId} className={`rounded-lg border ${clip.status === "pending" ? "border-zinc-700 bg-zinc-900" : "border-zinc-800 bg-zinc-950/60"}`}>
        <button
          type="button"
          onClick={() => setOpen(expanded ? null : clip.clipId)}
          aria-expanded={expanded}
          title={t(expanded ? "clipReviews.collapse" : "clipReviews.expand")}
          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-800/40"
        >
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${STATUS_STYLES[clip.status]}`}>{t(STATUS_KEYS[clip.status])}</span>
          <span className="shrink-0 font-medium text-zinc-100">{clip.sceneId}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-zinc-400">{clip.note}</span>
          {clip.file !== "ok" && (
            <span className="shrink-0 rounded-full bg-orange-500/15 px-2 py-0.5 text-[11px] text-orange-300 ring-1 ring-orange-500/30">
              {t(clip.file === "missing" ? "clipReviews.file.missing" : "clipReviews.file.changed")}
            </span>
          )}
          <span className="shrink-0 text-xs tabular-nums text-zinc-500">{t("clipReviews.duration", { seconds: formatNumber(Math.round(clip.durationSeconds)) })}</span>
          <span className="hidden shrink-0 text-xs text-zinc-500 sm:inline">{at(clip.submittedAt)}</span>
          <span aria-hidden className="shrink-0 text-zinc-500">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
        {expanded && (
          <div className="space-y-3 border-t border-zinc-800 px-3 py-3">
            {clip.file === "missing" ? (
              <p className="rounded-md border border-orange-900 bg-orange-950/40 px-3 py-2 text-sm text-orange-200">{t("clipReviews.file.missingHelp")}</p>
            ) : (
              <ClipPlayer src={videoSrcOf(base!, clip)} startSec={clip.startSec} replayLabel={range ? t("clipReviews.replayRange") : null} />
            )}
            {clip.file === "changed" && <p className="rounded-md border border-orange-900 bg-orange-950/40 px-3 py-2 text-sm text-orange-200">{t("clipReviews.file.changedHelp")}</p>}
            <p className="whitespace-pre-wrap text-sm text-zinc-200">{clip.note}</p>
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
              {range && <dd>{t("clipReviews.range", range)}</dd>}
              <dd>{clip.device ? t("clipReviews.submittedOn", { when: at(clip.submittedAt), device: clip.device }) : t("clipReviews.submitted", { when: at(clip.submittedAt) })}</dd>
              <dd>{t("clipReviews.size", { megabytes: formatNumber(clip.sizeBytes / 1_048_576, { maximumFractionDigits: 1 }) })}</dd>
              <dd className="font-mono" title={t("clipReviews.path")}>
                {clip.clipPath}
              </dd>
            </dl>
            {clip.status !== "pending" && clip.decidedAt && (
              <div className="rounded-md bg-zinc-900 px-3 py-2 text-sm">
                <p className="text-zinc-300">
                  {t(DECIDED_KEYS[clip.status], { when: at(clip.decidedAt) })}
                  {clip.decidedOn ? ` ${t("clipReviews.decidedOn", { device: clip.decidedOn })}` : ""}
                </p>
                {clip.comment && (
                  <p className="mt-1 whitespace-pre-wrap text-zinc-400">
                    <span className="text-zinc-500">{t("clipReviews.yourComment")}: </span>
                    {clip.comment}
                  </p>
                )}
              </div>
            )}
            {clip.status === "pending" && !confirming && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canApprove(clip) || busy !== null}
                  onClick={() => ask(clip.clipId, "approve")}
                  className="rounded-md bg-violet-600 px-3 py-1 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
                  title={canApprove(clip) ? undefined : t("clipReviews.approveBlocked")}
                >
                  {t("clipReviews.action.approve")}
                </button>
                <button type="button" disabled={busy !== null} onClick={() => ask(clip.clipId, "return")} className="rounded-md border border-zinc-600 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
                  {t("clipReviews.action.return")}
                </button>
                {!canApprove(clip) && <span className="text-xs text-zinc-500">{t("clipReviews.approveBlocked")}</span>}
              </div>
            )}
            {clip.status === "pending" && confirming && (
              <div className={`space-y-2 rounded-md border px-3 py-2 ${confirming === "approve" ? "border-violet-800 bg-violet-950/30" : "border-red-900 bg-red-950/30"}`}>
                <p className="text-sm font-medium text-zinc-100">{t(confirming === "approve" ? "clipReviews.confirm.approveTitle" : "clipReviews.confirm.returnTitle")}</p>
                <textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  maxLength={2000}
                  rows={confirming === "return" ? 3 : 2}
                  aria-label={t(confirming === "approve" ? "clipReviews.confirm.approveComment" : "clipReviews.confirm.returnTitle")}
                  placeholder={t(confirming === "approve" ? "clipReviews.confirm.approveComment" : "clipReviews.confirm.returnPlaceholder")}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 placeholder:text-zinc-600"
                />
                <div className="flex items-center gap-2">
                  <ActionButton
                    busy={rowBusy}
                    busyLabel={t("clipReviews.action.saving")}
                    disabled={busy !== null || (confirming === "return" && !returnCommentReady(comment))}
                    onClick={() => void decide(clip, confirming)}
                    className={`rounded-md px-3 py-1 text-sm font-semibold text-white disabled:opacity-40 ${confirming === "approve" ? "bg-violet-600 hover:bg-violet-500" : "bg-red-700 hover:bg-red-600"}`}
                  >
                    {t(confirming === "approve" ? "clipReviews.confirm.approveYes" : "clipReviews.confirm.returnYes")}
                  </ActionButton>
                  <button type="button" disabled={rowBusy} onClick={() => setConfirm(null)} className="rounded-md px-3 py-1 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-40">
                    {t("clipReviews.action.cancel")}
                  </button>
                </div>
              </div>
            )}
            {actionError?.clipId === clip.clipId && <p className="text-sm text-red-400">{actionError.text}</p>}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold text-zinc-100">{t("clipReviews.title")}</h2>
          <p className="max-w-3xl text-sm text-zinc-400">{t("clipReviews.help")}</p>
        </div>
        <button type="button" onClick={() => void load()} className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800">
          {t("clipReviews.refresh")}
        </button>
      </header>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!clips && !error && <SkeletonLines lines={3} />}
      {clips && clips.length === 0 && <p className="text-sm text-zinc-500">{t("clipReviews.empty")}</p>}
      {clips && clips.length > 0 && (
        <>
          <p className={`text-sm font-medium ${waiting > 0 ? "text-amber-300" : "text-zinc-400"}`}>{waiting > 0 ? t("clipReviews.waiting", { count: waiting }) : t("clipReviews.noneWaiting")}</p>
          {pending.length > 0 && <ul className="space-y-2">{pending.map(renderRow)}</ul>}
          {answered.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("clipReviews.decidedHeading")}</h3>
              <ul className="space-y-1.5">{answered.map(renderRow)}</ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The inline player: this computer's copy with HTTP Range; the fragment starts and stops it at the Producer's range. */
function ClipPlayer({ src, startSec, replayLabel }: { src: string; startSec: number | null; replayLabel: string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const replay = () => {
    const video = ref.current;
    if (!video) return;
    // Re-applying the same address with its fragment restarts the range (the end of a fragment pauses the browser there).
    video.src = src;
    video.currentTime = startSec ?? 0;
    void video.play().catch(() => undefined);
  };
  return (
    <div className="space-y-1.5">
      <video ref={ref} src={src} controls preload="metadata" playsInline className="aspect-video w-full max-w-3xl rounded-md bg-black" />
      {replayLabel && (
        <button type="button" onClick={replay} className="text-xs text-sky-400 hover:text-sky-300">
          {replayLabel}
        </button>
      )}
    </div>
  );
}
