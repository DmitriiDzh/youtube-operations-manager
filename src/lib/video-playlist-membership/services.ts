// Package playlists (owner, Telegram 4858/4859, 2026-11-24): which playlists of its channel a video is in -- the Producer's read
// (`producer_video_playlists`). Read-only. The checks run in this order and each fails closed before anything after it: the channel
// is connected on this computer (else CHANNEL_NOT_ACTIVE), the video is that channel's by local data (its synced list, or an upload
// row of this computer; else video_not_in_channel) -- both before any credential or YouTube call -- then the channel's own identity
// check on the grant, then the live reads through the read gateway. The answer is kept for MEMBERSHIP_CACHE_TTL_MS per channel and
// video, and the channel's playlist list for the same time per channel (`refresh: true` reads live). Next to the live membership it
// returns what this computer's uploads of the video recorded per playlist (0 units), so a playlist the upload could not add (a
// foreign id, a read-back that never showed it) is readable without a YouTube call.

import { DomainError } from "@/lib/shared-domain";

export const MEMBERSHIP_CACHE_TTL_MS = 10 * 60_000;
/** At most this many playlists of a channel are checked in one answer (`truncated` says when there are more). */
export const MEMBERSHIP_MAX_PLAYLISTS = 200;

export type ChannelPlaylist = { id: string; title: string; privacyStatus: string };

/** One of this computer's upload rows of the video, with its playlist step as recorded (`steps.playlist` / `steps.playlists`). */
export type UploadPlaylistRecord = {
  uploadId: string;
  video: string;
  status: string;
  finishedAt: string | null;
  /** The settings playlist's outcome (added / already_there / none / failed), null before the step ran. */
  settingsPlaylist: string | null;
  /** Each playlist's outcome: { playlistId, source: settings | package, result, reason? }; [] before the step ran or with none. */
  playlists: Array<{ playlistId: string; source: string; result: string; reason?: string }>;
};

export type VideoPlaylistsResult = {
  channelId: string;
  videoId: string;
  /** The channel's playlists that hold the video now (as read at `readAt`). */
  playlists: ChannelPlaylist[];
  /** How many of the channel's playlists were checked, and whether there were more than MEMBERSHIP_MAX_PLAYLISTS. */
  checkedPlaylists: number;
  truncated: boolean;
  readAt: string;
  /** True when the answer is the kept one (no YouTube call made now). */
  cached: boolean;
  /** Data API units this call spent (0 when cached): playlist list pages + one membership read per playlist (+ the identity check's). */
  quotaUnits: number;
  /** This computer's uploads of the video and their playlist step (local, 0 units). */
  uploads: UploadPlaylistRecord[];
};

export type VideoPlaylistMembershipDeps = {
  /** The Google account the channel is connected under here, or null when it is not connected here. */
  channelUser(channelId: string): Promise<string | null>;
  /** Whether the video is the channel's by local data (the synced list or an upload row of this computer). */
  videoOfChannel(channelId: string, videoId: string): Promise<boolean>;
  uploadRecords(channelId: string, videoId: string): Promise<UploadPlaylistRecord[]>;
  credentials(userId: string): Promise<unknown>;
  /** The identity check: the grant's channel is `channelId` (fails closed otherwise). Counts as 1 unit. */
  assertChannel(args: { channelId: string; userId: string; credentials: unknown }): Promise<void>;
  /** The grant's own channel's playlists (`playlists.list`, 1 unit per page of 50). */
  listPlaylists(credentials: unknown): Promise<ChannelPlaylist[]>;
  /** Whether a playlist holds the video (`playlistItems.list` by videoId, 1 unit). */
  playlistHasVideo(credentials: unknown, playlistId: string, videoId: string): Promise<boolean>;
  clock: { now(): Date };
};

type Kept<T> = { value: T; at: number };

/** The kept answers (per channel and video) and playlist lists (per channel); one per process in production. */
export type MembershipCache = {
  answers: Map<string, Kept<Omit<VideoPlaylistsResult, "cached" | "quotaUnits" | "uploads">>>;
  lists: Map<string, Kept<ChannelPlaylist[]>>;
};

export const createMembershipCache = (): MembershipCache => ({ answers: new Map(), lists: new Map() });

export function createVideoPlaylistMembership(deps: VideoPlaylistMembershipDeps, cache: MembershipCache = createMembershipCache()) {
  const { answers, lists } = cache;
  const fresh = (kept: Kept<unknown> | undefined, nowMs: number) => kept !== undefined && nowMs - kept.at < MEMBERSHIP_CACHE_TTL_MS;

  return {
    async videoPlaylists(input: { channelId: string; videoId: string; refresh?: boolean }): Promise<VideoPlaylistsResult> {
      const { channelId, videoId } = input;
      const userId = await deps.channelUser(channelId);
      if (!userId) throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "This channel is not connected on this computer (Settings → Channels).", details: { channelId } });
      if (!(await deps.videoOfChannel(channelId, videoId))) {
        throw new DomainError({ code: "video_not_in_channel", message: "This video is not a video of this channel here (its synced videos or this computer's uploads).", details: { channelId, videoId } });
      }
      const uploads = await deps.uploadRecords(channelId, videoId);
      const nowMs = deps.clock.now().getTime();
      const key = `${channelId} ${videoId}`;
      const kept = answers.get(key);
      if (!input.refresh && kept && fresh(kept, nowMs)) return { ...kept.value, cached: true, quotaUnits: 0, uploads };

      const credentials = await deps.credentials(userId);
      await deps.assertChannel({ channelId, userId, credentials });
      let quotaUnits = 1;
      const keptList = lists.get(channelId);
      let all: ChannelPlaylist[];
      if (!input.refresh && keptList && fresh(keptList, nowMs)) all = keptList.value;
      else {
        all = await deps.listPlaylists(credentials);
        quotaUnits += Math.max(1, Math.ceil(all.length / 50));
        lists.set(channelId, { value: all, at: nowMs });
      }
      const checked = all.slice(0, MEMBERSHIP_MAX_PLAYLISTS);
      const holding: ChannelPlaylist[] = [];
      for (const playlist of checked) {
        quotaUnits += 1;
        if (await deps.playlistHasVideo(credentials, playlist.id, videoId)) holding.push(playlist);
      }
      const value = { channelId, videoId, playlists: holding, checkedPlaylists: checked.length, truncated: all.length > checked.length, readAt: new Date(nowMs).toISOString() };
      answers.set(key, { value, at: nowMs });
      return { ...value, cached: false, quotaUnits, uploads };
    },
  };
}
