/**
 * The app-wide shared kernel (architecture audit 2026-10-01, M1): `DomainError` and the one
 * `DomainErrorCode` union, schema/parse helpers, the id generator, and the credential reference
 * types. Previously lived inside the `video-metadata` FEATURE module, which made 30+ modules --
 * including both YouTube gateways -- depend on a feature (an 8-module dependency knot). Moved here
 * verbatim; `src/lib/video-metadata/contracts.ts` re-exports every name unchanged.
 */
import { randomUUID } from "node:crypto";
import { z, type ZodError, type ZodType } from "zod";

export function createIdGenerator() {
  return () => randomUUID();
}

export type CredentialRef =
  | { userId: string }
  | {
      accessToken: string;
      refreshToken?: string;
      tokenExpiry?: number;
      scope?: string;
    };

export type DomainErrorCode =
  | "unauthorized"
  | "validation_failed"
  | "target_language_unresolvable"
  | "not_found"
  | "transcript_unavailable"
  | "generation_failed"
  | "update_failed"
  | "AUTH_CALLBACK_INVALID"
  | "AUTH_REFRESH_TOKEN_MISSING"
  | "AUTH_USER_NOT_FOUND"
  | "AUTH_SCOPE_INSUFFICIENT"
  | "WRITE_CHANNEL_REQUIRED"
  | "WRITE_CHANNEL_MISMATCH"
  | "WRITE_CHANNEL_UNRESOLVED"
  | "CHANNEL_NOT_ACTIVE"
  | "change_not_approvable"
  | "batch_invalid_selection"
  | "batch_not_found"
  | "batch_already_running"
  | "send_nothing_to_send"
  | "send_already_in_progress"
  | "ledger_row_not_found"
  | "ledger_invalid_transition"
  | "video_locked"
  | "attempt_already_resolved"
  | "attempt_already_active"
  | "change_approval_invalid"
  | "default_language_missing"
  | "backup_item_failed"
  | "backup_infrastructure_unavailable"
  | "live_writes_disabled"
  | "data_api_reads_disabled"
  // Phase 13 (docs/roadmap/plans/PHASE_13_PLAN.md): the RSS feed and Wikipedia read categories.
  | "youtube_feed_reads_disabled"
  | "youtube_feed_invalid_channel"
  | "youtube_feed_unavailable"
  | "wikipedia_reads_disabled"
  | "wikipedia_unavailable"
  | "reporting_reads_disabled"
  | "reporting_report_malformed"
  | "reporting_download_rejected"
  | "analytics_reads_disabled"
  | "analytics_data_current"
  | "youtube_quota_exceeded"
  | "quota_insufficient"
  | "quota_unknown"
  | "provider_not_configured"
  | "generation_invalid_target_language"
  | "generation_no_proposals"
  | "encryption_key_not_configured"
  | "capability_not_supported"
  | "endpoint_not_allowed"
  | "connection_disabled"
  | "no_fields_to_update"
  | "publish_at_requires_private"
  | "publish_at_already_published"
  | "video_details_conflict"
  | "device_unavailable"
  | "deletion_targets_default_language"
  | "divergent_document_lineage"
  | "crdt_conflict_open"
  | "channel_not_connected"
  // Phase 7 (Agent Operations Interface, docs/AGENT_OPERATIONS_INTERFACE.md) -- structured
  // errors an external operational agent needs to make a deterministic decision on, per that
  // document's own §27 "Failure behavior" requirement. Shared here (not a separate error type)
  // so every domain module's existing DomainError handling (toolErrorResult, CLI serializeError,
  // API route catch blocks) already knows how to surface these without new plumbing.
  | "CAPABILITY_NOT_AVAILABLE"
  | "DATA_NOT_SYNCED"
  | "ANALYTICS_STALE"
  | "CHANNEL_NOT_AUTHORIZED"
  | "ASSET_NOT_AVAILABLE"
  | "CONTENT_PROPOSAL_NOT_AVAILABLE"
  | "INVALID_CONTEXT_REQUEST"
  | "DRAFT_VALIDATION_FAILED"
  | "APPROVAL_REQUIRED"
  | "EXECUTION_NOT_AUTHORIZED"
  // Phase 7 slice I (owner spec §3/§30, operations-workspace path surfacing). Distinct from
  // "not configured" (which is not an error -- see `OperationsWorkspaceListResult`/
  // `OperationsWorkspaceFileResult`'s own `configured: false` discriminant): these two cover the
  // "configured, but something about the actual request/directory is wrong" cases.
  | "OPERATIONS_WORKSPACE_UNAVAILABLE"
  | "OPERATIONS_FILE_NOT_AVAILABLE"
  // Phase 11 (docs/roadmap/plans/PHASE_11_PLAN.md) -- per-channel workspace path. INVALID: the
  // operator-supplied path failed set-time validation. CHANNEL_NOT_CONNECTED: the channelId is not
  // one of this installation's connected channels (never "does not exist" vs. "not connected").
  | "CHANNEL_WORKSPACE_PATH_INVALID"
  | "CHANNEL_WORKSPACE_CHANNEL_NOT_CONNECTED"
  // Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md) -- remote media generation on RunPod/ComfyUI.
  // NOT_CONFIGURED: no credentials/settings on this device (the feature is simply off, AC-P14-01).
  // GATEWAY_DISABLED: the operator's "Media gateway" toggle is off. CREDENTIALS_INVALID: RunPod or
  // the S3 API rejected the stored key (401/403), or a test call failed. *_UNAVAILABLE: the
  // external service answered with an error or did not answer. SETTINGS_INVALID: a value that is
  // syntactically fine but not in the live catalog / inconsistent (AC-P14-19).
  | "media_generation_not_configured"
  | "media_gateway_disabled"
  | "media_credentials_invalid"
  | "media_settings_invalid"
  | "runpod_api_unavailable"
  | "runpod_forbidden"
  | "runpod_s3_unavailable"
  | "comfyui_unavailable"
  | "comfyui_rejected"
  // Phase 14 slice 2 -- generation sessions (one pod, approved by a human, always terminated).
  | "media_session_not_found"
  | "media_session_conflict"
  | "media_session_invalid_state"
  | "media_daily_cap_reached"
  | "media_session_start_failed"
  // BL-133: no GPU candidate could be placed in the volume's datacenter within the capacity wait.
  | "media_no_capacity"
  // BL-155: every placement landed on a host whose CUDA driver is too old (or with no CUDA device); also a job's errorCode.
  | "media_gpu_host_incompatible"
  // Phase 14 slice 3 -- workflow templates, jobs and the exchange folder.
  | "media_template_not_found"
  | "media_template_invalid"
  | "media_job_not_found"
  | "media_job_invalid_state"
  | "media_job_params_invalid"
  | "media_workspace_unavailable"
  // BL-132 (docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md) -- factory control of models, storage, templates, job inputs.
  // HUGGINGFACE_UNAVAILABLE: the Hub did not answer. MODEL_NOT_FOUND: no such repo/revision/file. MODEL_GATED: a gated or
  // private repo (no HF token in this phase). MODEL_HASH_MISMATCH: the requested SHA-256 differs from the Hub's or from the
  // downloaded bytes. VOLUME_FULL: the file is larger than the volume's free space. MODEL_IN_USE: a template uses the file.
  // TEMPLATE_REGISTRY_UNAVAILABLE: the registry folder is not configured/readable on this device. INPUT_UNAVAILABLE: a job
  // input file failed its checks or could not be uploaded.
  | "huggingface_unavailable"
  | "media_model_not_found"
  | "media_model_gated"
  | "media_model_hash_mismatch"
  | "media_volume_full"
  | "media_model_in_use"
  | "media_template_registry_unavailable"
  | "media_input_unavailable"
  // BL-143 (ADR 0029) generation plans: unknown plan; a write on a completed/cancelled plan; a report, job or run that does
  // not fit the plan (stage kind, item, channel, session, template); a plan definition that is not valid as a whole.
  | "plan_not_found"
  | "plan_closed"
  | "plan_mismatch"
  | "plan_invalid"
  // BL-157 (SERVERS_MEDIA_PLAN.md AC-TC-04): the attempt already has a verdict and the request did not say `replace`.
  | "plan_verdict_exists"
  // BL-173 (PLAN_RECHECKS_PLAN.md §2.2/§2.3): a re-check id already used for other content; a re-check that is no longer open.
  | "plan_recheck_exists"
  | "plan_recheck_closed"
  // BL-174 (GEMINI_MEDIA_PLAN.md §2.6): Google's Gemini API through the `gemini-media` module.
  | "gemini_disabled"
  | "gemini_key_missing"
  | "gemini_key_invalid"
  | "gemini_payment_required"
  | "gemini_limit_exceeded"
  | "gemini_request_exists"
  | "gemini_job_not_found"
  | "gemini_input_unavailable"
  | "gemini_workspace_unavailable"
  | "gemini_invalid_params"
  | "gemini_unavailable"
  | "gemini_rate_limited"
  | "gemini_request_rejected"
  // Research export (docs/roadmap/plans/RESEARCH_EXPORT_PLAN.md) -- NOT_CONFIGURED: the channel has no workspace folder on this
  // device (the operator sets it in Settings). UNAVAILABLE: the folder (or its exports/ subfolder) failed re-validation at export
  // time. WRITE_FAILED: a file could not be written; nothing from that call is left behind.
  // A Change Set was created but not every one of its changes could be read back (see changesets/services.ts persistChangeSet).
  | "change_set_incomplete"
  | "RESEARCH_EXPORT_WORKSPACE_NOT_CONFIGURED"
  | "RESEARCH_EXPORT_WORKSPACE_UNAVAILABLE"
  | "RESEARCH_EXPORT_WRITE_FAILED"
  // Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md) -- channel-bound agent sessions.
  // INVALID: missing/unknown/revoked token (never distinguishes which). CHANNEL_NOT_CONNECTED: the
  // operator tried to issue a token for a channel that is not connected. IDENTITY_MISMATCH: the
  // channel's recorded Google identity does not currently own that channel live. CREDENTIAL_OVERRIDE:
  // an agent session tried to supply its own credentialRef/--userId/--accessToken. OPERATOR_ONLY:
  // an agent session invoked something reserved for the operator.
  | "AGENT_TOKEN_INVALID"
  | "AGENT_TOKEN_CHANNEL_NOT_CONNECTED"
  | "AGENT_TOKEN_IDENTITY_MISMATCH"
  | "AGENT_SESSION_CREDENTIAL_OVERRIDE"
  | "AGENT_SESSION_OPERATOR_ONLY"
  // BL-130 (docs/roadmap/plans/AGENT_TOKEN_IMPORT_PLAN.md) -- an operator importing an already-issued
  // token on another device. MALFORMED: not a token of this kind (wrong prefix, length, alphabet).
  // LEGACY_FORMAT: a channel token issued before channel ids were embedded -- reissue it instead.
  // CHANNEL_MISMATCH: the token's embedded channel is not the channel it is being imported into.
  // REVOKED: this device already revoked that token; a revoked token stays revoked here.
  | "AGENT_TOKEN_IMPORT_MALFORMED"
  | "AGENT_TOKEN_IMPORT_LEGACY_FORMAT"
  | "AGENT_TOKEN_CHANNEL_MISMATCH"
  | "AGENT_TOKEN_IMPORT_REVOKED"
  // Owner-reported: the generic "Connection failed" Cloud Connection callback message gave no way
  // to tell "Google rejected the token exchange" (most often: docs/decisions/0008-cloud-connection.md's
  // separate `/api/cloud-connection/callback` redirect URI was never added to the OAuth client's own
  // "Authorized redirect URIs" in Google Cloud Console) apart from every other callback failure.
  | "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED"
  // Phase 9 slice 1 (docs/roadmap/plans/PHASE_9_PLAN.md) -- market-research watchlist.
  | "RESEARCH_CHANNEL_ALREADY_WATCHED"
  | "RESEARCH_CHANNEL_NOT_AVAILABLE"
  // Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md) -- discovery.
  | "MARKET_INTELLIGENCE_QUOTA_DISABLED"
  | "MARKET_INTELLIGENCE_QUOTA_EXCEEDED"
  | "DISCOVERY_CANDIDATE_NOT_FOUND"
  | "DISCOVERY_CANDIDATE_ALREADY_PROMOTED"
  // Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- topics & trends.
  | "TOPIC_NOT_FOUND"
  | "TOPIC_ALREADY_EXISTS"
  | "TOPIC_ASSIGNMENT_ALREADY_EXISTS"
  | "TREND_CANDIDATE_NOT_FOUND"
  // Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md) -- agent-created
  // research requests.
  | "RESEARCH_REQUEST_NOT_FOUND"
  | "RESEARCH_REQUEST_NOT_PENDING"
  // Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md).
  | "COLLECTION_REQUEST_NOT_FOUND"
  | "COLLECTION_REQUEST_NOT_PENDING"
  // Phase 10 slice 1 (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md) -- Decision & Experiment
  // Engine, manual-entry record-keeping foundation.
  | "HYPOTHESIS_NOT_FOUND"
  | "EXPERIMENT_NOT_FOUND"
  | "EXPERIMENT_INVALID_TRANSITION"
  | "EXPERIMENT_NOT_OBSERVABLE"
  // Phase 10 slice 5 (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md) -- execution of an approved
  // localization-type experiment via the existing Change Set/Batch pipeline.
  | "EXPERIMENT_NOT_EXECUTABLE"
  | "EXPERIMENT_MUST_USE_EXECUTE"
  | "EXPERIMENT_CHANGE_SET_NOT_FOUND"
  | "EXPERIMENT_CHANGE_SET_CHANNEL_MISMATCH"
  | "EXPERIMENT_CHANGE_SET_TOO_LARGE"
  | "EXPERIMENT_CHANGE_SET_NO_ELIGIBLE_CHANGES"
  // BL-170 (docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md) -- videos linked to an experiment's arms.
  | "EXPERIMENT_ARM_CHANNEL_REQUIRED"
  | "EXPERIMENT_ARMS_FROZEN"
  | "EXPERIMENT_ARM_VIDEO_NOT_FOUND"
  | "EXPERIMENT_ARM_VIDEO_ALREADY_LINKED"
  | "EXPERIMENT_ARMS_FULL"
  | "EXPERIMENT_ARM_VIDEO_NOT_LINKED"
  // Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md) -- logical path
  // registry. NOT_FOUND also covers a name an agent is not allowed to see (indistinguishable).
  // NOT_CONFIGURED_ON_DEVICE: the path exists but has no value on THIS machine.
  | "LOGICAL_PATH_NOT_FOUND"
  | "LOGICAL_PATH_ALREADY_EXISTS"
  | "LOGICAL_PATH_VALUE_INVALID"
  | "LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE"
  // BL-163 (docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md §2.C) -- agent proposals the owner approves or rejects.
  | "AGENT_PROPOSAL_NOT_FOUND"
  | "AGENT_PROPOSAL_NOT_PENDING"
  | "AGENT_PROPOSAL_DUPLICATE"
  | "AGENT_PROPOSAL_NOT_APPLICABLE"
  | "AGENT_PROPOSAL_CHANNEL_NOT_ACTIVE";

