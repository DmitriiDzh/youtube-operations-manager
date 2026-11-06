"use client";

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { attachmentRefusalOf, CLIP_ATTACHMENT_ACCEPT, CLIP_ATTACHMENT_LIMITS, pastedFileNeedsName, pastedNameOf } from "@/lib/clip-reviews/attachments";
import type { UiTextKey } from "@/lib/ui-text";
import { attachmentSrcOf, attachmentsReady, isImageMime, percentOf, pieceOffsetsOf, type ClipAttachmentDto, type ComposerItemState } from "./clip-reviews-model";
import { useT, useUiText } from "./ui-text-provider";

// BL-246 (CLIP_REVIEWS_PLAN.md items 10, 13, 16; ADR 0065; owner msgs 4076/4078/4079): files on the owner's answer to a clip.
// Three ways in, all visible from the comment box: paste a picture (Cmd/Ctrl+V in the comment), drop files on the box, or the
// «Прикрепить файл» button. Each file becomes a chip at once -- a thumbnail for a picture -- with its upload progress or its error and
// × to remove it; the answer waits until every chip is uploaded. Files go in 4 MiB pieces (every /api body passes the proxy, which
// keeps only its first 40 MB) to this computer's app data; the decision then writes them into the channel folder.

type Item = {
  key: string;
  file: File;
  name: string;
  previewUrl: string | null;
  state: ComposerItemState;
  sent: number;
  uploadId: string | null;
  error: string | null;
};

