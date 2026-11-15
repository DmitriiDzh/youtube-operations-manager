// BL-255 (ADR 0069): the thumbnail writer for videos already on YouTube -- the owner's Web UI routes and the Producer's
// `producer_video_thumbnail_replace` are its only callers (no-agent-upload-tool.test.ts, AGENTS.md §F).
import { YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { createBackupCore } from "@/lib/backup";
import { getStoredChannel, insertVideoEditAuditEvent, updateStoredVideoThumbnails } from "@/lib/db";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createPackageScanCore, isUploadThumbnailStepPending, listThumbnailCandidates, type ThumbnailCandidateFolder } from "@/lib/publishing";
import { createIdGenerator, DomainError, type ResolvedCredentials } from "@/lib/shared-domain";
import { createWriteContextCore } from "@/lib/write-context";
import { createYoutubeClient, downloadVideoThumbnailImage, getVideoThumbnailState } from "@/lib/youtube-read-gateway";
import { runWithQuotaContext } from "@/lib/youtube-quota/context";
import { authorizedOAuth, createVideoThumbnailWrites } from "./adapters/youtube-writes";
import type { ThumbnailActor, ThumbnailReplaceResult } from "./contracts";
import { parseThumbnailReplaceInput } from "./schemas";
import { createVideoThumbnailsServices } from "./services";

export type { ThumbnailActor, ThumbnailReplaceInput, ThumbnailReplaceResult } from "./contracts";
export { THUMBNAIL_REPLACE_MAX_BYTES, THUMBNAIL_REPLACE_UNITS } from "./contracts";
export { isThumbnailCandidatePath } from "./services";

/** The Google account a channel is connected under here -- only for a channel Settings → Channels lists as connected. */
async function channelUser(channelId: string): Promise<string | null> {
  const connected = (await createChannelConnectionsCore().listConnectedChannels()).some((channel) => channel.channelId === channelId);
  return connected ? ((await getStoredChannel(channelId))?.connectedUserId ?? null) : null;
}

export function createVideoThumbnailsCore() {
  const writeContext = createWriteContextCore();
  const backup = createBackupCore();
  const writes = createVideoThumbnailWrites();
  const scan = createPackageScanCore();
  const newId = createIdGenerator();
  const services = createVideoThumbnailsServices({
    async credentials(channelId, actor) {
      const userId = actor.kind === "owner" ? actor.userId : await channelUser(channelId);
      if (!userId) throw new DomainError({ code: "WRITE_CHANNEL_UNRESOLVED", message: "This channel is not connected on this computer (Settings → Channels).", details: { channelId } });
      const credentialRef = { userId };
      return { credentialRef, credentials: await resolveGoogleCredentials({ credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] }) };
    },
    readFile: (channelId, relativePath) => scan.readThumbnail(channelId, relativePath),
    async readVideo(credentials: ResolvedCredentials, videoId: string) {
      return getVideoThumbnailState(await createYoutubeClient(authorizedOAuth(credentials)), videoId);
    },
    uploadThumbnailStepPending: (channelId, videoId) => isUploadThumbnailStepPending(channelId, videoId),
    downloadImage: (url) => downloadVideoThumbnailImage(url),
    backup,
    async assertWriteChannel({ channelId, credentialRef, credentials }) {
      await writeContext.assertWriteChannel({ credentialRef, credentials, expectedChannelId: channelId });
    },
    setThumbnail: (credentials, videoId, image) => writes.setThumbnail(credentials, videoId, image),
    audit: ({ channelId, videoId, eventType, detail }) => insertVideoEditAuditEvent({ channelId, videoId, eventType, detail }),
    storeThumbnails: (channelId, videoId, thumbnails) => updateStoredVideoThumbnails(channelId, videoId, thumbnails),
    newOperationId: () => `thumbnail-${newId()}`,
  });
  return {
    /** The images under `04 Videos/` to choose from: this video's own upload folders first (ADR 0069 §2). */
    async listCandidates(channelId: string, videoId: string): Promise<ThumbnailCandidateFolder[]> {
      return listThumbnailCandidates(channelId, videoId);
    },
    /** Validates the input, then runs the replace (or its dry run) under its own quota context. */
    async replace(payload: unknown, actor: ThumbnailActor): Promise<ThumbnailReplaceResult> {
      const input = parseThumbnailReplaceInput(payload);
      return runWithQuotaContext({ kind: "video_thumbnail", id: input.videoId, label: `Thumbnail ${input.videoId}` }, () => services.replace(input, actor));
    },
  };
}