export type DomainErrorShape = {
  code: DomainErrorCode;
  message: string;
  details?: unknown;
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: unknown;

  constructor({ code, message, details }: DomainErrorShape) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Structural, not only `instanceof` (Phase 14 slice 6, found live): a core cached on `globalThis` (the media core, built
 * first by `src/instrumentation.ts`) throws the `DomainError` class of ANOTHER Next.js bundle, so a route's own
 * `instanceof DomainError` is false and a 409 became a 500 "internal_error". Name + string code identify it either way.
 */
export function isDomainError(value: unknown): value is DomainError {
  if (value instanceof DomainError) return true;
  return value instanceof Error && value.name === "DomainError" && typeof (value as { code?: unknown }).code === "string";
}

export function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export function parseWithSchema<T>(schema: ZodType<T>, payload: unknown, context: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError({
      code: "validation_failed",
      message: `Invalid ${context}`,
      details: formatZodError(parsed.error),
    });
  }

  return parsed.data;
}

export function mapUnknownError(error: unknown, fallbackCode: DomainErrorCode): DomainError {
  if (isDomainError(error)) return error;

  return new DomainError({
    code: fallbackCode,
    message: error instanceof Error ? error.message : "Unknown error",
  });
}

export type ResolvedCredentials = {
  credentialRef: CredentialRef;
  accessToken: string;
  refreshToken?: string;
  tokenExpiry?: number;
  scopeSet: Set<string>;
};

/**
 * A real calendar date as YYYY-MM-DD (2026-02-31 and 2026-13-01 are refused, not rolled over). The one definition for tool inputs that
 * take dates (the Producer's upload milestones and portfolio overview, BL-168's stored breakdowns).
 */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD")
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00Z`);
    return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
  }, "not a calendar date");
