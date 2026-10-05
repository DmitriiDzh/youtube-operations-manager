import { DomainError, type CreativeAsset } from "./contracts";
import {
  getAssetContextInputSchema,
  getAssetContextOutputSchema,
  listAssetsInputSchema,
  listAssetsOutputSchema,
  parseWithSchema,
  registerAssetInputSchema,
  registerAssetOutputSchema,
} from "./schemas";

type StoredCreativeAssetForService = {
  id: string;
  channelId: string;
  assetType: string;
  referenceKind: string;
  referenceValue: string;
  title: string | null;
  description: string | null;
  linkedVideoId: string | null;
  provenanceJson: string | null;
  createdAt: Date;
};

function toCreativeAsset(row: StoredCreativeAssetForService): CreativeAsset {
  return {
    assetId: row.id,
    channelId: row.channelId,
    // Cast: the DB layer stores these as plain TEXT; this module's own INSERT path is the only
    // writer and always validates against the real enum first (registerAsset below), so a value
    // read back here is always one of the real enum members.
    assetType: row.assetType as CreativeAsset["assetType"],
    referenceKind: row.referenceKind as CreativeAsset["referenceKind"],
    referenceValue: row.referenceValue,
    title: row.title,
    description: row.description,
    linkedVideoId: row.linkedVideoId,
    // A row this app itself wrote should always have valid JSON -- if it somehow doesn't
    // (external tampering, disk corruption), report "no provenance recorded" rather than
    // crashing the whole read over one malformed row (same discipline
    // `listAnalyticsCollectionRunsByChannel` already uses for its own JSON column).
    provenance: (() => {
      if (!row.provenanceJson) return null;
      try {
        const parsed = JSON.parse(row.provenanceJson);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })(),
    createdAt: row.createdAt.toISOString(),
  };
}

type ServiceDependencies = {
  idGenerator(): string;
  insertAsset(input: {
    id: string;
    channelId: string;
    assetType: string;
    referenceKind: string;
    referenceValue: string;
    title?: string | null;
    description?: string | null;
    linkedVideoId?: string | null;
    provenanceJson?: string | null;
  }): Promise<void>;
  listAssetsByChannel(
    channelId: string,
    filters: { videoId?: string; assetType?: string }
  ): Promise<StoredCreativeAssetForService[]>;
  getAssetById(assetId: string): Promise<StoredCreativeAssetForService | null>;
  // Reused unchanged from `changesets`' own channel/video store adapter (AGENTS.md §D) -- the
  // one legitimate way this module verifies a `linkedVideoId` actually belongs to the requesting
  // channel, since the DB-level foreign key on `linked_video_id` only proves the video exists
  // ANYWHERE, not that it belongs to THIS channel (AGENTS.md §F: channel-context validation is
  // never automatic).
  videoBelongsToChannel(channelId: string, videoId: string): Promise<boolean>;
};

export function createAssetCatalogServices(deps: ServiceDependencies) {
  return {
    /**
     * Owner spec §15/§19-adjacent: catalogs a pre-existing production file by reference (never
     * copies or reads the file itself). This function itself is not part of the agent-operations
     * capability set (owner spec §25 lists only `list_assets`/`get_asset_context` as READ
     * capabilities for this domain) -- it is exposed directly via CLI only ("asset register"),
     * not as its own agent-callable MCP tool. It IS reachable indirectly, however, via
     * `content-proposals`' `registerExternalArtifact` (Phase 7 slice G2, owner spec §19), which
     * delegates to this exact function -- restricted there to `referenceKind`
     * `url`/`external_artifact_id`, never `local_path` (see `content-proposals/schemas.ts`'s
     * `registerExternalArtifactInputSchema`).
     */
    async registerAsset(input: unknown): Promise<CreativeAsset> {
      const parsedInput = parseWithSchema(registerAssetInputSchema, input, "register asset input");

      if (parsedInput.linkedVideoId) {
        const belongs = await deps.videoBelongsToChannel(parsedInput.channelId, parsedInput.linkedVideoId);
        if (!belongs) {
          throw new DomainError({
            code: "INVALID_CONTEXT_REQUEST",
            message: "linkedVideoId does not belong to the requested channel",
            details: { channelId: parsedInput.channelId, linkedVideoId: parsedInput.linkedVideoId },
          });
        }
      }

      const id = deps.idGenerator();
      await deps.insertAsset({
        id,
        channelId: parsedInput.channelId,
        assetType: parsedInput.assetType,
        referenceKind: parsedInput.referenceKind,
        referenceValue: parsedInput.referenceValue,
        title: parsedInput.title ?? null,
        description: parsedInput.description ?? null,
        linkedVideoId: parsedInput.linkedVideoId ?? null,
        provenanceJson: parsedInput.provenance ? JSON.stringify(parsedInput.provenance) : null,
      });

      // Guaranteed to exist -- `id` is a fresh UUID this call itself just inserted, under the
      // same connection this read uses.
      const row = (await deps.getAssetById(id))!;

      return parseWithSchema(registerAssetOutputSchema, toCreativeAsset(row), "register asset output");
    },

    /**
     * Owner spec §25's `list_assets`. Channel-scoping is deliberately NOT done here -- mirrors
     * `agent-operations` slice B's convention (`getChannelContext`/`getVideoContext`): the
     * MCP/CLI caller checks `channelAccessCore.assertActiveChannel` before calling this.
     */
    async listAssets(input: unknown): Promise<{ assets: CreativeAsset[] }> {
      const parsedInput = parseWithSchema(listAssetsInputSchema, input, "list assets input");

      const rows = await deps.listAssetsByChannel(parsedInput.channelId, {
        videoId: parsedInput.videoId,
        assetType: parsedInput.assetType,
      });

      const output = { assets: rows.map(toCreativeAsset) };
      return parseWithSchema(listAssetsOutputSchema, output, "list assets output");
    },

    /** Owner spec §25's `get_asset_context`. Same channel-scoping note as `listAssets` above. */
    async getAssetContext(input: unknown): Promise<CreativeAsset> {
      const parsedInput = parseWithSchema(getAssetContextInputSchema, input, "get asset context input");

      const row = await deps.getAssetById(parsedInput.assetId);
      // Reports the SAME error for "doesn't exist" and "exists but belongs to another channel"
      // -- never lets a caller distinguish the two (would otherwise leak which asset ids exist
      // for a channel this caller has no access to).
      if (!row || row.channelId !== parsedInput.channelId) {
        throw new DomainError({
          code: "ASSET_NOT_AVAILABLE",
          message: "Asset not found for the requested channel",
          details: { channelId: parsedInput.channelId, assetId: parsedInput.assetId },
        });
      }

      return parseWithSchema(getAssetContextOutputSchema, toCreativeAsset(row), "get asset context output");
    },
  };
}

export type AssetCatalogServices = ReturnType<typeof createAssetCatalogServices>;
