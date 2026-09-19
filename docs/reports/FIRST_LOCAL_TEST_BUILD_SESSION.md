# First Local Test Build — session report

Task: prepare the first user-facing local test build (project owner assignment via Telegram,
2026-09-19), on `feature/first-local-test-build` from `dev`. Implementing environment: macOS
(darwin) — no Windows machine was available.

## What was actually executed, not just written

All runtime checks below ran against this machine's real macOS install of Node.js 26.9.0 /
Next.js 16.3.5, never against a mocked or simulated environment.

1. `npm install` — 579 packages, clean exit.
2. `npm run build` — production build succeeded; all expected routes listed, including every
   Phase 4–6 API route and the device-handoff routes.
3. `npm run start` against the **real** macOS app-data location
   (`~/Library/Application Support/YouTubeOperationsManager/`, which had no pre-existing data on
   this machine — confirmed empty before this task touched it):
   - `GET /` → `200`.
   - Database created at the correct path; `schema_meta.value = 3`; all 20 expected tables
     present (channels, videos, rules, users, change_sets, changes, batches, batch_ledger_rows,
     batch_attempts, audit_events, ai_connections, ai_connection_credentials,
     channel_editorial_profiles, ai_localization_generation_provenance, app_operation_locks,
     video_execution_locks, handoff_log, recovery_acknowledgements, snapshot_lineage,
     schema_meta).
   - `GET /dashboard` → `200`; `GET /api/channels`, `/api/ai-connections`,
     `/api/device-handoff/status`, `/api/device-handoff/bootstrap-config` → `401` each (auth gate
     correctly active with no session).
   - Restart (kill + `npm run start` again): database file byte-identical (same MD5) before and
     after — no silent re-initialization.
4. Update-verification (§6 of the task), run entirely under an **overridden `HOME`**
   (`/tmp/.../scratchpad/fake-home-update-verify`) so the operator's real location was never
   touched:
   - First boot under the isolated `HOME` created a fresh database.
   - Seeded disposable rows directly via `sqlite3`: one `users` row, one `channels` row
     (`UC_TEST_CHANNEL_1`), one `rules` row — standing in for "existing settings/operational
     history".
   - Ran `npm run build` again (simulating "replace the build with the new build") and restarted
     the server under the same isolated `HOME`.
   - Confirmed: database MD5 identical before/after, the seeded channel and rule rows still
     present, `schema_meta.value` unchanged. No empty database was silently substituted.
   - This validates the persistence *mechanism* (build/restart never touches app-data) against
     disposable data; it does not simulate an actual old-schema-version database, since only one
     codebase/schema version was available to test with — the schema-migration-with-backup path
     itself already has its own automated tests (`src/lib/schema-versioning/*.test.ts`, commit
     `0efa345` and `821bb3e`).
5. `scripts/macos/start.sh`, `scripts/macos/stop.sh`, `scripts/macos/update.sh` — each executed
   for real (not just reviewed): `start.sh` brought the server up and opened it successfully;
   `stop.sh` located the PID file and the process actually stopped (confirmed by a subsequent
   failed connection); `update.sh` stopped, reinstalled, and rebuilt successfully.

## What was written but not executed

- `scripts/windows/start.bat`, `stop.bat`, `update.bat` — written against the documented Next.js
  16 CLI behavior (`node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`:
  `next start`/`next build` default port 3000, `PORT` env var, `-p`/`-H` flags) and this task's
  own findings about the real app-data path and update-safety behavior. **Not run on a real
  Windows machine** — none was available. This is the largest open item before this build is
  operator-ready, given the task's stated Windows priority.
- No UI-level (signed-in browser) checks were performed for Settings, AI Connections, AI
  Localization, editorial profiles, Change Sets, Batch dry-run UI, or Device settings — all sit
  behind a NextAuth session, and completing a real Google OAuth login is explicitly out of scope
  for an automated agent (`AGENTS.md` §G, task safety boundary §7). No `claude-in-chrome` browser
  session was available in this environment either. See `docs/FIRST_LOCAL_TEST_BUILD.md` §7 for
  the resulting operator checklist.

## Documentation discrepancies found and corrected as part of this task (`AGENTS.md` §H)

