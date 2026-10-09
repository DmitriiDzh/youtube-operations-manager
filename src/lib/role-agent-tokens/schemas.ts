import { z } from "zod";
export { parseWithSchema, formatZodError } from "./contracts";

/** `.strict()`: the issue input carries a label only -- a `channelId`, `userId` or any credential
 * field is rejected, never silently ignored, so a role token can never be mistaken for a channel one. */
export const issueRoleTokenInputSchema = z
  .object({
    label: z.string().trim().max(100).optional(),
  })
  .strict();

/** BL-130. `token` is only typed here; the service checks its format without echoing it. */
export const importRoleTokenInputSchema = z
  .object({
    token: z.string(),
    label: z.string().trim().max(100).optional(),
  })
  .strict();
