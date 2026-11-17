"use client";

import { useCallback, useEffect, useState } from "react";
import { pipelinePhase, type PipelineProject } from "./video-pipeline";
import { startVisibleInterval } from "./visible-interval";

// BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage E): what each Content tab is waiting for, shown on the tab itself -- local
// reads once a minute; a read that fails shows no badge (never a wrong one).

export type ContentTabBadges = {
  /** «Ролики и релизы»: numbers whose video is ready or whose package is ready -- the next step is someone's action. */
  releases: number;
  /** «Календарь»: fewer than the reminder's days are scheduled ahead. */
  calendarDue: boolean;
  /** «Трансляции»: on air and YouTube reports the stream as bad / without data / revoked. */
  streamTrouble: boolean;
  /** BL-225: «План недели» -- the future, not vetoed slots of the channel's plans that wait for the owner's approval. */
  weekPlan: number;
};

const NONE: ContentTabBadges = { releases: 0, calendarDue: false, streamTrouble: false, weekPlan: 0 };
const TROUBLE = new Set(["bad", "noData", "revoked"]);

/** Pure: the badges from the reads (each null when it failed; BL-225 added the plans). */
export function contentTabBadges(input: {
  projects: { videos: Array<PipelineProject> } | null;
  calendar: { lastSyncedAt: string | null; coverage: { due: boolean } } | null;
  live: { stream: { intent: string } | null; youtube: { lifeCycleStatus: string | null; healthStatus: string | null } | null } | null;
  plans?: { waiting: number } | null;
}): ContentTabBadges {
  const releases = (input.projects?.videos ?? []).filter((v) => {
    const phase = pipelinePhase(v, null);
    return phase === "edit" || phase === "package";
  }).length;
  const calendarDue = Boolean(input.calendar?.lastSyncedAt) && input.calendar?.coverage.due === true;
  const yt = input.live?.youtube ?? null;
  const streamTrouble = input.live?.stream?.intent === "on" && yt?.lifeCycleStatus === "live" && TROUBLE.has(yt.healthStatus ?? "");
  const weekPlan = Math.max(0, input.plans?.waiting ?? 0);
  return { releases, calendarDue, streamTrouble, weekPlan };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** BL-266 review: the channel's video-projects list as the badges read it, shared with «План» (one read, not two). */
export type ContentProjectsList = { videos: Array<PipelineProject & { video: string; conflict?: unknown }>; workspace?: "ok" | "not_configured" | "unavailable" };

type Reads = {
  channelId: string | null;
  projects: ContentProjectsList | null;
  calendar: { lastSyncedAt: string | null; coverage: { due: boolean } } | null;
  live: { stream: { intent: string } | null; youtube: { lifeCycleStatus: string | null; healthStatus: string | null } | null } | null;
  plans: { waiting: number } | null;
  /** The last list that was read successfully (a failed read leaves «Без слота» as it was; the badge itself shows none). */
  lastProjects: ContentProjectsList | null;
};

/**
 * The badges, the video-projects list they come from (BL-266 review: «План»'s «Без слота» uses the same list instead of a second
 * read every minute), and `acceptProjects` -- a list read elsewhere (the open videos board) replaces the shared one at once.
 */
export function useContentTabBadges(channelId: string | null): ContentTabBadges & { projects: ContentProjectsList | null; acceptProjects: (list: ContentProjectsList) => void } {
  const [reads, setReads] = useState<Reads>({ channelId: null, projects: null, calendar: null, live: null, plans: null, lastProjects: null });
  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    const base = `/api/channels/${encodeURIComponent(channelId)}`;
    const read = () => {
      // A hidden browser tab reads nothing (review): the badges catch up when it is shown again.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void Promise.all([
        getJson<ContentProjectsList>(`${base}/video-projects`),
        getJson<{ lastSyncedAt: string | null; coverage: { due: boolean } }>(`${base}/publishing/calendar`),
        getJson<{ stream: { intent: string } | null; youtube: { lifeCycleStatus: string | null; healthStatus: string | null } | null }>(`${base}/live-stream`),
        getJson<{ waiting: number }>(`${base}/publishing-plans`),
      ]).then(([projects, calendar, live, plans]) => {
        if (!cancelled) setReads((current) => ({ channelId, projects, calendar, live, plans, lastProjects: projects ?? (current.channelId === channelId ? current.lastProjects : null) }));
      });
    };
    read();
    // BL-270: no read while the tab is hidden; one at once when it is shown again.
    const stopPolling = startVisibleInterval(read, 60_000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [channelId]);
  const acceptProjects = useCallback(
    (list: ContentProjectsList) => setReads((current) => (current.channelId === channelId ? { ...current, projects: list, lastProjects: list } : { channelId, projects: list, calendar: null, live: null, plans: null, lastProjects: list })),
    [channelId]
  );
  const mine = channelId && reads.channelId === channelId ? reads : null;
  const badges = mine ? contentTabBadges(mine) : NONE;
  return { ...badges, projects: mine?.lastProjects ?? null, acceptProjects };
}
