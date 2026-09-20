import { z, ZodError } from "zod";
import { DomainError } from "./contracts";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";

const localizationOverviewRowSchema = z
  .object({
    videoId: z.string().min(1),
    title: z.string(),
    thumbnailUrl: z.string().nullable(),
    publishedAt: z.string(),
    defaultLanguage: z.string().nullable(),
    presentLanguages: z.array(z.string()),
    missingLanguages: z.array(z.string()),
    status: z.enum(["complete", "missing"]),
    lastSyncedAt: z.string(),
  })
  .strict();

export const localizationOverviewInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
  })
  .strict();

export const localizationOverviewOutputSchema = z
  .object({
    channelId: z.string().min(1),
    channelTitle: z.string(),
    languages: z.array(z.string()),
    totalVideos: z.number().int().nonnegative(),
    videos: z.array(localizationOverviewRowSchema),
  })
  .strict();

export const videoLocalizationDetailInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    videoId: z.string().min(1),
  })
  .strict();

export const videoLocalizationDetailOutputSchema = z
  .object({
    videoId: z.string().min(1),
    channelId: z.string().min(1),
    originalTitle: z.string(),
    originalDescription: z.string(),
    defaultLanguage: z.string().nullable(),
    locales: z.array(
      z
        .object({
          language: z.string().min(1),
          remoteTitle: z.string(),
          remoteDescription: z.string(),
        })
        .strict()
    ),
    lastSyncedAt: z.string(),
  })
  .strict();

export const exportLocalizationsInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    videoIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export type LocalizationOverviewInput = z.infer<typeof localizationOverviewInputSchema>;
export type LocalizationOverviewOutput = z.infer<typeof localizationOverviewOutputSchema>;
export type VideoLocalizationDetailInput = z.infer<typeof videoLocalizationDetailInputSchema>;
export type VideoLocalizationDetailOutput = z.infer<typeof videoLocalizationDetailOutputSchema>;
export type ExportLocalizationsInput = z.infer<typeof exportLocalizationsInputSchema>;

export function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export function parseWithSchema<T>(schema: z.ZodType<T>, payload: unknown, context: string): T {
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
