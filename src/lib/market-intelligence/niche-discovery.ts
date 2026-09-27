// ---------------------------------------------------------------------------
// Phase 9 slice 9F (docs/roadmap/plans/PHASE_9_SLICE_9F_PLAN.md) -- niche discovery. Pure, no-I/O
// functions only, mirroring derived-metrics.ts/historical-intelligence.ts at their own zero-caller
// stage: this slice's precondition (9C-9E having accumulated real, meaningful data) cannot be
// satisfied on this branch before merge, so a real service/API/UI caller is a separate, later,
// unassigned slice. A "niche" is never a new stored entity -- it is a computed grouping over
// already-existing market_discovery_candidates/market_trend_candidates by their existing
// market_topic_assignments/topicId, never a fabricated new opinion.
// ---------------------------------------------------------------------------

export type NicheDiscoveryCandidate = { channelId: string; title: string };
export type NicheTrendCandidate = { trendCandidateId: string; title: string; hasEvidence: boolean };
export type NicheTopicAssignment = { topicId: string; subjectType: "channel" | "video"; subjectId: string };

export type NicheGroup = {
  topicId: string;
  discoveryCandidates: NicheDiscoveryCandidate[];
  trendCandidates: NicheTrendCandidate[];
};

// A niche needs at least this many independent members (across discovery + trend candidates
// combined) sharing a topic before it is reported at all -- never a single data point dressed up
// as a "niche concept" (owner spec §10's "do not assume one universal baseline formula" applied
// here: no minimum-group-size claim is invented without this same discipline, mirroring 9D's own
// BREAKOUT_MIN_BASELINE_SAMPLE_SIZE precedent).
export const NICHE_MIN_GROUP_SIZE = 2;

/**
 * Groups discovery candidates (via their channel's own `market_topic_assignments` rows) and trend
 * candidates (via their own direct `topicId` field) by shared topic. Only topics with
 * `NICHE_MIN_GROUP_SIZE` or more combined members are returned -- a topic with a single member is
 * not a "niche", it is one data point.
 */
export function groupCandidatesByTopic(
  discoveryCandidates: NicheDiscoveryCandidate[],
  channelTopicAssignments: NicheTopicAssignment[],
  trendCandidates: NicheTrendCandidate[],
  topicIdsByTrendCandidateId: Map<string, string>
): NicheGroup[] {
  const channelIdToTopicIds = new Map<string, string[]>();
  for (const a of channelTopicAssignments) {
    if (a.subjectType !== "channel") continue;
    const list = channelIdToTopicIds.get(a.subjectId) ?? [];
    list.push(a.topicId);
    channelIdToTopicIds.set(a.subjectId, list);
  }

  const groups = new Map<string, NicheGroup>();
  const getGroup = (topicId: string): NicheGroup => {
    const existing = groups.get(topicId);
    if (existing) return existing;
    const created: NicheGroup = { topicId, discoveryCandidates: [], trendCandidates: [] };
    groups.set(topicId, created);
    return created;
  };

  for (const candidate of discoveryCandidates) {
    for (const topicId of channelIdToTopicIds.get(candidate.channelId) ?? []) {
      getGroup(topicId).discoveryCandidates.push(candidate);
    }
  }
  for (const candidate of trendCandidates) {
    const topicId = topicIdsByTrendCandidateId.get(candidate.trendCandidateId);
    if (topicId) getGroup(topicId).trendCandidates.push(candidate);
  }

  return [...groups.values()].filter(
    (g) => g.discoveryCandidates.length + g.trendCandidates.length >= NICHE_MIN_GROUP_SIZE
  );
}

export type NicheEvidence = {
  topicId: string;
  representativeChannelIds: string[];
  representativeTrendCandidateIds: string[];
  /** Owner spec §30's own "unknowns" field, honestly computed -- never omitted, never a fabricated
   * confidence claim. Empty when nothing is actually unknown for this group. */
  unknowns: string[];
};

/** Representative channels/videos are the group's own real member ids -- never a fabricated title
 * or url. `unknowns` states plainly what this niche's own data does NOT yet establish. */
export function describeNicheEvidence(group: NicheGroup): NicheEvidence {
  const unknowns: string[] = [];
  if (group.trendCandidates.length === 0) {
    unknowns.push("no trend evidence beyond initial discovery -- only discovery candidates share this topic so far");
  } else if (group.trendCandidates.every((t) => !t.hasEvidence)) {
    unknowns.push("trend candidates share this topic, but none has any recorded evidence yet");
  }
  if (group.discoveryCandidates.length === 0) {
    unknowns.push("no discovery candidates in this niche -- only trend candidates share this topic so far");
  }

  return {
    topicId: group.topicId,
    representativeChannelIds: group.discoveryCandidates.map((c) => c.channelId),
    representativeTrendCandidateIds: group.trendCandidates.map((t) => t.trendCandidateId),
    unknowns,
  };
}
