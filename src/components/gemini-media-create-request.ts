import { ceil4 } from "@/lib/shared-money";

// BL-188 stage 4 (SHARED_MEDIA_JOBS_PLAN.md §5 item 4, owner msg 2806 Q3): the owner's Gemini form in Media -> the request the
// Gemini module takes (the same body for a job on this computer and for one sent to another computer). Pure, for its test. It
// checks only what the form itself can know (a model of the tab's kind, a setting the model offers, paths that are relative);
// the Gemini module of the computer that runs the job checks everything again, with its own switch, key and limits.

export type GeminiCatalogModel =
  | { model: string; kind: "image"; label: string; sizes: string[]; usdPerImage: Record<string, number> }
  | { model: string; kind: "video"; label: string; resolutions: string[]; usdPerSecond: Record<string, number>; referenceImages: boolean; frames: boolean; retiresOn: string | null };

export const GEMINI_FORM_IMAGE_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export const GEMINI_FORM_VIDEO_ASPECTS = ["16:9", "9:16"] as const;
export const GEMINI_FORM_DURATIONS = [4, 6, 8] as const;
export const GEMINI_FORM_MAX_REFERENCE_IMAGES = { image: 14, video: 3 } as const;

export type GeminiFormState = {
  model: string;
  prompt: string;
  /** image */
  size: string;
  aspectRatio: string;
  /** One path per line, relative to the channel's `99 Data Exchange/Sent to YTM/`. */
  referenceImages: string;
  /** video */
  resolution: string;
  durationSeconds: number;
  firstFrame: string;
  lastFrame: string;
  storyboardId: string;
  segmentId: string;
};

export type GeminiRequest = {
  kind: "image" | "video";
  model: string;
  prompt: string;
  image?: { size: string; aspectRatio: string; inputs?: { images: string[] } };
  video?: { resolution: string; aspectRatio: string; durationSeconds: number; inputs?: { firstFrame?: string; lastFrame?: string; referenceImages?: string[] } };
  storyboardId?: string;
  segmentId?: string;
};

/** Which field is wrong, for the form's message (each maps to a text key in the component). */
export type GeminiFormProblem = "model" | "prompt" | "size" | "aspectRatio" | "resolution" | "duration" | "path" | "references" | "frames" | "lastFrame" | "storyboard";

/** A path the form accepts: relative, `/` between folders, no `..` (the executor proves it is inside `Sent to YTM/` itself). */
export function isRelativeInputPath(path: string): boolean {
  return path.length > 0 && path.length <= 500 && !path.includes("\\") && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

const ID = /^[A-Za-z0-9_-]{1,40}$/;

export function buildGeminiRequest(kind: "image" | "video", form: GeminiFormState, catalog: readonly GeminiCatalogModel[]): { ok: true; request: GeminiRequest } | { ok: false; problem: GeminiFormProblem } {
  const spec = catalog.find((m) => m.model === form.model && m.kind === kind);
  if (!spec) return { ok: false, problem: "model" };
  const prompt = form.prompt.trim();
  if (!prompt || prompt.length > 10_000) return { ok: false, problem: "prompt" };
  const refs = lines(form.referenceImages);
  if (refs.some((p) => !isRelativeInputPath(p))) return { ok: false, problem: "path" };
  if (spec.kind === "image") {
    if (!spec.sizes.includes(form.size)) return { ok: false, problem: "size" };
    if (!(GEMINI_FORM_IMAGE_ASPECTS as readonly string[]).includes(form.aspectRatio)) return { ok: false, problem: "aspectRatio" };
    if (refs.length > GEMINI_FORM_MAX_REFERENCE_IMAGES.image) return { ok: false, problem: "references" };
    return { ok: true, request: { kind, model: spec.model, prompt, image: { size: form.size, aspectRatio: form.aspectRatio, ...(refs.length ? { inputs: { images: refs } } : {}) } } };
  }
  if (!spec.resolutions.includes(form.resolution)) return { ok: false, problem: "resolution" };
  if (!(GEMINI_FORM_VIDEO_ASPECTS as readonly string[]).includes(form.aspectRatio)) return { ok: false, problem: "aspectRatio" };
  if (!(GEMINI_FORM_DURATIONS as readonly number[]).includes(form.durationSeconds)) return { ok: false, problem: "duration" };
  const firstFrame = form.firstFrame.trim();
  const lastFrame = form.lastFrame.trim();
  if ((firstFrame && !isRelativeInputPath(firstFrame)) || (lastFrame && !isRelativeInputPath(lastFrame))) return { ok: false, problem: "path" };
  if ((firstFrame || lastFrame) && !spec.frames) return { ok: false, problem: "frames" };
  if (lastFrame && !firstFrame) return { ok: false, problem: "lastFrame" };
  if (refs.length > 0 && (!spec.referenceImages || refs.length > GEMINI_FORM_MAX_REFERENCE_IMAGES.video || firstFrame)) return { ok: false, problem: "references" };
  const storyboardId = form.storyboardId.trim();
  const segmentId = form.segmentId.trim();
  if (Boolean(storyboardId) !== Boolean(segmentId) || (storyboardId && (!ID.test(storyboardId) || !ID.test(segmentId)))) return { ok: false, problem: "storyboard" };
  const inputs = { ...(firstFrame ? { firstFrame } : {}), ...(lastFrame ? { lastFrame } : {}), ...(refs.length ? { referenceImages: refs } : {}) };
  return {
    ok: true,
    request: {
      kind,
      model: spec.model,
      prompt,
      video: { resolution: form.resolution, aspectRatio: form.aspectRatio, durationSeconds: form.durationSeconds, ...(Object.keys(inputs).length ? { inputs } : {}) },
      ...(storyboardId ? { storyboardId, segmentId } : {}),
    },
  };
}

/**
 * The price list's figure for the request (this build's prices, the same table every computer of this version uses): one image
 * of the size, or the video's seconds at the resolution. Shown as "about" -- the computer that runs it computes its own estimate.
 */
export function catalogEstimateUsd(request: GeminiRequest, catalog: readonly GeminiCatalogModel[]): number | null {
  const spec = catalog.find((m) => m.model === request.model && m.kind === request.kind);
  if (!spec) return null;
  if (spec.kind === "image") return request.image ? (spec.usdPerImage[request.image.size] ?? null) : null;
  if (!request.video) return null;
  const perSecond = spec.usdPerSecond[request.video.resolution];
  return perSecond === undefined ? null : ceil4(perSecond * request.video.durationSeconds);
}
