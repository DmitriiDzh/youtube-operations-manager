// Minimal inline line-icon set for the sidebar nav (YouTube Studio-style: 24px, 1.5px stroke,
// no fill). Hand-rolled rather than a new icon-library dependency -- only 8 icons are needed,
// and this keeps the redesign self-contained with no new package (AGENTS.md "prefer existing
// capabilities over unnecessary custom infrastructure").
import type { SVGProps } from "react";

function IconBase({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-5 w-5 ${className ?? ""}`.trim()}
      {...props}
    />
  );
}

// Matches real YouTube Studio's "Content" sidebar glyph (a stacked video-library icon) rather
// than the refresh-arrows glyph this tab used under its former name "Sync" --
// docs/roadmap/plans/STUDIO_PARITY_PLAN.md Slice S2, "maximally close to real Studio" per the
// owner's explicit visual-fidelity decision.
export function ContentIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <rect x="3" y="5" width="18" height="4" rx="1" />
      <rect x="3" y="11" width="18" height="4" rx="1" />
      <rect x="3" y="17" width="10" height="4" rx="1" />
    </IconBase>
  );
}

// Matches real Studio's "Home" sidebar glyph -- docs/roadmap/plans/STUDIO_PARITY_PLAN.md Slice
// S4/S6-stub.
export function HomeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9h12v-9" />
    </IconBase>
  );
}

// Matches real Studio's "Analytics" sidebar glyph (a bar chart) -- Slice S6-stub.
export function AnalyticsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M4 20V10M10 20V4M16 20v-7M20 20H4" />
    </IconBase>
  );
}

export function LocalizationsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" />
    </IconBase>
  );
}

export function BatchesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" />
      <path d="M3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5" />
    </IconBase>
  );
}

export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.35a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.65 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.65a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.65a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.35 9a1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
    </IconBase>
  );
}

export function DeviceIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </IconBase>
  );
}

// Phase 9 slice 2 (docs/roadmap/plans/PHASE_9_PLAN.md) -- a magnifying glass, for the
// market-research watchlist tab.
export function ResearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20 20-4.6-4.6" />
    </IconBase>
  );
}
