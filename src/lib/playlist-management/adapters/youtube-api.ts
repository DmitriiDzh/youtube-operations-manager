import { createGoogleOAuthClient } from "@/lib/auth";
import {
  createYoutubeClient,
  getPlaylistForUpdate as getPlaylistForUpdateFromYoutube,
  listPlaylistItemIdsByVideo,
  listPlaylistsForAuthenticated,
} from "@/lib/youtube-read-gateway";
import {
  addVideoToPlaylistForAuthenticated,
  assertLiveWritesAuthorized,
  createPlaylistForAuthenticated,
  deletePlaylistForAuthenticated,
  deletePlaylistItemById,
  updatePlaylistForAuthenticated,
} from "@/lib/youtube-write-gateway";
import type {
  Playlist,
  PlaylistPrivacyStatus,
  ResolvedCredentials,
} from "../contracts";

function createAuthorizedClient(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });

  return createYoutubeClient(oauth2);
}

export function createPlaylistYoutubeApiAdapter() {
  return {
    async listPlaylists(args: { credentials: ResolvedCredentials }): Promise<Playlist[]> {
      const youtube = await createAuthorizedClient(args.credentials);
      return listPlaylistsForAuthenticated(youtube);
    },

    async createPlaylist(args: {
      credentials: ResolvedCredentials;
      title: string;
      description?: string;
      privacyStatus: PlaylistPrivacyStatus;
    }): Promise<Playlist> {
      await assertLiveWritesAuthorized();
      const youtube = await createAuthorizedClient(args.credentials);
      return createPlaylistForAuthenticated(
        youtube,
        args.title,
        args.privacyStatus,
        args.description
      );
    },

    async getPlaylistForUpdate(args: { credentials: ResolvedCredentials; playlistId: string }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return getPlaylistForUpdateFromYoutube(youtube, args.playlistId);
    },

    async updatePlaylist(args: {
      credentials: ResolvedCredentials;
      playlistId: string;
      title: string;
      description: string;
      privacyStatus: PlaylistPrivacyStatus;
    }): Promise<Playlist> {
      await assertLiveWritesAuthorized();
      const youtube = await createAuthorizedClient(args.credentials);
      return updatePlaylistForAuthenticated({
        youtube,
        playlistId: args.playlistId,
        title: args.title,
        description: args.description,
        privacyStatus: args.privacyStatus,
      });
    },

    async getPlaylistForDelete(args: { credentials: ResolvedCredentials; playlistId: string }) {
      const youtube = await createAuthorizedClient(args.credentials);
      const response = await youtube.playlists.list({
        part: ["id", "snippet"],
        id: [args.playlistId],
        maxResults: 1,
      });

      const playlist = response.data.items?.[0];
      if (!playlist?.id || !playlist.snippet?.channelId) {
        return null;
      }

      return {
        id: playlist.id,
        channelId: playlist.snippet.channelId,
        title: playlist.snippet.title ?? "Untitled",
      };
    },

    async deletePlaylist(args: { credentials: ResolvedCredentials; playlistId: string }) {
      await assertLiveWritesAuthorized();
      const youtube = await createAuthorizedClient(args.credentials);
      await deletePlaylistForAuthenticated(youtube, args.playlistId);
    },

    async addVideoToPlaylist(args: {
      credentials: ResolvedCredentials;
      playlistId: string;
      videoId: string;
    }) {
      await assertLiveWritesAuthorized();
      const youtube = await createAuthorizedClient(args.credentials);
      await addVideoToPlaylistForAuthenticated(youtube, args.videoId, args.playlistId);
    },

    async listPlaylistItemIdsByVideo(args: {
      credentials: ResolvedCredentials;
      playlistId: string;
    }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return listPlaylistItemIdsByVideo(youtube, args.playlistId);
    },

    async deletePlaylistItem(args: { credentials: ResolvedCredentials; playlistItemId: string }) {
      await assertLiveWritesAuthorized();
      const youtube = await createAuthorizedClient(args.credentials);
      await deletePlaylistItemById(youtube, args.playlistItemId);
    },
  };
}
