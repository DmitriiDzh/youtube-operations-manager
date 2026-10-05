"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./confirm-dialog";

type VideoDetailModalProps = {
  title: string;
  thumbnailUrl?: string | null;
  onClose: () => void;
  /** True while the content inside `children` has edits the operator has not saved/submitted
   * yet. When true, an attempt to close (backdrop click, Escape, the close button) shows a
   * "discard unsaved changes?" confirmation instead of closing immediately (owner instruction,
   * Telegram 2026-09-21: "если в меню были сделаны какие-либо изменения, он никогда не должен
   * просто закрываться. Должен появляться поп ап окно с вопросом о желании сохранить
   * изменения"). Defaults to false so existing callers that don't track dirty state are
   * unaffected. */
  hasUnsavedChanges?: boolean;
  /** Overrides the card's max-width Tailwind class (default `max-w-5xl`). Languages' per-video
   * localization review uses a wider one (owner instruction, 2026-09-21) for its side-by-side
   * original/translation layout; Content's own popup is unaffected since it doesn't pass this. */
  widthClassName?: string;
  children: ReactNode;
};

/**
 * Shared, near-fullscreen popup shell for "you clicked a video row, here is everything about it" --
 * used by both Content (`VideoDetailsPanel`) and Languages (localization detail + inline AI
 * generation), and designed to be reused by any future tab that needs the same "open a video,
 * show tab-specific content" interaction (owner's own framing, Telegram 2026-09-21: "может
 * использоваться как в контенте, так и в языках и возможно будет нужна где-то ещё"). This
 * component owns only the popup shell (overlay, sizing, header, close affordances) -- what's
 * rendered inside is entirely up to the caller via `children`, since that content is exactly what
 * differs "в зависимости от того в какой категории мы сейчас находимся."
 */
export function VideoDetailModal({
  title,
  thumbnailUrl,
  onClose,
  hasUnsavedChanges = false,
  widthClassName = "max-w-5xl",
  children,
}: VideoDetailModalProps) {
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  // Tracks where the CURRENT mouse gesture started, so a text-selection drag that begins inside
  // the card and is released past its edge is never mistaken for a click on the backdrop (owner
  // instruction, 2026-09-21: dragging a text selection and releasing outside the popup must never
  // close it). A native `click` event fires on the element under the pointer at mouseup
  // regardless of where the mousedown/selection started, so `onClick` alone cannot tell the two
  // apart -- only requiring BOTH mousedown and mouseup to land on the backdrop itself can.
  const mouseDownOnBackdrop = useRef(false);

  function attemptClose() {
    if (hasUnsavedChanges) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") attemptClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUnsavedChanges]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => {
        mouseDownOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (mouseDownOnBackdrop.current && e.target === e.currentTarget) attemptClose();
        mouseDownOnBackdrop.current = false;
      }}
      role="presentation"
    >
      <div
        className={`relative flex h-[92vh] w-full ${widthClassName} flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            {thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbnailUrl} alt="" className="h-9 w-14 shrink-0 rounded object-cover" />
            )}
            <h2 className="truncate text-sm font-semibold text-zinc-100">{title}</h2>
          </div>
          <button
            onClick={attemptClose}
            className="shrink-0 rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close"
          >
            &#10005;
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>

        {showDiscardConfirm && (
          <ConfirmDialog
            title="Discard unsaved changes?"
            description="This video has edits that haven't been saved yet. Closing now will discard them."
            confirmLabel="Discard changes"
            confirmVariant="danger"
            onCancel={() => setShowDiscardConfirm(false)}
            onConfirm={() => {
              setShowDiscardConfirm(false);
              onClose();
            }}
          />
        )}
      </div>
    </div>
  );
}
