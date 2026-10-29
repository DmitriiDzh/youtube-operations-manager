import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import { VOICE_LIMITS, VOICE_PROVIDERS } from "./contracts";

export { parseWithSchema };

// BL-236 (ADR 0057): the registry's inputs. A design takes a text description only -- no field accepts audio, a file or a URL
// (the schemas are strict, so an extra `audio` / `referenceAudio` field is refused: no voice is ever cloned).

const channelId = z.string().trim().min(1).max(64);
const voiceId = z.string().regex(/^vc_[A-Za-z0-9_-]{1,80}$/, "a voice id such as vc_…");
const name = z.string().trim().min(1).max(VOICE_LIMITS.nameChars).regex(/^[^\u0000-\u001f]+$/, "a name without control characters");

export const designVoiceSchema = z
  .object({
    channelId,
    provider: z.enum(VOICE_PROVIDERS),
    name,
    description: z.string().trim().min(10, "describe the voice in a sentence or more").max(VOICE_LIMITS.descriptionChars),
    previewText: z.string().trim().min(1).max(VOICE_LIMITS.previewTextChars).optional(),
    previews: z.number().int().min(1).max(VOICE_LIMITS.maxPreviews).optional(),
    model: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const approveVoiceSchema = z.object({ channelId, voiceId, previewId: z.string().regex(/^p[1-9][0-9]?$/) }).strict();

export const updateVoiceSchema = z
  .object({ channelId, voiceId, name: name.optional(), archived: z.literal(true).optional() })
  .strict()
  .refine((input) => input.name !== undefined || input.archived !== undefined, { message: "give a new name or archived: true" });

export const listVoicesSchema = z
  .object({ channelId, provider: z.enum(VOICE_PROVIDERS).optional(), includeArchived: z.boolean().optional() })
  .strict();
