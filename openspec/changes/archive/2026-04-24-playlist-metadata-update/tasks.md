# Tasks: Playlist Metadata Update

## Phase 1: Contracts & Validation Foundation

- [x] 1.1 Update `src/lib/playlist-management/contracts.ts` to extend `Playlist` (`id/title/description/privacyStatus`) and add `UpdatePlaylistInput`/`UpdatePlaylistResult` patch contracts.
- [x] 1.2 Update `src/lib/playlist-management/schemas.ts` to extend `playlistSchema`, accept optional `description` in create, and add update input schema (`title?`, `description?`, `privacyStatus?`) with rule “at least one mutable field”.
- [x] 1.3 Align API adapter contracts in `src/lib/playlist-management/adapters/youtube-api.ts` and shared mapper types in `src/lib/youtube.ts` so list/create/update parse and return the same metadata shape.

## Phase 2: Core Create/Update Implementation

- [x] 2.1 Update list/create flows in `src/lib/playlist-management/services.ts` to return normalized metadata (`description` string, `privacyStatus` enum) without breaking existing envelopes.
- [x] 2.2 Implement `updatePlaylist` in `src/lib/playlist-management/services.ts` with auth resolution, `assertWriteChannel(expectedChannelId)`, ownership preflight, read-before-update merge, and typed domain errors.
- [x] 2.3 Implement YouTube integration in `src/lib/youtube.ts` and `src/lib/playlist-management/adapters/youtube-api.ts` for playlist lookup + update (`snippet.title`, `snippet.description`, `status.privacyStatus`) preserving non-patched values.
- [x] 2.4 Persist selected write channel on successful update in `services.ts` (same policy as other write use cases).

## Phase 3: MCP & CLI Wiring

- [x] 3.1 Add CLI command `playlist update` in `src/cli/video-metadata.ts` with `--playlistId`, `--expectedChannelId`, optional patch flags, strict validation, and stable JSON output.
- [x] 3.2 Extend CLI `playlist create` in `src/cli/video-metadata.ts` to accept optional `--description` while preserving existing argument behavior.
- [x] 3.3 Ensure CLI `playlist list` in `src/cli/video-metadata.ts` returns `description` and `privacyStatus` with unchanged envelope conventions.
- [x] 3.4 Add MCP tool `playlist_update` in `src/mcp/server.ts` and route to core with credential fallback parity (`credentialRef` explicit > active context).
- [x] 3.5 Extend MCP `playlist_create` + `playlist_list` in `src/mcp/server.ts` to support/return full metadata contracts and structured guardrail errors.

## Phase 4: Tests & Scenario Verification

- [x] 4.1 Expand `src/lib/playlist-management/schemas.test.ts` for updated playlist schema, update patch validation, and “empty patch” rejection.
- [x] 4.2 Expand `src/lib/playlist-management/services.test.ts` for update happy path, write-channel mismatch, unresolved channel, invalid ownership, and read-merge semantics.
- [x] 4.3 Expand `src/cli/video-metadata.test.ts` for `playlist list/create/update` contracts, exit-code behavior, and actionable validation errors.
- [x] 4.4 Expand `src/mcp/server.test.ts` for `playlist_update` plus list/create metadata shape and fail-closed guardrail errors.
- [x] 4.5 Run verification commands `npm test`, `npm run lint`, and `npx tsc --noEmit` to confirm scenarios pass across core/CLI/MCP.

## Phase 5: Documentation & Change Notes

- [x] 5.1 Update `README.md` with examples for `playlist update`, optional create description, and list output including `description`/`privacyStatus`.
- [x] 5.2 Add/update section in `openspec/changes/playlist-metadata-update/verify-report.md` (during verify phase) to map implemented tests to every delta scenario.
