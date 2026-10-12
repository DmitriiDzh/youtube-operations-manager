import { createGoogleOAuthClient } from "@/lib/auth";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import {
  assertLiveWritesAuthorized,
  bindLiveBroadcast,
  insertLiveBroadcast,
  insertLiveStream,
  transitionLiveBroadcast,
  updateLiveBroadcast,
} from "@/lib/youtube-write-gateway";
import { createYoutubeClient, getLiveBroadcasts } from "@/lib/youtube-read-gateway";
import type { BroadcastsDependencies } from "../broadcasts";

// BL-176 (LIVE_STREAMS_PLAN.md §3.2/§3.9, ADR 0036 §3): the owner's live writes, each through the write gateway with the
// shared Live-writes check immediately before it (AGENTS.md §G; gateway-inventory.test.ts checks this file calls it).

async function clientFor(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
  return createYoutubeClient(oauth2);
}

export function createLiveStreamsYoutubeWrites(): BroadcastsDependencies["youtube"] {
  return {
    async insertStream(credentials, args) {
      const youtube = await clientFor(credentials);
      await assertLiveWritesAuthorized();
      return insertLiveStream(youtube, { title: args.title, format: { resolution: "1080p", frameRate: "30fps" } });
    },
    async insertBroadcast(credentials, args) {
      const youtube = await clientFor(credentials);
      await assertLiveWritesAuthorized();
      return insertLiveBroadcast(youtube, args);
    },
    async bind(credentials, args) {
      const youtube = await clientFor(credentials);
      await assertLiveWritesAuthorized();
      return bindLiveBroadcast(youtube, args);
    },
    async transition(credentials, args) {
      const youtube = await clientFor(credentials);
      await assertLiveWritesAuthorized();
      return transitionLiveBroadcast(youtube, args);
    },
    async update(credentials, args) {
      const youtube = await clientFor(credentials);
      await assertLiveWritesAuthorized();
      return updateLiveBroadcast(youtube, args);
    },
    async getBroadcast(credentials, broadcastId) {
      const youtube = await clientFor(credentials);
      return (await getLiveBroadcasts(youtube, [broadcastId]))[0] ?? null;
    },
  };
}
