import type { ProgressReporter } from "@/lib/operation-progress";
import { YOUTUBE_READ_SCOPE } from "@/lib/auth";
import type { ChannelAccessService } from "@/lib/channel-access";
import {
  DomainError,
  mapUnknownError,
  type ChannelForSync,
  type LocaleMetadata,
  type ResolvedCredentials,
  type SyncChannelResult,
  type SyncedChannel,
  type SyncedVideo,
  type ThumbnailInfo,
  type VideoSyncMetadata,
} from "./contracts";
import {
  listChannelsInputSchema,
  listChannelsOutputSchema,
  listSyncedVideosInputSchema,
  listSyncedVideosOutputSchema,
  parseWithSchema,
  syncChannelInputSchema,
  syncChannelOutputSchema,
} from "./schemas";

export type StoredChannelRecord = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string;
  connectedUserId: string | null;
  connectedAt: Date;
  lastSyncedAt: Date | null;
};

export type StoredVideoRecord = {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  thumbnails: Record<string, ThumbnailInfo>;
  existingLocalizations: Record<string, LocaleMetadata>;
  etag: string | null;
  viewCount: number | null;
  commentCount: number | null;
  likeCount: number | null;
  durationSeconds: number | null;
  publishAt: string | null;
  lastSyncedAt: Date;
};

type ServiceDependencies = {
  authResolver: {
    resolve(args: {
      credentialRef: unknown;
      requiredScopes: readonly string[];
    }): Promise<ResolvedCredentials>;
  };
  youtubeApi: {
    getChannelForSync(args: {
      credentials: ResolvedCredentials;
      channelId?: string;
    }): Promise<ChannelForSync | null>;
    listUploadsPlaylistVideoIds(args: {
      credentials: ResolvedCredentials;
      uploadsPlaylistId: string;
      /** Optional: running count of uploads found, after each page. */
      onPage?: (found: number) => void;
    }): Promise<string[]>;
    getVideosMetadataBatch(args: {
      credentials: ResolvedCredentials;
      videoIds: string[];
      /** Optional: `(ids processed, total)` after each chunk. Still ONE logical call for all ids. */
      onProgress?: (done: number, total: number) => void;
    }): Promise<VideoSyncMetadata[]>;
  };
  channelStore: {
    upsertChannel(args: {
      channelId: string;
      title: string;
      thumbnailUrl: string | null;
      uploadsPlaylistId: string;
      /** `undefined` = leave the stored owner unchanged (never cleared by a sync). */
      connectedUserId?: string;
      /** BL-118: the channel's creation time on YouTube; `null`/`undefined` leaves a stored value untouched. */
      publishedAt?: string | null;
    }): Promise<void>;
    markChannelSynced(channelId: string, syncedAt: Date): Promise<void>;
    listChannels(): Promise<StoredChannelRecord[]>;
    getChannel(channelId: string): Promise<StoredChannelRecord | null>;
    upsertVideos(
      entries: Array<{
        videoId: string;
        channelId: string;
        title: string;
        description: string;
        publishedAt: string;
        privacyStatus: string;
        defaultLanguage: string | null;
        defaultAudioLanguage: string | null;
        thumbnails: Record<string, ThumbnailInfo>;
        existingLocalizations: Record<string, LocaleMetadata>;
        etag: string | null;
        viewCount: number | null;
        commentCount: number | null;
        likeCount: number | null;
        durationSeconds: number | null;
        publishAt: string | null;
      }>,
      syncedAt: Date
    ): Promise<void>;
    listVideosByChannel(channelId: string): Promise<StoredVideoRecord[]>;
  };
  logger: {
    info(payload: { event: string; context?: Record<string, unknown> }): void;
    error(payload: { event: string; context?: Record<string, unknown> }): void;
  };
  channelAccess: ChannelAccessService;
};

function mapStoredChannel(record: StoredChannelRecord): SyncedChannel {
  return {
    channelId: record.channelId,
    title: record.title,
    thumbnailUrl: record.thumbnailUrl,
    uploadsPlaylistId: record.uploadsPlaylistId,
    connectedUserId: record.connectedUserId,
    connectedAt: record.connectedAt.toISOString(),
    lastSyncedAt: record.lastSyncedAt ? record.lastSyncedAt.toISOString() : null,
  };
}

function mapStoredVideo(record: StoredVideoRecord): SyncedVideo {
  return {
    videoId: record.videoId,
    channelId: record.channelId,
    title: record.title,
    description: record.description,
    publishedAt: record.publishedAt,
    privacyStatus: record.privacyStatus,
    defaultLanguage: record.defaultLanguage,
    defaultAudioLanguage: record.defaultAudioLanguage,
    thumbnails: record.thumbnails,
    existingLocalizations: record.existingLocalizations,
    existingLocalizationLanguages: Object.keys(record.existingLocalizations).sort(),
    lastSyncedAt: record.lastSyncedAt.toISOString(),
    etag: record.etag,
    viewCount: record.viewCount,
    commentCount: record.commentCount,
    likeCount: record.likeCount,
    publishAt: record.publishAt,
  };
}

function getCredentialUserId(credentialRef: unknown): string | null {
  return credentialRef !== null &&
    typeof credentialRef === "object" &&
    "userId" in credentialRef &&
    typeof (credentialRef as { userId?: unknown }).userId === "string"
    ? (credentialRef as { userId: string }).userId
    : null;
}

