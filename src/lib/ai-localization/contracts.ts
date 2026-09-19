import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";
import type { ChangeType, ChangeValidationStatus, StoredChannelRecord, StoredVideoRecord } from "@/lib/changesets/contracts";

export type { DomainErrorCode, DomainErrorShape, StoredChannelRecord, StoredVideoRecord };
export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// Phase 6, Slice 1 -- AI LOCALIZATION (vertical feature).
//
// Scope (docs/PROJECT_SPEC.md §32 "Future AI Localization Module", extended by the
// project owner's Phase 6 assignment): generate localization proposals for
// (videoId, targetLanguage) pairs via a replaceable `LocalizationProvider`, validate
// the output using the same field-level rules already used by XLSX import
// (src/lib/changesets/diff.ts), let a human inspect/edit the proposals, and hand the
// final, edited set to the existing ChangeSet creation path
// (`src/lib/changesets/services.ts`'s `createChangeSetFromProposals`) with
// `source: "ai_localization"`.
//
// This module never persists a ChangeSet or Change itself, never approves anything,
// never creates a Batch, and never calls the YouTube API. It is a proposal generator
// sitting entirely upstream of Phase 4/5's existing, unmodified approval and write
// pipeline (AGENTS.md §D: one approval system, one batch system).
//
// AI-generated text is a draft until it passes through that existing approval
// workflow (AGENTS.md §G) -- nothing in this module can mark a Change "approved".
// ---------------------------------------------------------------------------

/** One (video, target-language) pair the caller wants proposals for. */
export type GenerationTarget = {
  videoId: string;
  language: string;
};

/**
 * Generic, content-free editorial context an API caller may supply per generation
 * call. Every field is caller-supplied, per-request, and never persisted by this
 * module -- `AGENTS.md` §B prohibits channel-specific editorial guidelines from
 * living in this repository, so no default value, per-channel lookup, or
 * repository-committed content backs any of this (see
 * docs/ai-localization/CHANNEL_CONTEXT_PROPOSAL.md Part A). A future real provider
 * adapter MAY use these fields to shape its prompt; the deterministic mock provider
 * ignores them.
 */
export type GenerationContext = {
  targetAudience?: string;
  toneNotes?: string;
  terminologyNotes?: string;
  titleConstraints?: string;
  descriptionConstraints?: string;
};

/** What the provider is given to generate one language's localization from. */
export type LocalizationGenerationRequest = {
  videoId: string;
  targetLanguage: string;
  sourceLanguage: string | null;
  sourceTitle: string;
  sourceDescription: string;
  editorialBrief?: GenerationContext;
};

/**
 * A provider either produces text, or reports it could not (rate limit, malformed
 * upstream response, transient failure, etc.) -- modeled explicitly so a single
 * provider failure never throws and aborts sibling videos/languages (mirrors Phase 5's
 * AC-ISOLATION-01 item-level-failure principle, applied to generation instead of write).
 */
/** Token usage a real provider reported for one generation call, when available.
 * Never fabricated: a provider/adapter that doesn't report usage simply omits this
 * (docs/acceptance/PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md AC-CONN-16 -- unknown is
 * never reported as zero). Purely informational; nothing in validation/approval
 * depends on it. */
export type GenerationTokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type LocalizationGenerationOutcome =
  | { status: "ok"; title: string; description: string; usage?: GenerationTokenUsage }
  | { status: "error"; message: string };

/**
 * The single replaceable extension point named by docs/PROJECT_SPEC.md §32
 * ("LocalizationProvider"). A real provider (OpenAI/Anthropic/DeepL/etc.) is an
 * explicit, separate, future-authorized integration -- see `resolveLocalizationProvider`
 * in `./provider-registry.ts`. This interface is deliberately minimal: no channel
 * editorial/SEO instructions live in this repository (AGENTS.md §B), so a real
 * implementation must source those out-of-band and pass only plain source text in.
 */
export type LocalizationProvider = {
  readonly name: string;
  generate(request: LocalizationGenerationRequest): Promise<LocalizationGenerationOutcome>;
};

export type GeneratedFieldOutcome = {
  videoId: string;
  language: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
  changeType: ChangeType;
  validationStatus: ChangeValidationStatus;
  validationError: string | null;
};

/** Result of generating proposals for one (video, language) pair. */
export type GeneratedTargetResult = {
  videoId: string;
  language: string;
  providerError: string | null;
  fields: GeneratedFieldOutcome[];
  usage: GenerationTokenUsage | null;
};

export type GenerationRowError = {
  videoId: string | null;
  language: string | null;
  message: string;
};

export type GenerationSummary = {
  targetsRequested: number;
  targetsGenerated: number;
  targetsFailed: number;
  validProposals: number;
  invalidProposals: number;
  unchangedProposals: number;
};

export type GenerationResult = {
  results: GeneratedTargetResult[];
  errors: GenerationRowError[];
  summary: GenerationSummary;
  /**
   * What was actually used for this call (channel profile version + the merged
   * context sent to the provider) -- echo this back verbatim in
   * `createChangeSetFromGeneration`'s `provenance` field to have it durably recorded
   * against the resulting Change Set (see `GenerationProvenance` below).
   */
  generationContext: GenerationProvenance;
};

/**
 * A channel's persistent editorial profile (Phase 6, Channel Editorial Profiles).
 * One profile per channel; `version` increments on every save. Every field is
 * free-text editorial guidance only -- never a credential/secret (`AGENTS.md` §F) and
 * never authored by this repository (`AGENTS.md` §B); the project owner or an
 * authorized operator supplies the content through the API/UI, per channel, at
 * runtime. Storage is this application's own SQLite database (gitignored runtime
 * state), never a file committed to this repository.
 */
export type EditorialProfile = {
  channelId: string;
  version: number;
  targetAudience: string | null;
  toneNotes: string | null;
  terminologyNotes: string | null;
  titleConstraints: string | null;
  descriptionConstraints: string | null;
  updatedAt: string;
};

/**
 * What was actually sent to the provider for a given generation call: the channel's
 * profile version (if any existed) merged with any per-request `editorialBrief`
 * override, per §3's combination rule (see `mergeEditorialContext` in services.ts and
 * `docs/acceptance/PHASE_6_ACCEPTANCE.md` AC-PROFILE-05/06 for the exact rule).
 * `profileVersion: null` means no profile existed for the channel at generation time.
 * `effectiveContext: null` means neither a profile nor a per-request brief supplied
 * anything (every field ended up absent).
 */
export type GenerationProvenance = {
  profileVersion: number | null;
  effectiveContext: GenerationContext | null;
};

/** A proposal the human has inspected and, optionally, edited before it is persisted
 * as a Change (via the existing ChangeSet creation path). Omitting a field means "no
 * proposed change for this field" -- the same "blank = no change" rule as XLSX import
 * (docs/PROJECT_SPEC.md §8), never "clear the existing value". */
export type ReviewedProposal = {
  videoId: string;
  language: string;
  title?: string;
  description?: string;
};
