import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import { ELEVENLABS_JOB_STATUSES, ELEVENLABS_LIMITS, ELEVENLABS_OUTPUT_FORMATS, ELEVENLABS_SPEECH_MODELS, charCount, elevenlabsInvalidParams, ownEntry } from "./contracts";

export { parseWithSchema };

// BL-236 (ADR 0057): the module's inputs. Text only -- no field takes audio, a file or a URL (strict schemas: no voice is ever
// cloned). Shape errors are `validation_failed`; the per-model rules (`checkJobRules`) `elevenlabs_invalid_params`.

export const ELEVENLABS_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export const createJobInputSchema = z
  .object({
    channelId: z.string().trim().min(1).max(64),
    voice: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(ELEVENLABS_LIMITS.maxTextChars),
    model: z.string().min(1).max(80).optional(),
    outputFormat: z.enum(ELEVENLABS_OUTPUT_FORMATS).optional(),
    requestId: z.string().regex(ELEVENLABS_REQUEST_ID_PATTERN, "a request id: up to 120 letters, digits, '.', '_' or '-'").optional(),
    dryRun: z.boolean().optional(),
    videoNumber: z.string().regex(/^V[1-9][0-9]{0,5}$/, "a video number such as V49").optional(),
  })
  .strict();

export type CreateJobInput = z.infer<typeof createJobInputSchema>;

export const designVoiceInputSchema = z
  .object({
    channelId: z.string().trim().min(1).max(64),
    description: z.string().trim().min(1).max(ELEVENLABS_LIMITS.descriptionMaxChars),
    previewText: z.string().trim().min(ELEVENLABS_LIMITS.previewTextMinChars).max(ELEVENLABS_LIMITS.previewTextMaxChars).optional(),
    count: z.number().int().min(1).max(ELEVENLABS_LIMITS.maxPreviews).optional(),
  })
  .strict();

export const getJobsInputSchema = z
  .object({
    jobId: z.string().min(1).max(80).optional(),
    channelId: z.string().trim().min(1).max(64).optional(),
    status: z.enum(ELEVENLABS_JOB_STATUSES).optional(),
    limit: z.number().int().min(1).max(ELEVENLABS_LIMITS.listMax).optional(),
  })
  .strict();

const chars = z.number().int().min(1).max(10_000_000);

export const updateSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    maxCharsPerJob: chars,
    maxCharsPerDay: chars,
    maxCharsPerMonth: chars,
    maxActiveJobs: z.number().int().min(1).max(50),
    outputFormat: z.enum(ELEVENLABS_OUTPUT_FORMATS),
  })
  .partial()
  .strict();

export const setKeyInputSchema = z
  .object({ apiKey: z.string().trim().min(20, "the key looks too short").max(200).regex(/^[\x21-\x7E]+$/, "a key is printable ASCII without spaces") })
  .strict();

/** A known model, and a text within that model's own character limit. */
export function checkJobRules(input: CreateJobInput, model: string): void {
  const spec = ownEntry(ELEVENLABS_SPEECH_MODELS, model);
  if (!spec) throw elevenlabsInvalidParams("model", `${model} is not a speech model here (${Object.keys(ELEVENLABS_SPEECH_MODELS).join(", ")}).`);
  if (charCount(input.text) > spec.maxChars) throw elevenlabsInvalidParams("text", `${model} takes at most ${spec.maxChars} characters in one take.`);
}