const REFUSAL_KEYS: Record<string, UiTextKey> = {
  type_not_allowed: "clipReviews.attach.error.type_not_allowed",
  type_mismatch: "clipReviews.attach.error.type_mismatch",
  too_large: "clipReviews.attach.error.too_large",
  empty: "clipReviews.attach.error.empty",
  clip_attachment_type_not_allowed: "clipReviews.attach.error.type_not_allowed",
  clip_attachment_type_mismatch: "clipReviews.attach.error.type_mismatch",
  clip_attachment_too_large: "clipReviews.attach.error.too_large",
  clip_attachment_upload_corrupt: "clipReviews.attach.error.corrupt",
  clip_review_not_pending: "clipReviews.error.not_pending",
};

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The composer's state for one clip's answer: the chips, adding (paste / drop / pick), removing, and what the decision sends. */
export function useAttachmentComposer(base: string | null, clipId: string | null) {
  const t = useT();
  const [items, setItems] = useState<Item[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const counter = useRef({ key: 0, pasted: 0 });
  const removed = useRef(new Set<string>());
  // The list as the handlers last left it (read by the next handler before React re-renders); changed only through `commit`.
  const itemsRef = useRef<Item[]>([]);
  const commit = useCallback((change: (list: Item[]) => Item[]) => {
    itemsRef.current = change(itemsRef.current);
    setItems(itemsRef.current);
  }, []);

  const patch = useCallback((key: string, change: Partial<Item>) => commit((list) => list.map((item) => (item.key === key ? { ...item, ...change } : item))), [commit]);

  const discardOnServer = useCallback(
    (uploadId: string | null) => {
      if (!base || !clipId || !uploadId) return;
      void fetch(`${base}/${encodeURIComponent(clipId)}/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" }).catch(() => undefined);
    },
    [base, clipId]
  );

  const upload = useCallback(
    async (item: Item) => {
      if (!base || !clipId) return;
      const failed = async (res: Response | null, fallback?: string) => {
        const body = res ? ((await res.json().catch(() => ({}))) as { error?: string; message?: string }) : {};
        const key = body.error ? REFUSAL_KEYS[body.error] : undefined;
        patch(item.key, { state: "failed", error: key ? t(key) : t("clipReviews.attach.error.generic", { message: body.message ?? body.error ?? fallback ?? String(res?.status ?? "network") }) });
      };
      try {
        const sha256 = await sha256Hex(item.file);
        const res = await fetch(`${base}/${encodeURIComponent(clipId)}/uploads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: item.name, type: item.file.type, size: item.file.size, sha256 }),
        });
        if (!res.ok) return void (await failed(res));
        const { uploadId, name } = (await res.json()) as { uploadId: string; name: string };
        if (removed.current.has(item.key)) return discardOnServer(uploadId);
        // The chip shows the name the file will have in the channel folder (review).
        patch(item.key, { uploadId, name });
        let complete = false;
        for (const offset of pieceOffsetsOf(item.file.size, CLIP_ATTACHMENT_LIMITS.pieceBytes)) {
          const piece = item.file.slice(offset, offset + CLIP_ATTACHMENT_LIMITS.pieceBytes);
          const sent = await fetch(`${base}/${encodeURIComponent(clipId)}/uploads/${encodeURIComponent(uploadId)}?offset=${offset}`, { method: "PUT", body: piece });
          if (removed.current.has(item.key)) return discardOnServer(uploadId);
          if (!sent.ok) return void (await failed(sent));
          complete = ((await sent.json().catch(() => ({}))) as { complete?: boolean }).complete === true;
          patch(item.key, { sent: offset + piece.size });
        }
        // Ready only when the server itself says the whole file arrived and passed its checks (review).
        if (!complete) return patch(item.key, { state: "failed", error: t("clipReviews.attach.error.incomplete") });
        patch(item.key, { state: "ready", sent: item.file.size });
      } catch {
        await failed(null);
      }
    },
    [base, clipId, discardOnServer, patch, t]
  );

  const add = useCallback(
    (files: readonly File[], how: "pasted" | "picked") => {
      const room = CLIP_ATTACHMENT_LIMITS.files - itemsRef.current.length;
      const taken = files.slice(0, Math.max(0, room));
      setNotice(files.length > taken.length ? t("clipReviews.attach.tooMany", { max: CLIP_ATTACHMENT_LIMITS.files, count: files.length - taken.length }) : null);
      const fresh: Item[] = taken.map((original) => {
        // A screenshot from the clipboard has no name of its own (or a generic "image.png"): pasted-<n>.<ext>. A file copied in
        // Finder / Explorer keeps its real name (review).
        const rename = how === "pasted" && pastedFileNeedsName(original.name);
        const name = rename ? pastedNameOf(++counter.current.pasted, original.type) : original.name;
        const file = rename ? new File([original], name, { type: original.type }) : original;
        const refusal = attachmentRefusalOf({ name, type: file.type, size: file.size });
        const picture = !refusal && isImageMime(file.type);
        return {
          key: `a${++counter.current.key}`,
          file,
          name,
          previewUrl: picture ? URL.createObjectURL(file) : null,
          state: refusal ? "failed" : "uploading",
          sent: 0,
          uploadId: null,
          error: refusal ? t(REFUSAL_KEYS[refusal]) : null,
        };
      });
      if (fresh.length === 0) return;
      commit((list) => [...list, ...fresh]);
      // One file after another: the owner sees each finish, and the server is never asked for ten at once.
      void fresh.filter((item) => item.state === "uploading").reduce((chain, item) => chain.then(() => upload(item)), Promise.resolve());
    },
    [commit, t, upload]
  );

  const remove = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((one) => one.key === key);
      if (!item) return;
      removed.current.add(key);
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      discardOnServer(item.uploadId);
      commit((list) => list.filter((one) => one.key !== key));
      setNotice(null);
    },
    [commit, discardOnServer]
  );

  /** Empties the composer; `discard` also drops the staged files (cancel), not after a sent decision (the server used them). */
  const clear = useCallback(
    (discard: boolean) => {
      for (const item of itemsRef.current) {
        removed.current.add(item.key);
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        if (discard) discardOnServer(item.uploadId);
      }
      commit(() => []);
      setNotice(null);
    },
    [commit, discardOnServer]
  );

  // Leaving the screen drops what was staged and frees the thumbnails.
  useEffect(() => () => clear(true), [clear]);

  return {
    items,
    notice,
    add,
    remove,
    clear,
    ready: attachmentsReady(items),
    hasFailed: items.some((item) => item.state === "failed"),
    uploadIds: items.flatMap((item) => (item.uploadId && item.state === "ready" ? [item.uploadId] : [])),
  };
}

export type AttachmentComposer = ReturnType<typeof useAttachmentComposer>;

/**
 * The comment box with its attachments: `children` is the comment's textarea (it receives the paste handler through `onPaste`);
 * the whole box is the drop target, outlined while files are dragged over it.
 */
