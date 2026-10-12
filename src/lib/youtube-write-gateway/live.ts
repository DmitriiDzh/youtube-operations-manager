import type { youtube_v3 } from "googleapis";
import { DomainError } from "./contracts";

// ---------------------------------------------------------------------------
// BL-176 (ADR 0036) -- the write gateway's live-streaming primitives. Same rules as `index.ts`:
// each function makes exactly the request its name says, takes an already-authorized client, and
// does NOT call `assertLiveWritesAuthorized` itself -- every caller does, immediately before
// (enforced by `gateway-inventory.test.ts`'s WRITE_PRIMITIVE_NAMES).
//
// Request shapes follow the official reference pages (developers.google.com/youtube/v3/live/docs,
// "Last updated 2026-09-14", read 2026-10-12). Three rules from those pages are enforced here,
// because breaking them silently changes a live broadcast:
//   - `liveBroadcasts.bind` without `streamId` REMOVES the binding -- so an empty stream id is
//     refused before any call.
//   - `liveBroadcasts.update` replaces every mutable property of each part it sends ("the
//     property's existing value will be deleted") and requires `snippet.scheduledStartTime` --
//     so the caller passes the full merged snippet, and a missing start time is refused.
//   - The stream key (`cdn.ingestionInfo.streamName`) that `liveStreams.insert` returns is never
//     handed back to the caller -- only the stream id is. The key is read on demand by the one
//     reader that needs it (`readLiveStreamIngestion` in the read gateway).
// ---------------------------------------------------------------------------

export type LivePrivacyStatus = "private" | "public" | "unlisted";

/** `cdn.resolution` / `cdn.frameRate` values the app sends (the reference lists more). */
export type LiveStreamFormat = { resolution: "720p" | "1080p"; frameRate: "30fps" | "60fps" };

/** Real `liveStreams.insert`: a reusable RTMP(S) stream. Returns its id only. Caller calls `assertLiveWritesAuthorized()` first. */
export async function insertLiveStream(
  youtube: youtube_v3.Youtube,
  args: { title: string; format: LiveStreamFormat }
): Promise<{ streamId: string }> {
  const response = await youtube.liveStreams.insert({
    part: ["id", "snippet", "cdn", "contentDetails"],
    requestBody: {
      snippet: { title: args.title },
      cdn: { ingestionType: "rtmp", resolution: args.format.resolution, frameRate: args.format.frameRate },
      contentDetails: { isReusable: true },
    },
  });
  const streamId = response.data.id;
  if (!streamId) throw new Error("YouTube liveStreams.insert response did not include a stream id");
  return { streamId };
}

export type LiveBroadcastInsert = {
  title: string;
  description: string;
  /** ISO 8601; YouTube requires it in the near future. */
  scheduledStartTime: string;
  privacyStatus: LivePrivacyStatus;
  selfDeclaredMadeForKids: boolean;
  enableAutoStart: boolean;
  enableAutoStop: boolean;
  /** `false` skips the testing stage: the broadcast can go straight to `live`. */
  enableMonitorStream: boolean;
};

/** Real `liveBroadcasts.insert`. Caller calls `assertLiveWritesAuthorized()` first. */
export async function insertLiveBroadcast(
  youtube: youtube_v3.Youtube,
  broadcast: LiveBroadcastInsert
): Promise<{ broadcastId: string; lifeCycleStatus: string | null }> {
  const response = await youtube.liveBroadcasts.insert({
    part: ["id", "snippet", "status", "contentDetails"],
    requestBody: {
      snippet: {
        title: broadcast.title,
        description: broadcast.description,
        scheduledStartTime: broadcast.scheduledStartTime,
      },
      status: {
        privacyStatus: broadcast.privacyStatus,
        selfDeclaredMadeForKids: broadcast.selfDeclaredMadeForKids,
      },
      contentDetails: {
        enableAutoStart: broadcast.enableAutoStart,
        enableAutoStop: broadcast.enableAutoStop,
        monitorStream: { enableMonitorStream: broadcast.enableMonitorStream },
      },
    },
  });
  const broadcastId = response.data.id;
  if (!broadcastId) throw new Error("YouTube liveBroadcasts.insert response did not include a broadcast id");
  return { broadcastId, lifeCycleStatus: response.data.status?.lifeCycleStatus ?? null };
}

