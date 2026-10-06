// ---------------------------------------------------------------------------
// Phase 13 slice 13.1 (docs/roadmap/plans/PHASE_13_PLAN.md) -- the single, mechanical classification
// of every table this app stores against the YouTube API Services Developer Policies
// (https://developers.google.com/youtube/terms/developer-policies, wording checked 2026-10-01):
//
//   - III.E.4.b: Authorized Data (obtained with the user's own credentials -- OUR channels) that is
//     analytics, Reporting API data, or statistics may be kept "for as long as is necessary".
//   - III.E.4.c: all OTHER Authorized Data (e.g. our own titles/descriptions) at most 30 calendar
//     days, then "delete or refresh".
//   - III.E.4.d: Non-Authorized Data (obtained WITHOUT the user's credentials -- other people's
//     channels) "not longer than 30 calendar days".
//   - III.E.4.h: no "new or derived data or metrics" from API Data (slice 13.3).
//
// A shared leaf module (`AGENTS.md` §M): the retention job (13.2) and every feature that adds a table
// read this one list; a test fails on any schema table that is not classified, so a new table can
// never silently start keeping API data past the policy window.
// ---------------------------------------------------------------------------

/** III.E.4.c/d. */
export const API_DATA_RETENTION_DAYS = 30;

/**
 * The exact `source` values collection writes for API-sourced snapshot rows (review round 1: a
 * prefix match would also catch an operator's free-text source such as "youtube.com page"). A test
 * fails if collection writes a source missing from this list, so a new source cannot escape the purge.
 */
export const YOUTUBE_API_SNAPSHOT_SOURCES = ["youtube.channels.list", "youtube.videos.list", "youtube.videos.batchGetStats"] as const;
const apiSourceWhere = `source IN (${YOUTUBE_API_SNAPSHOT_SOURCES.map((s) => `'${s}'`).join(", ")})`;

export type YoutubeDataClassification =
  | {
      /** Other people's channels, fetched without their credentials. Kept at most 30 days. */
      kind: "non_authorized";
      /** Column holding when THIS row's data was obtained from the API (the 30-day clock). */
      clockColumn: string;
      /**
       * SQL condition selecting the rows that came from the API. Rows outside it (e.g. an operator's
       * manual observation) are the operator's own data, not API Data. Omitted = every row.
       */
      apiRowsWhere?: string;
      /** When rows expire, also drop `channel_record_assignments` rows of this kind pointing at them. */
      assignmentRecordKind?: string;
      /**
       * Rows matching this are the OPERATOR's decision about the record (review round 1): on expiry
       * they are not deleted -- their API-sourced columns are blanked instead (`blankSet`), so the
       * decision survives while no API data outlives the window. Other expired rows are deleted.
       */
      keepDecisionWhere?: string;
      blankSet?: string;
      alreadyBlankWhere?: string;
      reason: string;
    }
  | {
      /** Our own channels, via the operator's OAuth (III.E.4.b, or III.E.4.c for metadata). */
      kind: "authorized";
      reason: string;
    }
  | {
      /** Not YouTube API Data: operator/agent-authored content, app state, bookkeeping. */
      kind: "not_api_data";
      reason: string;
    };

const nonAuthorized = (
  clockColumn: string,
  reason: string,
  options: {
    apiRowsWhere?: string;
    assignmentRecordKind?: string;
    keepDecisionWhere?: string;
    blankSet?: string;
    alreadyBlankWhere?: string;
  } = {}
): YoutubeDataClassification => ({ kind: "non_authorized", clockColumn, reason, ...options });
const authorized = (reason: string): YoutubeDataClassification => ({ kind: "authorized", reason });
const notApiData = (reason: string): YoutubeDataClassification => ({ kind: "not_api_data", reason });

