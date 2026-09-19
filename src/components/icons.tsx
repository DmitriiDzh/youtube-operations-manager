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

export function ManualIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M9 11.5V5a1.5 1.5 0 0 1 3 0v5.5M12 10.5V4a1.5 1.5 0 0 1 3 0v6.5M15 10.5V6a1.5 1.5 0 0 1 3 0v7c0 3.31-2.69 6-6 6h-1c-1.9 0-3.6-.83-4.75-2.15L4 14" />
      <path d="M6 11.5c-1.1 0-2 .9-2 2v.5" />
    </IconBase>
  );
}

export function RulesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M4 6h16M4 12h10M4 18h6" />
      <path d="M18 15l3 3-3 3" />
    </IconBase>
  );
}

export function SyncIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M4 12a8 8 0 0 1 14.5-4.5M20 12a8 8 0 0 1-14.5 4.5" />
      <path d="M18 3v4.5h-4.5M6 21v-4.5h4.5" />
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

export function AiLocalizationIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z" />
      <path d="M5 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7L5 17ZM19 15l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6.6-1.8Z" />
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
