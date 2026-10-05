"use client";

import type { ReactNode } from "react";

/**
 * The shared "dim and blur everything behind, nothing else clickable" shell (extracted from
 * `operation-progress/operation-overlay.tsx` for BL-115 so the re-login prompt looks and stacks the same).
 * It only draws the backdrop and the card; what may close it, and how, is each user's business.
 */
export function BlockingDialog({
  label,
  busy,
  maxWidthClass = "max-w-lg",
  children,
}: {
  label: string;
  busy?: boolean;
  maxWidthClass?: string;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="presentation">
      <div
        className={`w-full ${maxWidthClass} space-y-3 rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl`}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}
