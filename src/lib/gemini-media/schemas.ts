import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import {
  GEMINI_IMAGE_ASPECT_RATIOS,
  GEMINI_IMAGE_MODELS,
  GEMINI_JOB_STATUSES,
  GEMINI_LIMITS,
  GEMINI_PERSON_GENERATION,
  GEMINI_VIDEO_ASPECT_RATIOS,
  GEMINI_VIDEO_DURATIONS,
  GEMINI_VIDEO_MODELS,
  GEMINI_VIDEO_RESOLUTIONS,
  geminiInvalidParams,
  ownEntry,
} from "./contracts";

export { parseWithSchema };

// BL-174 (GEMINI_MEDIA_PLAN.md §2.5/§2.7): the shapes of the module's inputs. Shape errors are `validation_failed`;
// the per-model rules (`checkJobRules`) are `gemini_invalid_params` naming the field.

export const GEMINI_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const relativePath = z.string().min(1).max(500);

const imageBlockSchema = z
  .object({
    size: z.string().min(1).max(10),
    aspectRatio: z.string().min(1).max(10),
    inputs: z.object({ images: z.array(relativePath).max(GEMINI_LIMITS.inputImages).optional() }).strict().optional(),
  })
  .strict();

const videoBlockSchema = z
  .object({
    resolution: z.string().min(1).max(10),
    aspectRatio: z.string().min(1).max(10),
    durationSeconds: z.number().int(),
    personGeneration: z.enum(GEMINI_PERSON_GENERATION).optional(),
    inputs: z
      .object({
        firstFrame: relativePath.optional(),
        lastFrame: relativePath.optional(),
        referenceImages: z.array(relativePath).max(GEMINI_LIMITS.referenceImages).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const createJobInputSchema = z
  .object({
    channelId: z.string().trim().min(1).max(64),
    kind: z.enum(["image", "video"]),
    model: z.string().min(1).max(80),
    prompt: z.string().trim().min(1).max(GEMINI_LIMITS.imagePromptChars),
    requestId: z.string().regex(GEMINI_REQUEST_ID_PATTERN, "a request id: up to 120 letters, digits, '.', '_' or '-'").optional(),
    dryRun: z.boolean().optional(),
    image: imageBlockSchema.optional(),
    video: videoBlockSchema.optional(),
    /** BL-184 stage 2 (FO-REQ-0024 B4): the storyboard segment a video renders (both or neither; checked by the storyboard gate). */
    storyboardId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
    segmentId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
    /** BL-194 (ADR 0040): the channel's video number this job is for (`video` is the video's settings); omitted = its storyboard's. */
    videoNumber: z.string().regex(/^V[1-9][0-9]{0,5}$/, "a video number such as V49").optional(),
  })
  .strict();

export type CreateJobInput = z.infer<typeof createJobInputSchema>;

export const getJobsInputSchema = z
  .object({
    jobId: z.string().min(1).max(80).optional(),
    channelId: z.string().trim().min(1).max(64).optional(),
    status: z.enum(GEMINI_JOB_STATUSES).optional(),
    limit: z.number().int().min(1).max(GEMINI_LIMITS.listMax).optional(),
  })
  .strict();

const usd = z.number().gt(0).max(10_000);

export const updateSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    maxUsdPerJob: usd,
    maxUsdPerDay: usd,
    maxUsdPerMonth: usd,
    maxActiveJobs: z.number().int().min(1).max(100),
  })
  .partial()
  .strict();

export const setKeyInputSchema = z
  .object({ apiKey: z.string().trim().min(20, "the key looks too short").max(200).regex(/^[\x21-\x7E]+$/, "a key is printable ASCII without spaces") })
  .strict();

/** The per-model rules (§2.5), checked before anything is read, stored or sent. */
export function checkJobRules(input: CreateJobInput): void {
  if ((input.storyboardId === undefined) !== (input.segmentId === undefined)) throw geminiInvalidParams("storyboardId", "storyboardId and segmentId go together (the storyboard segment this video renders).");
  if (input.kind === "image" && input.storyboardId !== undefined) throw geminiInvalidParams("storyboardId", "A storyboard segment is rendered as a video, not an image.");
  if (input.kind === "image") {
    const spec = ownEntry(GEMINI_IMAGE_MODELS, input.model);
    if (!spec) throw geminiInvalidParams("model", `${input.model} is not an image model here (${Object.keys(GEMINI_IMAGE_MODELS).join(", ")}).`);
    if (input.video) throw geminiInvalidParams("video", "An image job takes `image`, not `video`.");
    if (!input.image) throw geminiInvalidParams("image", "An image job needs `image` { size, aspectRatio }.");
    if (ownEntry(spec.sizes, input.image.size) === undefined) throw geminiInvalidParams("image.size", `${input.model} offers sizes ${Object.keys(spec.sizes).join(", ")} (uppercase K).`);
    if (!(GEMINI_IMAGE_ASPECT_RATIOS as readonly string[]).includes(input.image.aspectRatio)) {
      throw geminiInvalidParams("image.aspectRatio", `Aspect ratio must be one of ${GEMINI_IMAGE_ASPECT_RATIOS.join(", ")}.`);
    }
    return;
  }
  const spec = ownEntry(GEMINI_VIDEO_MODELS, input.model);
  if (!spec) throw geminiInvalidParams("model", `${input.model} is not a video model here (${Object.keys(GEMINI_VIDEO_MODELS).join(", ")}).`);
  if (input.image) throw geminiInvalidParams("image", "A video job takes `video`, not `image`.");
  if (!input.video) throw geminiInvalidParams("video", "A video job needs `video` { resolution, aspectRatio, durationSeconds }.");
  const video = input.video;
  if (input.prompt.length > GEMINI_LIMITS.videoPromptChars) throw geminiInvalidParams("prompt", `A video prompt is at most ${GEMINI_LIMITS.videoPromptChars} characters.`);
  if (!(GEMINI_VIDEO_ASPECT_RATIOS as readonly string[]).includes(video.aspectRatio)) throw geminiInvalidParams("video.aspectRatio", "Video aspect ratio is 16:9 or 9:16.");
  if (!(GEMINI_VIDEO_RESOLUTIONS as readonly string[]).includes(video.resolution) || ownEntry(spec.perSecond, video.resolution) === undefined) {
    throw geminiInvalidParams("video.resolution", `${input.model} offers ${Object.keys(spec.perSecond).join(", ")}.`);
  }
  if (!(GEMINI_VIDEO_DURATIONS as readonly number[]).includes(video.durationSeconds)) throw geminiInvalidParams("video.durationSeconds", "Duration is 4, 6 or 8 seconds.");
  if (spec.transport === "veo" && video.resolution !== "720p" && video.durationSeconds !== 8) throw geminiInvalidParams("video.durationSeconds", "1080p and 4k need an 8-second video.");
  const inputs = video.inputs ?? {};
  if (inputs.lastFrame && !inputs.firstFrame) throw geminiInvalidParams("video.inputs.lastFrame", "A last frame needs a first frame.");
  if (spec.transport === "interactions" && video.personGeneration) {
    throw geminiInvalidParams("video.personGeneration", `${input.model} has no personGeneration setting (describe people in the prompt).`);
  }
  if (inputs.referenceImages && inputs.referenceImages.length > 0) {
    if (!spec.referenceImages) throw geminiInvalidParams("video.inputs.referenceImages", `${input.model} takes no reference images.`);
    if (video.durationSeconds !== 8) throw geminiInvalidParams("video.durationSeconds", "Reference images need an 8-second video.");
    if (inputs.firstFrame) throw geminiInvalidParams("video.inputs.referenceImages", "Reference images are not combined with a first frame.");
  }
  // BL-179 (FO-REQ-0021): refused before any call (free) -- Veo's `predictLongRunning` rejects frames with a 400, and its
  // previews shut down on 2026-10-22; Omni takes them.
  if ((inputs.firstFrame || inputs.lastFrame) && !spec.frames) {
    const withFrames = Object.entries(GEMINI_VIDEO_MODELS).filter(([, s]) => s.frames).map(([model]) => model);
    throw geminiInvalidParams("video.inputs.firstFrame", `${input.model} does not take first/last frames here (Google accepts them for Veo only through generateContent); use ${withFrames.join(" or ")}.`);
  }
}
