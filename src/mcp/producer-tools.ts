/**
 * BL-161 (FO-REQ-0012, `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md` §3, ADR 0034) -- what the Producer role may call on its own
 * endpoint (`/api/mcp/producer`). A closed list: a channel tool reaches the Producer only by being named here, and every entry
 * names the capability (`src/lib/agent-operations` registry) whose permission class must be READ -- the inventory test fails the
 * suite otherwise, so no DRAFT or WRITE channel tool can be added by accident. Its only DRAFT tools are its own proposal tools
 * (BL-163, `PRODUCER_DRAFT_TOOLS`): a proposal changes nothing until the owner approves it in the Web UI.
 */

/** The Producer API's own version, independent of `AGENT_API_VERSION` and `FACTORY_API_VERSION`. */
export const PRODUCER_API_VERSION = "1.1.0";

/** The channel agent's READ tools the Producer gets; each call names its channel and runs in that channel's agent scope. */
export const PRODUCER_CHANNEL_TOOLS: Readonly<Record<string, { capability: string }>> = Object.freeze({
  agent_get_channel_context: { capability: "channel_context.get_channel_context" },
  channel_video_list: { capability: "video_context.list_videos" },
  agent_get_video_context: { capability: "video_context.get_video_context" },
  agent_query_channel_analytics: { capability: "analytics.query_channel_analytics" },
  agent_query_channel_breakdown: { capability: "analytics.query_channel_breakdown" },
  agent_query_channel_reach: { capability: "analytics.query_channel_reach" },
  agent_query_video_analytics: { capability: "analytics.query_video_analytics" },
  analytics_data_quality: { capability: "analytics.query_data_quality" },
  analytics_comparable_age: { capability: "analytics.query_comparable_age_performance" },
  analytics_weekly_reports_list: { capability: "analytics.query_weekly_reports" },
  analytics_weekly_report_get: { capability: "analytics.query_weekly_reports" },
  agent_list_asset_performance: { capability: "asset_performance.list_asset_performance" },
  agent_find_comparable_videos: { capability: "comparable_content.find_comparable_videos" },
  query_competitors: { capability: "market_intelligence.query_competitors" },
  query_market_intelligence: { capability: "market_intelligence.query_market_intelligence" },
  query_market_overview: { capability: "market_intelligence.query_market_overview" },
  agent_list_market_records: { capability: "market_intelligence.agent_list_market_records" },
  agent_get_collection_request: { capability: "market_intelligence.agent_get_collection_request" },
  agent_get_collection_limits: { capability: "market_intelligence.agent_get_collection_limits" },
  agent_get_content_proposal: { capability: "content_proposal.get_content_proposal" },
  agent_list_content_proposals: { capability: "content_proposal.list_content_proposals" },
  agent_list_hypotheses: { capability: "decision_engine.agent_list_hypotheses" },
  agent_get_hypothesis_trail: { capability: "decision_engine.agent_get_hypothesis_trail" },
  agent_list_generation_plans: { capability: "media_generation.list_generation_plans" },
  agent_get_generation_plan: { capability: "media_generation.get_generation_plan" },
  agent_get_channel_workspace: { capability: "channel_workspace.get_channel_workspace" },
});

/**
 * A channel tool whose own `channelId` means something else gets it under another name on the Producer endpoint, so `channelId`
 * always names the Producer's channel: `query_market_intelligence`'s is a watchlist (competitor) channel.
 */
export const PRODUCER_RENAMED_CHANNEL_FIELD: Readonly<Record<string, string>> = Object.freeze({
  query_market_intelligence: "watchlistChannelId",
});

/** The Producer's own tools (never registered for a channel agent). */
export const PRODUCER_ONLY_TOOLS = [
  "producer_get_capabilities",
  "producer_list_channels",
  "producer_portfolio_overview",
  "producer_propose",
  "producer_list_proposals",
  "producer_mark_proposals_done",
] as const;

/**
 * BL-163 (FO-REQ-0014 §C, ADR 0034 Amendment 1): the Producer's DRAFT tools -- exactly these two, the test pins the list. They store
 * a proposal, or mark a decided one read; neither changes the watchlist or the hypotheses. Approving, rejecting and applying are
 * Web-UI-only (`agent-proposal-approval-inventory.test.ts`).
 */
export const PRODUCER_DRAFT_TOOLS = ["producer_propose", "producer_mark_proposals_done"] as const;

/** Every tool the Producer endpoint lists, in order. */
export const PRODUCER_TOOL_NAMES: readonly string[] = Object.freeze([...PRODUCER_ONLY_TOOLS, ...Object.keys(PRODUCER_CHANNEL_TOOLS)]);
