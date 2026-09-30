import type { HypothesisGenerationOutcome, HypothesisGenerationRequest, HypothesisDraftProvider } from "./contracts";

/**
 * Deterministic, zero-cost, zero-network mock `HypothesisDraftProvider`, mirroring
 * `ai-localization/adapters/mock-provider.ts`'s own shape exactly (AGENTS.md §D). Default
 * behavior is a fixed, reproducible transformation of the input -- never a real generated
 * hypothesis -- so every test asserting against its output is asserting against a value computed
 * independently of any implementation detail, per AGENTS.md §L.
 */
export function createMockHypothesisDraftProvider(overrides?: {
  generateHypothesis?: (request: HypothesisGenerationRequest) => Promise<HypothesisGenerationOutcome>;
}): HypothesisDraftProvider {
  return {
    name: "mock",
    async generateHypothesis(request: HypothesisGenerationRequest): Promise<HypothesisGenerationOutcome> {
      if (overrides?.generateHypothesis) {
        return overrides.generateHypothesis(request);
      }

      const evidenceCount = request.evidenceSummaries.length;
      return {
        status: "ok",
        statement: `[MOCK] Based on ${evidenceCount} evidence item(s) and the notes "${request.notes}", a hypothesis worth testing.`,
        rationale:
          evidenceCount > 0
            ? `Generated from: ${request.evidenceSummaries.join("; ")}`
            : "No evidence was selected -- this is a notes-only hypothesis with no data grounding.",
      };
    },
  };
}
