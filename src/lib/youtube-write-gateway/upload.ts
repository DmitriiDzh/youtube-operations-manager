import { Readable } from "node:stream";
import { request as httpsRequest } from "node:https";
import type { youtube_v3 } from "googleapis";
import { noteYoutubeQuotaCall } from "@/lib/youtube-read-gateway";
import { DomainError } from "./contracts";

// ---------------------------------------------------------------------------
// BL-182 (ADR 0037) -- the write gateway's video upload primitives. Same rules as `index.ts` and `live.ts`: each function makes
// exactly the request its name says and does NOT call `assertLiveWritesAuthorized` itself -- every caller does, immediately before
// (enforced by `gateway-inventory.test.ts`'s WRITE_PRIMITIVE_NAMES).
//
// The resumable protocol follows Google's "Resumable Uploads" guide for the YouTube Data API
// (developers.google.com/youtube/v3/guides/using_resumable_upload_protocol):
//   1. POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=... with the video resource as JSON and
//      `X-Upload-Content-Length` / `X-Upload-Content-Type`; the session URI comes back in `Location`.
//   2. PUT the bytes to the session URI; a chunk carries `Content-Range: bytes first-last/total` and must be a multiple of 256 KB,
//      except the last. `308 Resume Incomplete` with `Range: bytes=0-N` means N+1 bytes are stored; 200/201 carries the video.
//   3. Asking where it stands: PUT with `Content-Range: bytes */total` and no body -> 308 (+ `Range`) or 200/201. 404 means the
//      session expired: start again.
// googleapis is not used for the media itself: it cannot resume a session after a restart, which an upload of a 1 GB file must.
// The access token is sent only to https://www.googleapis.com (the session URI is checked before every request).
// ---------------------------------------------------------------------------

export const UPLOAD_CHUNK_GRANULARITY = 256 * 1024;
const UPLOAD_ORIGIN = "https://www.googleapis.com";
const UPLOAD_ENDPOINT = `${UPLOAD_ORIGIN}/upload/youtube/v3/videos`;
const REQUEST_TIMEOUT_MS = 10 * 60_000;

/** The video resource sent at insert. Only what the plan sets; `publishAt` only together with `privacyStatus: "private"`. */
export type VideoInsertResource = {
  snippet: {
    title: string;
    description: string;
    tags?: string[];
    categoryId?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  status: {
    privacyStatus: "private";
    publishAt?: string;
    selfDeclaredMadeForKids: boolean;
    containsSyntheticMedia?: boolean;
    license?: "youtube" | "creativeCommon";
    embeddable?: boolean;
  };
};

export type UploadHttpResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** The one HTTPS call shape the upload needs; injectable so the protocol is tested without the network. */
export type UploadHttp = (args: { method: "POST" | "PUT"; url: string; headers: Record<string, string>; body?: Buffer }) => Promise<UploadHttpResponse>;

export const nodeUploadHttp: UploadHttp = ({ method, url, headers, body }) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (part: Buffer) => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("upload request timed out")));
    req.on("error", reject);
    if (body) req.end(body);
    else req.end();
  });

function assertGoogleUploadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DomainError({ code: "update_failed", message: "The upload session URI is not a URL." });
  }
  if (parsed.origin !== UPLOAD_ORIGIN || !parsed.pathname.startsWith("/upload/youtube/v3/videos")) {
    throw new DomainError({ code: "update_failed", message: `Refusing to send the token to an upload URI outside ${UPLOAD_ORIGIN}.` });
  }
}

function headerOf(headers: UploadHttpResponse["headers"], name: string): string | null {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function uploadError(response: UploadHttpResponse, step: string): DomainError {
  // A 5xx is not a refusal: Google's guide says the outcome is unknown and the session should be asked where it stands.
  const verb = response.status >= 500 ? "answered with an error, outcome unknown" : "refused the upload";
  let reason: string | null = null;
  try {
    const parsed = JSON.parse(response.body) as { error?: { errors?: Array<{ reason?: string }>; message?: string } };
    reason = parsed.error?.errors?.[0]?.reason ?? null;
    return new DomainError({
      code: "update_failed",
      message: `YouTube ${verb} (${step}): HTTP ${response.status}${reason ? ` ${reason}` : ""}${parsed.error?.message ? ` -- ${parsed.error.message}` : ""}`,
      details: { status: response.status, reason },
    });
  } catch {
    return new DomainError({ code: "update_failed", message: `YouTube ${verb} (${step}): HTTP ${response.status}`, details: { status: response.status, reason } });
  }
}

/** The stored-bytes count a 308 reports (`Range: bytes=0-N` -> N+1; no `Range` -> 0). */
function storedBytesOf(response: UploadHttpResponse): number {
  const range = headerOf(response.headers, "range");
  const match = range ? /^bytes=0-(\d+)$/.exec(range.trim()) : null;
  return match ? Number(match[1]) + 1 : 0;
}

function videoIdOf(response: UploadHttpResponse): string {
  const parsed = JSON.parse(response.body) as { id?: unknown };
  if (typeof parsed.id !== "string" || parsed.id === "") throw new DomainError({ code: "update_failed", message: "The finished upload's answer has no video id." });
  return parsed.id;
}

/** Real resumable `videos.insert`, step 1. Returns the session URI. Caller calls `assertLiveWritesAuthorized()` first. */
export async function beginResumableVideoUpload(
  args: { accessToken: string; resource: VideoInsertResource; contentLength: number; contentType: string; notifySubscribers: boolean },
  http: UploadHttp = nodeUploadHttp
): Promise<{ sessionUri: string }> {
  if (!Number.isInteger(args.contentLength) || args.contentLength <= 0) throw new DomainError({ code: "validation_failed", message: "The upload has no bytes." });
  if (args.resource.status.publishAt !== undefined && args.resource.status.privacyStatus !== "private") {
    throw new DomainError({ code: "validation_failed", message: "publishAt is only allowed with privacyStatus private." });
  }
  const body = Buffer.from(JSON.stringify(args.resource), "utf8");
  const url = `${UPLOAD_ENDPOINT}?uploadType=resumable&part=snippet,status&notifySubscribers=${args.notifySubscribers ? "true" : "false"}`;
  const response = await http({
    method: "POST",
    url,
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Length": String(body.length),
      "X-Upload-Content-Length": String(args.contentLength),
      "X-Upload-Content-Type": args.contentType,
    },
    body,
  });
  if (response.status !== 200) {
    const error = uploadError(response, "start");
    noteYoutubeQuotaCall("data", "videos.insert", isQuotaRefusal(error) ? "quota_exceeded" : "error");
    throw error;
  }
  const sessionUri = headerOf(response.headers, "location");
  if (!sessionUri) throw new DomainError({ code: "update_failed", message: "YouTube did not return an upload session URI." });
  assertGoogleUploadUrl(sessionUri);
  return { sessionUri };
}

