import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { hasSCode, VIDEO_CODE_PATTERN } from "@/lib/shared-video-code";

export { DomainError, isDomainError };

// BL-194 stage 1 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2, ADR 0040): the video numbers (`Vn`) this computer reserved, as a
// per-device report (the ADR 0028 pattern): each computer writes only its OWN reservations and keeps the latest report of every
// peer, so no file is edited by two computers. The rules that turn the reports into the list of videos and its conflicts belong to
// `src/lib/video-projects` (this family imports nothing from it).

/** The one constant key this family is synced under (one report per device). */
export const GLOBAL_DOCUMENT_KEY = "global";
export const VIDEO_RESERVATIONS_REPORT_FORMAT = "ytm-video-reservations";
/**
 * BL-263 (plan §5): the newest version this build reads. A report is written as version 2 only when it holds an S code
 * (`reportVersionFor`), else version 1 exactly as before, so an older build keeps reading every V-only report.
 */
export const VIDEO_RESERVATIONS_REPORT_VERSION = 2;
/** A generous bound (a channel makes a few videos a week; a released number stays listed for good), not a working limit. */
export const VIDEO_RESERVATIONS_REPORT_MAX = 20_000;

/** BL-263: a video code -- `V1`, `V49` or `S14`: the series letter and a number without leading zeros (`src/lib/shared-video-code`). */
export const VIDEO_NUMBER_PATTERN = VIDEO_CODE_PATTERN;
const iso = z.string().datetime({ offset: true });

export const sharedVideoReservationSchema = z
  .object({
    channelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    video: z.string().regex(VIDEO_NUMBER_PATTERN),
    workingTitle: z.string().max(200).nullable(),
    reservedAt: iso,
    /** `cancelled`: given up on this computer (also when it was renumbered after a conflict); the number is never reused. */
    state: z.enum(["in_work", "cancelled"]),
    cancelledAt: iso.nullable(),
    /** The number this computer took instead, after losing a duplicate (null otherwise). */
    replacedBy: z.string().regex(VIDEO_NUMBER_PATTERN).nullable(),
  })
  .strict();

export const videoReservationsReportSchema = z
  .object({
    format: z.literal(VIDEO_RESERVATIONS_REPORT_FORMAT),
    version: z.union([z.literal(1), z.literal(2)]),
    deviceId: z.string().min(1).max(128),
    /** The computer's name as the owner knows it ("Mac", a host name), or null. */
    hostName: z.string().max(255).nullable(),
    updatedAt: iso,
    reservations: z.array(sharedVideoReservationSchema).max(VIDEO_RESERVATIONS_REPORT_MAX),
  })
  .strict()
  .refine((r) => r.version === 2 || !hasSCode(r.reservations.flatMap((x) => [x.video, x.replacedBy])), { message: "a version 1 report holds no S code" });

export type SharedVideoReservation = z.infer<typeof sharedVideoReservationSchema>;
export type VideoReservationsReport = z.infer<typeof videoReservationsReportSchema>;
