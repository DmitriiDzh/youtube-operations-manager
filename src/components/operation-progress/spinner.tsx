"use client";

import { useT } from "../ui-text-provider";

/** Small inline spinner; `motion-reduce` users get a static ring instead of the rotation. */
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  const t = useT();
  return (
    <span
      role="status"
      aria-label={t("common.loading")}
      className={`inline-block animate-spin rounded-full border-2 border-zinc-600 border-t-red-500 motion-reduce:animate-none ${className}`}
    />
  );
}
