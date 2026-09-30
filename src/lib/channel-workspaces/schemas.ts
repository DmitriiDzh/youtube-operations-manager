import { z } from "zod";
export { parseWithSchema, formatZodError } from "./contracts";

const channelIdSchema = z.string().min(1).max(64);

/** Agent-facing read input. `.strict()` -- an extra field (e.g. a `path`) is rejected, never
 * silently ignored, so this read tool can never be mistaken for a setter (AC-P11-10). */
export const getChannelWorkspaceInputSchema = z
  .object({
    channelId: channelIdSchema,
  })
  .strict();

/** Operator-facing set input. `null`/`""` both clear the value. Length-capped so a pathological
 * body cannot store an unbounded string. */
export const setChannelWorkspaceInputSchema = z
  .object({
    channelId: channelIdSchema,
    path: z.string().max(4096).nullable(),
  })
  .strict();

export const getChannelWorkspaceOutputSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }).strict(),
  z.object({ configured: z.literal(true), path: z.string().min(1) }).strict(),
]);

export type GetChannelWorkspaceInput = z.infer<typeof getChannelWorkspaceInputSchema>;
export type SetChannelWorkspaceInput = z.infer<typeof setChannelWorkspaceInputSchema>;
