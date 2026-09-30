/**
 * Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md` §6, AC-P12-08) -- every MCP tool this server can
 * register, classified for channel-bound agent sessions. `createMcpServer` refuses to register a
 * tool that is missing from this table (fails at construction, and the inventory test fails the
 * suite), so a new tool can never silently appear in agent sessions unclassified.
 *
 * - `bound`: available to a channel-bound agent; the process-wide agent scope
 *   (`src/lib/agent-session`) plus the tool's own checks confine it to the bound channel.
 * - `operator-only`: never registered in an agent session. Identity/selection switching (hole #1/#2),
 *   the global operations workspace (owner decision D2: channel folders only), and data that has no
 *   per-channel ownership yet.
 */
export type McpToolClass = "bound" | "operator-only";

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
  query_competitors: "operator-only",
  query_market_intelligence: "operator-only",
  agent_list_market_records: "operator-only",
  agent_create_market_research_request: "operator-only",
  agent_list_hypotheses: "bound",
  agent_get_hypothesis_trail: "bound",
  create_experiment_proposal: "bound",
});