/** Real `liveBroadcasts.bind` to a stream. Never unbinds: an empty stream id is refused. Caller calls `assertLiveWritesAuthorized()` first. */
export async function bindLiveBroadcast(
  youtube: youtube_v3.Youtube,
  args: { broadcastId: string; streamId: string }
): Promise<{ boundStreamId: string | null }> {
  if (!args.streamId.trim()) {
    throw new DomainError({
      code: "validation_failed",
      message: "A stream id is required: liveBroadcasts.bind without one removes the broadcast's binding.",
    });
  }
  const response = await youtube.liveBroadcasts.bind({
    id: args.broadcastId,
    streamId: args.streamId,
    part: ["id", "contentDetails"],
  });
  return { boundStreamId: response.data.contentDetails?.boundStreamId ?? null };
}

/** `testing` is not offered: the app's broadcasts have the monitor stream off, so they go straight to `live`. */
export type LiveBroadcastTransition = "live" | "complete";

/** Real `liveBroadcasts.transition`. Caller calls `assertLiveWritesAuthorized()` first. */
export async function transitionLiveBroadcast(
  youtube: youtube_v3.Youtube,
  args: { broadcastId: string; broadcastStatus: LiveBroadcastTransition }
): Promise<{ lifeCycleStatus: string | null }> {
  if (args.broadcastStatus !== "live" && args.broadcastStatus !== "complete") {
    throw new DomainError({ code: "validation_failed", message: `Unsupported broadcast transition: ${String(args.broadcastStatus)}` });
  }
  const response = await youtube.liveBroadcasts.transition({
    id: args.broadcastId,
    broadcastStatus: args.broadcastStatus,
    part: ["id", "status"],
  });
  return { lifeCycleStatus: response.data.status?.lifeCycleStatus ?? null };
}

export type LiveBroadcastSnippetUpdate = {
  title: string;
  description: string;
  /** Required by `liveBroadcasts.update`; pass the broadcast's current value. */
  scheduledStartTime: string;
  scheduledEndTime?: string | null;
  categoryId?: string | null;
};

/**
 * Real `liveBroadcasts.update` of the snippet (title, description) and status (privacy) parts. The
 * parts sent are replaced wholesale, so `snippet` must be the full merged snippet built on a fresh
 * read. `contentDetails` is never sent: most of it cannot change while live, and the parts not
 * sent stay as they are. Caller calls `assertLiveWritesAuthorized()` first.
 */
export async function updateLiveBroadcast(
  youtube: youtube_v3.Youtube,
  args: { broadcastId: string; snippet: LiveBroadcastSnippetUpdate; privacyStatus: LivePrivacyStatus }
): Promise<void> {
  if (!args.snippet.scheduledStartTime) {
    throw new DomainError({
      code: "validation_failed",
      message: "liveBroadcasts.update requires snippet.scheduledStartTime (the broadcast's current value).",
    });
  }
  const snippet: youtube_v3.Schema$LiveBroadcastSnippet = {
    title: args.snippet.title,
    description: args.snippet.description,
    scheduledStartTime: args.snippet.scheduledStartTime,
  };
  if (args.snippet.scheduledEndTime) snippet.scheduledEndTime = args.snippet.scheduledEndTime;
  if (args.snippet.categoryId) (snippet as Record<string, unknown>).categoryId = args.snippet.categoryId;

  await youtube.liveBroadcasts.update({
    part: ["id", "snippet", "status"],
    requestBody: {
      id: args.broadcastId,
      snippet,
      status: { privacyStatus: args.privacyStatus },
    },
  });
}
