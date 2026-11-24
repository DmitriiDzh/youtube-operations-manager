import { stat } from "node:fs/promises";

// ---------------------------------------------------------------------------
// BL-175 (FO-REQ-0018 §B, docs/roadmap/plans/VISUAL_REVIEW_PLAN.md §2.7): small JPEG previews of images for the review grid,
// made with `sharp` (Next.js installs it; a direct dependency since BL-175) and kept in memory only. A shared module: it knows
// nothing about plans -- the caller resolves and proves the file first. Any failure gives null and the caller sends the original.
// ---------------------------------------------------------------------------

/** The longest side of a preview, in pixels (a grid cell at 2x density). */
export const PREVIEW_MAX_SIDE = 480;
/** How many previews the memory cache keeps (about 30-60 KB each). */
export const PREVIEW_CACHE_ENTRIES = 300;
/** sharp's own guard against decompression bombs (its default: 16383 x 16383). */
const LIMIT_INPUT_PIXELS = 268_402_689;

type SharpPipeline = {
  rotate(): SharpPipeline;
  resize(options: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }): SharpPipeline;
  jpeg(options: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Uint8Array>;
};
export type SharpFactory = (input: string, options: { failOn: "none"; limitInputPixels: number }) => SharpPipeline;

export type ImagePreviewerDeps = {
  /** Loads `sharp`; null when it cannot be loaded here (then every preview is null). */
  loadSharp(): Promise<SharpFactory | null>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  maxSide?: number;
  entries?: number;
};

export function createImagePreviewer(deps: ImagePreviewerDeps) {
  const maxSide = deps.maxSide ?? PREVIEW_MAX_SIDE;
  const entries = deps.entries ?? PREVIEW_CACHE_ENTRIES;
  const cache = new Map<string, Uint8Array>();
  return {
    /** A JPEG no larger than `maxSide` on either side, or null (unreadable, not an image `sharp` decodes, no `sharp`). */
    async preview(path: string): Promise<Uint8Array | null> {
      try {
        const info = await deps.stat(path);
        // The same file again (same size and time) is the same preview; a rewritten file gets a new one.
        const key = `${path}\u0000${info.size}\u0000${info.mtimeMs}`;
        const hit = cache.get(key);
        if (hit) {
          cache.delete(key);
          cache.set(key, hit);
          return hit;
        }
        const sharp = await deps.loadSharp();
        if (!sharp) return null;
        const body = await sharp(path, { failOn: "none", limitInputPixels: LIMIT_INPUT_PIXELS })
          .rotate()
          .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        cache.set(key, body);
        while (cache.size > entries) cache.delete(cache.keys().next().value as string);
        return body;
      } catch {
        return null;
      }
    },
  };
}

export type ImagePreviewer = ReturnType<typeof createImagePreviewer>;

const PRODUCTION_KEY = Symbol.for("youtube-operations-manager.media-preview");

async function loadSharpForProduction(): Promise<SharpFactory | null> {
  try {
    const mod = (await import("sharp")) as unknown as { default?: SharpFactory } & SharpFactory;
    return (mod.default ?? mod) as SharpFactory;
  } catch {
    return null;
  }
}

async function statForProduction(path: string): Promise<{ size: number; mtimeMs: number }> {
  const s = await stat(path);
  return { size: s.size, mtimeMs: s.mtimeMs };
}

/** The process's previewer (one cache per server process). */
export function createImagePreviewerForProduction(): ImagePreviewer {
  const holder = globalThis as unknown as Record<symbol, ImagePreviewer | undefined>;
  return (holder[PRODUCTION_KEY] ??= createImagePreviewer({ loadSharp: loadSharpForProduction, stat: statForProduction }));
}

/** BL-272 (ADR 0076): the longest side of a large grid preview (a 1920×1080 still shown about 480 px wide, at 2x density). */
export const LARGE_PREVIEW_MAX_SIDE = 960;
/** How many large previews the memory cache keeps (about 100-150 KB each). */
const LARGE_PREVIEW_CACHE_ENTRIES = 120;
const LARGE_PRODUCTION_KEY = Symbol.for("youtube-operations-manager.media-preview.large");

/** BL-272: the process's previewer of large grid thumbnails (its own cache, so the small previews keep theirs). */
export function createLargeImagePreviewerForProduction(): ImagePreviewer {
  const holder = globalThis as unknown as Record<symbol, ImagePreviewer | undefined>;
  return (holder[LARGE_PRODUCTION_KEY] ??= createImagePreviewer({ loadSharp: loadSharpForProduction, stat: statForProduction, maxSide: LARGE_PREVIEW_MAX_SIDE, entries: LARGE_PREVIEW_CACHE_ENTRIES }));
}

/** BL-272: an image's real format and size as `sharp` reads its header (not its extension); null when it is not an image here. */
export async function readImageInfo(path: string): Promise<{ format: string; width: number; height: number } | null> {
  try {
    const sharp = (await loadSharpForProduction()) as unknown as ((input: string, options: { failOn: "none"; limitInputPixels: number }) => { metadata(): Promise<{ format?: string; width?: number; height?: number }> }) | null;
    if (!sharp) return null;
    const meta = await sharp(path, { failOn: "none", limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();
    if (!meta.format || !meta.width || !meta.height) return null;
    return { format: meta.format, width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}
