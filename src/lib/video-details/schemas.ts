import { z } from "zod";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";
export { parseWithSchema, formatZodError } from "./contracts";

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

export const getSnapshotInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    expectedChannelId: z.string().min(1),
    videoId: z.string().min(1),
  })
  .strict();

export const previewFieldsUpdateInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    expectedChannelId: z.string().min(1),
    videoId: z.string().min(1),
    patch: videoDetailsPatchSchema,
  })
  .strict();

export const applyFieldsUpdateInputSchema = previewFieldsUpdateInputSchema.extend({
  // Optional, but strongly recommended for any UI caller: the `etag` the operator's diff was
  // actually shown against. If the video changed on YouTube between preview and this call, the
  // freshly-fetched `before.etag` will differ -- reject rather than silently apply a patch the
  // operator never actually saw a correct diff for (AGENTS.md §G's "approval" requirement means
  // approving *this* diff, not whatever the video happens to look like now).
  expectedEtag: z.string().min(1).optional(),
});

export type VideoDetailsPatchInput = z.infer<typeof videoDetailsPatchSchema>;
export type GetSnapshotInput = z.infer<typeof getSnapshotInputSchema>;
export type PreviewFieldsUpdateInput = z.infer<typeof previewFieldsUpdateInputSchema>;
export type ApplyFieldsUpdateInput = z.infer<typeof applyFieldsUpdateInputSchema>;
