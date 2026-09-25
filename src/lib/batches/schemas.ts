import { z } from "zod";
export { parseWithSchema, formatZodError } from "./contracts";


// Concurrency range confirmed as part of the Phase 5 acceptance contract's §0.D
// (configurable 1-5, default 1) -- see docs/acceptance/PHASE_5_ACCEPTANCE.md.
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 5;
export const DEFAULT_CONCURRENCY = 1;

export const createBatchInputSchema = z
  .object({
    channelId: z.string().min(1),
    concurrency: z.number().int().min(MIN_CONCURRENCY).max(MAX_CONCURRENCY).optional(),
    dryRun: z.boolean().optional(),
    selections: z
      .array(
        z
          .object({
            videoId: z.string().min(1),
            changeIds: z.array(z.string().min(1)).min(1),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

export type CreateBatchInput = z.infer<typeof createBatchInputSchema>;
