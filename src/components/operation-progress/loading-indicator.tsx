/**
 * The one "data is loading" indicator for read operations (ADR 0015, stage 5): a spinner plus text, so a
 * screen that is still fetching visibly differs from one that has nothing to show. Replaces the bare
 * `<p>Loading...</p>` lines that each screen used to render on its own. Long writes and syncs use the
 * blocking `OperationOverlay` instead; this is only for the non-blocking, read-only case.
 */
export function LoadingIndicator({
  label = "Loading…",
  className = "text-sm text-zinc-400",
}: {
  label?: string;
  /** Text color/size classes of the line (kept from the paragraph this replaces). */
  className?: string;
}) {
  return (
    <p role="status" aria-live="polite" className={`flex items-center gap-2 ${className}`}>
      <span
        aria-hidden="true"
        className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-zinc-600 border-t-red-500 motion-reduce:animate-none"
      />
      {label}
    </p>
  );
}
