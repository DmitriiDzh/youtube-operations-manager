import { z } from "zod";
export { parseWithSchema, formatZodError } from "./contracts";


export const importWorkbookInputSchema = z
  .object({
    channelId: z.string().min(1),
    filename: z.string().min(1),
    buffer: z.instanceof(Buffer),
  })
  .strict();

export const listChangeSetsInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

export const getChangeSetInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
    status: z.enum(["pending", "approved", "rejected", "conflict", "invalid", "all"]).optional(),
    language: z.string().min(1).optional(),
    videoId: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(500).optional(),
  })
  .strict();

export const changeActionInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
    changeId: z.string().min(1),
  })
  .strict();

export const changeSetBulkActionInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
  })
  .strict();

export const proposeLocalizationDeletionInputSchema = z
  .object({
    channelId: z.string().min(1),
    language: z.string().min(1),
    // Omitted (or absent) means "every video on the channel with a real localization in this
    // language" -- the whole-column deletion case (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md
    // §7.2/E5b). Provided explicitly, it scopes the proposal to exactly those videos.
    videoIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export type ImportWorkbookInput = z.infer<typeof importWorkbookInputSchema>;
export type ListChangeSetsInput = z.infer<typeof listChangeSetsInputSchema>;
export type GetChangeSetInput = z.infer<typeof getChangeSetInputSchema>;
export type ChangeActionInput = z.infer<typeof changeActionInputSchema>;
export type ChangeSetBulkActionInput = z.infer<typeof changeSetBulkActionInputSchema>;
export type ProposeLocalizationDeletionInput = z.infer<typeof proposeLocalizationDeletionInputSchema>;
