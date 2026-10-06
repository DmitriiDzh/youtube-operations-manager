// BL-140 R2 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.4/§6): server-side paging, sorting and filtering of the
// Research → Videos table, so the browser never receives every observed video at once (it was 4,590 rows, 261,667 px).
// Phase 13 boundary (YouTube API Developer Policies III.E.4.f/h): a paged row carries only observed values with their
// observation time. Sorting by an observed value is allowed; no velocity, ratio or rank may be added here.

export type PageableVideo = {
  videoId: string;
  channelId: string;
  channelHandleOrUrl: string | null;
  title: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  observedAt: string;
  topics: { topicId: string; name: string }[];
};

export type VideosQuery = {
  page: number;
  limit: number;
  sort: "published" | "views";
  channelId: string | null;
  topicId: string | null;
  publishedAfter: string | null;
  publishedBefore: string | null;
  q: string | null;
};

export const VIDEOS_PAGE_DEFAULT_LIMIT = 50;
export const VIDEOS_PAGE_MAX_LIMIT = 100;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `null` when the request has no `page` parameter: the caller then returns the old, unpaged response (AC-R2-4). */
export function parseVideosQuery(params: URLSearchParams): VideosQuery | null {
  if (!params.has("page")) return null;
  const int = (name: string, fallback: number) => {
    const n = Number.parseInt(params.get(name) ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const text = (name: string) => {
    const value = params.get(name)?.trim();
    return value ? value : null;
  };
  const day = (name: string) => {
    const value = text(name);
    return value && DAY_RE.test(value) ? value : null;
  };
  return {
    page: int("page", 1),
    limit: Math.min(VIDEOS_PAGE_MAX_LIMIT, int("limit", VIDEOS_PAGE_DEFAULT_LIMIT)),
    sort: params.get("sort") === "views" ? "views" : "published",
    channelId: text("channelId"),
    topicId: text("topicId"),
    publishedAfter: day("publishedAfter"),
    publishedBefore: day("publishedBefore"),
    q: text("q"),
  };
}

/** `videos` must already be in the service's order (newest published first, nulls last); `published` keeps it. */
export function pageMarketVideos(videos: PageableVideo[], query: VideosQuery) {
  const channels = new Map<string, string>();
  const topics = new Map<string, string>();
  for (const video of videos) {
    channels.set(video.channelId, video.channelHandleOrUrl ?? video.channelId);
    for (const t of video.topics) topics.set(t.topicId, t.name);
  }

  const needle = query.q?.toLowerCase() ?? null;
  const after = query.publishedAfter ? Date.parse(`${query.publishedAfter}T00:00:00.000Z`) : null;
  const before = query.publishedBefore ? Date.parse(`${query.publishedBefore}T23:59:59.999Z`) : null;
  const matching = videos.filter((video) => {
    if (query.channelId && video.channelId !== query.channelId) return false;
    if (query.topicId && !video.topics.some((t) => t.topicId === query.topicId)) return false;
    if (after !== null || before !== null) {
      if (!video.publishedAt) return false;
      const at = Date.parse(video.publishedAt);
      if (after !== null && at < after) return false;
      if (before !== null && at > before) return false;
    }
    if (needle && !(video.title ?? "").toLowerCase().includes(needle)) return false;
    return true;
  });

  const ordered =
    query.sort === "views"
      ? matching
          .map((video, index) => ({ video, index }))
          .sort((a, b) => {
            const va = a.video.viewCount;
            const vb = b.video.viewCount;
            if (va === null && vb === null) return a.index - b.index;
            if (va === null) return 1;
            if (vb === null) return -1;
            return vb - va || a.index - b.index;
          })
          .map((entry) => entry.video)
      : matching;

  const start = (query.page - 1) * query.limit;
  return {
    rows: ordered.slice(start, start + query.limit).map((video) => ({
      videoId: video.videoId,
      channelId: video.channelId,
      channelHandleOrUrl: video.channelHandleOrUrl,
      title: video.title,
      publishedAt: video.publishedAt,
      viewCount: video.viewCount,
      observedAt: video.observedAt,
      topics: video.topics,
    })),
    total: matching.length,
    page: query.page,
    limit: query.limit,
    channels: [...channels.entries()].map(([channelId, label]) => ({ channelId, label })).sort((a, b) => a.label.localeCompare(b.label)),
    topics: [...topics.entries()].map(([topicId, name]) => ({ topicId, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
