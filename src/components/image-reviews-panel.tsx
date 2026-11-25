"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UiTextKey } from "@/lib/ui-text";
import { ActionButton, SkeletonLines } from "./busy-feedback";
import { answerReady, batchesOf, canApprove, fullSrcOf, previewSrcOf, versionsOf, viewerKeyAction, type ImageAction, type ImageBatch, type ImageDto, type ImageStatus } from "./image-reviews-model";
import { useT, useUiText } from "./ui-text-provider";
import { useDialogFocus } from "./use-dialog-focus";
import { useUserTimezone } from "./use-user-timezone";

// BL-272 (ADR 0076; owner TG 2547 via the Producer): Медиа → «Кадры». The questions the owner brings, in order: does anything wait for
// me (the line on top, the waiting batches first), what does each still look like (one grid of large thumbnails per batch, any one
// opened full size -- ← / → or PageUp / PageDown through the batch, a 100 % view for details such as a passer-by where the arrows
// scroll and PageUp / PageDown switch), and his answer on each still:
// «Одобрить», «С заметкой» (approved; the note is required and is applied when the clip is made) or «Вернуть» (a comment required)
// -- each confirmed inside the card or the viewer, never in a browser dialog. Answered batches fold below.

const STATUS_STYLES: Record<ImageStatus, string> = {
  pending: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  approved: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  approved_with_note: "bg-teal-500/15 text-teal-200 ring-teal-500/30",
  returned: "bg-red-500/15 text-red-300 ring-red-500/30",
  withdrawn: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
};
const STATUS_KEYS: Record<ImageStatus, UiTextKey> = {
  pending: "imageReviews.status.pending",
  approved: "imageReviews.status.approved",
  approved_with_note: "imageReviews.status.approved_with_note",
  returned: "imageReviews.status.returned",
  withdrawn: "imageReviews.status.withdrawn",
};
const DECIDED_KEYS: Record<Exclude<ImageStatus, "pending">, UiTextKey> = {
  approved: "imageReviews.decided.approved",
  approved_with_note: "imageReviews.decided.approved_with_note",
  returned: "imageReviews.decided.returned",
  withdrawn: "imageReviews.decided.withdrawn",
};
const ERROR_KEYS: Record<string, UiTextKey> = {
  image_review_not_pending: "imageReviews.error.not_pending",
  image_review_file_missing: "imageReviews.error.file_missing",
  image_review_file_changed: "imageReviews.error.file_changed",
};
const CONFIRM: Record<ImageAction, { title: UiTextKey; yes: UiTextKey; placeholder: UiTextKey | null; tone: string; button: string }> = {
  approve: { title: "imageReviews.confirm.approveTitle", yes: "imageReviews.confirm.approveYes", placeholder: null, tone: "border-violet-800 bg-violet-950/40", button: "bg-violet-600 hover:bg-violet-500" },
  approve_with_note: { title: "imageReviews.confirm.noteTitle", yes: "imageReviews.confirm.noteYes", placeholder: "imageReviews.confirm.notePlaceholder", tone: "border-teal-800 bg-teal-950/40", button: "bg-teal-700 hover:bg-teal-600" },
  return: { title: "imageReviews.confirm.returnTitle", yes: "imageReviews.confirm.returnYes", placeholder: "imageReviews.confirm.returnPlaceholder", tone: "border-red-900 bg-red-950/40", button: "bg-red-700 hover:bg-red-600" },
};
// Which answered batches this browser keeps open (folded by default).
const OPEN_DONE_KEY = "ytm.imageReviews.openDone";

type Answer = { imageId: string; action: ImageAction } | null;

