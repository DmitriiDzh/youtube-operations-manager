import { readFileSync } from "node:fs";
import path from "node:path";
import { getChannelTargetLanguages, SCHEMA_CURRENT_VERSION } from "@/lib/db";
import { createChangeSetChannelStoreAdapter } from "@/lib/changesets/adapters/store";
import { createAiLocalizationCore } from "@/lib/ai-localization";
import { createAnalyticsCore } from "@/lib/analytics";
import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { createContentProposalCore } from "@/lib/content-proposals";
import { createOperationsInstructionsCore } from "@/lib/operations-instructions";
import { createComparableContentCore } from "@/lib/comparable-content";
import { createAssetPerformanceCore } from "@/lib/asset-performance";
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
  const assetCatalogCore = createAssetCatalogCore();
  const contentProposalCore = createContentProposalCore();
  const operationsInstructionsCore = createOperationsInstructionsCore();
  const comparableContentCore = createComparableContentCore();
  const assetPerformanceCore = createAssetPerformanceCore();

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
    // Slice D -- delegates unchanged to `assetCatalogCore`'s own already-tested functions
    // (AGENTS.md §D).
    assetCatalogListAssets: assetCatalogCore.listAssets,
    assetCatalogGetAssetContext: assetCatalogCore.getAssetContext,
    // Slice E -- delegates unchanged to `aiLocalizationCore`'s own already-existing, already-
    // tested `getGenerationProvenance` (AGENTS.md §D).
    aiLocalizationGetGenerationProvenance: aiLocalizationCore.getGenerationProvenance,
    // Slice G -- delegates unchanged to `contentProposalCore`'s own already-tested functions
    // (AGENTS.md §D).
    contentProposalCreateContentProposal: contentProposalCore.createContentProposal,
    contentProposalGetContentProposal: contentProposalCore.getContentProposal,
    contentProposalListContentProposals: contentProposalCore.listContentProposals,
    // Slice G2 -- delegates unchanged to `contentProposalCore`'s own already-tested functions
    // (AGENTS.md §D).
    contentProposalRegisterExternalArtifact: contentProposalCore.registerExternalArtifact,
    contentProposalListProposalArtifacts: contentProposalCore.listProposalArtifacts,
    // Slice I -- delegates unchanged to `operationsInstructionsCore`'s own already-tested
    // functions (AGENTS.md §D).
    operationsWorkspaceListFiles: operationsInstructionsCore.listOperationsFiles,
    operationsWorkspaceGetFile: operationsInstructionsCore.getOperationsFile,
    // Slice K -- delegates unchanged to `comparableContentCore`'s own already-tested
    // `findComparableVideos` (AGENTS.md §D).
    findComparableVideos: comparableContentCore.findComparableVideos,
    // Slice L -- delegates unchanged to `assetPerformanceCore`'s own already-tested
    // `listAssetPerformance` (AGENTS.md §D).
    listAssetPerformance: assetPerformanceCore.listAssetPerformance,
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
export type { CreativeAsset } from "@/lib/asset-catalog";
export type { StoredGenerationProvenance } from "@/lib/ai-localization/contracts";
export type { ContentProposal, ContentProposalBrief, ProposalArtifactLink } from "@/lib/content-proposals";
export type {
  OperationsWorkspaceFileEntry,
  OperationsWorkspaceFileResult,
  OperationsWorkspaceListResult,
} from "@/lib/operations-instructions";
export type {
  ComparableVideoCandidate,
  ComparableVideosSortMode,
  FindComparableVideosResult,
} from "@/lib/comparable-content";
export type {
  AssetPerformanceEntry,
  AssetPerformanceLinkedVideo,
  AssetPerformanceSortMode,
  ListAssetPerformanceResult,
} from "@/lib/asset-performance";
export type { FindComparableVideosContext, ListAssetPerformanceContext } from "./schemas";