export type UploadProgress = { done: true; videoId: string } | { done: false; storedBytes: number } | { expired: true };

/**
 * Real resumable `videos.insert`, step 2: one chunk starting at `start`. A chunk that is not the last must be a multiple of 256 KB.
 * Caller calls `assertLiveWritesAuthorized()` first.
 */
export async function putVideoUploadChunk(
  args: { accessToken: string; sessionUri: string; chunk: Buffer; start: number; total: number; contentType: string },
  http: UploadHttp = nodeUploadHttp
): Promise<UploadProgress> {
  assertGoogleUploadUrl(args.sessionUri);
  const last = args.start + args.chunk.length - 1;
  if (args.chunk.length === 0 || last >= args.total) throw new DomainError({ code: "validation_failed", message: "The chunk does not fit the upload." });
  if (last !== args.total - 1 && args.chunk.length % UPLOAD_CHUNK_GRANULARITY !== 0) {
    throw new DomainError({ code: "validation_failed", message: "A chunk other than the last must be a multiple of 256 KB." });
  }
  const response = await http({
    method: "PUT",
    url: args.sessionUri,
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": args.contentType,
      "Content-Length": String(args.chunk.length),
      "Content-Range": `bytes ${args.start}-${last}/${args.total}`,
    },
    body: args.chunk,
  });
  return progressOf(response, "chunk");
}

/** Real resumable `videos.insert`, step 3: how many bytes YouTube holds. Caller calls `assertLiveWritesAuthorized()` first. */
export async function queryVideoUploadOffset(
  args: { accessToken: string; sessionUri: string; total: number },
  http: UploadHttp = nodeUploadHttp
): Promise<UploadProgress> {
  assertGoogleUploadUrl(args.sessionUri);
  const response = await http({
    method: "PUT",
    url: args.sessionUri,
    headers: { Authorization: `Bearer ${args.accessToken}`, "Content-Length": "0", "Content-Range": `bytes */${args.total}` },
  });
  return progressOf(response, "status");
}

/** The project's daily bucket is spent (`quotaExceeded`); the channel's own cap (`uploadLimitExceeded`) is a different refusal. */
function isQuotaRefusal(error: DomainError): boolean {
  return (error.details as { reason?: string | null } | undefined)?.reason === "quotaExceeded";
}

function progressOf(response: UploadHttpResponse, step: string): UploadProgress {
  if (response.status === 200 || response.status === 201) {
    // One `videos.insert` in the ledger per finished upload (its own daily bucket, `countsAgainstPool`).
    noteYoutubeQuotaCall("data", "videos.insert", "ok");
    return { done: true, videoId: videoIdOf(response) };
  }
  if (response.status === 308) return { done: false, storedBytes: storedBytesOf(response) };
  if (response.status === 404) return { expired: true };
  throw uploadError(response, step);
}

/** Real `videos.delete`. ADR 0037: used only by the G1 probe, for the probe's own video. Caller calls `assertLiveWritesAuthorized()` first. */
export async function deleteVideoById(youtube: youtube_v3.Youtube, videoId: string): Promise<void> {
  if (!videoId) throw new DomainError({ code: "validation_failed", message: "No video id to delete." });
  await youtube.videos.delete({ id: videoId });
}

/**
 * Real `thumbnails.set` (BL-182 stage 2, ADR 0037): a JPEG or PNG of at most 2 MB as the video's custom thumbnail (50 units). The
 * caller checks the file and calls `assertLiveWritesAuthorized()` first.
 */
export async function setVideoThumbnail(youtube: youtube_v3.Youtube, videoId: string, image: { mimeType: "image/jpeg" | "image/png"; bytes: Buffer }): Promise<void> {
  if (!videoId) throw new DomainError({ code: "validation_failed", message: "No video id for the thumbnail." });
  if (image.bytes.length === 0 || image.bytes.length > 2 * 1024 * 1024) throw new DomainError({ code: "validation_failed", message: "A thumbnail must be 1 byte to 2 MB." });
  await youtube.thumbnails.set({ videoId, media: { mimeType: image.mimeType, body: Readable.from(image.bytes) } });
}
