import { z } from "zod";
import { ASSET_REFERENCE_KINDS, ASSET_TYPES } from "./contracts";
export { parseWithSchema, formatZodError } from "./contracts";


const assetTypeSchema = z.enum(ASSET_TYPES);
const assetReferenceKindSchema = z.enum(ASSET_REFERENCE_KINDS);

// No `credentialRef` -- mirrors `agent-operations` slice B's convention (`getChannelContext`/
// `getVideoContext`), not slice C's: there is no external API call here to defer validation to,
// so the caller (MCP/CLI) resolves the active-user identity and calls
// `channelAccessCore.assertActiveChannel` itself before invoking any function below.

export const registerAssetInputSchema = z
  .object({
    channelId: z.string().min(1),
    assetType: assetTypeSchema,
    referenceKind: assetReferenceKindSchema,
    referenceValue: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    linkedVideoId: z.string().min(1).optional(),
    provenance: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const listAssetsInputSchema = z
  .object({
    channelId: z.string().min(1),
    videoId: z.string().min(1).optional(),
    assetType: assetTypeSchema.optional(),
  })
  .strict();

export const getAssetContextInputSchema = z
  .object({
    channelId: z.string().min(1),
    assetId: z.string().min(1),
  })
  .strict();

export const creativeAssetSchema = z
  .object({
    assetId: z.string().min(1),
    channelId: z.string().min(1),
    assetType: assetTypeSchema,
    referenceKind: assetReferenceKindSchema,
    referenceValue: z.string().min(1),
    title: z.string().nullable(),
    description: z.string().nullable(),
    linkedVideoId: z.string().nullable(),
    provenance: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
  })
  .strict();

export const registerAssetOutputSchema = creativeAssetSchema;
export const listAssetsOutputSchema = z.object({ assets: z.array(creativeAssetSchema) }).strict();
export const getAssetContextOutputSchema = creativeAssetSchema;

export type RegisterAssetInput = z.infer<typeof registerAssetInputSchema>;
export type ListAssetsInput = z.infer<typeof listAssetsInputSchema>;
export type GetAssetContextInput = z.infer<typeof getAssetContextInputSchema>;
export type ListAssetsOutput = z.infer<typeof listAssetsOutputSchema>;
