import { z, ZodError } from "zod";
import { DomainError } from "./contracts";

export const credentialRefSchema = z.union([
  z.object({ userId: z.string().min(1) }).strict(),
  z
    .object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1).optional(),
      tokenExpiry: z.number().int().positive().optional(),
      scope: z.string().min(1).optional(),
    })
    .strict(),
]);

export const videoMetadataItemSchema = z
  .object({
    videoId: z.string().min(1),
    title: z.string(),
    description: z.string(),
    publishedAt: z.string(),
  })
  .strict();

export const transcriptResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      text: z.string().min(1),
      language: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.enum([
        "no-captions",
        "captions-not-downloadable",
        "permissions-insufficient",
        "rate-limited",
        "api-error",
        "unknown",
      ]),
      diagnostic: z
        .object({
          stage: z.enum(["captions-list", "captions-download"]),
          httpStatus: z.number().int().min(100).max(599).optional(),
          apiReason: z.string().min(1).optional(),
          retriable: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unsupported"),
      reason: z.literal("provider-missing"),
    })
    .strict(),
]);

export const metadataDraftSchema = z
  .object({
    finalTitle: z.string().min(1),
    description: z.string().min(1),
    promptVersion: z.string().min(1),
  })
  .strict();

export const listVideosInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1).optional(),
    maxResults: z.number().int().positive().max(50).optional(),
  })
  .strict();

export const listVideosOutputSchema = z.object({
  videos: z.array(videoMetadataItemSchema),
});

export const transcriptInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    videoId: z.string().min(1),
  })
  .strict();

export const transcriptOutputSchema = z.object({
  transcript: transcriptResultSchema,
});

export const previewMetadataInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    videoId: z.string().min(1),
    editorialPrompt: z.string().min(1),
  })
  .strict();

export const previewMetadataOutputSchema = z
  .object({
    video: videoMetadataItemSchema,
    transcript: transcriptResultSchema,
    draft: metadataDraftSchema,
  })
  .strict();

/**
 * RISK-12 fix (2026-09-18, project-owner-approved BREAKING BEHAVIORAL CHANGE): `dryRun`
 * used to default to `false`, so omitting it from an `applyMetadata` call (via
 * `/api/video-metadata/apply` or the MCP `apply` tool) performed a REAL YouTube write.
 * This contradicted `docs/PROJECT_SPEC.md` §20 ("dryRun = true until the user explicitly
 * confirms a live operation") and the fail-safe default already established for the
 * newer batch pipeline (AC-DRYRUN-02). The default is now `true` -- omitting `dryRun`
 * is a preview, never a write. Any caller (the MCP `apply` tool included) that relied on
 * the old default to perform a live write without passing `dryRun: false` explicitly
 * will now get a dry-run preview instead and MUST be updated to pass `dryRun: false`
 * explicitly to keep writing live -- this is a deliberate, approved safety-first
 * behavior change, not a bug fix that preserves prior behavior.
 */
export const applyMetadataInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    videoId: z.string().min(1),
    finalTitle: z.string().min(1),
    description: z.string().min(1),
    expectedChannelId: z.string().min(1).optional(),
    dryRun: z.boolean().optional().default(true),
  })
  .strict();

const snippetRecordSchema = z.record(z.string(), z.unknown());
const localeMetadataSchema = z
  .object({
    title: z.string(),
    description: z.string(),
  })
  .strict();

const localeMetadataMapSchema = z.record(z.string(), localeMetadataSchema);

const metadataLanguageSourceSchema = z.enum(["defaultLanguage", "existing-localization"]);

export const applyMetadataOutputSchema = z
  .object({
    dryRun: z.boolean(),
    videoId: z.string().min(1),
    targetLanguage: z.string().min(1),
    languageSource: metadataLanguageSourceSchema,
    snippet: z
      .object({
        before: snippetRecordSchema,
        proposed: snippetRecordSchema,
      })
      .strict(),
    localizations: z
      .object({
        before: localeMetadataMapSchema,
        proposed: localeMetadataMapSchema,
        affected: z
          .array(
            z
              .object({
                locale: z.string().min(1),
                before: localeMetadataSchema.nullable(),
                proposed: localeMetadataSchema,
                source: metadataLanguageSourceSchema,
              })
              .strict()
          )
          .min(1),
      })
      .strict(),
  })
  .strict();

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