export function AttachmentDropZone({ composer, disabled, children }: { composer: AttachmentComposer; disabled: boolean; children: (onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void) => ReactNode }) {
  const t = useT();
  const { formatNumber } = useUiText();
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0 || disabled) return;
    // Files taken from the paste never also put the clipboard's text (Finder's file name) into the comment (review).
    event.preventDefault();
    composer.add(files, "pasted");
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (disabled || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    composer.add(Array.from(event.dataTransfer.files), "picked");
  };

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      className={`relative space-y-2 rounded-md border border-dashed p-2 transition-colors ${dragging ? "border-sky-400 bg-sky-950/30" : "border-zinc-700"}`}
    >
      {children(onPaste)}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-sky-950/70 text-sm font-medium text-sky-200">{t("clipReviews.attach.dropHere")}</div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled || composer.items.length >= CLIP_ATTACHMENT_LIMITS.files}
          onClick={() => input.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-600 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-40"
        >
          <span aria-hidden>+</span>
          {t("clipReviews.attach.button")}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={CLIP_ATTACHMENT_ACCEPT}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            composer.add(Array.from(event.target.files ?? []), "picked");
            event.target.value = "";
          }}
        />
        <span className="text-xs text-zinc-500">{t("clipReviews.attach.hint", { max: CLIP_ATTACHMENT_LIMITS.files, mebibytes: CLIP_ATTACHMENT_LIMITS.bytes / 1_048_576 })}</span>
      </div>
      {composer.notice && (
        <p role="status" className="text-xs text-amber-300">
          {composer.notice}
        </p>
      )}
      {composer.items.length > 0 && (
        <ul aria-label={t("clipReviews.attach.listLabel")} className="flex flex-wrap gap-2">
          {composer.items.map((item) => (
            <li
              key={item.key}
              className={`flex max-w-[16rem] items-center gap-2 rounded-md border px-2 py-1 text-xs ${item.state === "failed" ? "border-red-800 bg-red-950/40" : "border-zinc-700 bg-zinc-900"}`}
            >
              {item.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local object URL of the owner's own file
                <img src={item.previewUrl} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
              ) : (
                <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-zinc-800 font-mono text-[10px] uppercase text-zinc-400">
                  {item.name.split(".").pop()}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-zinc-200" title={item.name}>
                  {item.name}
                </span>
                {item.state === "uploading" && (
                  <span className="mt-0.5 block" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentOf(item.sent, item.file.size)} aria-label={t("clipReviews.attach.uploading", { percent: percentOf(item.sent, item.file.size) })}>
                    <span className="block h-1 overflow-hidden rounded bg-zinc-800">
                      <span className="block h-1 bg-sky-500 transition-[width]" style={{ width: `${percentOf(item.sent, item.file.size)}%` }} />
                    </span>
                    <span className="text-[10px] text-zinc-500">{t("clipReviews.attach.uploading", { percent: percentOf(item.sent, item.file.size) })}</span>
                  </span>
                )}
                {item.state === "ready" && <span className="block text-[10px] text-zinc-500">{t("clipReviews.attach.size", { mebibytes: formatNumber(item.file.size / 1_048_576, { maximumFractionDigits: 1 }) })}</span>}
                {item.state === "failed" && <span className="block text-[10px] text-red-300">{item.error}</span>}
              </span>
              <button
                type="button"
                onClick={() => composer.remove(item.key)}
                disabled={disabled}
                aria-label={t("clipReviews.attach.remove", { name: item.name })}
                title={t("clipReviews.attach.remove", { name: item.name })}
                className="shrink-0 rounded px-1 text-base leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-40"
              >
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The files on an answered clip: pictures as thumbnails that open full size, other files as links; a file not here says so. */
export function DecisionAttachments({ base, clipId, decisionId, attachments }: { base: string; clipId: string; decisionId: string; attachments: readonly ClipAttachmentDto[] }) {
  const t = useT();
  const { formatNumber } = useUiText();
  const [broken, setBroken] = useState<Set<number>>(new Set());
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-zinc-500">{t("clipReviews.history.attachments")}</p>
      <ul className="flex flex-wrap gap-2">
        {attachments.map((attachment) => {
          const src = attachmentSrcOf(base, clipId, decisionId, attachment.index);
          const size = t("clipReviews.attach.size", { mebibytes: formatNumber(attachment.size / 1_048_576, { maximumFractionDigits: 1 }) });
          if (attachment.file !== "ok" || broken.has(attachment.index)) {
            const key: UiTextKey = attachment.file === "missing" ? "clipReviews.history.missing" : attachment.file === "changed" ? "clipReviews.history.changed" : "clipReviews.history.unavailable";
            return (
              <li key={attachment.index} className="rounded-md border border-orange-900 bg-orange-950/40 px-2 py-1 text-xs text-orange-200">
                {t(key, { name: attachment.name })}
              </li>
            );
          }
          if (isImageMime(attachment.mime)) {
            return (
              <li key={attachment.index}>
                <a href={src} target="_blank" rel="noopener noreferrer" title={t("clipReviews.history.openFull", { name: attachment.name })} className="block rounded-md ring-1 ring-zinc-700 hover:ring-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local file served by the owner's loopback route */}
                  <img
                    src={src}
                    alt={attachment.name}
                    loading="lazy"
                    onError={() => setBroken((set) => new Set(set).add(attachment.index))}
                    className="h-24 max-w-[12rem] rounded-md object-contain"
                  />
                </a>
              </li>
            );
          }
          return (
            <li key={attachment.index}>
              <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-xs text-sky-300 hover:bg-zinc-800 hover:text-sky-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                <span className="max-w-[14rem] truncate">{attachment.name}</span>
                <span className="text-zinc-500">{size}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
