// ---------------------------------------------------------------------------
// The single module for cross-device propagation of draft/config/audit data (owner
// instruction, 2026-09-22, Telegram): "используем также правило 1 модуля и шлюза.
// Объединяем весь этот функционал в отдельный модуль. Он отвечает за отслеживание
// изменений, каталогизировать это отправлять на перенос. Транспортом пока занимается
// syncthing." -- mirrors this project's existing single-gateway pattern
// (`docs/decisions/0005-youtube-write-gateway.md`, `0007-youtube-read-gateway.md`).
//
// Three responsibilities, each document family reusing the same generic engine
// (`./automerge-core`, `AGENTS.md` §M -- shared logic extracted to its own module rather than
// copy-pasted per family) for change tracking, cataloging, and transport dispatch (see
// `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4 for the full rationale):
//
//   - `./change-drafts` + `./change-drafts-sync` -- the original draft-layer document (per
//     channel: change_sets/changes). Formerly its own top-level module
//     (`docs/decisions/0006-automerge-for-draft-layer.md`, CD1-CD7); moved here 2026-09-22 as a
//     pure relocation -- no logic changed, its own child modules and sync cycle untouched
//     (`AGENTS.md` §D -- already-shipped, safety-adjacent code is not refactored just to share
//     the new generic engine retroactively).
//   - `./editorial-profile` + `./editorial-profile-sync` -- a channel's editorial profile
//     (`channel_editorial_profiles`), added 2026-09-22 per the owner's "отдельными документами"
//     decision: its own document, its own independent sync cycle (own Syncthing subfolder), so a
//     bug in one family's sync never blocks the other's.
//   - `./ai-connections-catalog` + `./ai-connections-catalog-sync` -- AI provider connections'
//     non-secret config (`ai_connections`, added 2026-09-22). Unlike the two families above, this
//     is a single GLOBAL document, not one per channel (`ai_connections` has no `channel_id` --
//     device/account-wide config) -- its sync runner reuses the same per-channel
//     `createSyncRunner` with exactly one constant "channel," rather than a separate
//     single-document runner implementation.
//   - `./automerge-core` -- the shared engine every family above builds on (generic per-key
//     document store, merge-safety logic, filesystem transport, sync-cycle runner). Owns no
//     document shape or business logic itself.
//
// Every caller outside this directory imports only from this barrel, never a child
// directly -- enforced mechanically by `sync-gateway-inventory.test.ts`, the same way the
// read/write gateways enforce their own single-entry-point rule.
// ---------------------------------------------------------------------------

export { createChangeDraftsCoreForProduction } from "./change-drafts";
export { createChangeDraftsSyncCoreForProduction } from "./change-drafts-sync";
export { DomainError, isDomainError } from "./change-drafts/contracts";
export type { FieldConflict } from "./change-drafts/contracts";

export { createEditorialProfileCoreForProduction } from "./editorial-profile";
export type { EditorialProfileDocument, FieldConflict as EditorialProfileFieldConflict } from "./editorial-profile";
export { createEditorialProfileSyncRunnerForProduction } from "./editorial-profile-sync";

export { createAiConnectionsCatalogCoreForProduction } from "./ai-connections-catalog";
export type { AiConnectionEntry, FieldConflict as AiConnectionFieldConflict } from "./ai-connections-catalog";
export { GLOBAL_DOCUMENT_KEY as AI_CONNECTIONS_GLOBAL_DOCUMENT_KEY } from "./ai-connections-catalog";
export { createAiConnectionsCatalogSyncRunnerForProduction } from "./ai-connections-catalog-sync";

export { createMediaSessionsShareCoreForProduction } from "./media-sessions";
export type { MediaSessionsReport, SharedMediaSession, SharedSessionJobs, SharedJobProgress } from "./media-sessions";
export { MEDIA_SESSIONS_REPORT_FORMAT, MEDIA_SESSIONS_REPORT_VERSION, SHARED_CURRENT_JOBS_MAX, sharedSessionJobsSchema } from "./media-sessions";
export { createMediaSessionsSyncRunnerForProduction } from "./media-sessions-sync";
export { createLiveStreamsShareCoreForProduction, createLiveStreamsShareCore } from "./live-streams";
export type { LiveStreamsReport, SharedLiveStream, LiveStreamsShareCore } from "./live-streams";
export { LIVE_STREAMS_REPORT_FORMAT, LIVE_STREAMS_REPORT_VERSION } from "./live-streams";
export { createLiveStreamsSyncRunnerForProduction } from "./live-streams-sync";
export { createAgentTokensShareCoreForProduction, createAgentTokensShareCore } from "./agent-tokens";
export type { AgentTokensReport, SharedAgentToken, AgentTokensShareCore, AgentTokensReportStore } from "./agent-tokens";
export { AGENT_TOKENS_REPORT_FORMAT, AGENT_TOKENS_REPORT_VERSION } from "./agent-tokens";
export { createAgentTokensSyncRunnerForProduction } from "./agent-tokens-sync";
// BL-143 phase 2: generation plans of every device (per-device reports, `./per-device-report`).
export {
  createGenerationPlansShareCoreForProduction,
  createGenerationPlansShareCore,
  GENERATION_PLANS_REPORT_FORMAT,
  GENERATION_PLANS_REPORT_VERSION,
  generationPlansReportSchema,
  jobOutputPathSchema,
  createReviewPresence,
  createReviewPresenceForProduction,
  reviewPresenceSchema,
  REVIEW_PRESENCE_FORMAT,
  REVIEW_PRESENCE_MAX_BYTES,
} from "./generation-plans";
export type { GenerationPlansReport, GenerationPlansShareCore, ReviewPresence, ReviewPresenceCore, SharedBatch, SharedClaim, SharedGroupNote, SharedPickAction, SharedPlan, SharedRecheck, SharedReviewEntry, SharedVerdict, SharedVerdictHistory } from "./generation-plans";
export { createGenerationPlansSyncRunnerForProduction } from "./generation-plans-sync";
// BL-150: the shared Servers → Setup settings (one global Automerge document, an opaque map of values).
export { createMediaSettingsCoreForProduction } from "./media-settings";
export type { MediaSettingsCore, SettingConflict as MediaSettingConflict, SettingValue as MediaSettingValue } from "./media-settings";
export { createMediaSettingsSyncRunnerForProduction } from "./media-settings-sync";

