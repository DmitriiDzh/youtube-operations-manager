import { API_DATA_RETENTION_DAYS, YOUTUBE_API_SNAPSHOT_SOURCES } from "@/lib/youtube-data-policy/contracts";
import {
  CHANNEL_SNAPSHOT_COLUMNS,
  VIDEO_SNAPSHOT_COLUMNS,
  type OwnVideoForExport,
  type WatchlistContextForExport,
} from "./contracts";
import type { CsvCell } from "./csv";

export type ChannelSnapshotRow = Record<(typeof CHANNEL_SNAPSHOT_COLUMNS)[number], CsvCell>;
export type VideoSnapshotRow = Record<(typeof VIDEO_SNAPSHOT_COLUMNS)[number], CsvCell>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const label = (channel: { channelId: string; handleOrUrl: string | null }) => channel.handleOrUrl?.trim() || channel.channelId;

/** Distinct videos and newest observation among a channel's stored video-snapshot rows. */
export function summarizeVideoSnapshots(videoSnapshots: Array<{ videoId: string; observedAt: string }>): { uniqueVideoCount: number; latestVideoSnapshotAt: string | null } {
  let latest: number | null = null;
  for (const snapshot of videoSnapshots) {
    const time = Date.parse(snapshot.observedAt);
    if (!Number.isNaN(time) && (latest === null || time > latest)) latest = time;
  }
  return { uniqueVideoCount: new Set(videoSnapshots.map((snapshot) => snapshot.videoId)).size, latestVideoSnapshotAt: latest === null ? null : new Date(latest).toISOString() };
}

/** One row per stored channel snapshot (a channel with none contributes no row); per-channel counts repeat on each of its rows. */
export function buildChannelSnapshotRows(contexts: WatchlistContextForExport[]): ChannelSnapshotRow[] {
  return contexts.flatMap((context) =>
    context.channelSnapshots.map((snapshot) => ({
      channel: label(context.channel),
      channelId: context.channel.channelId,
      observedAt: snapshot.observedAt,
      subscriberCount: snapshot.subscriberCount,
      viewCount: snapshot.viewCount,
      videoCount: snapshot.videoCount,
      hiddenSubscriberCount: snapshot.hiddenSubscriberCount,
      videoSnapshotCount: context.videoSnapshots.length,
      evidenceCount: context.evidenceCount,
      dataQualityFlags: context.dataQualityFlags.join(";"),
      ...summarizeVideoSnapshots(context.videoSnapshots),
    }))
  );
}

/** One row per stored video snapshot. */
export function buildVideoSnapshotRows(contexts: WatchlistContextForExport[]): VideoSnapshotRow[] {
  return contexts.flatMap((context) =>
    context.videoSnapshots.map((snapshot) => ({
      channel: label(context.channel),
      channelId: context.channel.channelId,
      videoId: snapshot.videoId,
      publishedAt: snapshot.publishedAt,
      observedAt: snapshot.observedAt,
      viewCount: snapshot.viewCount,
      likeCount: snapshot.likeCount,
      commentCount: snapshot.commentCount,
      title: snapshot.title,
      durationSeconds: snapshot.durationSeconds ?? null,
      liveBroadcastContent: snapshot.liveBroadcastContent ?? null,
    }))
  );
}

/** Our own channel's PUBLIC videos in the competitor video-snapshot shape (`observedAt` = this device's last sync of the video). */
export function buildOwnVideoRows(channel: { channelId: string; title: string }, videos: OwnVideoForExport[]): VideoSnapshotRow[] {
  return videos
    .filter((video) => video.privacyStatus === "public")
    .map((video) => ({
      channel: channel.title,
      channelId: channel.channelId,
      videoId: video.videoId,
      publishedAt: toIsoOrNull(video.publishedAt),
      observedAt: video.lastSyncedAt.toISOString(),
      viewCount: video.viewCount,
      likeCount: video.likeCount,
      commentCount: video.commentCount,
      title: video.title,
      durationSeconds: video.durationSeconds ?? null,
      liveBroadcastContent: video.liveBroadcastContent ?? null,
    }));
}

function toIsoOrNull(value: string): string | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * When a file holding other people's API data must be gone (YouTube policy III.E.4.d, `API_DATA_RETENTION_DAYS`): 30 days after the OLDEST
 * API-sourced observation it contains, so no value outlives its own window. `null` when no row is API-sourced (operator-entered rows are not
 * API data). A row with an unreadable observation time counts as observed at `now`.
 */
export function computeResearchFileExpiry(contexts: WatchlistContextForExport[], now: Date): Date | null {
  const apiSources = new Set<string>(YOUTUBE_API_SNAPSHOT_SOURCES);
  let oldest: number | null = null;
  for (const context of contexts) {
    for (const snapshot of [...context.channelSnapshots, ...context.videoSnapshots]) {
      if (!apiSources.has(snapshot.source)) continue;
      // Fail closed: an API row whose time cannot be read counts as observed at export time, so its file still gets an expiry.
      const parsed = Date.parse(snapshot.observedAt);
      const time = Number.isNaN(parsed) ? now.getTime() : parsed;
      if (oldest === null || time < oldest) oldest = time;
    }
  }
  return oldest === null ? null : new Date(oldest + API_DATA_RETENTION_DAYS * MS_PER_DAY);
}