export const YOUTUBE_DATA_CLASSIFICATION: Readonly<Record<string, YoutubeDataClassification>> = Object.freeze({
  // --- Other people's channels: at most 30 days (III.E.4.d) ----------------------------------------
  market_channel_snapshots: nonAuthorized(
    "observed_at",
    "public statistics of watchlist channels from channels.list",
    { apiRowsWhere: apiSourceWhere }
  ),
  market_video_snapshots: nonAuthorized(
    "observed_at",
    "public statistics of watchlist channels' videos from videos.list / batchGetStats",
    { apiRowsWhere: apiSourceWhere }
  ),
  market_discovery_candidates: nonAuthorized(
    "last_seen_at",
    "channel ids/titles/descriptions returned by search.list; refreshed (title and description too) when a later search returns them again",
    {
      assignmentRecordKind: "discovery_candidate",
      // The operator's decision (watching / ignored / promoted / archived) is kept with the channel
      // id and the operator's own query; the API-sourced title/reason are blanked. Keeping the id as
      // the key of that decision is a judgment call recorded in RISK-92.
      keepDecisionWhere: "status <> 'new'",
      blankSet: "title = '', reason_discovered = NULL",
      alreadyBlankWhere: "title = '' AND reason_discovered IS NULL",
    }
  ),

  // --- Our own channels (III.E.4.b statistics/analytics; III.E.4.c metadata, refreshed by sync) -----
  channels: authorized("our connected channels' metadata, refreshed by channel sync"),
  videos: authorized("our videos' metadata and statistics, refreshed by channel sync"),
  video_metrics_daily: authorized("YouTube Analytics API data for our channels"),
  channel_reach_daily: authorized("YouTube Reporting API Reach data for our channels (III.E.4.b: Reporting API data)"),
  reporting_report_files: authorized("Reporting API file ledger for our channels: ids and timestamps, no content"),
  channel_metrics_daily: authorized("YouTube Analytics API channel-level totals for our channels (III.E.4.b)"),
  analytics_video_history: authorized("bookkeeping of our own analytics collection: video ids and dates, no YouTube content"),
  quota_ledger: authorized("bookkeeping of our own API calls and their quota cost: method names, units and timestamps, no YouTube content"),
  reporting_sync_attempts: authorized("last Reporting API sync attempt per our channel: time, outcome, error text, no YouTube content"),
  reporting_jobs: authorized("Reporting API job per our channel: ids and timestamps, no content"),
  analytics_collection_runs: authorized("bookkeeping of our own analytics collection"),
  analytics_weekly_reports: authorized("reports built from our own analytics"),
  change_sets: authorized("drafts of our own videos' metadata"),
  changes: authorized("drafts of our own videos' metadata (baseline = our current value)"),
  ai_localization_generation_provenance: authorized("provenance of drafts for our own videos"),
  batches: authorized("write pipeline for our own videos"),
  batch_ledger_rows: authorized("write pipeline for our own videos"),
  batch_attempts: authorized("write pipeline for our own videos"),
  audit_events: authorized("audit of writes to our own videos"),
  video_edit_audit_events: authorized("audit of Details writes to our own videos"),
  video_execution_locks: authorized("runtime locks for writes to our own videos"),

  // --- Not YouTube API Data -----------------------------------------------------------------------
  research_channels: notApiData("the operator's own watchlist entries (handle/URL typed by the operator)"),
  // Evidence written from the API ("Fetch public snapshot": source youtube.channels.list, the
  // competitor's counts in its text -- review round 4) is that channel's API data (30 days). Every
  // other evidence source is free text the operator typed -- their own note, kept (review round 8:
  // no code writes an "ai_assisted" evidence source, so matching it would only purge operator notes).
  research_evidence: nonAuthorized("collected_at", "API-sourced notes about watchlist channels", {
    apiRowsWhere: apiSourceWhere,
  }),
  workspace_export_files: notApiData("ledger of export files the Manager wrote: names, paths and expiry, no YouTube content (the files themselves expire after 30 days)"),
  market_intelligence_collection_runs: notApiData("collection bookkeeping (status, units spent)"),
  market_discovery_runs: notApiData("discovery bookkeeping (the operator's query, units spent)"),
  market_research_requests: notApiData("agent-drafted research requests (query text, status)"),
  market_collection_requests: notApiData("agent-drafted collection requests (channel ids, estimate, per-channel outcome, units spent)"),
  market_topics: notApiData("operator-defined topics"),
  topic_wikipedia_articles: notApiData("operator links from topics to Wikipedia articles (Phase 13.8)"),
  wikipedia_pageviews_daily: notApiData("Wikimedia page views (CC0), not YouTube API data (Phase 13.8)"),
  market_topic_assignments: notApiData("operator/agent topic tags on records"),
  market_trend_candidates: notApiData("operator/agent-authored trend notes"),
  market_trend_evidence: notApiData("operator/agent-authored evidence links (ids + their own description)"),
  channel_record_assignments: notApiData("which channel's agents may see which market record"),
  hypotheses: notApiData("operator/agent hypotheses"),
  experiments: notApiData("operator-designed experiments"),
  experiment_outcomes: notApiData("operator-recorded outcomes"),
  hypothesis_evidence: notApiData("references (ids) to evidence rows, not copies of their values"),
  hypothesis_generation_provenance: notApiData("AI generation provenance for hypotheses"),
  content_proposals: notApiData("agent-authored content proposals"),
  content_proposal_artifacts: notApiData("agent-registered artifact references"),
  creative_assets: notApiData("operator-registered local assets"),
  channel_editorial_profiles: notApiData("operator-written editorial guidance"),
  channel_workspaces: notApiData("local folder paths"),
  logical_paths: notApiData("names of local folder paths"),
  logical_path_values: notApiData("local folder paths"),
  users: notApiData("OAuth identities/tokens (credentials, not API Data)"),
  cloud_connection: notApiData("Google Cloud OAuth grant (credentials)"),
  media_credentials: notApiData("RunPod / S3 API keys (credentials, Phase 14)"),
  media_sessions: notApiData("RunPod pod sessions and their cost (Phase 14)"),
  media_workflow_templates: notApiData("operator-imported ComfyUI workflow graphs (Phase 14)"),
  media_jobs: notApiData("generation jobs, parameters and output paths (Phase 14)"),
  media_exchange_files: notApiData("ledger of pulled output files (Phase 14)"),
  media_control_events: notApiData("audit of model/template actions on this device (BL-132)"),
  media_exchange_inputs: notApiData("ledger of job input files uploaded to the volume (BL-132)"),
  media_capacity_attempts: notApiData("createPod attempts on RunPod (BL-133 capacity log)"),
  ai_connections: notApiData("AI provider configuration"),
  ai_connection_credentials: notApiData("AI provider secrets"),
  agent_channel_tokens: notApiData("agent credentials (hashes)"),
  factory_agent_tokens: notApiData("agent credentials (hashes)"),
  agent_connections: notApiData("retired, inert"),
  agent_capability_zones: notApiData("retired, inert"),
  app_settings: notApiData("app toggles and status"),
  app_operation_locks: notApiData("runtime lock"),
  gateway_call_events: notApiData("call counters"),
  handoff_log: notApiData("handoff bookkeeping"),
  recovery_acknowledgements: notApiData("recovery bookkeeping"),
  snapshot_lineage: notApiData("device lineage"),
  sync_family_status: notApiData("sync bookkeeping"),
  schema_meta: notApiData("schema version"),
  rules: notApiData("retired, inert"),
});

/** The tables whose API-sourced rows expire after `API_DATA_RETENTION_DAYS`. */
export type NonAuthorizedTable = Extract<YoutubeDataClassification, { kind: "non_authorized" }> & { table: string };

export function nonAuthorizedTables(): NonAuthorizedTable[] {
  return Object.entries(YOUTUBE_DATA_CLASSIFICATION).flatMap(([table, c]) =>
    c.kind === "non_authorized" ? [{ ...c, table }] : []
  );
}

