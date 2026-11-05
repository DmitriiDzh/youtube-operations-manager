/**
 * BL-161 (FO-REQ-0012, `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md` §3, ADR 0034) -- what the Producer role may call on its own
 * endpoint (`/api/mcp/producer`). A closed list: a channel tool reaches the Producer only by being named here, and every entry
 * names the capability (`src/lib/agent-operations` registry) whose permission class must be READ -- the inventory test fails the
 * suite otherwise, so no DRAFT or WRITE channel tool can be added by accident. Its DRAFT tools are its own proposal tools (BL-163) and
 * one channel tool the owner allowed by name (BL-170, `PRODUCER_DRAFT_CHANNEL_TOOLS`), all listed in `PRODUCER_DRAFT_TOOLS`: each only
 * proposes, and nothing changes until the owner approves it in the Web UI.
 *
 * BL-239 (owner msgs 3928/3930, ADR 0059 -- a new requirement lifting ADR 0037 §1 for these tools only): the Producer also controls
 * this computer's upload queue with `PRODUCER_UPLOAD_QUEUE_TOOLS` (permission UPLOAD_QUEUE): it lists the queue, moves and cancels
 * queued rows of any channel (since BL-244, ADR 0064, it also stops a row being sent before its last chunk), and adds a ready release package under the owner's automatic-upload switch -- private, a date only
 * from a weekly-plan slot the owner approved. Channel agents and the factory get none of them.
 *
 * BL-241 (owner msgs 4010/4011, ADR 0061): the Producer submits clips for review with `PRODUCER_CLIP_REVIEW_TOOLS` -- a short clip
 * already in a channel's folder, which only the owner approves or returns in the Web UI. Submit and withdraw are DRAFT (a request the
 * owner decides), list and get READ. Channel agents and the factory get none of them.
 */

/** The Producer API's own version, independent of `AGENT_API_VERSION` and `FACTORY_API_VERSION`. */
// 1.10.0 (BL-209, ADR 0046): agent_get_publishing_calendar's uploads gain automatic / progressPercent / finishedAt (additive).
// 1.11.0 (BL-214, LIVE_ANALYTICS_PLAN.md stage 4): the READ tool producer_live_analytics (additive).
// 1.12.0 (BL-221, owner msg 3453): producer_live_analytics counts a sample taken while live without a viewer count as 0 viewers
// (YouTube omits concurrentViewers when nobody watches): averageViewers / peakViewers are 0, not null, for such time. Same shape.
// 1.13.0 (BL-235, owner msgs 3806/3807): agent_get_publishing_calendar -- coverage.due is "fewer than 7 covered days in a row"
// (a release with every tracked translation, the channel's zone), coverage.coveredDaysInARow; gapDates are the channel's days not
// covered (gapDatesTimeZone), missingTranslationDates; entries can be kind published_pending (date passed < 24 h, not synced yet).
// 1.14.0 (BL-239, owner msgs 3928/3930, ADR 0059): the upload queue tools producer_upload_queue_list / _add / _move / _cancel and
// the permission UPLOAD_QUEUE in producer_get_capabilities (additive).
// 1.15.0 (BL-241, owner msgs 4010/4011, ADR 0061): the clip review tools producer_clip_review_submit / _list / _get / _withdraw;
// producer_get_capabilities lists clipReviewTools, and submit / withdraw join draftTools (additive).
// 1.16.0 (BL-242, ADR 0062): producer_upload_queue_add -- in the packaged approval stage the date comes only from an approval of the
// same manifest (a package changed since the owner approved it uploads without a date). Same shape.
// 1.17.0 (BL-243, ADR 0063): agent_get_publishing_calendar -- deleted_on_youtube, existsOnChannel / checkedAt / removedAt,
// missingOnChannel and a top-level checkedAt; channel_video_list videoIds with removed / notFound. Additive.
// 1.18.0 (BL-244, owner msgs 4046/4050, ADR 0064): producer_upload_queue_cancel also stops an upload being sent (or paused while
// sending) before its last chunk; its result gains previousStatus / storedBytes / totalBytes; refusals carry details.reason. Same tool.
export const PRODUCER_API_VERSION = "1.18.0";

