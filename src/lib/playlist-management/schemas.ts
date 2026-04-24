import { z, ZodError } from "zod";
import { DomainError } from "./contracts";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";

const playlistSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1),
    description: z.string(),
    privacyStatus: z.enum(["private", "public", "unlisted"]),
  })
  .strict();

const playlistFailureSchema = z
  .object({
    videoId: z.string().min(1),
    reason: z.enum([
      "already-present",
      "not-found-in-playlist",
      "forbidden",
      "api-error",
      "unknown",
    ]),
    message: z.string().min(1).optional(),
  })
  .strict();

export const playlistListInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
  })
  .strict();

export const playlistListOutputSchema = z
  .object({
    playlists: z.array(playlistSchema),
  })
  .strict();

export const playlistCreateInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    title: z.string().trim().min(1),
    description: z.string().optional(),
    privacyStatus: z.enum(["private", "public", "unlisted"]).default("private"),
    expectedChannelId: z.string().min(1).optional(),
  })
  .strict();

export const playlistCreateOutputSchema = z
  .object({
    playlist: playlistSchema,
  })
  .strict();

export const playlistUpdateInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    playlistId: z.string().min(1),
    expectedChannelId: z.string().min(1),
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    privacyStatus: z.enum(["private", "public", "unlisted"]).optional(),
  })
  .strict()
  .refine(
    (payload) =>
      payload.title !== undefined ||
      payload.description !== undefined ||
      payload.privacyStatus !== undefined,
    {
      message: "At least one mutable field is required: title, description or privacyStatus",
      path: ["title"],
    }
  );

export const playlistUpdateOutputSchema = z
  .object({
    playlist: playlistSchema,
  })
  .strict();

export const playlistDeleteInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    playlistId: z.string().min(1),
    expectedChannelId: z.string().min(1),
  })
  .strict();

export const playlistDeleteOutputSchema = z
  .object({
    deleted: z.literal(true),
    playlistId: z.string().min(1),
  })
  .strict();

export const playlistAddVideosInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    playlistId: z.string().min(1),
    videoIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const playlistAddVideosOutputSchema = z
  .object({
    playlistId: z.string().min(1),
    attempted: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    failures: z.array(playlistFailureSchema),
  })
  .strict();

export const playlistRemoveVideosInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    playlistId: z.string().min(1),
    videoIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const playlistRemoveVideosOutputSchema = z
  .object({
    playlistId: z.string().min(1),
    requested: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    failures: z.array(playlistFailureSchema),
  })
  .strict();

export type PlaylistListInput = z.infer<typeof playlistListInputSchema>;
export type PlaylistListOutput = z.infer<typeof playlistListOutputSchema>;
export type PlaylistCreateInput = z.infer<typeof playlistCreateInputSchema>;
export type PlaylistCreateOutput = z.infer<typeof playlistCreateOutputSchema>;
export type PlaylistUpdateInput = z.infer<typeof playlistUpdateInputSchema>;
export type PlaylistUpdateOutput = z.infer<typeof playlistUpdateOutputSchema>;
export type PlaylistDeleteInput = z.infer<typeof playlistDeleteInputSchema>;
export type PlaylistDeleteOutput = z.infer<typeof playlistDeleteOutputSchema>;
export type PlaylistAddVideosInput = z.infer<typeof playlistAddVideosInputSchema>;
export type PlaylistAddVideosOutput = z.infer<typeof playlistAddVideosOutputSchema>;
export type PlaylistRemoveVideosInput = z.infer<typeof playlistRemoveVideosInputSchema>;
export type PlaylistRemoveVideosOutput = z.infer<typeof playlistRemoveVideosOutputSchema>;

export function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export function parseWithSchema<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  context: string
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError({
      code: "validation_failed",
      message: `Invalid ${context}`,
      details: formatZodError(parsed.error),
    });
  }

  return parsed.data;
}
