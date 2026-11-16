// BL-269 (VIDEO_CAPTIONS_PLAN.md §3.2, ADR 0074): the captions writer. Its callers are the publishing module only -- the upload
// runner's captions step and the package-captions service (owner route, Producer tool); §M: this module imports nothing from
// `publishing`, which hands it the file, the app's own tracks and the channel's switch.
import { YOUTUBE_FORCE_SSL_SCOPE, YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { createBackupCore } from "@/lib/backup";
import { resolveConnectedChannelUser } from "@/lib/channel-connections";
import { insertVideoEditAuditEvent, rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createQuotaGuardCore } from "@/lib/quota-guard";
import { createIdGenerator, DomainError } from "@/lib/shared-domain";
import { createWriteContextCore } from "@/lib/write-context";
import { createYoutubeClient, downloadVideoCaption, getVideoCaptionContext, listVideoCaptions } from "@/lib/youtube-read-gateway";
import { runWithQuotaContext } from "@/lib/youtube-quota/context";
import { authorizedOAuth, createVideoCaptionWrites } from "./adapters/youtube-writes";
import type { CaptionActor, CaptionWriteInput, CaptionWriteResult } from "./contracts";
import { createVideoCaptionsServices } from "./services";

export type { CaptionActor, CaptionTrackSummary, CaptionWriteInput, CaptionWriteResult } from "./contracts";
export { CAPTIONS_DRY_RUN_UNITS, CAPTIONS_INSERT_UNITS, CAPTIONS_OVERWRITE_UNITS } from "./contracts";
export { CAPTIONS_LANGUAGE, CAPTIONS_MAX_BYTES, checkCaptionFile, isEnglishLanguage } from "./caption-file";
export { sha256Hex } from "./hash";

export type VideoCaptionsCoreOptions = {
  /** The channel's captions switch now (publishing's synced default; the caller reads it). */
  captionsEnabled(channelId: string): Promise<boolean>;
  /** The runner's lost-answer mark (absent: nothing persisted -- the owner and Producer paths). */
  markAttempt?(args: { channelId: string; videoId: string; trackIdsBefore: string[] }): Promise<void>;
};

export function createVideoCaptionsCore(options: VideoCaptionsCoreOptions) {
  const writeContext = createWriteContextCore();
  const backup = createBackupCore();
  const writes = createVideoCaptionWrites();
  const newId = createIdGenerator();
  const client = async (credentials: Parameters<typeof authorizedOAuth>[0]) => createYoutubeClient(authorizedOAuth(credentials));
  const services = createVideoCaptionsServices({
    async credentials(channelId, actor) {
      const userId = actor.kind === "producer" ? await resolveConnectedChannelUser(channelId) : actor.userId;
      if (!userId) throw new DomainError({ code: "WRITE_CHANNEL_UNRESOLVED", message: "This channel is not connected on this computer (Settings → Channels).", details: { channelId } });
      const credentialRef = { userId };
      // `captions.*` lists youtube.force-ssl (or youtubepartner), not the plain youtube scope (captions/insert reference).
      return { credentialRef, credentials: await resolveGoogleCredentials({ credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE, YOUTUBE_FORCE_SSL_SCOPE] }) };
    },
    captionsEnabled: (channelId) => options.captionsEnabled(channelId),
    readVideo: async (credentials, videoId) => getVideoCaptionContext(await client(credentials), videoId),
    listTracks: async (credentials, videoId) => listVideoCaptions(await client(credentials), videoId),
    downloadTrack: async (credentials, trackId) => downloadVideoCaption(await client(credentials), trackId),
    checkUnits: (units) => createQuotaGuardCore().checkUnits(units),
    assertDeviceAvailable: () => assertDeviceAvailableForMutation(rawSqlClient),
    backup,
    async assertWriteChannel({ channelId, credentialRef, credentials }) {
      await writeContext.assertWriteChannel({ credentialRef, credentials, expectedChannelId: channelId });
    },
    markAttempt: async (args) => {
      await options.markAttempt?.(args);
    },
    insert: (credentials, args) => writes.insert(credentials, args),
    update: (credentials, args) => writes.update(credentials, args),
    audit: ({ channelId, videoId, eventType, detail }) => insertVideoEditAuditEvent({ channelId, videoId, eventType, detail }),
    newOperationId: () => `captions-${newId()}`,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return {
    /** The write (or its dry run) under its own quota context. */
    write(input: CaptionWriteInput, actor: CaptionActor): Promise<CaptionWriteResult> {
      return runWithQuotaContext({ kind: "video_captions", id: input.videoId, label: `Captions ${input.video}` }, () => services.write(input, actor));
    },
  };
}
