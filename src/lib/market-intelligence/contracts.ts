import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  createIdGenerator,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError, createIdGenerator };

// ---------------------------------------------------------------------------
// Phase 9 slice 1 -- market-research watchlist (docs/roadmap/plans/PHASE_9_PLAN.md). Owns
// `research_channels`/`research_evidence`: manually-seeded public observations about a channel
// the operator does not (necessarily) own. Structurally separate from `channels`/`videos` --
// never joined, never a foreign key into either (AGENTS.md §F: owned-channel analytics and
// public market/competitor observations stay explicitly separate). Global, not scoped to any
// one owned channel.
// ---------------------------------------------------------------------------

export type ResearchChannel = {
  channelId: string;
  handleOrUrl: string | null;
  reason: string;
  addedAt: string;
};

export type ResearchEvidence = {
  evidenceId: string;
  researchChannelId: string;
  observation: string;
  source: string;
  confidence: string | null;
  collectedAt: string;
};
