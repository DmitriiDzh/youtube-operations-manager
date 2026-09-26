import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/playlist-management/contracts";
import { createPlaylistsGetHandler } from "./route";

test("playlists route returns list payload on happy path", async () => {
  const handler = createPlaylistsGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      listPlaylists: async () => ({
        playlists: [
          {
            id: "p1",
            title: "Playlist 1",
            description: "Roadtrip videos",
            privacyStatus: "private",
          },
        ],
      }),
    },
  });

  const response = await handler();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, [
    {
      id: "p1",
      title: "Playlist 1",
      description: "Roadtrip videos",
      privacyStatus: "private",
    },
  ]);
});

test("playlists route returns unauthorized when session is missing", async () => {
  const handler = createPlaylistsGetHandler({
    getSession: async () => null,
    core: {
      listPlaylists: async () => ({ playlists: [] }),
    },
  });

  const response = await handler();
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(payload, { error: "Unauthorized" });
});

// Independent test-suite audit (2026-09-26): this route's GET handler had no try/catch at all,
// so a DomainError from the core (e.g. a disabled-reads toggle) propagated uncaught as a bare
// framework 500 instead of the structured JSON error every sibling POST route already returns
// (and has its own regression test for, e.g. ../create-playlist/route.test.ts).
test("playlists route surfaces a DomainError as a structured JSON error, not a bare 500", async () => {
  const handler = createPlaylistsGetHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      listPlaylists: async () => {
        throw new DomainError({ code: "data_api_reads_disabled", message: "Data API reads are disabled" });
      },
    },
  });

  const response = await handler();
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.deepEqual(payload, {
    error: "data_api_reads_disabled",
    message: "Data API reads are disabled",
  });
});