// BL-178 part B: a channel's language settings (baseline + tracked languages), one Automerge document per channel.
export { createChannelLanguageSettingsCoreForProduction } from "./channel-language-settings";
export type { ChannelLanguageSettingsCore, LanguageSettingConflict, LanguageSettingField, LanguageSettingValues } from "./channel-language-settings";
export { LANGUAGE_SETTING_FIELDS } from "./channel-language-settings";
export { createChannelLanguageSettingsSyncRunnerForProduction } from "./channel-language-settings-sync";

// BL-182 stage 2: a channel's publishing defaults (an opaque map of values; publishing owns the fields), one document per channel.
export { createChannelPublishingSettingsCoreForProduction } from "./channel-publishing-settings";
export type { ChannelPublishingSettingsCore, PublishingSettingConflict, PublishingSettingValue } from "./channel-publishing-settings";
export { createChannelPublishingSettingsSyncRunnerForProduction } from "./channel-publishing-settings-sync";
// BL-182 stage 2: the uploads this computer has under way, as a per-device report (another computer refuses the same package).
export { createPublishingUploadsShareCoreForProduction, PUBLISHING_UPLOADS_REPORT_FORMAT, PUBLISHING_UPLOADS_REPORT_VERSION } from "./publishing-uploads";
export type { PublishingUploadsReport, SharedUpload } from "./publishing-uploads";
export { createPublishingUploadsSyncRunnerForProduction } from "./publishing-uploads-sync";
// BL-188: every computer's media jobs (RunPod and Gemini), as a per-device report -- one shared list on every computer.
export {
  createMediaJobsShareCoreForProduction,
  MEDIA_JOBS_FINISHED_WINDOW_MS,
  MEDIA_JOBS_REPORT_FORMAT,
  MEDIA_JOBS_REPORT_MAX,
  MEDIA_JOBS_REPORT_VERSION,
  MEDIA_JOB_OUTPUTS_MAX,
  MEDIA_JOB_COMMAND_KINDS,
  MEDIA_JOB_CREATE_COMMAND_MAX_AGE_MS,
  MEDIA_JOB_COMMANDS_KEEP_MS,
  MEDIA_JOB_COMMANDS_MAX,
  MEDIA_JOB_COMMAND_RESULTS_MAX,
  mediaJobsReportSchema,
  sharedMediaJobSchema,
  sharedJobCommandSchema,
  sharedCommandResultSchema,
  sharedGeminiCreateSchema,
} from "./media-jobs";
export type { MediaJobsReport, SharedMediaJob, SharedJobCommand, SharedCommandResult, SharedGeminiCreate, MediaJobCommandKind } from "./media-jobs";
export { createMediaJobsSyncRunnerForProduction } from "./media-jobs-sync";
// BL-193 (ADR 0039): each computer's Gemini spend (today, this month) under a fingerprint of its key, so computers on one key add
// their spend up; and the Gemini limits, one shared settings map (the media-settings engine on its own document).
export { createGeminiSpendShareCoreForProduction, GEMINI_SPEND_REPORT_FORMAT, GEMINI_SPEND_REPORT_VERSION, geminiSpendReportSchema } from "./gemini-spend";
export type { GeminiSpendReport, GeminiSpendShareCore } from "./gemini-spend";
export { createGeminiSpendSyncRunnerForProduction } from "./gemini-spend-sync";
export { createGeminiSettingsCoreForProduction } from "./gemini-settings";
export type { GeminiSettingsCore } from "./gemini-settings";
export { createGeminiSettingsSyncRunnerForProduction } from "./gemini-settings-sync";
// BL-184: a channel's storyboards (versions from the Operator, comments and decisions from the owner), one document per channel.
export { createStoryboardsCoreForProduction } from "./storyboards";
export type {
  StoryboardAuthor,
  StoryboardComment,
  StoryboardCommentTarget,
  StoryboardDecision,
  StoryboardGateSetting,
  StoryboardKeyframe,
  StoryboardPick,
  StoryboardProp,
  StoryboardRecord,
  StoryboardRender,
  StoryboardRenderDecision,
  StoryboardReply,
  StoryboardSegment,
  StoryboardsCore,
  StoryboardVersion,
} from "./storyboards";
export { createStoryboardsSyncRunnerForProduction } from "./storyboards-sync";

// BL-194 (ADR 0040): the video numbers each computer reserved, as a per-device report (the list and its conflicts: video-projects).
export {
  createVideoReservationsShareCoreForProduction,
  createVideoReservationsShareCore,
  VIDEO_RESERVATIONS_REPORT_FORMAT,
  VIDEO_RESERVATIONS_REPORT_VERSION,
  VIDEO_RESERVATIONS_REPORT_MAX,
  VIDEO_NUMBER_PATTERN,
  videoReservationsReportSchema,
} from "./video-reservations";
export type { VideoReservationsReport, SharedVideoReservation, VideoReservationsShareCore, VideoReservationsReportStore } from "./video-reservations";
export { createVideoReservationsSyncRunnerForProduction } from "./video-reservations-sync";

export { runAllSyncFamiliesOnce } from "./run-all-families";
