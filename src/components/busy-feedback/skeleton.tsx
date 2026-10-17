"use client";

import { useT } from "../ui-text-provider";

// BL-195 stage E (UI_FEEDBACK_CLARITY_PLAN.md §3): grey placeholders where a big list's rows will be, instead of a "Loading…"
// line -- the screen does not jump when the rows arrive, and it is plain what is being loaded. Screen readers hear "Loading…".

const bar = "animate-pulse rounded bg-zinc-800/80 motion-reduce:animate-none";
const WIDTHS = ["w-11/12", "w-3/4", "w-5/6", "w-2/3", "w-4/5", "w-3/5"];

/** Placeholder rows inside a table's `<tbody>`. */
export function SkeletonTableRows({ rows, columns }: { rows: number; columns: number }) {
  const t = useT();
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} className="border-b border-zinc-800/60" aria-hidden={r > 0 || undefined}>
          {Array.from({ length: columns }, (_, c) => (
            <td key={c} className="px-3 py-3">
              {r === 0 && c === 0 ? <span className="sr-only" role="status">{t("common.loading")}</span> : null}
              <span className={`block h-3.5 ${bar} ${c === 0 ? WIDTHS[r % WIDTHS.length] : "w-2/3"}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Placeholder lines for a list or card. */
export function SkeletonLines({ lines, className = "" }: { lines: number; className?: string }) {
  const t = useT();
  return (
    <div role="status" aria-label={t("common.loading")} className={`space-y-3 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} aria-hidden className={`block h-4 ${bar} ${WIDTHS[i % WIDTHS.length]}`} />
      ))}
    </div>
  );
}
