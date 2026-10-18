import { createUserTtlMemo } from "@/lib/user-ttl-memo";
import type { Playlist } from "./contracts";

/**
 * BL-197 (owner, Telegram 2026-10-18, msg 2988): the Web UI's playlist pickers (Content → publishing settings, the live stream's video
 * settings) reuse the channel's playlist list for `PLAYLIST_LIST_MEMO_TTL_MS` instead of reading `playlists.list` on every open. Kept per
 * signed-in identity (one identity = one channel's grant); any playlist change made through this app, a Google sign-in and a disconnect
 * forget it, the pickers' own "refresh" reads live, and a server restart starts empty. Agents (MCP) and the CLI always read live.
 */

export const PLAYLIST_LIST_MEMO_TTL_MS = 3_600_000;

const memo = createUserTtlMemo<Playlist[]>("youtube-operations-manager.playlist-list-memo", PLAYLIST_LIST_MEMO_TTL_MS);

export function recallPlaylists(userId: string, now: Date = new Date()): Playlist[] | null {
  return memo.recall(userId, now);
}

export function playlistsEpoch(userId: string): number {
  return memo.epoch(userId);
}

export function rememberPlaylists(userId: string, playlists: Playlist[], epoch: number, now: Date = new Date()): void {
  memo.remember(userId, playlists, epoch, now);
}

export function forgetPlaylists(userId: string): void {
  memo.forget(userId);
}

export type PlaylistListMemo = {
  recall(userId: string): Playlist[] | null;
  epoch(userId: string): number;
  remember(userId: string, playlists: Playlist[], epoch: number): void;
  forget(userId: string): void;
};

const processMemo: PlaylistListMemo = {
  recall: (userId) => recallPlaylists(userId),
  epoch: playlistsEpoch,
  remember: (userId, playlists, epoch) => rememberPlaylists(userId, playlists, epoch),
  forget: (userId) => forgetPlaylists(userId),
};

function userIdOf(input: unknown): string | null {
  const ref = input && typeof input === "object" ? (input as { credentialRef?: unknown }).credentialRef : null;
  return ref && typeof ref === "object" && typeof (ref as { userId?: unknown }).userId === "string" ? (ref as { userId: string }).userId : null;
}

type PlaylistServicesShape = {
  listPlaylists(input: unknown): Promise<{ playlists: Playlist[] }>;
  createPlaylist(input: unknown): Promise<unknown>;
  updatePlaylist(input: unknown): Promise<unknown>;
  deletePlaylist(input: unknown): Promise<unknown>;
  addVideosToPlaylist(input: unknown): Promise<unknown>;
  removeVideosFromPlaylist(input: unknown): Promise<unknown>;
};

/**
 * The playlist services with the memo: every playlist change made through them (even one that failed half way) forgets the identity's
 * remembered list, and `listPlaylistsRemembered` is the Web UI pickers' read. `listPlaylists` itself stays live (agents, CLI).
 */
export function withPlaylistListMemo<S extends PlaylistServicesShape>(services: S, memo: PlaylistListMemo = processMemo) {
  function forgettingAfter<R>(fn: (input: unknown) => Promise<R>): (input: unknown) => Promise<R> {
    return async (input: unknown) => {
      try {
        return await fn(input);
      } finally {
        const userId = userIdOf(input);
        if (userId) memo.forget(userId);
      }
    };
  }
  return {
    ...services,
    createPlaylist: forgettingAfter(services.createPlaylist) as S["createPlaylist"],
    updatePlaylist: forgettingAfter(services.updatePlaylist) as S["updatePlaylist"],
    deletePlaylist: forgettingAfter(services.deletePlaylist) as S["deletePlaylist"],
    addVideosToPlaylist: forgettingAfter(services.addVideosToPlaylist) as S["addVideosToPlaylist"],
    removeVideosFromPlaylist: forgettingAfter(services.removeVideosFromPlaylist) as S["removeVideosFromPlaylist"],
    /** The identity's remembered list while younger than 1 h, otherwise (or with `refresh`) the live list, which is then remembered. */
    async listPlaylistsRemembered(input: unknown, options: { refresh?: boolean } = {}): Promise<{ playlists: Playlist[] }> {
      const userId = userIdOf(input);
      const remembered = userId && !options.refresh ? memo.recall(userId) : null;
      if (remembered) return { playlists: remembered };
      // A playlist change finishing while this read runs forgets the list; this older answer is then not remembered.
      const epoch = userId ? memo.epoch(userId) : 0;
      const result = await services.listPlaylists(input);
      if (userId) memo.remember(userId, result.playlists, epoch);
      return result;
    },
  };
}
