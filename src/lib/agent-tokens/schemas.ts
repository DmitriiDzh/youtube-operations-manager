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
