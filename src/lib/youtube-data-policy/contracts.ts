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
      /**
       * BL-171: our own channels' Authorized Data that is neither analytics nor statistics (III.E.4.c, e.g. comments on our videos):
       * kept at most 30 days by its clock column, then deleted -- by the same purge as Non-Authorized rows (live database, import, backups).
       */
      kind: "authorized_expiring";
      clockColumn: string;
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
const authorizedExpiring = (clockColumn: string, reason: string): YoutubeDataClassification => ({ kind: "authorized_expiring", clockColumn, reason });
const notApiData = (reason: string): YoutubeDataClassification => ({ kind: "not_api_data", reason });

export const YOUTUBE_DATA_CLASSIFICATION: Readonly<Record<string, YoutubeDataClassification>> = Object.freeze({
  // --- Other people's channels: at most 30 days (III.E.4.d) ----------------------------------------
  market_channel_snapshots: nonAuthorized(
    "observed_at",
    "public statistics of watchlist channels from channels.list",
    { apiRowsWhere: apiSourceWhere }
  ),
  suggested_video_titles: nonAuthorized("fetched_at", "titles and channels of other people's videos that suggested ours (BL-191, Data API videos.list)"),
  market_video_snapshots: nonAuthorized(
    "observed_at",
    "public statistics of watchlist channels' videos from videos.list / batchGetStats",
    { apiRowsWhere: apiSourceWhere }
  ),
  market_discovery_candidates: nonAuthorized(
    "last_seen_at",
    "channel ids/titles/descriptions returned by search.list, and their public counts from channels.list (BL-145); refreshed when a later search returns them again",
    {
      assignmentRecordKind: "discovery_candidate",
      // The operator's decision (watching / ignored / promoted / archived) is kept with the channel
      // id and the operator's own query; the API-sourced title/reason are blanked. Keeping the id as
      // the key of that decision is a judgment call recorded in RISK-92.
      keepDecisionWhere: "status <> 'new'",
      // BL-145: the observed public counts are API data too, blanked with the title.
      blankSet:
        "title = '', reason_discovered = NULL, subscriber_count = NULL, hidden_subscriber_count = NULL, video_count = NULL, view_count = NULL, channel_published_at = NULL, stats_observed_at = NULL, match_video_count = NULL, match_view_count = NULL",
      alreadyBlankWhere: "title = '' AND reason_discovered IS NULL AND subscriber_count IS NULL AND video_count IS NULL AND view_count IS NULL AND channel_published_at IS NULL AND hidden_subscriber_count IS NULL AND stats_observed_at IS NULL AND match_video_count IS NULL AND match_view_count IS NULL",
    }
  ),

  // --- Our own channels (III.E.4.b statistics/analytics; III.E.4.c metadata, refreshed by sync) -----
  channels: authorized("our connected channels' metadata, refreshed by channel sync"),
  videos: authorized("our videos' metadata and statistics, refreshed by channel sync"),
  video_metrics_daily: authorized("YouTube Analytics API data for our channels"),
  video_milestones: authorized("YouTube Analytics API data for our channels (BL-166: day-7/day-28 retention and window totals)"),
  video_breakdown_daily: authorized("YouTube Analytics API data for our channels (BL-168: traffic sources and devices per day per video)"),
  channel_breakdown_daily: authorized("YouTube Analytics API data for our channels (BL-168: traffic sources and devices per day per channel)"),
  analytics_breakdown_state: authorized("collection bookkeeping of the two tables above and of the two search-term tables: dates, status, attempts, no API values"),
  video_search_terms: authorized("YouTube Analytics API data for our channels (BL-169: the search terms of each own video's first 90 days)"),
  channel_search_terms_weekly: authorized("YouTube Analytics API data for our channels (BL-169: the channel's search terms per week)"),
  video_suggested_sources: authorized("YouTube Analytics API data for our channels (BL-191: the ids of the videos that suggested each own video in its first 90 days)"),
  channel_suggested_sources_weekly: authorized("YouTube Analytics API data for our channels (BL-191: the ids of the videos that suggested the channel's videos per week)"),
  channel_reach_daily: authorized("YouTube Reporting API Reach data for our channels (III.E.4.b: Reporting API data)"),
  channel_basic_daily: authorized("YouTube Reporting API basic user-activity data for our channels (BL-181, III.E.4.b: Reporting API data)"),
  channel_traffic_source_daily: authorized("YouTube Reporting API traffic-source data for our channels (BL-181, III.E.4.b: Reporting API data)"),
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
  agent_proposals: notApiData("agent and system proposals to the watchlist and hypotheses (the proposer's text, status, the owner's decision; BL-163)"),
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
  video_comments: authorizedExpiring("fetched_at", "comments on our own videos (BL-171): Authorized Data that is not analytics, at most 30 days (III.E.4.c); no author data"),
  video_comment_state: authorized("per-video read bookkeeping and the comment count it had (a statistic, BL-171)"),
  video_comment_channel_state: notApiData("the day each channel's comments were last checked (BL-171)"),
  experiment_arm_videos: notApiData("which own video is in which arm of an experiment (BL-170): ids and labels, no API values"),
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
  media_gpu_availability_log: notApiData("RunPod GPU stock per datacenter, read every 15 minutes (BL-172 availability log, BL-206)"),
  media_gpu_availability_snapshots: notApiData("one row per RunPod GPU stock snapshot (BL-206 availability log; retired by v102)"),
  media_gpu_availability_cuda_snapshots: notApiData("one row per RunPod GPU stock snapshot and CUDA minimum (BL-208 availability log, v102)"),
  generation_plans: notApiData("media generation plans (BL-143)"),
  generation_plan_results: notApiData("results and owner verdicts of media generation plans (BL-143)"),
  generation_plan_events: notApiData("events of media generation plans (BL-143)"),
  generation_plan_peer_verdicts: notApiData("listening verdicts on another device's generation plans (BL-143 phase 2)"),
  media_job_commands_out: notApiData("the owner's actions on another computer's media jobs and sessions (BL-188)"),
  media_job_peer_commands: notApiData("actions received from another computer for this computer's media jobs and sessions (BL-188)"),
  generation_plan_peer_group_notes: notApiData("the owner's wave notes on another device's generation plans (BL-162)"),
  generation_plan_verdict_history: notApiData("the owner's listening verdict history of media generation plans (BL-157)"),
  generation_plan_review_claims: notApiData("'being reviewed here' claims on media generation plans (BL-157)"),
  generation_plan_rechecks: notApiData("the factory's re-checks of rated media generation attempts and the owner's answers (BL-173)"),
  generation_plan_picks: notApiData("the owner's picks of one generated attempt of several, and \"none fits\" (BL-175)"),
  generation_plan_peer_picks: notApiData("the owner's picks on another device's generation plans (BL-175)"),
  gemini_credentials: notApiData("the Gemini API key (credentials, BL-174)"),
  device_secrets: notApiData("this computer's typed secrets: RunPod/S3, Gemini, Hugging Face (credentials, BL-199)"),
  gemini_media_jobs: notApiData("images and video generated through Google's Gemini API for a channel, with their prompts and costs (BL-174)"),
  live_streams: authorized("our channels' live broadcast ids and texts, set by the owner (BL-176)"),
  publishing_uploads: authorized("our channels' uploads: the video ids YouTube returned and the titles and descriptions the owner approved (BL-182)"),
  video_reservations: notApiData("the video numbers this computer gave out for our channels, with the owner's working titles (BL-194)"),
  live_stream_videos: authorized("our own public videos in a live-stream rotation, with their privacy re-read from YouTube (BL-176)"),
  live_stream_events: authorized("our channels' live-broadcast audit trail and YouTube status changes (BL-176)"),
  live_stream_sources: notApiData("the Operator's map of our videos to local files (BL-176)"),
  live_stream_segments: authorized("our channels' live-stream segment broadcasts: ids, YouTube's start/end times and recording state (BL-205)"),
  live_broadcast_analytics: authorized("YouTube Analytics API data of our own ended broadcasts (BL-212): analytics, III.E.4.b"),
  live_viewer_samples: authorized("our own broadcasts' concurrent viewers and stream state, sampled by the stream's poll (BL-211): statistics, III.E.4.b"),
  channel_localizations: authorized("our channels' own title/description translations, set by the owner or the Operator, and the last apply's result (BL-210)"),
  channel_localization_events: authorized("our channels' translations audit trail: languages written and read-back results (BL-210)"),
  ai_connections: notApiData("AI provider configuration"),
  ai_connection_credentials: notApiData("AI provider secrets"),
  agent_channel_tokens: notApiData("agent credentials (hashes)"),
  factory_agent_tokens: notApiData("agent credentials (hashes)"),
  producer_agent_tokens: notApiData("agent credentials (hashes)"),
  producer_call_log: notApiData("which Producer tool was called for which channel, and when"),
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

/** Every table with a 30-day clock: the Non-Authorized ones and, since BL-171, our own III.E.4.c data (`authorized_expiring`). */
export type ExpiringTable = { table: string; clockColumn: string } & Partial<Omit<NonAuthorizedTable, "kind" | "table" | "clockColumn" | "reason">>;

export function expiringTables(): ExpiringTable[] {
  return Object.entries(YOUTUBE_DATA_CLASSIFICATION).flatMap(([table, c]): ExpiringTable[] => {
    if (c.kind === "non_authorized") {
      const { kind: _kind, reason: _reason, ...rest } = c;
      void _kind;
      void _reason;
      return [{ ...rest, table }];
    }
    return c.kind === "authorized_expiring" ? [{ table, clockColumn: c.clockColumn }] : [];
  });
}

