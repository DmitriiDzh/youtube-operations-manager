import { DomainError } from "@/lib/shared-domain";

// ---------------------------------------------------------------------------
// BL-236 (FO-REQ-0050, ADR 0057, docs/roadmap/plans/SUMIRE_VOICE_PLAN.md): a channel's designed voices -- the small registry the
// speech providers speak with. A shared module (AGENTS.md §M): it never imports a provider module (gemini-media,
// elevenlabs-speech); the providers are injected as ports (`VoiceProviderPort`, wired in `src/composition/speech.ts`) and the
// providers use the registry only through its resolver. Designed voices only -- nothing here takes, stores or sends recorded
// audio of a person (owner, Telegram 2026-10-29 msg 3816: no cloning anywhere).
// ---------------------------------------------------------------------------

export const VOICE_PROVIDERS = ["gemini", "elevenlabs"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export const VOICE_STATUSES = ["draft", "approved", "archived"] as const;
export type VoiceStatus = (typeof VOICE_STATUSES)[number];

export const VOICE_LIMITS = Object.freeze({
  nameChars: 60,
  descriptionChars: 1000,
  previewTextChars: 500,
  /** Previews per design: ElevenLabs returns up to 3 in one call; each Gemini preview is its own designed voice (project limit 200). */
  maxPreviews: 3,
  listMax: 200,
});

/** The folder of a voice's previews under the channel's `99 Data Exchange/From YTM/`: `<provider>/voices/<voiceId>/`. */
export const VOICE_PREVIEWS_SUBDIR = "voices";

export type VoicePreview = {
  previewId: string;
  /** Relative to the channel's `99 Data Exchange/From YTM/`, `/` separators: `gemini/voices/<voiceId>/preview-1.wav`. */
  file: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  sampleRateHz: number | null;
  durationSeconds: number | null;
  /** The provider's handle of this preview (Gemini: the designed voice's id; ElevenLabs: the generated voice id to save). */
  providerRef: string;
  /** The provider's job that recorded the paid design (null when the provider records none). */
  jobId: string | null;
};

export type VoiceView = {
  voiceId: string;
  channelId: string;
  name: string;
  provider: VoiceProvider;
  /** The id the provider speaks with: set once a preview is approved; null for a draft. */
  providerVoiceId: string | null;
  description: string;
  model: string | null;
  status: VoiceStatus;
  previews: VoicePreview[];
  approvedPreviewId: string | null;
  /** Review item 2: why a design failed (the voice archived) or why some previews were not written (still a draft); null = none. */
  error: string | null;
  createdAt: string;
  createdBy: string;
  approvedAt: string | null;
  approvedBy: string | null;
  updatedAt: string;
};

/** One designed preview as a provider returns it: the audio as a file to keep and the handle to approve it with. */
export type DesignedPreview = {
  providerRef: string;
  audio: { data: Buffer; extension: string; mimeType: string; sampleRateHz: number | null; durationSeconds: number | null };
  jobId: string | null;
};

/**
 * A speech provider as the registry needs it (injected, AGENTS.md §M). `design` is PAID: the provider passes its own switch, key and
 * limits and records the spend. `save` turns an approved preview into the voice the provider speaks with (ElevenLabs: saves the
 * generated voice and returns its `voice_id`; Gemini: the preview's own voice id).
 */
export type VoiceProviderPort = {
  design(input: { channelId: string; name: string; description: string; previewText: string | null; count: number; model: string | null }, actor: string): Promise<{ previews: DesignedPreview[]; model: string | null }>;
  save(input: { channelId: string; name: string; description: string; providerRef: string }): Promise<{ providerVoiceId: string }>;
};

export function voiceNotFound(voiceId: string): DomainError {
  return new DomainError({ code: "voice_not_found", message: `No voice ${voiceId} on this channel.`, details: { voiceId } });
}
