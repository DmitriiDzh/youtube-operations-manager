import { z, ZodError } from "zod";
import { DomainError } from "./contracts";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";

/** YouTube counts `description` in bytes (UTF-8), not JS string length -- an emoji or
 * non-Latin title/description can hit this limit well before 5000 characters. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const videoDetailsPatchSchema = z
  .object({
    title: z.string().min(1).max(100).optional(),
    description: z
      .string()
      .max(5000)
      .refine((value) => byteLength(value) <= 5000, {
        message: "description must be at most 5000 bytes (UTF-8), not just 5000 characters",
      })
      .optional(),
    tags: z
      .array(z.string().min(1))
      .refine(
        (tags) => {
          // Mirrors YouTube's own accounting: each tag containing a space is quote-wrapped,
          // and tags are joined with commas -- both count toward the 500-character budget.
          const assembled = tags
            .map((tag) => (tag.includes(" ") ? `"${tag}"` : tag))
            .join(",");
          return assembled.length <= 500;
        },
        { message: "tags must fit within YouTube's combined 500-character budget (commas and quoting included)" }
      )
      .optional(),
    categoryId: z.string().min(1).optional(),
    defaultLanguage: z.string().min(1).optional(),
    privacyStatus: z.enum(["private", "public", "unlisted"]).optional(),
    publishAt: z.string().min(1).optional(),
    license: z.enum(["youtube", "creativeCommon"]).optional(),
    embeddable: z.boolean().optional(),
    publicStatsViewable: z.boolean().optional(),
    selfDeclaredMadeForKids: z.boolean().optional(),
    containsSyntheticMedia: z.boolean().optional(),
    recordingDate: z.string().min(1).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "patch must include at least one field to update",
  })
  .refine(
    (patch) => !("publishAt" in patch) || patch.privacyStatus === "private",
    {
      // YouTube only accepts `status.publishAt` in the same request that sets
      // `status.privacyStatus: "private"` -- a schema-level rule, not a runtime hope, per
      // review: encoding this here means an invalid patch never reaches the network at all.
      message: "publishAt can only be set together with privacyStatus: \"private\" in the same patch",
      path: ["publishAt"],
    }
  );

export const previewFieldsUpdateInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    expectedChannelId: z.string().min(1),
    videoId: z.string().min(1),
    patch: videoDetailsPatchSchema,
  })
  .strict();

export const applyFieldsUpdateInputSchema = previewFieldsUpdateInputSchema;

export type VideoDetailsPatchInput = z.infer<typeof videoDetailsPatchSchema>;
export type PreviewFieldsUpdateInput = z.infer<typeof previewFieldsUpdateInputSchema>;
export type ApplyFieldsUpdateInput = z.infer<typeof applyFieldsUpdateInputSchema>;

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
