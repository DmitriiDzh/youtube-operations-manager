"use client";

import { useEffect, type ReactNode } from "react";

type VideoDetailModalProps = {
  title: string;
  thumbnailUrl?: string | null;
  onClose: () => void;
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
export function VideoDetailModal({ title, thumbnailUrl, onClose, children }: VideoDetailModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
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
            onClick={onClose}
            className="shrink-0 rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close"
          >
            &#10005;
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
