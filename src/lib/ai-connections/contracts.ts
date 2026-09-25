import {
  DomainError,
  isDomainError,
  mapUnknownError,
  createIdGenerator,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/video-metadata/contracts";
import type { LocalizationGenerationOutcome, LocalizationGenerationRequest, LocalizationProvider } from "@/lib/ai-localization/contracts";

export type { DomainErrorCode, DomainErrorShape, LocalizationGenerationOutcome, LocalizationGenerationRequest, LocalizationProvider };
export { DomainError, isDomainError, mapUnknownError, createIdGenerator };

// ---------------------------------------------------------------------------
// Phase 6 -- AI Connections (provider-agnostic).
//
// A "connection" is a configured, named way to reach one model behind one protocol
// adapter. This module never hardcodes a vendor, a model, or a base URL -- every one
// of those is user-supplied configuration. Only the PROTOCOL (how to talk to the
// endpoint) is a fixed, small set of adapters (see adapters/registry.ts): today
// "mock" (deterministic, no network) and "openai_compatible" (the OpenAI Chat
// Completions request/response shape, which many vendors and local-inference servers
// also implement). Adding a new protocol later means adding one adapter, never
// touching src/lib/ai-localization/services.ts.
// ---------------------------------------------------------------------------

export type AdapterType = "mock" | "openai_compatible";

export type StructuredOutputCapability = "json_schema" | "json_object" | "none";

export type ConnectionCapabilities = {
  structuredOutput: StructuredOutputCapability;
};

export type ConnectionStatus = "unknown" | "ok" | "error";

export type PricingMetadata = {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  currency: string;
} | null;

/** Public shape -- NEVER includes the credential itself, only `hasCredential`. */
export type AiConnection = {
  id: string;
  displayName: string;
  adapterType: AdapterType;
  baseUrl: string | null;
  modelId: string;
  localInferenceMode: boolean;
  enabled: boolean;
  status: ConnectionStatus;
  statusMessage: string | null;
  statusCheckedAt: string | null;
  capabilities: ConnectionCapabilities;
  assignedTasks: string[];
  pricing: PricingMetadata;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type EstimatedCost = {
  amount: number;
  currency: string;
} | null; // null = unknown, never fabricated as zero

/** What a protocol adapter actually does for one generation call. Distinct from
 * `LocalizationProvider` (src/lib/ai-localization/contracts.ts) only in that it also
 * needs the resolved credential (never the ai-localization domain's concern) and can
 * report token usage when the protocol provides it. `toLocalizationProvider` (in
 * services.ts) adapts this into the exact `LocalizationProvider` shape ai-localization
 * already depends on, so that domain's code never needs to know connections exist. */
export type ConnectionProtocolAdapter = {
  readonly adapterType: AdapterType;
  generate(args: {
    connection: AiConnection;
    credential: string | null;
    request: LocalizationGenerationRequest;
  }): Promise<{ outcome: LocalizationGenerationOutcome; usage: TokenUsage | null }>;
  /** Explicit, user-triggered only (INV-AIC-2) -- never called automatically. */
  testConnection(args: {
    connection: AiConnection;
    credential: string | null;
  }): Promise<{ ok: boolean; message: string; mayIncurCost: boolean }>;
};

export type CreateConnectionInput = {
  displayName: string;
  adapterType: AdapterType;
  baseUrl?: string | null;
  modelId: string;
  localInferenceMode?: boolean;
  enabled?: boolean;
  capabilities: ConnectionCapabilities;
  assignedTasks?: string[];
  pricing?: PricingMetadata;
  apiKey?: string | null;
};

export type UpdateConnectionInput = {
  connectionId: string;
  displayName?: string;
  baseUrl?: string | null;
  modelId?: string;
  localInferenceMode?: boolean;
  enabled?: boolean;
  capabilities?: ConnectionCapabilities;
  assignedTasks?: string[];
  pricing?: PricingMetadata;
  /** `undefined` = leave credential unchanged; a string = replace it; `null` =
   * explicitly clear it (delete the stored credential row). */
  apiKey?: string | null;
};
