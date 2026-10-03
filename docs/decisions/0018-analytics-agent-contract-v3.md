# 0018. Agent API 3.0.0: channel analytics from the local database, channel start date, previousTotals may be null

Status: Accepted

**Date:** 2026-10-03.

**Assigned by** the owner (chat, 2026-10-03, BL-118) after the first MCP agent test of the analytics tools. Plan:
`docs/roadmap/plans/ANALYTICS_AGENT_FEEDBACK_PLAN.md`.

## Context

The agent found that locally collected per-video analytics started 31 days after the channel was created, that the channel analytics tool
reported a previous period from before the channel existed as `0`, that the 256-date `uncoveredDates` list mixed real gaps with dates
before the channel, and that no capability advertised impressions/CTR (the tool existed; the capability inventory was a hand-kept list that
had drifted).

## Decision

1. **Breaking change to an existing tool's contract** (`AGENT_API_VERSION` 2.0.0 -> **3.0.0**, per the policy in
   `agent-operations/contracts.ts`): `agent_query_channel_analytics.previousTotals` is `null` (not zeros) when the comparison period ended
   before the channel was created, with `previousPeriod.status` (`full` | `partial` | `predates_channel`) and a note. A consumer that
   assumed an object must handle `null`.
2. **Behaviour change, same tool**: it answers from the stored channel-level daily totals when they cover both periods
   (`freshness.source = local_collected_data`, `asOf` = collection time, no live call, no quota), otherwise a live read as before;
   `refresh: true` forces the live read. New optional input `granularity` (`day` | `week` | `month`) and new output fields
   `channelStartDate`, `granularity`, `buckets`.
3. **Additive**: `agent_get_channel_context.channelStartDate`; `analytics_data_quality` gains `channelStartDate`, `notApplicableRange`,
   `coveredRanges`, `uncoveredRanges`, `coveredWithoutData`, `provisionalDates`, `coveredMeans`, and pre-channel dates are no longer
   listed in `uncoveredDates`/`coveredDates` (they are `notApplicableRange`); new tool `agent_query_channel_breakdown`; new capability
   entries (`analytics.query_channel_reach`, `analytics.query_channel_breakdown`) and `AgentCapabilityDescriptor.mcpTools`.
4. **Storage and collection**: `channels.published_at` (v44, nullable, no default: the table is transferred), `channel_metrics_daily`,
   `analytics_video_history` and `analytics_collection_runs.channel_level` (v45; device-local like `video_metrics_daily`). Collection asks
   each video from one day before its own publish date, stores the channel-level totals with every run, and the automatic collection closes
   history gaps itself (per-video coverage, bounded per call); a manual collection is refused only when every date it asks for is already
   covered (owner decision; previously refused whenever today's run had happened).
5. **Drift guard**: a test ties every registered `agent_*` / `analytics_*` MCP tool to a capability's `mcpTools`.

## Consequences

- The Web UI Overview tab keeps its live read (`preferLocal` off by default there) and its non-null `previousTotals`; only the agent tool
  changed shape.
- A channel whose creation date is not synced yet is reported with `channelStartDate: null` and is never guessed; its previous period
  is judged `full`.
- Local totals for the most recent days can lag the live read by up to a day (refreshed by the next automatic collection); the freshness
  note says so and `refresh: true` is the escape hatch.
