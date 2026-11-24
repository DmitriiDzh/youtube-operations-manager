/**
 * BL-161 (FO-REQ-0012, `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md` §3, ADR 0034) -- what the Producer role may call on its own
 * endpoint (`/api/mcp/producer`). A closed list: a channel tool reaches the Producer only by being named here, and every entry
 * names the capability (`src/lib/agent-operations` registry) whose permission class must be READ -- the inventory test fails the
 * suite otherwise, so no DRAFT or WRITE channel tool can be added by accident (the DRAFT and playlist lists below are pinned by name). Its DRAFT tools are its own proposal tools (BL-163) and
 * one channel tool the owner allowed by name (BL-170, `PRODUCER_DRAFT_CHANNEL_TOOLS`), all listed in `PRODUCER_DRAFT_TOOLS`: each only
 * proposes, and nothing changes until the owner approves it in the Web UI.
 *
 * BL-239 (owner msgs 3928/3930, ADR 0059 -- a new requirement lifting ADR 0037 §1 for these tools only): the Producer also controls
 * this computer's upload queue with `PRODUCER_UPLOAD_QUEUE_TOOLS` (permission UPLOAD_QUEUE): it lists the queue, moves and cancels
 * queued rows of any channel (since BL-244, ADR 0064, it also stops a row being sent before its last chunk), and adds a ready release package under the owner's automatic-upload switch -- private, a date only
 * from a weekly-plan slot the owner approved. Channel agents and the factory get none of them.
 *
 * Owner msg 4782 (2026-11-23): the Producer edits the playlists of every channel connected here with the channel agent's own playlist
 * tools (`PRODUCER_PLAYLIST_CHANNEL_TOOLS`, permission EXECUTE in the capability registry) -- never a playlist delete.
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
// 1.19.0 (BL-246, owner msgs 4076/4078/4079, ADR 0065): producer_clip_review_get / _list -- each clip gains `attachments` (the owner's
// files on the deciding decision: { path (workspace-relative), name, mime, size, sha256 }; [] otherwise). Additive; no tool added.
// 1.20.0 (BL-255, owner msgs 4380/4383, ADR 0069): producer_video_thumbnail_replace -- replace the custom thumbnail of a video
// already on YouTube (any video of a channel connected here) from an image under the channel's 04 Videos/, with dryRun;
// producer_get_capabilities lists thumbnailTools and the permission THUMBNAIL_WRITE (additive).
// 1.21.0 (BL-257, owner msgs 4514/4516, ADR 0070): agent_get_publishing_calendar and producer_upload_queue_add -- a package of a
// channel whose owner reviews its final packages gains the problem owner_review_pending (not yet approved in Media → «Видео на
// проверку») or owner_review_returned (he returned it; the calendar carries codes only -- his comment is in the Inbox file
// REVIEW-DECISION-package-<video>-<decisionId>.md and in a refused queue add's details.problems) and is not_ready until he approves
// that manifest version. No tool decides. Additive; no tool added.
// PRD-REQ-0195 C (owner TG 2340): 1.22.0 -- producer_upload_queue_add may queue a version the owner approved in package review
// whose earlier rows here were all cancelled before that approval (same shape; one refusal fewer).
// 1.23.0 (BL-263, PRD-REQ-0194, ADR 0071): video codes may be `S<n>` (a WWE Short) besides `V<n>` -- in agent_get_publishing_calendar,
// producer_upload_queue_* (`video`: 'V61' or 'S14') and the wake file names (REVIEW-DECISION-package-S14-...). Additive; no tool added.
// 1.24.0 (BL-265, PRD-REQ-0195 B, owner TG 4578/4581, ADR 0072): producer_video_metadata_update -- fix an uploaded video's title /
// description / tags from its package's current manifest (dryRun first; refuses any conflict); permission METADATA_WRITE and
// metadataTools in producer_get_capabilities. agent_get_publishing_calendar's packages gain `warnings` (codes that never block); the
// owner's package review gates the VIDEO (mp4) only, so a re-package of only its packaging stays ready; producer_upload_queue_add's
// "tried" rule keys a row by its mp4; wake files gain the status packaging_comment (REVIEW-DECISION-package-<video>-<id>.md); upload
// rows gain the error codes media_changed / package_slot_changed. Additive.
// 1.25.0 (BL-267, PRD-REQ-0195 A, owner TG 4569/4575/4620/4630-4636, ADR 0073): the weekly plan's tools producer_week_template_get /
// _propose (DRAFT), producer_publishing_plan_get / _list (READ) and producer_publishing_plan_move_slot (permission PLAN_MOVE: moves a
// slot anywhere at once and writes a dated video's new date on YouTube); producer_get_capabilities lists planTools / planMoveTools.
// producer_upload_queue_add: a date by the weekly-plan rule (the owner's approved template with his media approval, or his explicit
// one-slot date). Additive.
// 1.26.0 (BL-269, owner TG 4590/4592/4660, ADR 0074): producer_video_captions_add -- the English captions of a release package onto
// the video its upload record names (dryRun first; `overwrite: true` replaces the video's one English standard track); permission
// CAPTIONS_WRITE and captionsTools in producer_get_capabilities. agent_get_publishing_calendar's packages gain `captions` and the
// problem codes captions_missing / captions_invalid (details.reason); uploads gain steps.captions. Additive.
// 1.27.0 (BL-271, owner TG 3617/3618, ADR 0075): producer_wait (READ) -- wait until one upload of this computer or a restart is final
// (timeoutSeconds default 50, clamped 1-240); not counted as MCP activity; any other target is invalid_request. Additive.
// 1.28.0 (BL-272, owner TG 2547 via the Producer, ADR 0076): the master still image review tools producer_image_review_submit /
// _list / _get / _withdraw (submit and withdraw DRAFT; the owner approves, approves with a note or returns, in the Web UI);
// producer_get_capabilities lists imageReviewTools; producer_clip_review_submit takes an optional approvedImageId (an image of the
// same channel the owner approved) and the clip then carries it in _get / _list. Additive.
// 1.29.0 (owner TG 4782, 2026-11-23; ADR 0048 amendment 2026-11-23): the channel playlist tools playlist_list, playlist_create,
// playlist_update (title / description / privacy, public included), playlist_add_videos (only the channel's own synced videos) and
// playlist_remove_videos, each run for the named channel as its own agent would (`expectedChannelId`, required except on
// playlist_create, must equal `channelId`); permission PLAYLIST_WRITE and playlistTools in producer_get_capabilities. No playlist delete. Additive.
// 1.30.0 (FO-REQ-0056 part 2, BL-273): channel_video_list gains the selectable field `tags` and agent_get_video_context's metadata gains
// `tags` (snippet.tags as of the last channel sync; [] = none; null = not read yet). Read-only, local copy. Additive; no tool added.
// 1.31.0 (BL-274, owner TG 4839/4842, ADR 0072 amendment 1): producer_video_metadata_update takes `localizations: true` -- the package's current
// translations onto its uploaded video (per-language three-way check, any conflict refuses, nothing removed, dryRun), through the
// shared video translations writer. Additive; no tool added.
// 1.32.0 (owner TG 4817, PACKAGE_REVIEW_PLAN.md AC-TC-08): producer_publishing_plan_get / _list -- a slot's package gains
// reviewTimedComments [{ atSeconds, time, text }] (the comments the owner bound to moments of the video in package review, sent with
// his standing approval or return), and the wake file REVIEW-DECISION-package-<video>-<decisionId>.md gains the section «Timed
// comments» (one line per comment: `<seconds> s (<m:ss>): <text>`; absent when none); owner TG 4836: an approval may carry notes for
// future videos (non-blocking) -- the wake file says «Notes: Одобрено с замечаниями на будущее», the plan package reviewComment with
// reviewCommentKind approved_notes (returned | returned_timed for a return); owner TG 4846: reviewIssues + reviewIssueCounts on the
// plan's package and the wake file section «Issues» (each owner comment an issue with an id; the factory answers in the next
// package's reviewReplies). Additive; no tool added.
// 1.33.0 (package playlists, BL-276, owner TG 4858/4859, ADR 0051 amendment 2026-11-24): producer_video_playlists (READ) -- { channelId, videoId, refresh? } -> the channel's
// playlists that hold the video (live through the read gateway, kept 10 minutes) and this computer's upload rows of it with each
// playlist's outcome; release packages (yt-release-package/2) may name `playlists` (0..10 ids) the upload adds the video to. Additive.
export const PRODUCER_API_VERSION = "1.33.0";

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
 * Owner, Telegram msg 4782 (2026-11-23; ADR 0048 amendment; `docs/WRITE_AUTHORIZATIONS.md`): the channel agent's playlist tools the
 * Producer also gets, by name -- exactly these five, pinned by the test (never `playlist_delete`). Called like every channel tool: per
 * call, in the named channel's agent scope, so the playlist core's checks apply unchanged (the write-channel guardrail with the required
 * `expectedChannelId`, which must be the named channel; the playlist's owner channel; Live writes immediately before each gateway write).
 * `playlist_add_videos` adds only the channel's own videos (`PRODUCER_OWN_VIDEO_TOOLS`). The four writes are real YouTube writes
 * (permission PLAYLIST_WRITE); every call, refused or not, is in the Producer's call log.
 */
