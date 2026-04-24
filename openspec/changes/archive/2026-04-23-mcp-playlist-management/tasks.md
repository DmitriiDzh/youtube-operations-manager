# Tasks: MCP Playlist Management

## Phase 1: Foundation (core + auth contracts)

- [x] 1.1 Create `src/lib/playlist-management/contracts.ts` with domain types (`Playlist`, mutation summary, per-item result) and typed domain errors aligned with spec.
- [x] 1.2 Create `src/lib/playlist-management/schemas.ts` with strict Zod 4 input/output schemas for `list/create/add/remove` and exported inferred TS types.
- [x] 1.3 Create `src/lib/playlist-management/adapters/youtube-api.ts` with playlist/playlistItems operations over authenticated `youtube_v3.Youtube`.
- [x] 1.4 Create `src/lib/playlist-management/index.ts` and `src/lib/playlist-management/services.ts` exposing `listPlaylists`, `createPlaylist`, `addVideosToPlaylist`, `removeVideosFromPlaylist`.
- [x] 1.5 Extend auth resolution boundary in `src/lib/cli-auth/service.ts` (or shared auth helper) to enforce precedence `credentialRef > activeUserId > actionable error` for playlist operations.

## Phase 2: Core implementation + web compatibility

- [x] 2.1 Refactor `src/lib/youtube.ts` to extract reusable playlist helpers that operate on an authenticated YouTube client while preserving existing wrapper behavior.
- [x] 2.2 Implement service orchestration in `src/lib/playlist-management/services.ts`: scope checks (`youtube.readonly` vs `youtube`), adapter calls, and stable error mapping.
- [x] 2.3 Implement partial-result aggregation for add/remove with stable counters and `failures[]`/per-item outcomes required by specs.
- [x] 2.4 Update `src/app/api/youtube/playlists/route.ts` and `src/app/api/youtube/create-playlist/route.ts` to delegate to the new core without observable contract drift.
- [x] 2.5 Update `src/app/api/youtube/add-to-playlist/route.ts` and `src/app/api/youtube/remove-from-playlist/route.ts` to delegate to core and preserve current success/error envelopes.

## Phase 3: MCP + CLI exposure

- [x] 3.1 Update `src/mcp/server.ts` to register `playlist_list`, `playlist_create`, `playlist_add_videos`, `playlist_remove_videos` using core schemas/contracts.
- [x] 3.2 Implement MCP tool handlers with strict validation and auth precedence (`credentialRef` override, fallback to active context).
- [x] 3.3 Update `src/cli/video-metadata.ts` to add `playlist` commands (list/create/add/remove) reusing the same core and JSON envelope conventions.
- [x] 3.4 Ensure CLI argument parsing supports explicit `credentialRef` and returns typed actionable validation/auth errors with non-zero exit code.

## Phase 4: Tests and regression coverage

- [x] 4.1 Create `src/lib/playlist-management/services.test.ts` covering happy paths, auth precedence, scope failures, and add/remove partial outcomes.
- [x] 4.2 Create `src/lib/playlist-management/schemas.test.ts` validating strict parse errors and stable output shapes.
- [x] 4.3 Extend `src/mcp/server.test.ts` to verify new playlist tools, contract serialization, and explicit-vs-active credential precedence.
- [x] 4.4 Extend `src/cli/video-metadata.test.ts` to verify playlist commands, JSON output stability, and non-success exits on auth/validation errors.
- [x] 4.5 Add route regression tests in `src/app/api/youtube/playlists/route.test.ts`, `create-playlist/route.test.ts`, `add-to-playlist/route.test.ts`, `remove-from-playlist/route.test.ts` for compatibility with web contracts.

## Phase 5: Specs + docs alignment

- [x] 5.1 Update delta wording in `openspec/changes/mcp-playlist-management/specs/youtube-credential-resolution/spec.md` if needed to match implemented scope/error codes exactly.
- [x] 5.2 Update `README.md` with MCP tool names, CLI command examples, auth precedence rules, and partial-result response examples for add/remove.
