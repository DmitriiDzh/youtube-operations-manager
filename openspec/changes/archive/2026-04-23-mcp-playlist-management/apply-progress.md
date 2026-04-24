# Apply Progress: mcp-playlist-management

## Mode

- Standard (strict_tdd: false)

## Completed Tasks

- [x] 1.1
- [x] 1.2
- [x] 1.3
- [x] 1.4
- [x] 1.5
- [x] 2.1
- [x] 2.2
- [x] 2.3
- [x] 2.4
- [x] 2.5
- [x] 3.1
- [x] 3.2
- [x] 3.3
- [x] 3.4
- [x] 4.1
- [x] 4.2
- [x] 4.3
- [x] 4.4
- [x] 4.5
- [x] 5.1
- [x] 5.2

## Validation Run

- `npm test` ✅
- `npm run lint` ✅
- `npx tsc --noEmit` ✅

## Notes

- Playlist capabilities are now shared in a transport-agnostic core and reused by web routes, MCP, and CLI.
- Add/remove contracts now expose stable partial outcomes (`attempted/requested`, `added/removed`, `failures[]`) for CLI/MCP while web routes preserve current `{ added }` / `{ removed }` envelopes.

## Corrective Batch (post-verify CRITICAL)

- Added explicit MCP validation coverage for invalid input across all `playlist_*` tools (`playlist_list`, `playlist_create`, `playlist_add_videos`, `playlist_remove_videos`) asserting structured `validation_failed` errors.
- Added explicit CLI playlist auth-fallback failure coverage for `playlist list` with no `credentialRef` and no active user context, asserting typed `AUTH_USER_NOT_FOUND` + non-zero exit code.
- Strengthened `playlist_create` MCP success test with direct assertions on `playlist.id` and `playlist.title` in tool output.

### Files

- `src/mcp/server.test.ts`
- `src/cli/video-metadata.test.ts`
