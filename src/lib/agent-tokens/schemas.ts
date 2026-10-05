import { z } from "zod";
export { parseWithSchema, formatZodError } from "./contracts";

const channelIdSchema = z.string().min(1).max(64);

export const issueAgentTokenInputSchema = z
  .object({
    channelId: channelIdSchema,
    label: z.string().trim().max(100).optional(),
  })
  .strict();

export const revokeAgentTokenInputSchema = z
  .object({
    channelId: channelIdSchema,
  })
  .strict();

/** BL-130. `token` is only typed here: its format is checked by the service, which reports
 * `AGENT_TOKEN_IMPORT_MALFORMED` without ever echoing the submitted value. */
export const importAgentTokenInputSchema = z
  .object({
    channelId: channelIdSchema,
    token: z.string(),
    label: z.string().trim().max(100).optional(),
  })
  .strict();
