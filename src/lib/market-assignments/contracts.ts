import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError };

/**
 * Phase 12 slice 12.4 (`docs/roadmap/plans/PHASE_12_PLAN.md`, owner decision D1). Which Phase 9
 * record a market assignment points at. The id is the record's own id field:
 * research_channel/discovery_candidate -> `channelId` (a YouTube channel id of the RESEARCHED
 * channel, not an owned one), topic -> `topicId`, trend_candidate -> `trendCandidateId`,
 * research_request -> `requestId`.
 *
 * A separate module rather than a change to `market-intelligence` itself (`AGENTS.md` §M): the
 * per-channel view is shared logic between the channel wall (Phase 12) and the global market data
 * (Phase 9), which stays unaware of channels.
 */
export const MARKET_RECORD_KINDS = [
  "research_channel",
  "topic",
  "trend_candidate",
  "discovery_candidate",
  "research_request",
] as const;
export type MarketRecordKind = (typeof MARKET_RECORD_KINDS)[number];

/** Kinds the operator assigns by hand. `research_request` ownership is recorded automatically when
 * an agent creates the request; the operator may also reassign it. */
export type MarketAssignmentView = { recordKind: MarketRecordKind; recordId: string; channelIds: string[] };
