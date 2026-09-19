import { createMockLocalizationProvider } from "@/lib/ai-localization/adapters/mock-provider";
import type { ConnectionProtocolAdapter } from "../contracts";

/**
 * Wraps the EXISTING deterministic mock `LocalizationProvider`
 * (src/lib/ai-localization/adapters/mock-provider.ts) as a connection protocol
 * adapter, rather than reimplementing mock generation here (AGENTS.md §D). This is
 * what lets the mock remain manageable through the same Settings UI/API as a real
 * connection, satisfying "preserve the existing deterministic mock provider."
 *
 * Imports the mock provider directly from its own file, not via
 * `src/lib/ai-localization`'s barrel (`index.ts`) -- that barrel wires
 * `resolveConnectionProvider` back from `src/lib/ai-connections`, so importing it here
 * would create a circular module dependency between the two domains' `index.ts` files.
 */
export function createMockConnectionAdapter(): ConnectionProtocolAdapter {
  const provider = createMockLocalizationProvider();

  return {
    adapterType: "mock",
    async generate({ request }) {
      const outcome = await provider.generate(request);
      return { outcome, usage: null }; // mock has no real token cost -- usage is unknown, not zero
    },
    async testConnection() {
      return { ok: true, message: "Mock adapter is always reachable (no network call).", mayIncurCost: false };
    },
  };
}
