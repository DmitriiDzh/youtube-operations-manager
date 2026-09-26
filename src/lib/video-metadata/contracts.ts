import { randomUUID } from "node:crypto";
import type { ZodError, ZodType } from "zod";

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
  | "analytics_reads_disabled"
  | "analytics_data_current"
  | "youtube_quota_exceeded"
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
  // BL-091 (docs/roadmap/plans/AGENT_ZONES_PLAN.md) -- multi-agent responsibility zones.
  | "AGENT_CONNECTION_NOT_AVAILABLE"
  | "AGENT_CONNECTION_ID_CONFLICT"
  // Slice 2 -- thrown by assertAgentAllowedForCapability for both "no/unknown caller identity
  // once zoning is in use" and "caller identity does not match this capability's assigned zone",
  // same one-code-covers-related-reasons convention as CONTENT_PROPOSAL_NOT_AVAILABLE.
  | "AGENT_ZONE_VIOLATION"
  // Owner-reported: the generic "Connection failed" Cloud Connection callback message gave no way
  // to tell "Google rejected the token exchange" (most often: docs/decisions/0008-cloud-connection.md's
  // separate `/api/cloud-connection/callback` redirect URI was never added to the OAuth client's own
  // "Authorized redirect URIs" in Google Cloud Console) apart from every other callback failure.
  | "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED"
  // Phase 9 slice 1 (docs/roadmap/plans/PHASE_9_PLAN.md) -- market-research watchlist.
  | "RESEARCH_CHANNEL_ALREADY_WATCHED"
  | "RESEARCH_CHANNEL_NOT_AVAILABLE";

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

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
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

export type VideoMetadataItem = {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
};

export type TranscriptDiagnosticStage = "captions-list" | "captions-download";

export type TranscriptDiagnostic = {
  stage: TranscriptDiagnosticStage;
  httpStatus?: number;
  apiReason?: string;
  retriable?: boolean;
};

export type TranscriptUnavailableReason =
  | "no-captions"
  | "captions-not-downloadable"
  | "permissions-insufficient"
  | "rate-limited"
  | "api-error"
  | "unknown";

export type TranscriptResult =
  | { status: "available"; text: string; language?: string }
  | {
      status: "unavailable";
      reason: TranscriptUnavailableReason;
      diagnostic?: TranscriptDiagnostic;
    }
  | { status: "unsupported"; reason: "provider-missing" };

export type MetadataDraft = {
  finalTitle: string;
  description: string;
  promptVersion: string;
};

export type LocaleMetadata = {
  title: string;
  description: string;
};

export type MetadataLanguageSource = "defaultLanguage" | "existing-localization";

export type MetadataLocaleReview = {
  locale: string;
  before: LocaleMetadata | null;
  proposed: LocaleMetadata;
  source: MetadataLanguageSource;
};

export type MetadataLocalizationsReview = {
  before: Record<string, LocaleMetadata>;
  proposed: Record<string, LocaleMetadata>;
  affected: MetadataLocaleReview[];
};

export type MetadataUpdateRequest = {
  videoId: string;
  snippet: Record<string, unknown>;
  localizations: Record<string, LocaleMetadata>;
};

export type MetadataSyncProposal = {
  targetLanguage: string;
  languageSource: MetadataLanguageSource;
  snippet: SnippetReview;
  localizations: MetadataLocalizationsReview;
  update: MetadataUpdateRequest;
};

export type VideoMetadataContext = {
  snippet: Record<string, unknown>;
  localizations: Record<string, LocaleMetadata>;
};

export type SnippetReview = {
  before: Record<string, unknown>;
  proposed: Record<string, unknown>;
};

export type MetadataApplyResult = {
  dryRun: boolean;
  videoId: string;
  targetLanguage: string;
  languageSource: MetadataLanguageSource;
  snippet: SnippetReview;
  localizations: MetadataLocalizationsReview;
};
