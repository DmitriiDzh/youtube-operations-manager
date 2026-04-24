import type { TranscriptResult, VideoMetadataItem } from "./contracts";

export const EDITORIAL_PROMPT_VERSION = "video-metadata-v1";

export function buildEditorialPromptTemplate(args: {
  video: VideoMetadataItem;
  transcript: TranscriptResult;
  editorialPrompt: string;
}) {
  const transcriptBlock =
    args.transcript.status === "available"
      ? args.transcript.text
      : `[${args.transcript.status}:${args.transcript.reason}]`;

  return [
    "You are an editorial assistant for YouTube metadata.",
    "Return exactly one finalTitle and one description.",
    "Avoid clickbait and keep language aligned with the user prompt.",
    "",
    `PROMPT_VERSION=${EDITORIAL_PROMPT_VERSION}`,
    `USER_PROMPT=${args.editorialPrompt}`,
    `VIDEO_TITLE=${args.video.title}`,
    `VIDEO_DESCRIPTION=${args.video.description}`,
    `VIDEO_PUBLISHED_AT=${args.video.publishedAt}`,
    `TRANSCRIPT=${transcriptBlock}`,
  ].join("\n");
}