export function ImageReviewsPanel({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const t = useT();
  const { language, formatNumber } = useUiText();
  const ownerZone = useUserTimezone();
  const [images, setImages] = useState<ImageDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ imageId: string; text: string } | null>(null);
  const [answer, setAnswer] = useState<Answer>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // The full-size viewer: the batch it walks through and the image shown.
  const [viewer, setViewer] = useState<{ batchKey: string; imageId: string } | null>(null);
  const [openDone, setOpenDone] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(OPEN_DONE_KEY) ?? "[]") as unknown;
      if (Array.isArray(stored)) setOpenDone(new Set(stored.filter((v): v is string => typeof v === "string")));
    } catch {
      // storage unavailable: everything stays folded
    }
  }, []);
  const toggleDone = (key: string) =>
    setOpenDone((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(OPEN_DONE_KEY, JSON.stringify([...next]));
      } catch {
        // not remembered on this browser
      }
      return next;
    });

  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/image-reviews` : null;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const res = await fetch(base);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { images: ImageDto[] };
      setImages(body.images);
      setError(null);
    } catch {
      setError(t("imageReviews.loadFailed"));
    }
  }, [base, t]);

  // While visible: now, then every minute (the Producer's images and the other computer's answers arrive by sync).
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

  const batches = useMemo(() => batchesOf(images ?? []), [images]);
  const versions = useMemo(() => versionsOf(images ?? []), [images]);

  function ask(imageId: string, action: ImageAction) {
    setAnswer({ imageId, action });
    setComment("");
    setActionError(null);
  }

  async function decide(image: ImageDto, action: ImageAction) {
    if (!base) return;
    setBusy(image.imageId);
    setActionError(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(image.imageId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, comment: action === "approve" ? null : comment.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        const key = body.error ? ERROR_KEYS[body.error] : undefined;
        setActionError({ imageId: image.imageId, text: key ? t(key) : t("imageReviews.error.generic", { message: body.message ?? body.error ?? String(res.status) }) });
        await load();
        return;
      }
      setAnswer(null);
      setComment("");
      await load();
    } catch {
      setActionError({ imageId: image.imageId, text: t("imageReviews.error.generic", { message: "network" }) });
    } finally {
      setBusy(null);
    }
  }

  if (!channelId) return null;

  const waiting = (images ?? []).filter((image) => image.status === "pending").length;
  const waitingBatches = batches.filter((batch) => batch.waiting > 0);
  const doneBatches = batches.filter((batch) => batch.waiting === 0);
  const viewerBatch = viewer ? batches.find((batch) => batch.key === viewer.batchKey) : undefined;
  const viewerIndex = viewerBatch && viewer ? viewerBatch.images.findIndex((image) => image.imageId === viewer.imageId) : -1;

  /** The answer of one still: three buttons, then the chosen one's confirmation in place (with the required words). */
  const renderAnswer = (image: ImageDto, compact: boolean) => {
    if (image.status !== "pending") return null;
    const choosing = answer?.imageId === image.imageId ? answer.action : null;
    const rowBusy = busy === image.imageId;
    const approvable = canApprove(image);
    if (!choosing) {
      return (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!approvable || busy !== null} onClick={() => ask(image.imageId, "approve")} className="min-h-9 rounded-md bg-violet-600 px-3 py-1 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40">
              {t("imageReviews.action.approve")}
            </button>
            <button type="button" disabled={!approvable || busy !== null} onClick={() => ask(image.imageId, "approve_with_note")} className="min-h-9 rounded-md border border-teal-700 px-3 py-1 text-sm text-teal-200 hover:bg-teal-950/60 disabled:opacity-40">
              {t("imageReviews.action.approveWithNote")}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => ask(image.imageId, "return")} className="min-h-9 rounded-md border border-zinc-600 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
              {t("imageReviews.action.return")}
            </button>
          </div>
          {!approvable && !compact && <p className="text-xs text-zinc-500">{t("imageReviews.approveBlocked")}</p>}
        </div>
      );
    }
    const spec = CONFIRM[choosing];
    return (
      <div className={`space-y-2 rounded-md border px-3 py-2 ${spec.tone}`}>
        <p className="text-sm font-medium text-zinc-100">{t(spec.title)}</p>
        {spec.placeholder && (
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={2000}
            rows={2}
            autoFocus
            aria-label={t(spec.title)}
            placeholder={t(spec.placeholder)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-base text-zinc-100 placeholder:text-zinc-600 sm:text-sm"
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            busy={rowBusy}
            busyLabel={t("imageReviews.action.saving")}
            disabled={busy !== null || !answerReady(choosing, comment)}
            onClick={() => void decide(image, choosing)}
            className={`min-h-9 rounded-md px-3 py-1 text-sm font-semibold text-white disabled:opacity-40 ${spec.button}`}
          >
            {t(spec.yes)}
          </ActionButton>
          <button type="button" disabled={rowBusy} onClick={() => setAnswer(null)} className="min-h-9 rounded-md px-3 py-1 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-40">
            {t("imageReviews.action.cancel")}
          </button>
        </div>
      </div>
    );
  };

  /** What was decided, with the owner's words. */
  const renderDecided = (image: ImageDto) =>
    image.status !== "pending" && image.decidedAt ? (
      <div className="rounded-md bg-zinc-900 px-3 py-2 text-sm">
        <p className="text-zinc-300">
          {t(DECIDED_KEYS[image.status], { when: at(image.decidedAt) })}
          {image.decidedOn ? ` ${t("imageReviews.decidedOn", { device: image.decidedOn })}` : ""}
        </p>
        {image.comment && (
          <p className="mt-1 whitespace-pre-wrap break-words text-zinc-400">
            <span className="text-zinc-500">{t(image.status === "approved_with_note" ? "imageReviews.yourNote" : "imageReviews.yourComment")}: </span>
            {image.comment}
          </p>
        )}
      </div>
    ) : null;

  const statusPill = (image: ImageDto) => <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${STATUS_STYLES[image.status]}`}>{t(STATUS_KEYS[image.status])}</span>;
  // Only a checked copy (a pending image) has a badge; an answered one is not checked (`file: null`).
  const fileBadge = (image: ImageDto) =>
    image.file === "missing" || image.file === "changed" ? (
      <span className="shrink-0 rounded-full bg-orange-500/15 px-2 py-0.5 text-[11px] text-orange-300 ring-1 ring-orange-500/30">{t(image.file === "missing" ? "imageReviews.file.missing" : "imageReviews.file.changed")}</span>
    ) : null;
  const versionBadge = (image: ImageDto) => {
    const version = versions.get(image.imageId) ?? 1;
    return version > 1 ? <span className="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium tabular-nums text-sky-300 ring-1 ring-sky-500/30">{t("imageReviews.version", { version })}</span> : null;
  };

  const renderCard = (image: ImageDto, batch: ImageBatch) => (
    <li key={image.imageId} className={`flex min-w-0 flex-col overflow-hidden rounded-lg border ${image.status === "pending" ? "border-zinc-700 bg-zinc-900" : "border-zinc-800 bg-zinc-950/60"}`}>
      <button
        type="button"
        onClick={() => setViewer({ batchKey: batch.key, imageId: image.imageId })}
        aria-label={t("imageReviews.open", { scene: image.sceneId })}
        className="group relative block aspect-video w-full overflow-hidden bg-black"
      >
        {image.file === "missing" ? (
          <span className="flex h-full w-full items-center justify-center px-3 text-center text-xs text-zinc-500">{t("imageReviews.file.missing")}</span>
        ) : (
          <StillImage key={previewSrcOf(base!, image)} src={previewSrcOf(base!, image)} alt="" lazy className="h-full w-full object-cover transition group-hover:opacity-90" fallback={<span className="flex h-full w-full items-center justify-center px-3 text-center text-xs text-zinc-500">{t("imageReviews.noPreview")}</span>} />
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate font-medium text-zinc-100">{image.sceneId}</span>
          {versionBadge(image)}
          {statusPill(image)}
          {fileBadge(image)}
        </div>
        {image.note && <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-zinc-400">{image.note}</p>}
        {image.file === "changed" && image.status === "pending" && <p className="text-xs text-orange-200">{t("imageReviews.file.changedHelp")}</p>}
        {renderDecided(image)}
        <div className="mt-auto">{renderAnswer(image, false)}</div>
        {actionError?.imageId === image.imageId && <p className="text-sm text-red-400">{actionError.text}</p>}
      </div>
    </li>
  );

  const renderBatch = (batch: ImageBatch) => (
    <section key={batch.key} className="space-y-3">
      <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 break-all text-sm font-semibold text-zinc-200">{batch.batchId ? t("imageReviews.batch", { batchId: batch.batchId }) : t("imageReviews.batch.single")}</h3>
        <span className="text-xs text-zinc-500">
          {batch.waiting > 0 ? t("imageReviews.batch.counts", { waiting: formatNumber(batch.waiting), total: formatNumber(batch.images.length) }) : t("imageReviews.batch.done", { total: batch.images.length })} · {at(batch.latestAt)}
        </span>
      </header>
      {/* Owner TG 4887: as many columns of at least 28rem as the width takes (two on a laptop, three or four on a wide screen, one on a
          phone), so the stills grow with the screen instead of two fixed columns. */}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,28rem),1fr))] gap-3">{batch.images.map((image) => renderCard(image, batch))}</ul>
    </section>
  );

  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold text-zinc-100">{t("imageReviews.title")}</h2>
          <p className="max-w-3xl text-sm text-zinc-400">{t("imageReviews.help")}</p>
        </div>
        <button type="button" onClick={() => void load()} className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800">
          {t("imageReviews.refresh")}
        </button>
      </header>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!images && !error && <SkeletonLines lines={3} />}
      {images && images.length === 0 && <p className="text-sm text-zinc-500">{t("imageReviews.empty")}</p>}
      {images && images.length > 0 && (
        <>
          <p className={`text-sm font-medium ${waiting > 0 ? "text-amber-300" : "text-zinc-400"}`}>{waiting > 0 ? t("imageReviews.waiting", { count: waiting }) : t("imageReviews.noneWaiting")}</p>
          {waitingBatches.map(renderBatch)}
          {doneBatches.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("imageReviews.decidedHeading")}</h3>
              {doneBatches.map((batch) => {
                const open = openDone.has(batch.key);
                return (
                  <div key={batch.key} className="space-y-2">
                    <button
                      type="button"
                      onClick={() => toggleDone(batch.key)}
                      aria-expanded={open}
                      title={t(open ? "imageReviews.group.hide" : "imageReviews.group.show")}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-zinc-300 hover:bg-zinc-800/40"
                    >
                      <span aria-hidden className="text-zinc-500">
                        {open ? "▾" : "▸"}
                      </span>
                      <span className="min-w-0 truncate">{batch.batchId ? t("imageReviews.batch", { batchId: batch.batchId }) : t("imageReviews.batch.single")}</span>
                      <span className="shrink-0 text-xs text-zinc-500">{t("imageReviews.batch.done", { total: batch.images.length })}</span>
                    </button>
                    {open && renderBatch(batch)}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {viewer && viewerBatch && viewerIndex >= 0 && (
        <ImageViewer
          image={viewerBatch.images[viewerIndex]}
          src={fullSrcOf(base!, viewerBatch.images[viewerIndex])}
          index={viewerIndex}
          total={viewerBatch.images.length}
          onMove={(step) => {
            const next = viewerBatch.images[viewerIndex + step];
            if (next) {
              setViewer({ batchKey: viewerBatch.key, imageId: next.imageId });
              if (answer && answer.imageId !== next.imageId) setAnswer(null);
            }
          }}
          onClose={() => setViewer(null)}
          confirming={answer?.imageId === viewerBatch.images[viewerIndex].imageId}
          saving={busy !== null}
          onCancelConfirm={() => setAnswer(null)}
          header={
            <>
              <span className="min-w-0 truncate font-medium text-zinc-100">{viewerBatch.images[viewerIndex].sceneId}</span>
              {versionBadge(viewerBatch.images[viewerIndex])}
              {statusPill(viewerBatch.images[viewerIndex])}
              {fileBadge(viewerBatch.images[viewerIndex])}
            </>
          }
          footer={
            <div className="space-y-2">
              {viewerBatch.images[viewerIndex].note && <p className="whitespace-pre-wrap break-words text-sm text-zinc-300">{viewerBatch.images[viewerIndex].note}</p>}
              <p className="text-xs text-zinc-500">
                {t("imageReviews.size", { width: viewerBatch.images[viewerIndex].width, height: viewerBatch.images[viewerIndex].height, megabytes: formatNumber(viewerBatch.images[viewerIndex].sizeBytes / 1_048_576, { maximumFractionDigits: 1 }) })}
                {" · "}
                {viewerBatch.images[viewerIndex].device
                  ? t("imageReviews.submittedOn", { when: at(viewerBatch.images[viewerIndex].submittedAt), device: viewerBatch.images[viewerIndex].device! })
                  : t("imageReviews.submitted", { when: at(viewerBatch.images[viewerIndex].submittedAt) })}
                {" · "}
                <span className="break-all font-mono" title={t("imageReviews.path")}>
                  {viewerBatch.images[viewerIndex].imagePath}
                </span>
              </p>
              {renderDecided(viewerBatch.images[viewerIndex])}
              {renderAnswer(viewerBatch.images[viewerIndex], false)}
              {actionError?.imageId === viewerBatch.images[viewerIndex].imageId && <p className="text-sm text-red-400">{actionError.text}</p>}
            </div>
          }
        />
      )}
    </section>
  );
}

/**
 * The full-size layer over the whole window (not a browser dialog): the image fitted or at 100 % (scrolling). Keys
 * (`viewerKeyAction`): ← / → or PageUp / PageDown through the batch; at 100 % the arrows scroll the image and PageUp / PageDown
 * switch; Esc cancels an open confirmation (or the typing in it) first, otherwise closes. The focus stays inside while it is open
 * and goes back where it was.
 */
function ImageViewer({
  image,
  src,
  index,
  total,
  onMove,
  onClose,
  confirming,
  saving,
  onCancelConfirm,
  header,
  footer,
}: {
  image: ImageDto;
  src: string;
  index: number;
  total: number;
  onMove: (step: -1 | 1) => void;
  onClose: () => void;
  confirming: boolean;
  saving: boolean;
  onCancelConfirm: () => void;
  header: ReactNode;
  footer: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [actual, setActual] = useState(false);
  useDialogFocus(ref, { initial: "container" });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.tagName === "TEXTAREA" || event.target.tagName === "INPUT" || event.target.isContentEditable);
      const action = viewerKeyAction({ key: event.key, typing, confirming, saving, actual });
      if (!action) return;
      event.preventDefault();
      if (action.type === "cancel_confirm") onCancelConfirm();
      else if (action.type === "close") onClose();
      else if (action.type === "move") onMove(action.step);
      else scrollRef.current?.scrollBy({ left: action.dx, top: action.dy });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onMove, onCancelConfirm, confirming, saving, actual]);
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("imageReviews.viewer.label", { scene: image.sceneId })} className="fixed inset-0 z-50 flex flex-col bg-black outline-none">
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{header}</div>
        <span className="shrink-0 text-xs tabular-nums text-zinc-400">{t("imageReviews.viewer.position", { index: index + 1, total })}</span>
        <button type="button" onClick={() => setActual((v) => !v)} aria-pressed={actual} className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
          {t(actual ? "imageReviews.viewer.fit" : "imageReviews.viewer.actual")}
        </button>
        <button type="button" onClick={onClose} className="shrink-0 rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800">
          {t("imageReviews.viewer.close")}
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className={`h-full w-full ${actual ? "overflow-auto" : "flex items-center justify-center overflow-hidden p-2"}`}>
          {image.file === "missing" ? (
            <p className="p-6 text-center text-sm text-zinc-400">{t("imageReviews.file.missingHelp")}</p>
          ) : (
            <StillImage key={src} src={src} alt={image.sceneId} className={actual ? "max-w-none" : "max-h-full max-w-full object-contain"} fallback={<p className="p-6 text-center text-sm text-zinc-400">{t("imageReviews.file.missingHelp")}</p>} />
          )}
        </div>
        <button type="button" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t("imageReviews.viewer.previous")} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-zinc-900/80 px-3 py-2 text-lg text-zinc-100 hover:bg-zinc-800 disabled:hidden">
          ‹
        </button>
        <button type="button" disabled={index >= total - 1} onClick={() => onMove(1)} aria-label={t("imageReviews.viewer.next")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-zinc-900/80 px-3 py-2 text-lg text-zinc-100 hover:bg-zinc-800 disabled:hidden">
          ›
        </button>
      </div>
      <div className="max-h-[45vh] overflow-y-auto border-t border-zinc-800 bg-zinc-950 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {footer}
        <p className="mt-2 hidden text-[11px] text-zinc-500 sm:block">{t(actual ? "imageReviews.viewer.keysActual" : "imageReviews.viewer.keys")}</p>
      </div>
    </div>
  );
}

/**
 * A still from this computer's copy; when it cannot be loaded (an answered still is not checked, so its file may be gone here) the
 * fallback shows instead of a broken image.
 */
function StillImage({ src, alt, className, lazy, fallback }: { src: string; alt: string; className: string; lazy?: boolean; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  // eslint-disable-next-line @next/next/no-img-element -- a local file streamed by the route, not an optimisable asset
  return <img src={src} alt={alt} loading={lazy ? "lazy" : undefined} onError={() => setFailed(true)} className={className} />;
}
