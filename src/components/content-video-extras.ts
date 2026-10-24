"use client";

import { useEffect, useState } from "react";
import type { VideoInsightsResult, VideoKind } from "@/lib/video-insights";

// BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage A): what the «Видео» list shows beyond the synced video itself -- its kind and
// last 7 days (insights), its number Vn (video projects), its visual cost (video costs) and its languages (localization overview).
// Four independent local reads: each one that fails leaves its columns at "—" and never touches the list (AGENTS.md §M).

export type { VideoKind };

export type VideoLanguages = { present: number; total: number; missing: string[] };

export type VideoExtras = {
  kind: VideoKind | null;
  views7d: number | null;
  impressions7d: number | null;
  ctr7d: number | null;
  vn: string | null;
  costUsd: number | null;
  costEstimated: boolean;
  languages: VideoLanguages | null;
};

export const NO_EXTRAS: VideoExtras = { kind: null, views7d: null, impressions7d: null, ctr7d: null, vn: null, costUsd: null, costEstimated: false, languages: null };

type ProjectsView = { videos: Array<{ video: string; youtubeVideoId?: string | null }> };
type CostsView = { videos: Array<{ video: string; totals: { totalUsd: number; runs: number; estimated: boolean } }> };
type OverviewView = { videos: Array<{ videoId: string; presentLanguages: string[]; missingLanguages: string[] }> };

export type ExtrasSources = {
  insights: VideoInsightsResult | null;
  projects: ProjectsView | null;
  costs: CostsView | null;
  overview: OverviewView | null;
};

/** One map from video id to everything the four reads know about it (pure). */
export function combineExtras(sources: ExtrasSources): Map<string, VideoExtras> {
  const out = new Map<string, VideoExtras>();
  const entry = (videoId: string) => {
    let e = out.get(videoId);
    if (!e) {
      e = { ...NO_EXTRAS };
      out.set(videoId, e);
    }
    return e;
  };
  for (const [videoId, insight] of Object.entries(sources.insights?.videos ?? {})) {
    Object.assign(entry(videoId), { kind: insight.kind, views7d: insight.views7d, impressions7d: insight.impressions7d, ctr7d: insight.ctr7d });
  }
  const costByVn = new Map((sources.costs?.videos ?? []).map((c) => [c.video, c.totals]));
  for (const project of sources.projects?.videos ?? []) {
    if (!project.youtubeVideoId) continue;
    const e = entry(project.youtubeVideoId);
    if (e.vn) continue; // two numbers naming one video: the higher one (the list comes highest first)
    e.vn = project.video;
    const cost = costByVn.get(project.video);
    if (cost && cost.runs > 0) {
      e.costUsd = cost.totalUsd;
      e.costEstimated = cost.estimated;
    }
  }
  for (const row of sources.overview?.videos ?? []) {
    entry(row.videoId).languages = { present: row.presentLanguages.length, total: row.presentLanguages.length + row.missingLanguages.length, missing: row.missingLanguages };
  }
  return out;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Loads the four sources for the channel (again whenever `reloadKey` changes, e.g. after a sync). */
export function useVideoExtras(channelId: string, reloadKey: number) {
  const [sources, setSources] = useState<ExtrasSources>({ insights: null, projects: null, costs: null, overview: null });
  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    const base = `/api/channels/${encodeURIComponent(channelId)}`;
    void Promise.all([
      getJson<VideoInsightsResult>(`${base}/videos/insights`),
      getJson<ProjectsView>(`${base}/video-projects`),
      getJson<CostsView>(`${base}/video-costs`),
      getJson<OverviewView>(`${base}/localizations`),
    ]).then(([insights, projects, costs, overview]) => {
      if (!cancelled) setSources({ insights, projects, costs, overview });
    });
    return () => {
      cancelled = true;
    };
  }, [channelId, reloadKey]);
  return sources;
}
