import { createMockHypothesisDraftProvider, createMockLocalizationProvider } from "@/lib/ai-generation-contracts";
import type { ConnectionProtocolAdapter } from "../contracts";

/**
 * Wraps the EXISTING deterministic mock `LocalizationProvider`
 * (src/lib/ai-localization/adapters/mock-provider.ts) as a connection protocol
 * adapter, rather than reimplementing mock generation here (AGENTS.md §D). This is
 * what lets the mock remain manageable through the same Settings UI/API as a real
 * connection, satisfying "preserve the existing deterministic mock provider."
 *
 * Both mocks come from the shared leaf `src/lib/ai-generation-contracts` (architecture audit M2),
 * so this shared transport depends on neither consumer feature.
 */
export function createMockConnectionAdapter(): ConnectionProtocolAdapter {
  const provider = createMockLocalizationProvider();
  const hypothesisProvider = createMockHypothesisDraftProvider();

  return {
    adapterType: "mock",
    async generate({ request }) {
      const outcome = await provider.generate(request);
      return { outcome, usage: null }; // mock has no real token cost -- usage is unknown, not zero
    },
    async generateHypothesis({ request }) {
      const outcome = await hypothesisProvider.generateHypothesis(request);
      return { outcome, usage: null };
    },
    async testConnection() {
      return { ok: true, message: "Mock adapter is always reachable (no network call).", mayIncurCost: false };
    },
  };
}
