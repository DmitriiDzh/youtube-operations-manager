import { readFileSync } from "node:fs";
import path from "node:path";
import { getChannelTargetLanguages, SCHEMA_CURRENT_VERSION } from "@/lib/db";
import { createChangeSetChannelStoreAdapter } from "@/lib/changesets/adapters/store";
import { createAiLocalizationCore } from "@/lib/ai-localization";
import { createAnalyticsCore } from "@/lib/analytics";
import { createAgentOperationsServices } from "./services";

/**
 * Reads `package.json`'s own `version` field directly (the same field
 * `scripts/write-build-info.mjs` captures at build time into `public/build-info.json`) --
 * resolved via `process.cwd()`, the same repo-root-relative convention `src/lib/db.ts` already
 * uses for its own legacy-path lookup. Never throws: a missing/malformed `package.json` is not
 * something a capability-discovery call should fail over -- falls back to `"unknown"`, the same
 * "never fabricate a fact, but never crash over optional metadata" discipline this codebase
 * already applies elsewhere (e.g. `videos.viewCount`'s own null-not-zero convention).
 */
function readProductVersion(): string {
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function createAgentOperationsCore() {
  // Reused unchanged (AGENTS.md §D): the same channel/video store adapter `ai-localization`/
  // `changesets` already use, and `ai-localization`'s own `getEditorialProfile` service function
  // -- this module never re-reads `channel_editorial_profiles` or the video-sync tables itself.
  const channelStore = createChangeSetChannelStoreAdapter();
  const aiLocalizationCore = createAiLocalizationCore();
  const analyticsCore = createAnalyticsCore();

  return createAgentOperationsServices({
    getProductVersion: readProductVersion,
    getSchemaVersion: () => SCHEMA_CURRENT_VERSION,
    channelStore,
    // `aiLocalizationCore.getEditorialProfile` takes `{ channelId }` (validated via its own
    // zod schema), not a bare string -- wrapped here rather than changing this module's own,
    // simpler `(channelId: string)` dependency shape.
    getEditorialProfile: (channelId: string) => aiLocalizationCore.getEditorialProfile({ channelId }),
    getTrackedLanguages: getChannelTargetLanguages,
    // Slice C -- delegates unchanged to `analyticsCore`'s own already-existing, already-tested
    // functions (AGENTS.md §D). Both accept `input: unknown` and do their own internal
    // validation/credential-resolution/active-channel check.
    getChannelOverview: analyticsCore.getChannelOverview,
    listMetrics: analyticsCore.listMetrics,
    now: () => new Date(),
  });
}

export type AgentOperationsCore = ReturnType<typeof createAgentOperationsCore>;
export {
  AGENT_API_VERSION,
  GRANTED_PERMISSIONS,
  PERMISSION_CLASSES,
  PLANNED_FUTURE_CAPABILITIES,
} from "./contracts";
export type {
  AgentCapabilityDescriptor,
  AgentCapabilityDomain,
  AgentDataDomain,
  AgentEditorialProfileContext,
  AgentLocalizationEntry,
  AnalyticsFreshness,
  ChannelAnalyticsContext,
  ChannelContext,
  MetricDefinition,
  PermissionClass,
  PlannedFutureCapability,
  SystemCapabilities,
  VideoAnalyticsContext,
  VideoContext,
  VideoContextSection,
  VideoMetadataContext,
} from "./contracts";
