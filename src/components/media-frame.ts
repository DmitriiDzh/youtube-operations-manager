/**
 * A video's frame from its own size: vertical (Shorts, 9:16) or the 16:9 default until the metadata is known. Shared by every player
 * that sizes itself by the file (release packages, clips, the video popup) -- its own module, so none reaches into another's model
 * (AGENTS.md §M; review of f05c349d).
 */
export function frameOf(width: number, height: number): "vertical" | "horizontal" {
  return width > 0 && height > width ? "vertical" : "horizontal";
}
