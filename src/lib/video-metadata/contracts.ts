// The shared kernel (DomainError, codes, parse helpers, credential types) moved to
// `src/lib/shared-domain` (architecture audit M1); re-exported so existing importers keep working.
export * from "@/lib/shared-domain";

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
