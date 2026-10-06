"use client";

import { useEffect, type ReactNode } from "react";

/**
 * The shared side panel for "list + drawer" views (BL-140, docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.3/§4.6):
 * a row click opens the record's details on the right instead of expanding the row in place. Escape or a click on the
 * backdrop closes it. `z-50` keeps `ConfirmDialog` (`z-[60]`) and `BlockingDialog` (`z-[70]`) above it, so a confirm
 * opened from inside the drawer renders on top.
 */
export function SideDrawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" role="presentation" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col border-l border-zinc-800 bg-zinc-900 shadow-xl"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-zinc-100">{title}</div>
            {subtitle && <div className="mt-0.5 text-xs text-zinc-500">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

/** One titled section inside a SideDrawer. */
export function DrawerSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h4>
      {children}
    </section>
  );
}
