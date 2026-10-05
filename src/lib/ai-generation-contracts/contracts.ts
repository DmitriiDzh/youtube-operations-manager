/**
 * Shared AI-generation contracts (architecture audit 2026-10-01, M2). The request/outcome/provider
 * shapes of the two AI generation kinds -- localization (Phase 6) and hypothesis drafts (Phase 10) --
 * plus their deterministic mock providers. Previously owned by `ai-localization` and
 * `decision-engine` themselves, which made the shared transport `ai-connections` import both
 * consumers (a dependency knot: removing decision-engine broke translations). Now all three depend
 * on this leaf module and not on each other (`AGENTS.md` §M). The two feature modules re-export
 * these names unchanged.
 */

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


export type HypothesisGenerationTokenUsage = { inputTokens: number; outputTokens: number };

/** What the provider is given -- never a raw DB row, only the operator's own notes plus
 * already-resolved, human-readable summaries of evidence the operator selected before generation
 * (see `EvidenceReferenceResolver.describe` below). The model never sees, and never produces, an
 * `EvidenceReference` itself -- it cannot invent one, per the plan's own §3. */
export type HypothesisGenerationRequest = {
  channelId: string | null;
  notes: string;
  evidenceSummaries: string[];
};

export type HypothesisGenerationOutcome =
  | { status: "ok"; statement: string; rationale: string; usage?: HypothesisGenerationTokenUsage }
  | { status: "error"; message: string };

/** The replaceable extension point this slice adds, alongside `LocalizationProvider` -- a second
 * real caller of the same shared `ai-connections` transport infrastructure (`AGENTS.md` §M). */
export type HypothesisDraftProvider = {
  readonly name: string;
  generateHypothesis(request: HypothesisGenerationRequest): Promise<HypothesisGenerationOutcome>;
};