export const PRODUCER_PLAYLIST_CHANNEL_TOOLS: Readonly<Record<string, { capability: string }>> = Object.freeze({
  playlist_list: { capability: "youtube_writes.list_playlists" },
  playlist_create: { capability: "youtube_writes.create_playlist" },
  playlist_update: { capability: "youtube_writes.update_playlist" },
  playlist_add_videos: { capability: "youtube_writes.edit_playlist_items" },
  playlist_remove_videos: { capability: "youtube_writes.edit_playlist_items" },
});

/** The Producer's playlist writes (permission PLAYLIST_WRITE): the playlist tools without the read. */
export const PRODUCER_PLAYLIST_WRITE_TOOLS = ["playlist_create", "playlist_update", "playlist_add_videos", "playlist_remove_videos"] as const;

/**
 * Owner msg 4782 ("добавлять / удалять оттуда видео" -- the channel's videos): on the Producer endpoint each id in `videoIds` must be a
 * video of the named channel in its local synced list (`not_found` otherwise, for the whole call, before any credential or YouTube call).
 */
export const PRODUCER_OWN_VIDEO_TOOLS: readonly string[] = Object.freeze(["playlist_add_videos"]);

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
  "producer_image_review_submit",
  "producer_image_review_list",
  "producer_image_review_get",
  "producer_image_review_withdraw",
  "producer_video_thumbnail_replace",
  "producer_video_metadata_update",
  "producer_video_captions_add",
  "producer_week_template_get",
  "producer_week_template_propose",
  "producer_publishing_plan_get",
  "producer_publishing_plan_list",
  "producer_publishing_plan_move_slot",
  // BL-271 (ADR 0075): wait until an upload of this computer or a restart is final (a read; not counted as MCP activity).
  "producer_wait",
  // Package playlists (owner TG 4858/4859): which playlists of its channel a video is in (a read).
  "producer_video_playlists",
] as const;

