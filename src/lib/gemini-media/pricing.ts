import { ceil4 } from "@/lib/shared-money";
import { GEMINI_IMAGE_MODELS, GEMINI_LIMITS, GEMINI_VIDEO_MODELS, ownEntry } from "./contracts";

// BL-174 (GEMINI_MEDIA_PLAN.md §2.3): estimates before a call and costs after it, from the official price table
// (`GEMINI_PRICES_AS_OF`). Pure. Every amount goes through `ceil4` (USD, 4 decimals, rounded up).

const PER_M = 1_000_000;

export function estimateImageUsd(args: { model: string; size: string; promptChars: number; inputImages: number }): number {
  const spec = ownEntry(GEMINI_IMAGE_MODELS, args.model);
  const imageTokens = spec ? ownEntry(spec.sizes, args.size) : undefined;
  if (!spec || imageTokens === undefined) throw new Error(`no price for ${args.model} ${args.size}`);
  const inputTokens = Math.ceil(args.promptChars / 3) + GEMINI_LIMITS.inputImageTokens * args.inputImages;
  return ceil4((imageTokens * spec.imageOutPerM + inputTokens * spec.inputPerM + GEMINI_LIMITS.thinkingAllowanceTokens * spec.textOutPerM) / PER_M);
}

export function estimateVideoUsd(args: { model: string; resolution: string; durationSeconds: number; promptChars?: number; inputImages?: number }): number {
  const spec = ownEntry(GEMINI_VIDEO_MODELS, args.model);
  const perSecond = spec ? ownEntry(spec.perSecond, args.resolution) : undefined;
  if (!spec || perSecond === undefined) throw new Error(`no price for ${args.model} ${args.resolution}`);
  const tokens = spec.tokenPricing;
  if (!tokens) return ceil4(perSecond * args.durationSeconds);
  // BL-179 (Omni): billed by tokens -- the video at the video rate, the prompt and frames at the input rate, and thinking (as
  // for the image models) at the text rate.
  const videoTokens = ownEntry(tokens.videoTokensPerSecond, args.resolution);
  if (videoTokens === undefined) throw new Error(`no price for ${args.model} ${args.resolution}`);
  const inputTokens = Math.ceil((args.promptChars ?? 0) / 3) + GEMINI_LIMITS.inputImageTokens * (args.inputImages ?? 0);
  return ceil4((videoTokens * args.durationSeconds * tokens.videoOutPerM + inputTokens * tokens.inputPerM + GEMINI_LIMITS.thinkingAllowanceTokens * tokens.textOutPerM) / PER_M);
}

/**
 * BL-179: the cost of a finished Omni call from Google's own token counts -- all input at the input rate, text output and
 * thinking at the text rate, every other output token (video, and the audio Omni always makes) at the video rate. Never
 * under-counted (review item 2): the output total is at least the sum of its modality split, and a call that saved a video
 * costs at least that video's table price (`videoCostFloor`) -- a renamed or missing count can only raise the price, never
 * lower it to the input alone.
 */
export function videoCostFromUsage(
  model: string,
  usage: { inputTokens: number; outputTokens: number; thoughtTokens: number; outputByModality: Record<string, number> },
  saved: { resolution: string; durationSeconds: number } | null
): number {
  const tokens = ownEntry(GEMINI_VIDEO_MODELS, model)?.tokenPricing;
  if (!tokens) throw new Error(`no token prices for ${model}`);
  const splitTotal = Object.values(usage.outputByModality).reduce((sum, n) => sum + n, 0);
  const totalOut = Math.max(usage.outputTokens, splitTotal);
  const textOut = Math.min(totalOut, ownEntry(usage.outputByModality, "text") ?? 0);
  const mediaOut = totalOut - textOut;
  const counted = ceil4((usage.inputTokens * tokens.inputPerM + mediaOut * tokens.videoOutPerM + (textOut + usage.thoughtTokens) * tokens.textOutPerM) / PER_M);
  return saved ? Math.max(counted, videoCostFloor(model, saved.resolution, saved.durationSeconds)) : counted;
}

