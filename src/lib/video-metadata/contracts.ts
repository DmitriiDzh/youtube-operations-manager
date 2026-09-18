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
  | "live_writes_disabled";

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
