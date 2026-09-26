import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/playlist-management/contracts";
import { createCreatePlaylistPostHandler } from "./route";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/youtube/create-playlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("create-playlist route preserves response envelope", async () => {
  const handler = createCreatePlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      createPlaylist: async () => ({
        playlist: {
          id: "p-created",
          title: "Roadtrip",
          description: "Summer videos",
          privacyStatus: "unlisted",
        },
      }),
    },
  });

  const response = await handler(
    makeRequest({ title: "Roadtrip", description: "Summer videos", privacyStatus: "unlisted" })
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(payload, {
    id: "p-created",
    title: "Roadtrip",
    description: "Summer videos",
    privacyStatus: "unlisted",
  });
});

test("create-playlist route rejects missing title", async () => {
  const handler = createCreatePlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      createPlaylist: async () => ({
        playlist: {
          id: "unused",
          title: "unused",
          description: "",
          privacyStatus: "private",
        },
      }),
    },
  });

  const response = await handler(makeRequest({ title: " " }));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: "Title is required" });
});

// Independent test-suite audit (2026-09-26): this route implements a 401 pre-auth check but had
// no test proving it, unlike its sibling GET route (../playlists/route.test.ts).
test("create-playlist route returns unauthorized when session is missing", async () => {
  const handler = createCreatePlaylistPostHandler({
    getSession: async () => null,
    core: {
      createPlaylist: async () => ({
        playlist: { id: "unused", title: "unused", description: "", privacyStatus: "private" },
      }),
    },
  });

  const response = await handler(makeRequest({ title: "Roadtrip" }));
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(payload, { error: "Unauthorized" });
});

// Independent test-suite audit (2026-09-26): this route used to parse the request body with raw
// `request.json()` before entering its try block, so a malformed body threw an uncaught
// SyntaxError -> bare 500. Now routed through parseVideoMetadataJsonBody inside the try block.
test("create-playlist route surfaces malformed JSON as a structured 400, not a bare 500", async () => {
  const handler = createCreatePlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      createPlaylist: async () => ({
        playlist: { id: "unused", title: "unused", description: "", privacyStatus: "private" },
      }),
    },
  });

  const request = new Request("http://localhost/api/youtube/create-playlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
  const response = await handler(request);
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, "validation_failed");
});

// Regression test: before this fix, a DomainError thrown by the core (e.g. the gateway's
// live_writes_disabled, src/lib/youtube-write-gateway) propagated uncaught, producing a bare
// 500 with no JSON body -- discovered live 2026-09-21 while independently verifying BL-046
// against a real browser session (this route currently has no UI caller, but must still fail
// with a structured, informative error like every other route in this app, DEVELOPMENT_PLAYBOOK
// §6.6 point 5).
test("create-playlist route surfaces a DomainError as a structured JSON error, not a bare 500", async () => {
  const handler = createCreatePlaylistPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      createPlaylist: async () => {
        throw new DomainError({ code: "live_writes_disabled", message: "Real YouTube write execution is disabled" });
      },
    },
  });

  const response = await handler(makeRequest({ title: "Roadtrip" }));
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.deepEqual(payload, {
    error: "live_writes_disabled",
    message: "Real YouTube write execution is disabled",
  });
});
