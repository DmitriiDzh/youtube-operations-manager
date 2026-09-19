import type { LocalizationGenerationRequest, LocalizationGenerationOutcome, LocalizationProvider } from "../contracts";

/**
 * Deterministic, zero-cost, zero-network mock `LocalizationProvider` (docs/PROJECT_SPEC.md
 * §32). Default behavior is a fixed, reproducible transformation of the source text --
 * never a real translation -- so every test asserting against its output is asserting
 * against a value computed independently of any implementation detail, per AGENTS.md §L.
 *
 * `overrides.generate` lets a test substitute a specific outcome (malformed output,
 * a provider error, an oversized value, an empty string) for exact target pairs without
 * needing a second provider implementation.
 */
export function createMockLocalizationProvider(overrides?: {
  generate?: (request: LocalizationGenerationRequest) => Promise<LocalizationGenerationOutcome>;
}): LocalizationProvider {
  return {
    name: "mock",
    async generate(request: LocalizationGenerationRequest): Promise<LocalizationGenerationOutcome> {
      if (overrides?.generate) {
        return overrides.generate(request);
      }

      const tag = request.targetLanguage.toUpperCase();
      return {
        status: "ok",
        title: `[${tag}] ${request.sourceTitle}`,
        description: `[${tag}] ${request.sourceDescription}`,
      };
    },
  };
}
