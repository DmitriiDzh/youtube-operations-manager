"use client";

import { useT } from "./ui-text-provider";

// BL-259 (owner msg 4397): a small mark of the video's frame -- a tall rectangle for a vertical video (Shorts), a wide one for a
// horizontal one -- on «Ролики и релизы», «План недели» and the calendar. Nothing when the frame is not known.

export type Orientation = "vertical" | "horizontal";

export function OrientationIcon({ orientation, className = "" }: { orientation: Orientation | null | undefined; className?: string }) {
  const t = useT();
  if (!orientation) return null;
  const label = t(orientation === "vertical" ? "orientation.vertical" : "orientation.horizontal");
  const vertical = orientation === "vertical";
  return (
    <span role="img" aria-label={label} title={label} className={`inline-flex shrink-0 items-center align-middle ${vertical ? "text-pink-300" : "text-sky-300"} ${className}`}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {vertical ? <rect x="4.5" y="1.5" width="7" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /> : <rect x="1.5" y="4.5" width="13" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      </svg>
    </span>
  );
}