/** BL-267 (ADR 0073 §5): the Producer's weekly-plan tools -- exactly these five, the test pins the list. */
export const PRODUCER_PLAN_TOOLS = ["producer_week_template_get", "producer_week_template_propose", "producer_publishing_plan_get", "producer_publishing_plan_list", "producer_publishing_plan_move_slot"] as const;
/** BL-267: the one tool with permission PLAN_MOVE (a move writes a dated video's new date on YouTube at once). */
export const PRODUCER_PLAN_MOVE_TOOLS = ["producer_publishing_plan_move_slot"] as const;

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
/**
 * BL-255 (ADR 0069, owner msgs 4380/4383): the Producer's thumbnail tool -- exactly this one, the test pins the list. It writes a
 * video's custom thumbnail through `src/lib/video-thumbnails/` (backup, identity check, Live writes, read-back, audit); nothing else.
 */
export const PRODUCER_THUMBNAIL_TOOLS = ["producer_video_thumbnail_replace"] as const;

/**
 * BL-265 (ADR 0072 §5, owner TG 4578/4581): the Producer's packaging-fix tool -- exactly this one, the test pins the list. It writes an
 * uploaded video's title / description / tags from its package's current manifest through `src/lib/publishing/package-metadata.ts`
 * (video-details' writer: identity check, backup, Live writes, read-back, audit), refusing any conflict; nothing else.
 */
export const PRODUCER_METADATA_TOOLS = ["producer_video_metadata_update"] as const;

/**
 * BL-269 (ADR 0074 §8, §10; owner TG 4590/4592/4660): the Producer's captions tool -- exactly this one, the test pins the list. It
 * writes the English captions of a release package onto the video its upload record names (or, with `overwrite`, replaces the
 * video's one English standard track) through `src/lib/video-captions/` (identity check, backup, Live writes, read-back, audit).
 */
export const PRODUCER_CAPTIONS_TOOLS = ["producer_video_captions_add"] as const;

export const PRODUCER_CLIP_REVIEW_TOOLS = ["producer_clip_review_submit", "producer_clip_review_list", "producer_clip_review_get", "producer_clip_review_withdraw"] as const;

/**
 * BL-272 (ADR 0076): the Producer's master still image review tools -- exactly these four, the test pins the list. Submit and withdraw
 * store a request or take it back; only the owner approves, approves with a note or returns an image, in the Web UI.
 */
export const PRODUCER_IMAGE_REVIEW_TOOLS = ["producer_image_review_submit", "producer_image_review_list", "producer_image_review_get", "producer_image_review_withdraw"] as const;

/**
 * BL-163 (FO-REQ-0014 §C, ADR 0034 Amendment 1): the Producer's DRAFT tools -- exactly these two, the test pins the list. They store
 * a proposal, or mark a decided one read; neither changes the watchlist or the hypotheses. Approving, rejecting and applying are
 * Web-UI-only (`agent-proposal-approval-inventory.test.ts`). BL-241 adds the clip review submit and withdraw: a request for the owner,
 * taken back while still pending; only the owner decides it (`clip-reviews/boundaries.test.ts`).
 */
export const PRODUCER_DRAFT_TOOLS = [
  "producer_propose",
  "producer_mark_proposals_done",
  "create_experiment_proposal",
  "producer_clip_review_submit",
  "producer_clip_review_withdraw",
  "producer_week_template_propose",
  // BL-272 (ADR 0076): a master still image for the owner's review, taken back while pending; only the owner decides it.
  "producer_image_review_submit",
  "producer_image_review_withdraw",
] as const;

/** Every tool the Producer endpoint lists, in order. */
export const PRODUCER_TOOL_NAMES: readonly string[] = Object.freeze([
  ...PRODUCER_ONLY_TOOLS,
  ...Object.keys(PRODUCER_CHANNEL_TOOLS),
  ...Object.keys(PRODUCER_DRAFT_CHANNEL_TOOLS),
  ...Object.keys(PRODUCER_PLAYLIST_CHANNEL_TOOLS),
]);
