// BL-140 R4 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.5/§6): Discover's candidate list filtered by status
// and paged on the server. Same shape of query as Research → Videos (videos-overview/paging.ts): `page` switches it on.

export const CANDIDATE_STATUSES = ["new", "watching", "ignored", "archived", "promoted"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export type CandidatesQuery = { status: CandidateStatus | null; page: number; limit: number };

export const CANDIDATES_PAGE_DEFAULT_LIMIT = 25;
export const CANDIDATES_PAGE_MAX_LIMIT = 100;

/** `null` when the request has no `page` parameter: the caller then returns the old, unpaged response. */
export function parseCandidatesQuery(params: URLSearchParams): CandidatesQuery | null {
  if (!params.has("page")) return null;
  const int = (name: string, fallback: number) => {
    const n = Number.parseInt(params.get(name) ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const status = params.get("status");
  return {
    status: (CANDIDATE_STATUSES as readonly string[]).includes(status ?? "") ? (status as CandidateStatus) : null,
    page: int("page", 1),
    limit: Math.min(CANDIDATES_PAGE_MAX_LIMIT, int("limit", CANDIDATES_PAGE_DEFAULT_LIMIT)),
  };
}

/** Keeps the service's order (newest `lastSeenAt` first). `counts` is per status over every candidate, for the filter. */
export function pageCandidates<T extends { status: CandidateStatus }>(candidates: T[], query: CandidatesQuery) {
  const counts = Object.fromEntries(CANDIDATE_STATUSES.map((s) => [s, 0])) as Record<CandidateStatus, number>;
  for (const candidate of candidates) counts[candidate.status] += 1;
  const matching = query.status ? candidates.filter((c) => c.status === query.status) : candidates;
  const start = (query.page - 1) * query.limit;
  return { candidates: matching.slice(start, start + query.limit), total: matching.length, page: query.page, limit: query.limit, counts };
}
