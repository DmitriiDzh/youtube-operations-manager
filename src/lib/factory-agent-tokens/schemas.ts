import { z } from "zod";
export { parseWithSchema, formatZodError } from "./contracts";

/** `.strict()`: the issue input carries a label only -- a `channelId`, `userId` or any credential
 * field is rejected, never silently ignored, so this token can never be mistaken for a channel one. */
export const issueFactoryTokenInputSchema = z
  .object({
    label: z.string().trim().max(100).optional(),
  })
  .strict();
