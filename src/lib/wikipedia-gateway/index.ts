// ---------------------------------------------------------------------------
// Phase 13 slice 13.8 (docs/roadmap/plans/PHASE_13_PLAN.md) -- the single funnel for every call to
// the Wikimedia Pageviews API (https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/),
// the same single-gateway-per-API-category rule the YouTube gateways follow (AGENTS.md §G): its own
// "reads enabled" toggle and traffic counter, checked here, and an inventory test forbids any other
// file from calling a wikimedia.org URL. Free, no key; Wikimedia asks for a descriptive User-Agent.
// Data: CC0, not YouTube API data (no 30-day limit applies).
// ---------------------------------------------------------------------------

import { DomainError } from "@/lib/shared-domain";
import { getWikipediaReadsEnabled, recordGatewayCallOutcome } from "@/lib/db";

// Descriptive, but deliberately without a personal contact or repository link: this is a local app
// on the owner's own machine, and the request is low-volume (a few articles, once a day).
export const WIKIMEDIA_USER_AGENT = "YouTubeOperationsManager/1.0 (local single-user desktop app; daily topic page views)";

export async function assertWikipediaReadsAuthorized(): Promise<void> {
  if (await getWikipediaReadsEnabled()) {
    await recordGatewayCallOutcome("wikipedia_reads", "allowed");
    return;
  }
  await recordGatewayCallOutcome("wikipedia_reads", "blocked");
  throw new DomainError({
    code: "wikipedia_reads_disabled",
    message: 'Wikipedia reads are disabled -- the Settings tab\'s "Wikipedia reads" toggle is off.',
  });
}

const compact = (isoDate: string) => isoDate.replace(/-/g, "");

/**
 * Daily user page views of one article, inclusive date range (YYYY-MM-DD, UTC days). A 404 from the
 * API means "no data for this range" (e.g. a brand-new article) and returns an empty list.
 */
export async function getDailyArticlePageviews(
  args: { project: string; article: string; startDate: string; endDate: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ date: string; views: number }[]> {
  await assertWikipediaReadsAuthorized();
  const url =
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/" +
    `${encodeURIComponent(args.project)}/all-access/user/${encodeURIComponent(args.article)}/daily/` +
    `${compact(args.startDate)}00/${compact(args.endDate)}00`;
  const response = await fetchImpl(url, {
    headers: { "User-Agent": WIKIMEDIA_USER_AGENT, "Api-User-Agent": WIKIMEDIA_USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new DomainError({ code: "wikipedia_unavailable", message: `Wikimedia Pageviews API returned HTTP ${response.status}.` });
  }
  const body = (await response.json()) as { items?: Array<{ timestamp?: string; views?: number }> };
  return (body.items ?? []).flatMap((item) => {
    const ts = item.timestamp ?? "";
    if (!/^\d{10}$/.test(ts) || typeof item.views !== "number") return [];
    return [{ date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`, views: item.views }];
  });
}
