"use client";

type ConfirmDialogProps = {
  title: string;
  description?: string;
  cancelLabel?: string;
  confirmLabel: string;
  /** "danger" renders the confirm button red (destructive actions); "default" uses the app's
   * ordinary accent color. */
  confirmVariant?: "default" | "danger";
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * The one, shared in-app confirmation dialog (owner instruction, Telegram 2026-09-21: "любые
 * контекстные окна, поп апы, сообщения об ошибках и тд -- если мы эти элементы планировали сами,
 * значит они должны отрисовываться через наш UI в едином стиле всего инструментария"). Never use
 * `window.confirm`/`window.alert`/`window.prompt` for anything this app itself designed --
 * those are unstyled native browser dialogs, inconsistent with the rest of the UI, and (found the
 * hard way, 2026-09-21) they also block Chrome DevTools Protocol-driven browser automation used
 * for this project's own live verification.
 *
 * Fixed/viewport-covering so it works both standalone (e.g. languages-manager.tsx, directly on
 * the page) and nested inside another modal (e.g. VideoDetailModal's own discard-confirm) without
 * needing a variant prop for each case -- `position: fixed` is relative to the viewport either
 * way. `z-[60]` sits above `VideoDetailModal`'s own `z-50` backdrop.
 */
export function ConfirmDialog({
  title,
  description,
  cancelLabel = "Cancel",
  confirmLabel,
  confirmVariant = "default",
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="presentation">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl" role="alertdialog" aria-modal="true" aria-label={title}>
        <p className="text-sm font-medium text-zinc-100">{title}</p>
        {description && <p className="text-xs text-zinc-400">{description}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={
              confirmVariant === "danger"
                ? "rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                : "rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
