import { z } from "zod";
import { DomainError, parseWithSchema } from "@/lib/shared-domain";

/**
 * BL-216 (docs/roadmap/plans/WORKER_CAPABILITIES_PLAN.md stage 2, ADR 0048): a channel agent hides its own channel's videos and
 * playlists -- private or unlisted, never public, never a scheduled video, never the app's current broadcast. It writes nothing
 * itself: a video goes through `video-details` (identity check, backup, Live writes, read-back, audit), a playlist through the
 * playlist core (write-channel guardrail, ownership, Live writes). Pure: every read and write arrives through `deps`.
 */

export const WORKER_PRIVACY_STATUSES = ["private", "unlisted"] as const;
export type WorkerPrivacyStatus = (typeof WORKER_PRIVACY_STATUSES)[number];

export const setPrivacyInputSchema = z
  .object({
    target: z.enum(["video", "playlist"]),
    id: z.string().min(1).max(64),
    privacyStatus: z.enum(WORKER_PRIVACY_STATUSES),
    dryRun: z.boolean().optional(),
  })
  .strict();

export type SetPrivacyResult = {
  target: "video" | "playlist";
  id: string;
  dryRun: boolean;
  previousPrivacyStatus: string | null;
  privacyStatus: WorkerPrivacyStatus;
  changed: boolean;
};

export type WorkerPrivacyDeps = {
  /** The agent session's channel (the token's). */
  channelId: string;
  /** Throws `AGENT_PUBLIC_NOT_ALLOWED` for "public" in an agent session (channel-access). */
  assertMayNotPublish(privacyStatus: string): void;
  /** The video in this channel's local synced mirror, or null. */
  findChannelVideo(channelId: string, videoId: string): Promise<unknown | null>;
  /** The broadcast ids the app is streaming for this channel right now (stream on, or a segment not ended). */
  currentBroadcastIds(channelId: string): Promise<Set<string>>;
  /** A fresh read of the video's status on YouTube. */
  readVideo(videoId: string): Promise<{ privacyStatus: string | null; publishAt: string | null; etag: string | null }>;
  /** The real write through video-details, bound to the read's etag; returns the status read back. */
  writeVideo(args: { videoId: string; privacyStatus: WorkerPrivacyStatus; expectedEtag: string | null }): Promise<{ privacyStatus: string | null }>;
  /** This channel's playlists from YouTube. */
  listPlaylists(): Promise<Array<{ id: string; privacyStatus: string }>>;
  /** The real write through the playlist core; returns the playlist as YouTube answered. */
  writePlaylist(args: { playlistId: string; privacyStatus: WorkerPrivacyStatus }): Promise<{ privacyStatus: string }>;
};

function notFound(target: "video" | "playlist", id: string): DomainError {
  return target === "video"
    ? new DomainError({ code: "not_found", message: "video not found in this channel's synced list -- run channel_sync first if it is new", details: { videoId: id } })
    : new DomainError({ code: "not_found", message: "playlist not found on this channel", details: { playlistId: id } });
}

export function createWorkerPrivacyServices(deps: WorkerPrivacyDeps) {
  return {
    async setPrivacy(input: unknown): Promise<SetPrivacyResult> {
      const parsed = parseWithSchema(setPrivacyInputSchema, input, "set privacy input");
      deps.assertMayNotPublish(parsed.privacyStatus);
      const dryRun = parsed.dryRun !== false;
      const base = { target: parsed.target, id: parsed.id, dryRun, privacyStatus: parsed.privacyStatus };

      if (parsed.target === "playlist") {
        const playlist = (await deps.listPlaylists()).find((entry) => entry.id === parsed.id);
        if (!playlist) throw notFound("playlist", parsed.id);
        const changed = playlist.privacyStatus !== parsed.privacyStatus;
        if (dryRun || !changed) return { ...base, previousPrivacyStatus: playlist.privacyStatus, changed };
        await deps.writePlaylist({ playlistId: parsed.id, privacyStatus: parsed.privacyStatus });
        return { ...base, previousPrivacyStatus: playlist.privacyStatus, changed: true };
      }

      const stored = await deps.findChannelVideo(deps.channelId, parsed.id);
      if (!stored) throw notFound("video", parsed.id);
      // Review (HIGH-adjacent): this computer knows its own current broadcast; a stream run by another computer is known only from the
      // synced list's liveBroadcastContent -- a live or upcoming broadcast stays the owner's either way.
      const broadcastState = (stored as { liveBroadcastContent?: unknown }).liveBroadcastContent;
      if ((await deps.currentBroadcastIds(deps.channelId)).has(parsed.id) || broadcastState === "live" || broadcastState === "upcoming") {
        throw new DomainError({
          code: "AGENT_LIVE_BROADCAST_OWNER_ONLY",
          message: "This is the channel's current live broadcast; only the owner changes its privacy.",
          details: { videoId: parsed.id },
        });
      }
      const current = await deps.readVideo(parsed.id);
      if (current.publishAt) {
        throw new DomainError({
          code: "AGENT_SCHEDULE_OWNER_ONLY",
          message: "This video is scheduled; changing its privacy would drop the owner's schedule.",
          details: { videoId: parsed.id, publishAt: current.publishAt },
        });
      }
      const changed = current.privacyStatus !== parsed.privacyStatus;
      if (dryRun || !changed) return { ...base, previousPrivacyStatus: current.privacyStatus, changed };
      await deps.writeVideo({ videoId: parsed.id, privacyStatus: parsed.privacyStatus, expectedEtag: current.etag });
      return { ...base, previousPrivacyStatus: current.privacyStatus, changed: true };
    },
  };
}

export type WorkerPrivacyServices = ReturnType<typeof createWorkerPrivacyServices>;
