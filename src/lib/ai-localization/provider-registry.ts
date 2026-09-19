import { DomainError, type LocalizationProvider } from "./contracts";
import { createMockLocalizationProvider } from "./adapters/mock-provider";

/**
 * Only "mock" is resolvable today. Selecting and wiring a real, paid provider
 * (OpenAI/Anthropic/DeepL/Google Translation/custom model -- docs/PROJECT_SPEC.md §32)
 * is an explicit product/cost decision left pending for the project owner (Phase 6
 * follow-up task instructions, §4/§8) -- this registry deliberately has no code path
 * that can reach a real network call, so no external AI cost can be incurred by
 * mistake. Any name other than "mock" fails closed with a clear, structured error
 * rather than silently falling back to the mock.
 */
export function resolveLocalizationProvider(providerName: string): LocalizationProvider {
  if (providerName === "mock") {
    return createMockLocalizationProvider();
  }

  throw new DomainError({
    code: "provider_not_configured",
    message: `Localization provider "${providerName}" is not configured. Only "mock" is available; real-provider selection is pending a separate, explicitly-authorized decision (docs/PROJECT_SPEC.md §32).`,
    details: { requestedProvider: providerName, available: ["mock"] },
  });
}
