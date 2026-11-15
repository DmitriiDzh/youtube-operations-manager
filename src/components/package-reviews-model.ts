// BL-257 (ADR 0070, PACKAGE_REVIEW_PLAN.md stage 2): the review screen's pure helpers (tested on their own).

export type PackageReviewState = "pending" | "approved" | "returned" | "uploaded";

/** One package as `GET /api/channels/<id>/package-reviews` answers it (`@/lib/package-reviews` PackageReviewItem). */
export type PackageReviewDto = {
  manifestSha256: string;
  manifestPath: string;
  video: string;
  title: string;
  description: string;
  languages: string[];
  slotId: string | null;
  plannedPublishDate: string | null;
  durationSeconds: number;
  thumbnailPath: string | null;
  state: PackageReviewState;
  decision: "approved" | "returned" | null;
  comment: string | null;
  decidedAt: string | null;
  decidedOn: string | null;
  hasVideoSha256: boolean;
  otherProblems: string[];
};

export type PackageReviewsDto = {
  channelId: string;
  required: boolean;
  requiredUpdatedAt: string | null;
  readable: boolean;
  packages: "ok" | "no_workspace" | "workspace_unavailable";
  items: PackageReviewDto[];
  waiting: number;
};

/** The package's own video or thumbnail, by its manifest hash -- never a path (the route finds the file itself). */
export function mediaSrcOf(base: string, manifestSha256: string, which: "video" | "thumbnail"): string {
  return `${base}/${which}?manifest=${encodeURIComponent(manifestSha256)}`;
}

/** `58` -> `0:58`, `754` -> `12:34`, `3725` -> `1:02:05`. */
export function durationLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Which actions a package offers: the owner may change his mind until the upload; approval needs the video's checksum. */
export function actionsOf(item: Pick<PackageReviewDto, "state" | "hasVideoSha256">): { approve: boolean; ret: boolean } {
  if (item.state === "uploaded") return { approve: false, ret: false };
  return { approve: item.state !== "approved" && item.hasVideoSha256, ret: item.state !== "returned" };
}

/** A return needs a comment with at least one character that is not a space. */
export function returnCommentReady(comment: string): boolean {
  return comment.trim().length > 0;
}

/** The player's frame from the video's own size: vertical (Shorts, 9:16) or the 16:9 default until the metadata is known. */
export function frameOf(width: number, height: number): "vertical" | "horizontal" {
  return width > 0 && height > width ? "vertical" : "horizontal";
}