- `docs/ROADMAP_STATUS.md`: the Cross-Platform Persistence row said "pending `dev` merge", but
  `git log` showed it already merged (`25917b5`, tip of `dev` at task start) — corrected to record
  the actual merge commit.
- `docs/getting-started.md` §6 still described local state as living at the legacy
  `data/playlist-manager.db` path, superseded by the platform-aware app-data location introduced
  in the immediately preceding Cross-Platform Persistence task — corrected to describe the
  current location and link to `docs/RELEASE_LAYOUT.md` §2 for the legacy-migration behavior.
- No `.env.example` existed despite `.gitignore` referencing one (`!.env.example`) and
  `docs/getting-started.md` describing the required variables prose-only — added one, enumerating
  every `process.env.*` reference actually found in `src/` plus the NextAuth-only variables.

## Independent review (`/code-review high`) and fixes applied

An independent review was run against this branch's diff before integration (`AGENTS.md` §K.3).
It correctly found the documentation accurate (fact-checked against `platform-paths`, `db.ts`,
`crypto.ts`) and no `AGENTS.md` §B violations, but found real, concrete bugs in the launcher
scripts themselves — the one piece of this task that had not been through the same
build/test/lint scrutiny as application code. All were fixed and the fixed scripts were then
re-executed for real on macOS (not just re-read):

- **`findstr :3000` substring-match bug** (`scripts/windows/stop.bat`, `update.bat`): matched any
  port in 30000–30009 too, so `stop.bat`/`update.bat` could force-kill an unrelated process.
  Fixed to match the literal `":3000 "` (with the column's trailing space) instead, and
  `update.bat` now calls the fixed `stop.bat` (with a `/noconfirm` flag to skip its interactive
  pause) instead of duplicating the pattern a second time.
- **`stop.bat` never closed the wrapper window** `start.bat` opened. Added a
  `taskkill /FI "WINDOWTITLE eq ..." /T /F` alongside the port-based kill.
- **macOS `stop.sh` trusted a possibly-stale pidfile PID** (PID reuse by the OS could make it kill
  an unrelated process) **and mishandled multiple PIDs** from `lsof -ti tcp:3000`. Rewritten to
  treat `lsof -ti tcp:3000` as the sole ground truth (loop over every PID actually listening,
  never a recorded PID alone), and to wait (up to 10s) and re-check that the port is actually free
  before reporting success, instead of reporting "Done" immediately after sending the signal.
- **macOS `start.sh` didn't verify the server actually came up** before opening a browser tab and
  writing the PID file — a failed `npm run start` would still be reported as running. Rewritten to
  poll `http://localhost:3000/` (up to 20s) and check the process is still alive before declaring
  success, and to refuse to start at all if port 3000 is already in use (preventing a second
  instance from overwriting the first one's PID file).
- **Shared, unscoped `/tmp/youtube-ops-manager.pid`** (risk on a shared machine or with two
  checkouts): moved to a project-scoped `.launcher.pid` in the repo root (gitignored).
- `update.sh`'s `"$(dirname "$0")/stop.sh" || true` unconditionally swallowed any failure from
  `stop.sh`, not just its normal "nothing was running" case. Removed the blanket swallow now that
  `stop.sh` itself reports its own outcome correctly.

Re-tested for real after fixes: `start.sh` (readiness poll works, correctly refuses a second
concurrent start), `stop.sh` (correctly found and stopped the real listening process, confirmed
the port was actually free before printing success), `update.sh` (full stop → install → rebuild
cycle). The Windows `.bat` changes were reasoned through against documented `cmd.exe`/`findstr`/
`taskkill` semantics but, like the rest of the Windows launcher, could not be executed on a real
Windows machine in this environment.

## Safety boundaries respected throughout

No real YouTube mutation, no real/paid AI API call, no automatic Google OAuth login, no real
Syncthing-folder modification, no automatic batch execution/resumption. `.env.local` used
throughout was a locally-generated, gitignored, dummy-credential file (fake `GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET`, real random `NEXTAUTH_SECRET`/`AI_CONNECTIONS_ENCRYPTION_KEY` — the latter
two are local secrets, not YouTube/AI credentials, and are never committed).