/** The channel agent's READ tools the Producer gets; each call names its channel and runs in that channel's agent scope. */
export const PRODUCER_CHANNEL_TOOLS: Readonly<Record<string, { capability: string }>> = Object.freeze({
  agent_get_channel_context: { capability: "channel_context.get_channel_context" },
  channel_video_list: { capability: "video_context.list_videos" },
  agent_get_video_context: { capability: "video_context.get_video_context" },
  agent_query_channel_analytics: { capability: "analytics.query_channel_analytics" },
  agent_query_channel_breakdown: { capability: "analytics.query_channel_breakdown" },
  agent_query_channel_reach: { capability: "analytics.query_channel_reach" },
  agent_get_video_milestones: { capability: "analytics.query_video_milestones" },
  agent_get_stored_breakdowns: { capability: "analytics.query_stored_breakdowns" },
  agent_get_stored_search_terms: { capability: "analytics.query_stored_search_terms" },
  // BL-191 (FO-REQ-0026 / PRD-REQ-0013, ADR 0034 Amendment 7): the stored "Suggested videos" sources, read-only.
  agent_get_stored_suggested_sources: { capability: "analytics.query_stored_suggested_sources" },
  agent_get_experiment_results: { capability: "decision_engine.query_experiment_results" },
  agent_get_video_comments: { capability: "video_context.query_video_comments" },
  // BL-182 stage 1 (FO-REQ-0023 §4 C4): the publishing calendar, read-only.
  agent_get_publishing_calendar: { capability: "video_context.query_publishing_calendar" },
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
 * BL-170 (owner, Telegram 2026-10-10 msg 2485, ADR 0034 Amendment 5): the channel agent's DRAFT tools the Producer also gets, by name --
 * exactly this one, pinned by the test. `create_experiment_proposal` creates an experiment that is always `proposed`; only the owner
 * approves, runs or abandons it (Web UI), so it is a proposal like the Producer's own. Called like every channel tool: per call, in the
 * named channel's agent scope (the hypothesis must be that channel's).
 */
export const PRODUCER_DRAFT_CHANNEL_TOOLS: Readonly<Record<string, { capability: string }>> = Object.freeze({
  create_experiment_proposal: { capability: "decision_engine.create_experiment_proposal" },
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
  "producer_upload_milestones",
  "producer_live_analytics",
  "producer_propose",
  "producer_list_proposals",
  "producer_mark_proposals_done",
  "producer_upload_queue_list",
  "producer_upload_queue_add",
  "producer_upload_queue_move",
  "producer_upload_queue_cancel",
  "producer_clip_review_submit",
  "producer_clip_review_list",
  "producer_clip_review_get",
  "producer_clip_review_withdraw",
] as const;

/**
 * BL-239 (UPLOAD_QUEUE_CONTROL_PLAN.md, ADR 0059): the Producer's upload queue tools -- exactly these four, the test pins the list.
 * The list reads; add, move and cancel change this computer's queue (never a video on YouTube by themselves: the runner uploads, as
 * for every queued row, with its identity check and Live writes before each write).
 */
export const PRODUCER_UPLOAD_QUEUE_TOOLS = ["producer_upload_queue_list", "producer_upload_queue_add", "producer_upload_queue_move", "producer_upload_queue_cancel"] as const;

/**
 * BL-241 (CLIP_REVIEWS_PLAN.md, ADR 0061): the Producer's clip review tools -- exactly these four, the test pins the list. Submit and
 * withdraw store a request or take it back; only the owner approves or returns a clip, in the Web UI (no MCP path reaches that).
 */
export const PRODUCER_CLIP_REVIEW_TOOLS = ["producer_clip_review_submit", "producer_clip_review_list", "producer_clip_review_get", "producer_clip_review_withdraw"] as const;

/**
 * BL-163 (FO-REQ-0014 §C, ADR 0034 Amendment 1): the Producer's DRAFT tools -- exactly these two, the test pins the list. They store
 * a proposal, or mark a decided one read; neither changes the watchlist or the hypotheses. Approving, rejecting and applying are
 * Web-UI-only (`agent-proposal-approval-inventory.test.ts`). BL-241 adds the clip review submit and withdraw: a request for the owner,
 * taken back while still pending; only the owner decides it (`clip-reviews/boundaries.test.ts`).
 */
export const PRODUCER_DRAFT_TOOLS = ["producer_propose", "producer_mark_proposals_done", "create_experiment_proposal", "producer_clip_review_submit", "producer_clip_review_withdraw"] as const;

/** Every tool the Producer endpoint lists, in order. */
export const PRODUCER_TOOL_NAMES: readonly string[] = Object.freeze([
  ...PRODUCER_ONLY_TOOLS,
  ...Object.keys(PRODUCER_CHANNEL_TOOLS),
  ...Object.keys(PRODUCER_DRAFT_CHANNEL_TOOLS),
]);
