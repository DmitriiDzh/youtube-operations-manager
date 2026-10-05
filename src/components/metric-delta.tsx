// Shared "+N% more/less than previous period" indicator (docs/roadmap/plans/STUDIO_PARITY_PLAN.md
// §4) -- one implementation, used by both the Analytics "Overview" cards and Home's "Channel
// analytics" summary card, rather than each rolling its own copy (AGENTS.md §M: shared logic
// needed by more than one place gets its own single owner).
//
// This is a computed fact (a period-over-period percentage from real collected numbers), not an
// interpretation or recommendation -- see `docs/roadmap/FUTURE_PHASES.md` §4's "distinguish
// observed facts from interpretations/hypotheses" constraint, which governs Phase 10's future
// AI-generated analysis, not arithmetic on numbers already fetched. Real YouTube Studio itself
// shows the identical kind of figure (e.g. "931% more than previous 28 days", live-verified
// 2026-09-23) -- confirmed with the project owner before building this (Telegram, 2026-09-23).
export function MetricDelta({
  percent,
  periodLabel,
  previousStatus = "full",
}: {
  percent: number | null;
  periodLabel: string;
  /** BL-120: whether the comparison period existed at all (`predates_channel` = nothing to compare with, `partial` = only part of it did). */
  previousStatus?: "full" | "partial" | "predates_channel";
}) {
  if (previousStatus === "predates_channel") {
    return <span className="text-xs text-zinc-500">The channel did not exist in the previous period</span>;
  }
  if (percent === null) {
    return <span className="text-xs text-zinc-500">No previous-period data to compare against</span>;
  }

  const isFlat = percent === 0;
  const isUp = percent > 0;
  const colorClass = isFlat ? "text-zinc-400" : isUp ? "text-green-400" : "text-red-400";
  const arrow = isFlat ? "→" : isUp ? "↑" : "↓";

  return (
    <span className="flex flex-col">
      <span className={`inline-flex items-center gap-1 text-xs font-medium ${colorClass}`}>
        <span aria-hidden="true">{arrow}</span>
        {Math.abs(percent)}% {isUp ? "more" : isFlat ? "than" : "less"} than {periodLabel}
      </span>
      {previousStatus === "partial" && <span className="text-[11px] text-zinc-500">the channel existed for only part of that period</span>}
    </span>
  );
}
