import { Readable } from "node:stream";
import type { youtube_v3 } from "googleapis";
import { DomainError } from "./contracts";

// ---------------------------------------------------------------------------
// BL-269 (VIDEO_CAPTIONS_PLAN.md §2, §3.2, §3.7; ADR 0074 §1, §10) -- the caption writer's two calls. Same rules as `index.ts`: each
// makes exactly the request its name says and does NOT call `assertLiveWritesAuthorized` itself (the only caller,
// `src/lib/video-captions/adapters/youtube-writes.ts`, does, immediately before). There is deliberately no delete primitive
// (`gateway-inventory.test.ts` fails on any `captions.delete` call anywhere).
//   - `captions.insert` (400 units; scope youtube.force-ssl): `part=snippet`, `snippet.videoId` / `language` / `name` (required),
//     `isDraft: false`; `sync` is deprecated (2024-03-13) and never sent; media ≤ 100 MB, `application/octet-stream`.
//   - `captions.update` (450 units; read 2026-11-17): the only settable property is `snippet.isDraft` and an omitted settable property
//     is deleted, so the replacement of a track's content is `part=id`, body `{ id }` plus the media -- no snippet. The track's name and
//     language cannot change.
// ---------------------------------------------------------------------------

/** `captions.insert`/`update`: "Maximum file size: 100MB". */
export const CAPTION_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

function checkMedia(bytes: Buffer): void {
  if (bytes.length === 0 || bytes.length > CAPTION_MEDIA_MAX_BYTES) throw new DomainError({ code: "validation_failed", message: "A caption file must be 1 byte to 100 MB." });
}

/** Real `captions.insert`; returns the new track's id. */
export async function insertVideoCaption(
  youtube: youtube_v3.Youtube,
  args: { videoId: string; language: string; name: string; media: { mimeType: string; bytes: Buffer } }
): Promise<{ trackId: string }> {
  if (!args.videoId || !args.language) throw new DomainError({ code: "validation_failed", message: "A caption track needs a video id and a language." });
  checkMedia(args.media.bytes);
  const res = await youtube.captions.insert({
    part: ["snippet"],
    requestBody: { snippet: { videoId: args.videoId, language: args.language, name: args.name, isDraft: false } },
    media: { mimeType: args.media.mimeType, body: Readable.from(args.media.bytes) },
  });
  const trackId = res.data?.id;
  if (!trackId) throw new DomainError({ code: "update_failed", message: "YouTube accepted the caption track but returned no id." });
  return { trackId };
}

/** Real `captions.update` of one track's content (`part=id`, `{ id }` + the file; no snippet is sent). */
export async function updateVideoCaption(youtube: youtube_v3.Youtube, args: { trackId: string; media: { mimeType: string; bytes: Buffer } }): Promise<void> {
  if (!args.trackId) throw new DomainError({ code: "validation_failed", message: "No caption track id to update." });
  checkMedia(args.media.bytes);
  await youtube.captions.update({
    part: ["id"],
    requestBody: { id: args.trackId },
    media: { mimeType: args.media.mimeType, body: Readable.from(args.media.bytes) },
  });
}
