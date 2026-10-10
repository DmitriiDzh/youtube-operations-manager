import { ceil4 } from "@/lib/shared-money";
import { GEMINI_IMAGE_MODELS, GEMINI_LIMITS, GEMINI_VIDEO_MODELS } from "./contracts";

// BL-174 (GEMINI_MEDIA_PLAN.md §2.3): estimates before a call and costs after it, from the official price table
// (`GEMINI_PRICES_AS_OF`). Pure. Every amount goes through `ceil4` (USD, 4 decimals, rounded up).

const PER_M = 1_000_000;

export function estimateImageUsd(args: { model: string; size: string; promptChars: number; inputImages: number }): number {
  const spec = GEMINI_IMAGE_MODELS[args.model];
  const imageTokens = spec?.sizes[args.size];
  if (!spec || imageTokens === undefined) throw new Error(`no price for ${args.model} ${args.size}`);
  const inputTokens = Math.ceil(args.promptChars / 3) + GEMINI_LIMITS.inputImageTokens * args.inputImages;
  return ceil4((imageTokens * spec.imageOutPerM + inputTokens * spec.inputPerM + GEMINI_LIMITS.thinkingAllowanceTokens * spec.textOutPerM) / PER_M);
}

export function estimateVideoUsd(args: { model: string; resolution: string; durationSeconds: number }): number {
  const perSecond = GEMINI_VIDEO_MODELS[args.model]?.perSecond[args.resolution];
  if (perSecond === undefined) throw new Error(`no price for ${args.model} ${args.resolution}`);
  return ceil4(perSecond * args.durationSeconds);
}

/**
 * The cost of a finished image call from Google's own token counts: all input at the input rate, image-modality output at
 * the image rate, every other output token and every thought token at the text rate.
 */
export function imageCostFromUsage(model: string, usage: { inputTokens: number; outputTokens: number; thoughtTokens: number; outputByModality: Record<string, number> }): number {
  const spec = GEMINI_IMAGE_MODELS[model];
  if (!spec) throw new Error(`no price for ${model}`);
  const imageOut = usage.outputByModality.image ?? 0;
  const otherOut = Math.max(0, usage.outputTokens - imageOut);
  return ceil4((usage.inputTokens * spec.inputPerM + imageOut * spec.imageOutPerM + (otherOut + usage.thoughtTokens) * spec.textOutPerM) / PER_M);
}

/** Without Google's counts: the table's per-image price for each image saved. */
export function imageCostFromTable(model: string, size: string, images: number): number {
  const spec = GEMINI_IMAGE_MODELS[model];
  const imageTokens = spec?.sizes[size];
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
      usdPerSecond: { ...spec.perSecond },
      referenceImages: spec.referenceImages,
    })),
  ];
}
