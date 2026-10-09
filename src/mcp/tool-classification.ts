/**
 * Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md` §6, AC-P12-08) -- every MCP tool this server can
 * register, classified for channel-bound agent sessions. `createMcpServer` refuses to register a
 * tool that is missing from this table (fails at construction, and the inventory test fails the
 * suite), so a new tool can never silently appear in agent sessions unclassified.
 *
 * - `bound`: available to a channel-bound agent; the per-request agent scope
 *   (`src/lib/agent-session`) plus the tool's own checks confine it to the bound channel.
 * - `operator-only`: never registered in an agent session. Identity/selection switching (hole #1/#2),
 *   and the global operations workspace (owner decision D2: channel folders only). Market tools are
 *   `bound`: their results are narrowed to records assigned to the agent's channel (D1, slice 12.4).
 * - `producer-only` (BL-161): the read-only Producer role's own tools, registered only on its endpoint
 *   (`/api/mcp/producer`), never in a channel session. Which `bound` tools the Producer also gets is the
 *   closed list in `src/mcp/producer-tools.ts`.
 */
export type McpToolClass = "bound" | "operator-only" | "producer-only";

export const MCP_TOOL_CLASSIFICATION: Readonly<Record<string, McpToolClass>> = Object.freeze({
  write_context: "bound",
  write_channel_list: "operator-only",
  write_channel_select: "operator-only",
  whoami: "bound",
  auth_user_select: "operator-only",
  list: "bound",
  transcript: "bound",
  preview: "bound",
  apply: "bound",
  playlist_list: "bound",
  playlist_create: "bound",
  playlist_add_videos: "bound",
  playlist_delete: "bound",
  playlist_update: "bound",
  playlist_remove_videos: "bound",
  changeset_list: "bound",
  changeset_get: "bound",
  localization_import_preview: "bound",
  changeset_create_from_import: "bound",
  batch_list: "bound",
  batch_get: "bound",
  channel_sync: "bound",
  channel_list: "bound",
  channel_video_list: "bound",
  analytics_list: "bound",
  analytics_overview: "bound",
  analytics_data_quality: "bound",
  analytics_comparable_age: "bound",
  analytics_weekly_reports_list: "bound",
  analytics_weekly_report_get: "bound",
  ai_localization_generate: "bound",
  ai_localization_create_change_set: "bound",
  agent_get_capabilities: "bound",
  agent_get_channel_context: "bound",
  agent_get_video_context: "bound",
  agent_query_channel_analytics: "bound",
  agent_query_channel_reach: "bound",
  agent_query_channel_breakdown: "bound",
  agent_query_video_analytics: "bound",
  agent_list_assets: "bound",
  agent_get_asset_context: "bound",
  agent_get_generation_provenance: "bound",
  agent_create_content_proposal: "bound",
  agent_get_content_proposal: "bound",
  agent_list_content_proposals: "bound",
  agent_register_external_artifact: "bound",
  agent_list_proposal_artifacts: "bound",
  agent_list_operations_files: "operator-only",
  agent_get_operations_file: "operator-only",
  agent_find_comparable_videos: "bound",
  agent_list_asset_performance: "bound",
  agent_get_channel_workspace: "bound",
  agent_list_logical_paths: "bound",
  agent_get_logical_path: "bound",
  agent_export_research_data: "bound",
  query_competitors: "bound",
  query_market_intelligence: "bound",
  query_market_overview: "bound",
  agent_list_market_records: "bound",
  agent_create_market_research_request: "bound",
  agent_create_collection_request: "bound",
  agent_get_collection_request: "bound",
  agent_get_collection_limits: "bound",
  agent_list_hypotheses: "bound",
  agent_get_hypothesis_trail: "bound",
  create_experiment_proposal: "bound",
  // Phase 14 slice 5 -- remote media generation: request/read/jobs only (approve/start/stop are Web-only, never registered).
  agent_list_media_templates: "bound",
  agent_request_media_session: "bound",
  agent_get_media_session: "bound",
  agent_get_media_limits: "bound",
  // BL-143 phase 3: read-only generation plans of the session's channel.
  agent_list_generation_plans: "bound",
  agent_get_generation_plan: "bound",
  agent_create_media_job: "bound",
  agent_get_media_job: "bound",
  agent_cancel_media_job: "bound",
  agent_release_media_session: "bound",
  // BL-161: the Producer role's own tools.
  producer_get_capabilities: "producer-only",
  producer_list_channels: "producer-only",
  producer_portfolio_overview: "producer-only",
  producer_propose: "producer-only",
  producer_list_proposals: "producer-only",
  producer_mark_proposals_done: "producer-only",
});