export function createChannelSyncServices(deps: ServiceDependencies) {
  return {
    async syncChannel(input: unknown, options: { progress?: ProgressReporter } = {}): Promise<SyncChannelResult> {
      const parsedInput = parseWithSchema(syncChannelInputSchema, input, "sync channel input");
      const progress = options.progress;

      try {
        progress?.stage("Resolving the channel on YouTube");
        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_READ_SCOPE],
        });

        const channel = await deps.youtubeApi.getChannelForSync({
          credentials,
          channelId: parsedInput.channelId,
        });

        if (!channel) {
          throw new DomainError({
            code: "not_found",
            message: "Cannot resolve channel for synchronization",
            details: { channelId: parsedInput.channelId ?? null },
          });
        }

        const connectedUserId = getCredentialUserId(parsedInput.credentialRef);

        // Only an *implicit* resolution (no explicit channelId -- i.e. "sync my channel",
        // channels.list({mine:true}) under the hood) is trustworthy evidence of which channel
        // this session's live OAuth token actually grants. An explicit channelId is a public,
        // unauthenticated-scope lookup (see getChannelForSync) and must never make some other
        // channel "active" just because it happened to be re-synced.
        if (!parsedInput.channelId && connectedUserId) {
          await deps.channelAccess.activateChannel({
            userId: connectedUserId,
            channelId: channel.channelId,
          });
        }

        await deps.channelStore.upsertChannel({
          channelId: channel.channelId,
          title: channel.title,
          thumbnailUrl: channel.thumbnailUrl,
          uploadsPlaylistId: channel.uploadsPlaylistId,
          // Architecture audit 2026-10-01 (H3): only the implicit "my channel" resolution is evidence
          // of which Google identity OWNS this channel. An explicit-id sync is a public lookup and a
          // credential without a user id (raw access token) proves nothing -- neither may re-own or
          // disconnect the channel (that column now also decides agent-token validity, Phase 12).
          connectedUserId: !parsedInput.channelId && connectedUserId ? connectedUserId : undefined,
          publishedAt: channel.publishedAt,
        });

        progress?.stage("Listing uploads");
        const videoIds = await deps.youtubeApi.listUploadsPlaylistVideoIds({
          credentials,
          uploadsPlaylistId: channel.uploadsPlaylistId,
          onPage: progress ? (found) => progress.stage(`Listing uploads \u2014 ${found} found`) : undefined,
        });

        progress?.counts(0, videoIds.length);
        progress?.stage("Reading video details");
        const videoMetadata = await deps.youtubeApi.getVideosMetadataBatch({
          credentials,
          videoIds,
          onProgress: progress ? (done, total) => progress.counts(done, total) : undefined,
        });

        progress?.stage("Saving videos locally");

        const syncedAt = new Date();

        await deps.channelStore.upsertVideos(
          videoMetadata.map((video) => ({
            videoId: video.videoId,
            channelId: channel.channelId,
            title: video.title,
            description: video.description,
            publishedAt: video.publishedAt,
            privacyStatus: video.privacyStatus,
            defaultLanguage: video.defaultLanguage,
            defaultAudioLanguage: video.defaultAudioLanguage,
            thumbnails: video.thumbnails,
            existingLocalizations: video.existingLocalizations,
            etag: video.etag,
            viewCount: video.viewCount,
            commentCount: video.commentCount,
            likeCount: video.likeCount,
            durationSeconds: video.durationSeconds,
            publishAt: video.publishAt,
          })),
          syncedAt
        );

        await deps.channelStore.markChannelSynced(channel.channelId, syncedAt);
        progress?.counts(videoMetadata.length, videoMetadata.length);

        const storedChannel = await deps.channelStore.getChannel(channel.channelId);
        if (!storedChannel) {
          throw new DomainError({
            code: "not_found",
            message: "Channel disappeared immediately after sync persistence",
            details: { channelId: channel.channelId },
          });
        }

        const output = parseWithSchema(
          syncChannelOutputSchema,
          {
            channel: mapStoredChannel(storedChannel),
            videoCount: videoMetadata.length,
            syncedAt: syncedAt.toISOString(),
          },
          "sync channel output"
        );

        deps.logger.info({
          event: "channel_sync.sync.success",
          context: { channelId: channel.channelId, videoCount: videoMetadata.length },
        });

        return output;
      } catch (error) {
        const mapped = mapUnknownError(error, "update_failed");
        deps.logger.error({ event: "channel_sync.sync.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    async listChannels(input: unknown) {
      const parsedInput = parseWithSchema(listChannelsInputSchema, input, "list channels input");

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        const activeChannelId = await deps.channelAccess.getActiveChannelId(userId);
        const records = await deps.channelStore.listChannels();
        const visible = records.filter((record) => record.channelId === activeChannelId);
        return parseWithSchema(
          listChannelsOutputSchema,
          { channels: visible.map(mapStoredChannel) },
          "list channels output"
        );
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    async listSyncedVideos(input: unknown) {
      const parsedInput = parseWithSchema(
        listSyncedVideosInputSchema,
        input,
        "list synced videos input"
      );

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const records = await deps.channelStore.listVideosByChannel(parsedInput.channelId);
        return parseWithSchema(
          listSyncedVideosOutputSchema,
          {
            channelId: parsedInput.channelId,
            videos: records.map(mapStoredVideo),
          },
          "list synced videos output"
        );
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },
  };
}

export type ChannelSyncServices = ReturnType<typeof createChannelSyncServices>;
