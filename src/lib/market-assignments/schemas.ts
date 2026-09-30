import { z } from "zod";
import { MARKET_RECORD_KINDS } from "./contracts";
export { parseWithSchema, formatZodError } from "./contracts";

export const marketRecordKindSchema = z.enum(MARKET_RECORD_KINDS);

export const setMarketAssignmentInputSchema = z
  .object({
    recordKind: marketRecordKindSchema,
    recordId: z.string().min(1).max(200),
    channelIds: z.array(z.string().min(1).max(64)).max(200),
  })
  .strict();

export const listMarketAssignmentsInputSchema = z
  .object({
    recordKind: marketRecordKindSchema,
  })
  .strict();
