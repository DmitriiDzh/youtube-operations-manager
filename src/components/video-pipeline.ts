// BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage B): where each video number stands on the «Ролики и релизы» board. Derived for
// display only from what the app already knows (the number's folder, package, upload and linked YouTube video); the video-projects
// state itself is unchanged. Pure.

export type PipelinePhase = "prep" | "edit" | "package" | "youtube" | "published";
export const PIPELINE_PHASES: readonly PipelinePhase[] = ["prep", "edit", "package", "youtube", "published"];

export type PipelineProject = {
  state: "in_work" | "packaged" | "published" | "cancelled";
  hasVideoFile?: boolean;
  youtubeVideoId?: string | null;
  /** An upload of the number is queued or running on this computer. */
  uploading?: boolean;
};
export type PipelineSyncedVideo = { privacyStatus: string; publishAt: string | null };

/**
 * `published`: the linked YouTube video is public (or the number is published with no video the app can see -- the registry or an
 * old upload). `youtube`: the linked video is on YouTube but not public yet (private, unlisted or scheduled), or not synced yet.
 * `package`: a release package (or an upload of it) and no YouTube video yet. `edit`: the folder has the video file, no package.
 * `prep`: nothing of that yet (storyboard and generation). A cancelled number is on no column (null).
 */
export function pipelinePhase(project: PipelineProject, synced: PipelineSyncedVideo | null): PipelinePhase | null {
  if (project.state === "cancelled") return null;
  if (project.youtubeVideoId) {
    if (!synced) return "youtube";
    return synced.privacyStatus === "public" ? "published" : "youtube";
  }
  if (project.state === "published") return "published";
  if (project.state === "packaged") return "package";
  return project.hasVideoFile ? "edit" : "prep";
}

/** A number the owner may link to a YouTube video: it has a folder, no video yet, no upload under way, and is not cancelled
 * (`linkVideo`'s rules). */
export function canLink(project: PipelineProject & { folder: string | null }): boolean {
  return project.state !== "cancelled" && Boolean(project.folder) && !project.youtubeVideoId && !project.uploading;
}
