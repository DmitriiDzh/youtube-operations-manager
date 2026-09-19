import type { AdapterType, ConnectionProtocolAdapter } from "../contracts";
import { DomainError } from "../contracts";
import { createMockConnectionAdapter } from "./mock-adapter";
import { createOpenAiCompatibleAdapter, type FetchLike } from "./openai-compatible";

/**
 * The small, fixed adapter registry named by the assignment ("use a small adapter
 * registry... do not implement speculative integrations for many providers"). Adding
 * a new protocol later means adding one entry here and one new adapter file --
 * src/lib/ai-localization/services.ts never needs to change, since it only ever sees
 * the `LocalizationProvider` interface (see services.ts's `toLocalizationProvider`).
 */
export function createProtocolAdapterRegistry(deps: { fetchImpl: FetchLike }): Record<AdapterType, ConnectionProtocolAdapter> {
  return {
    mock: createMockConnectionAdapter(),
    openai_compatible: createOpenAiCompatibleAdapter({ fetchImpl: deps.fetchImpl }),
  };
}

export function resolveProtocolAdapter(
  registry: Record<AdapterType, ConnectionProtocolAdapter>,
  adapterType: AdapterType
): ConnectionProtocolAdapter {
  const adapter = registry[adapterType];
  if (!adapter) {
    throw new DomainError({ code: "provider_not_configured", message: `No protocol adapter registered for "${adapterType}"` });
  }
  return adapter;
}
