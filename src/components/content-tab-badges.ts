"use client";

import { useEffect, useState } from "react";
import { pipelinePhase, type PipelineProject } from "./video-pipeline";

// BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage E): what each Content tab is waiting for, shown on the tab itself -- local
// reads once a minute; a read that fails shows no badge (never a wrong one).

export type ContentTabBadges = {
  /** «Ролики и релизы»: numbers whose video is ready or whose package is ready -- the next step is someone's action. */
  releases: number;
  /** «Календарь»: fewer than the reminder's days are scheduled ahead. */
  calendarDue: boolean;
  /** «Трансляции»: on air and YouTube reports the stream as bad / without data / revoked. */
  streamTrouble: boolean;
};

const NONE: ContentTabBadges = { releases: 0, calendarDue: false, streamTrouble: false };
const TROUBLE = new Set(["bad", "noData", "revoked"]);

/** Pure: the badges from the three reads (each null when it failed). */
export function contentTabBadges(input: {
  projects: { videos: Array<PipelineProject> } | null;
  calendar: { lastSyncedAt: string | null; coverage: { due: boolean } } | null;
  live: { stream: { intent: string } | null; youtube: { lifeCycleStatus: string | null; healthStatus: string | null } | null } | null;
}): ContentTabBadges {
  const releases = (input.projects?.videos ?? []).filter((v) => {
    const phase = pipelinePhase(v, null);
    return phase === "edit" || phase === "package";
  }).length;
  const calendarDue = Boolean(input.calendar?.lastSyncedAt) && input.calendar?.coverage.due === true;
  const yt = input.live?.youtube ?? null;
  const streamTrouble = input.live?.stream?.intent === "on" && yt?.lifeCycleStatus === "live" && TROUBLE.has(yt.healthStatus ?? "");
  return { releases, calendarDue, streamTrouble };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function useContentTabBadges(channelId: string | null): ContentTabBadges {
  const [badges, setBadges] = useState<ContentTabBadges & { channelId: string | null }>({ ...NONE, channelId: null });
  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    const base = `/api/channels/${encodeURIComponent(channelId)}`;
    const read = () => {
      // A hidden browser tab reads nothing (review): the badges catch up when it is shown again.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void Promise.all([
        getJson<{ videos: PipelineProject[] }>(`${base}/video-projects`),
        getJson<{ lastSyncedAt: string | null; coverage: { due: boolean } }>(`${base}/publishing/calendar`),
        getJson<{ stream: { intent: string } | null; youtube: { lifeCycleStatus: string | null; healthStatus: string | null } | null }>(`${base}/live-stream`),
      ]).then(([projects, calendar, live]) => {
        if (!cancelled) setBadges({ ...contentTabBadges({ projects, calendar, live }), channelId });
      });
    };
    read();
    const timer = setInterval(read, 60_000);
    document.addEventListener("visibilitychange", read);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [channelId]);
  return channelId && badges.channelId === channelId ? badges : NONE;
}
