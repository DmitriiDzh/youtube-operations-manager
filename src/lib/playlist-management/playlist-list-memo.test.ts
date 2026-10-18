import assert from "node:assert/strict";
import test from "node:test";
import type { Playlist } from "./contracts";
import { PLAYLIST_LIST_MEMO_TTL_MS, forgetPlaylists, playlistsEpoch, recallPlaylists, rememberPlaylists, withPlaylistListMemo, type PlaylistListMemo } from "./playlist-list-memo";

// BL-197 acceptance (owner, Telegram 2026-10-18, msg 2988): the pickers' playlist list is read from YouTube at most once an hour per
// identity; a playlist change made in this app, or the picker's refresh, reads it live again; agents keep the live list.

const LIST: Playlist[] = [{ id: "PL1", title: "One", description: "", privacyStatus: "public" }];
const input = (userId: string) => ({ credentialRef: { userId } });

function harness(options: { failCreate?: boolean; slowList?: boolean } = {}) {
  const liveReads: string[] = [];
  const store = new Map<string, Playlist[]>();
  const epochs = new Map<string, number>();
  const memo: PlaylistListMemo = {
    recall: (u) => store.get(u) ?? null,
    epoch: (u) => epochs.get(u) ?? 0,
    remember: (u, p, e) => {
      if ((epochs.get(u) ?? 0) === e) store.set(u, p);
    },
    forget: (u) => {
      store.delete(u);
      epochs.set(u, (epochs.get(u) ?? 0) + 1);
    },
  };
  let releaseList: (() => void) | null = null;
  const ok = async (changeInput: unknown) => ({ ok: changeInput !== undefined });
  const services = withPlaylistListMemo(
    {
      listPlaylists: async (i: unknown) => {
        liveReads.push((i as { credentialRef: { userId: string } }).credentialRef.userId);
        if (options.slowList) await new Promise<void>((resolve) => (releaseList = resolve));
        return { playlists: LIST };
      },
      createPlaylist: async (changeInput: unknown) => {
        if (options.failCreate) throw new Error("quota");
        return { ok: changeInput !== undefined };
      },
      updatePlaylist: ok,
      deletePlaylist: ok,
      addVideosToPlaylist: ok,
      removeVideosFromPlaylist: ok,
    },
    memo
  );
  return { services, liveReads, store, release: () => releaseList?.() };
}

test("playlist memo: the TTL is 1 hour", () => {
  assert.equal(PLAYLIST_LIST_MEMO_TTL_MS, 3_600_000);
});

test("playlist memo: the second picker open answers from the memo; another identity reads its own", async () => {
  const h = harness();
  assert.deepEqual(await h.services.listPlaylistsRemembered(input("u1")), { playlists: LIST });
  assert.deepEqual(await h.services.listPlaylistsRemembered(input("u1")), { playlists: LIST });
  await h.services.listPlaylistsRemembered(input("u2"));
  assert.deepEqual(h.liveReads, ["u1", "u2"]);
});

test("playlist memo: refresh reads live even when remembered", async () => {
  const h = harness();
  await h.services.listPlaylistsRemembered(input("u1"));
  await h.services.listPlaylistsRemembered(input("u1"), { refresh: true });
  assert.deepEqual(h.liveReads, ["u1", "u1"]);
});

test("playlist memo: every playlist change forgets that identity's list (even a failed one), not the others'", async () => {
  for (const change of ["createPlaylist", "updatePlaylist", "deletePlaylist", "addVideosToPlaylist", "removeVideosFromPlaylist"] as const) {
    const h = harness();
    await h.services.listPlaylistsRemembered(input("u1"));
    await h.services.listPlaylistsRemembered(input("u2"));
    await h.services[change](input("u1"));
    assert.equal(h.store.has("u1"), false, change);
    assert.equal(h.store.has("u2"), true, change);
  }
  const failing = harness({ failCreate: true });
  await failing.services.listPlaylistsRemembered(input("u1"));
  await assert.rejects(failing.services.createPlaylist(input("u1")), /quota/);
  assert.equal(failing.store.has("u1"), false);
});

test("playlist memo: the plain listPlaylists (agents, CLI) always reads live and does not fill the memo", async () => {
  const h = harness();
  await h.services.listPlaylists(input("u1"));
  await h.services.listPlaylists(input("u1"));
  assert.deepEqual(h.liveReads, ["u1", "u1"]);
  assert.equal(h.store.size, 0);
});

test("playlist memo (process store): recalled until just before 1 h, gone at 1 h; forget removes it", () => {
  const at = new Date("2026-10-18T10:00:00Z");
  rememberPlaylists("pl-memo-user", LIST, playlistsEpoch("pl-memo-user"), at);
  assert.deepEqual(recallPlaylists("pl-memo-user", new Date("2026-10-18T10:59:59Z")), LIST);
  assert.equal(recallPlaylists("pl-memo-user", new Date("2026-10-18T11:00:00Z")), null);
  rememberPlaylists("pl-memo-user", LIST, playlistsEpoch("pl-memo-user"), at);
  forgetPlaylists("pl-memo-user");
  assert.equal(recallPlaylists("pl-memo-user", at), null);
});

test("playlist memo: a list read that started before a playlist change is not remembered after it (review of BL-197)", async () => {
  const h = harness({ slowList: true });
  const reading = h.services.listPlaylistsRemembered(input("u1"));
  await new Promise((resolve) => setImmediate(resolve));
  await h.services.createPlaylist(input("u1"));
  h.release();
  await reading;
  assert.equal(h.store.has("u1"), false);
});
