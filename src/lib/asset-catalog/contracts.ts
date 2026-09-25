import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// Phase 7 slice D -- creative asset catalog (owner spec §15): "The agent needs access to files
// previously used in production... Do not necessarily copy large binary files into API/MCP
// responses. Expose metadata plus controlled file/resource handles." This module owns exactly
// that metadata catalog; it never reads, fetches, or otherwise resolves `referenceValue` itself
// (no filesystem/network access of its own) -- an opaque handle only.
// ---------------------------------------------------------------------------

export const ASSET_TYPES = [
  "thumbnail",
  "source_image",
  "generated_image",
  "video_loop",
  "source_video_clip",
  "audio_track",
  "project_file",
  "prompt",
  "script",
  "metadata_document",
  "other",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_REFERENCE_KINDS = ["url", "local_path", "external_artifact_id"] as const;
export type AssetReferenceKind = (typeof ASSET_REFERENCE_KINDS)[number];

export type CreativeAsset = {
  assetId: string;
  channelId: string;
  assetType: AssetType;
  /** How to interpret `referenceValue` -- this module never resolves it either way. */
  referenceKind: AssetReferenceKind;
  referenceValue: string;
  title: string | null;
  description: string | null;
  linkedVideoId: string | null;
  /** Free-form provenance (generator/tool, prompt/settings, source) -- `null` when none was
   * recorded, never fabricated (owner spec §15: "provenance/source; generator/tool where known;
   * prompt/settings where available"). */
  provenance: Record<string, unknown> | null;
  createdAt: string;
};