/** The table price of a saved Omni video alone: its seconds x the video tokens per second x the video rate. */
export function videoCostFloor(model: string, resolution: string, durationSeconds: number): number {
  const tokens = ownEntry(GEMINI_VIDEO_MODELS, model)?.tokenPricing;
  const perSecond = tokens ? ownEntry(tokens.videoTokensPerSecond, resolution) : undefined;
  if (!tokens || perSecond === undefined) throw new Error(`no token prices for ${model} ${resolution}`);
  return ceil4((perSecond * durationSeconds * tokens.videoOutPerM) / PER_M);
}

/**
 * The cost of a finished image call from Google's own token counts: all input at the input rate, image-modality output at
 * the image rate, every other output token and every thought token at the text rate. When images came back but Google did
 * not split the output by modality, every output token is priced at the image rate (review round 1: never under-count).
 */
export function imageCostFromUsage(
  model: string,
  usage: { inputTokens: number; outputTokens: number; thoughtTokens: number; outputByModality: Record<string, number> },
  imagesSaved = 0
): number {
  const spec = ownEntry(GEMINI_IMAGE_MODELS, model);
  if (!spec) throw new Error(`no price for ${model}`);
  const split = ownEntry(usage.outputByModality, "image") ?? 0;
  const imageOut = imagesSaved > 0 && split <= 0 ? usage.outputTokens : split;
  const otherOut = Math.max(0, usage.outputTokens - imageOut);
  return ceil4((usage.inputTokens * spec.inputPerM + imageOut * spec.imageOutPerM + (otherOut + usage.thoughtTokens) * spec.textOutPerM) / PER_M);
}

/** Without Google's counts: the table's per-image price for each image saved. */
export function imageCostFromTable(model: string, size: string, images: number): number {
  const spec = ownEntry(GEMINI_IMAGE_MODELS, model);
  const imageTokens = spec ? ownEntry(spec.sizes, size) : undefined;
  if (!spec || imageTokens === undefined) throw new Error(`no price for ${model} ${size}`);
  return ceil4((imageTokens * spec.imageOutPerM * images) / PER_M);
}

/** The model catalog with prices, for the operator's status read. */
export function modelCatalog() {
  return [
    ...Object.entries(GEMINI_IMAGE_MODELS).map(([model, spec]) => ({
      model,
      kind: "image" as const,
      label: spec.label,
      sizes: Object.keys(spec.sizes),
      usdPerImage: Object.fromEntries(Object.entries(spec.sizes).map(([size, tokens]) => [size, ceil4((tokens * spec.imageOutPerM) / PER_M)])),
      usdPerMillionTokens: { input: spec.inputPerM, textAndThinkingOutput: spec.textOutPerM, imageOutput: spec.imageOutPerM },
    })),
    ...Object.entries(GEMINI_VIDEO_MODELS).map(([model, spec]) => ({
      model,
      kind: "video" as const,
      label: spec.label,
      resolutions: Object.keys(spec.perSecond),
      // An Omni price per second is an estimate (billed by tokens, `usdPerMillionTokens`); rounded up like every amount.
      usdPerSecond: Object.fromEntries(Object.entries(spec.perSecond).map(([resolution, usd]) => [resolution, ceil4(usd)])),
      referenceImages: spec.referenceImages,
      // BL-179 (FO-REQ-0021): whether first/last frames are accepted, and Google's announced shutdown date.
      frames: spec.frames,
      retiresOn: spec.retiresOn ?? null,
      ...(spec.tokenPricing
        ? { usdPerMillionTokens: { input: spec.tokenPricing.inputPerM, textAndThinkingOutput: spec.tokenPricing.textOutPerM, videoOutput: spec.tokenPricing.videoOutPerM } }
        : {}),
    })),
  ];
}
