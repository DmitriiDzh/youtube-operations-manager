import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { hasSCode, isReportVCode, isStrictSCode } from "@/lib/shared-video-code";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 items 5–6; ADR 0037 §4 "a per-device record stops two computers from starting the
// same package"): the per-device report of the uploads this computer has under way (ADR 0028 pattern). Each computer publishes
// its own; the other computer refuses to approve a package a peer is uploading. Strict and narrow: a channel id, a video number
// and a state -- no title, path or error text. Defined here: sync-gateway imports nothing from publishing.
// ---------------------------------------------------------------------------

export const GLOBAL_DOCUMENT_KEY = "global";
export const PUBLISHING_UPLOADS_REPORT_FORMAT = "ytm-publishing-uploads";
/** BL-263 (plan §5): the newest version this build reads; written as 2 only when the report holds an S code, else 1 as before. */
export const PUBLISHING_UPLOADS_REPORT_VERSION = 2;

export const sharedUploadSchema = z
  .object({
    channelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    /** Today's `V\d{1,6}` (kept: no V row valid before turns invalid) or a strict S code (BL-263). */
    video: z.string().refine((v) => isReportVCode(v) || isStrictSCode(v), { message: "a video code such as V49 or S14" }),
    /** "uploaded": finished (or failed) with a video on YouTube -- the package stays taken. */
    state: z.enum(["queued", "uploading", "processing", "finishing", "paused", "uploaded"]),
  })
  .strict();

export const publishingUploadsReportSchema = z
  .object({
    format: z.literal(PUBLISHING_UPLOADS_REPORT_FORMAT),
    version: z.union([z.literal(1), z.literal(2)]),
    deviceId: z.string().min(1).max(128),
    /** The computer's own name, shown as "uploading on <host>". */
    hostName: z.string().regex(/^[\p{L}\p{N} ._'-]{1,64}$/u).nullable(),
    updatedAt: z.string().datetime(),
    uploads: z.array(sharedUploadSchema).max(500),
  })
  .strict()
  .refine((r) => r.version === 2 || !hasSCode(r.uploads.map((u) => u.video)), { message: "a version 1 report holds no S code" });

export type SharedUpload = z.infer<typeof sharedUploadSchema>;
export type PublishingUploadsReport = z.infer<typeof publishingUploadsReportSchema>;
