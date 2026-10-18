import type { Playlist } from "./contracts";

/**
 * BL-197 (owner, Telegram 2026-10-18, msg 2988): the Web UI's playlist pickers (Content → publishing settings, the live stream's video
 * settings) reuse the channel's playlist list for `PLAYLIST_LIST_MEMO_TTL_MS` instead of reading `playlists.list` on every open. Kept per
 * signed-in identity (one identity = one channel's grant); any playlist change made through this app forgets it, the pickers' own
 * "refresh" reads live, and a server restart starts empty. Agents (MCP) and the CLI always read live.
 *
 * On `globalThis` under a `Symbol.for` key: route bundles must share one memo (the BL-116 lesson).
 */

export const PLAYLIST_LIST_MEMO_TTL_MS = 3_600_000;

type Entry = { playlists: Playlist[]; readAt: number };

const KEY = Symbol.for("youtube-operations-manager.playlist-list-memo");
type GlobalWithMemo = typeof globalThis & { [KEY]?: Map<string, Entry> };

function entries(): Map<string, Entry> {
  const g = globalThis as GlobalWithMemo;
  return (g[KEY] ??= new Map<string, Entry>());
}

export function recallPlaylists(userId: string, now: Date = new Date()): Playlist[] | null {
  const entry = entries().get(userId);
  if (!entry) return null;
  if (now.getTime() - entry.readAt >= PLAYLIST_LIST_MEMO_TTL_MS) {
    entries().delete(userId);
    return null;
  }
  return entry.playlists;
}

export function rememberPlaylists(userId: string, playlists: Playlist[], now: Date = new Date()): void {
  entries().set(userId, { playlists, readAt: now.getTime() });
}

export function forgetPlaylists(userId: string): void {
  entries().delete(userId);
}

export type PlaylistListMemo = {
  recall(userId: string): Playlist[] | null;
  remember(userId: string, playlists: Playlist[]): void;
  forget(userId: string): void;
};

const processMemo: PlaylistListMemo = {
  recall: (userId) => recallPlaylists(userId),
  remember: (userId, playlists) => rememberPlaylists(userId, playlists),
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
      const result = await services.listPlaylists(input);
      if (userId) memo.remember(userId, result.playlists);
      return result;
    },
  };
}
