# UPSTREAM_BASELINE.md

Phase 1 baseline record for this independent repository. See `docs/UPSTREAM_ANALYSIS.md` for the architecture writeup this baseline validates against.

---

## 1. Baseline Identity

- Repository: `youtube-operations-manager` (independent private repo; **not a GitHub fork**)
- `origin`: `https://github.com/DmitriiDzh/youtube-operations-manager.git`
- `upstream` (reference only): `https://github.com/Gentleman-Programming/tubemaster.git`
- Branch: `main`
- Baseline commit: `e8f5bae4f9df9e94ada01669e56875d1866af37e` ("Base changes", 2026-09-15 14:28:51 +0300)
- Baseline validation date: 2026-09-15
- Suggested tag: `upstream-baseline` (see §8)

### Working tree state at baseline validation

```text
M package-lock.json    (pre-existing, benign — reverted in cleanup pass, see §6a)
?? .idea/               (local JetBrains IDE metadata, untracked — now gitignored, see §6a)
```

No `src/**` files were modified to produce a passing baseline — the project ran, tested, linted, and built successfully against the pre-existing `main` HEAD with no application code changes required. The only changes made across both passes are: two new docs (this file and `docs/UPSTREAM_ANALYSIS.md`), a one-line `.gitignore` addition, and a `package-lock.json` revert to its committed state (see §6a).

### Relationship to original TubeMaster upstream

`upstream/HEAD` currently points at `upstream/feature-2`. A diff of `main` against `upstream/feature-2` shows upstream is **missing** files this repository already added (`AGENTS.md`, `docs/PROJECT_SPEC.md`, this repo's `.gitignore` additions) and has a different `README.md`/`CONTRIBUTING.md` — i.e. this repository has diverged additively and there is no unmerged upstream drift to reconcile right now. Future review should use:

```bash
git fetch upstream
git log main..upstream/feature-2 --oneline
git diff main..upstream/feature-2
```

No automatic merge/rebase/sync from `upstream` is configured or intended (per `AGENTS.md`).

---

## 2. Dependency / Runtime Assumptions

- Node.js: `v24.19.0` (verified in this environment)
- npm: `12.0.2`
- OS tested: Windows 10 Pro 10.0.19045 (PowerShell/Git Bash)
- Framework: Next.js `16.2.2` (Turbopack build), React `19.2.4`
- Key runtime deps: `googleapis ^171.4.0`, `next-auth ^4.24.13`, `@modelcontextprotocol/sdk ^1.29.0`, `drizzle-orm ^0.45.2`, `@libsql/client ^0.17.2`, `zod ^4.3.6`, `tsx ^4.21.0`
- Test runner: Node's built-in `node:test`, invoked via `node --import tsx --test "src/**/*.test.ts"` (no Jest/Vitest dependency)
- Lint: ESLint 9 flat config (`eslint.config.mjs`) with `eslint-config-next`
- Local persistence: SQLite file at `data/playlist-manager.db` (libSQL), created/migrated automatically on first run
- `node_modules` was already installed and up to date prior to this baseline run

---

## 3. Commands Executed

```bash
npm install
npm test
npm run lint
npm run build
```

No `npm run dev` server was left running as part of this baseline check (build success + full test suite is sufficient evidence the app runs; see §7 for what was *not* exercised).

---

## 4. Test Results

```text
npm install   → "up to date, audited 488 packages" — no changes required
npm test      → ok 164/164 tests passing, 0 failing, 0 skipped
              → duration_ms 14277.9
```

Coverage spans: credential resolution (incl. scope/refresh failure modes), metadata generator, transcript provider (all error-mapping branches), video-metadata services (list/transcript/preview/apply, dry-run parity, language resolution, guardrail failure), write-context guardrail (matched/mismatch/unresolved, alignment messaging), playlist-management services (create/update/delete/add/remove, ownership preflight, guardrail-before-ownership ordering), and MCP tool handlers (schema validation, structured error shapes, guardrail propagation) for every registered tool.

No test failures, no flaky output, no skipped/todo tests.

---

## 5. Lint Results

```text
npm run lint  → eslint (flat config) — clean, zero errors, zero warnings
```

---

## 6. Build Results

```text
npm run build → next build (Turbopack)
  ✓ Compiled successfully in 11.0s
  ✓ TypeScript check finished in 12.0s (no type errors)
  ✓ Static/dynamic route generation succeeded (16/16 pages)
```

Route manifest confirms all expected routes compiled: `/`, `/dashboard` (static), plus dynamic API routes (`/api/auth/[...nextauth]`, `/api/rules`, `/api/run`, `/api/video-metadata/{apply,preview,transcript}`, `/api/youtube/{add-to-playlist,channel-info,create-playlist,playlists,remove-from-playlist,videos}`).

### Known warnings / non-blocking issues

See §6a for the detailed audit/cleanup findings from the follow-up verification pass. Summary: no test/lint/build failures were caused by any of the items below.

---

## 6a. Follow-up Verification Pass (repository cleanup, audit, install-script review, read-only smoke tests)

Performed after the initial Phase 0/1 pass, still without live OAuth credentials (`.env.local` does not exist in this environment — confirmed via `ls .env*` returning "No such file or directory"). Scope of this pass: read-only/dry-run checks only, plus non-functional repository hygiene. **No live YouTube writes were made or attempted.**

### Repository cleanup result

- **`package-lock.json`**: the pre-existing uncommitted diff was 16 removed lines, all `"peer": true` markers on transitive dev-tooling packages, with **zero added lines** (confirmed via `git diff package-lock.json | grep '^+' | grep -v '^+++'` returning nothing). Purely metadata noise from an npm-version difference, not a dependency change. Decision: **reverted** via `git checkout -- package-lock.json` to keep the baseline clean and match the committed lockfile exactly. Re-ran `npm test` / `npm run lint` / `npm run build` afterward — all still pass (164/164 tests, clean lint, clean build), confirming the revert had no functional effect.
- **`.idea/` (untracked JetBrains IDE metadata)**: added `.idea/` to `.gitignore` (one-line, additive, under a new `# IDE` section) so it can no longer be accidentally committed. The directory itself was left in place (it's the user's local IDE state, not deleted).
- No other files were touched. No `src/**` changes.

### Package-lock decision

Keep `package-lock.json` exactly as committed (reverted, see above). No dependency version changes were made — per this task's constraints, no framework/dependency upgrades are in scope for Phase 0/1.

### npm audit findings

`npm audit --json` (report generated to a temp file and deleted after parsing — not committed):

```text
Severity totals: 2 low, 10 moderate, 10 high, 2 critical  (24 total, matches earlier pass)
```

Critical/high findings with fixes available:

| Package | Severity | Issue summary | Fix available |
|---|---|---|---|
| `next` | critical | DoS via Server Components; middleware/proxy segment-prefetch bypass (incomplete-fix follow-up) | `next@16.3.5` (non-major semver bump) |
| `next-auth` | critical | Email-normalizer homoglyph `@` bypass; `getToken()` uncaught exception on malformed Bearer header; OAuth state/nonce/PKCE cookies not bound to originating provider | fix available |
| `postcss`, `sharp` | high | XSS via unescaped `</style>`; arbitrary file read via `sourceMappingURL`; sharp's bundled libvips/libheif CVEs | via `next@16.3.5` |
| `brace-expansion`, `browserslist`, `fast-uri`, `hono`, `ip-address`, `js-yaml`, `nanoid`, `ws` | high | Various DoS / memory-growth / SSRF / host-confusion issues in transitive tooling deps | fix available |

**Decision: no remediation applied in this pass.** This task explicitly excludes framework upgrades and refactors, and `next`/`next-auth` fixes are the two critical items with real user-facing exposure (Next.js is the live web server; next-auth handles OAuth state binding). Both fixes are non-major per npm's own classification, which makes this a **low-risk, high-value candidate for the very first Phase 2 (or a dedicated Phase 1.5) task** — but is deliberately not done here to keep this baseline pass to verification only, per instruction.

**Risk framing for a single-operator, local-only tool (current deployment model):** the OAuth state/PKCE binding issue in `next-auth` is the one item worth prioritizing regardless of deployment model, since it directly touches the auth flow this project depends on for channel-identity guardrails. The Next.js Server Components DoS and the transitive tooling CVEs (build-time tools like `browserslist`, `js-yaml`, dev-only `hono`) are lower urgency for a non-networked, non-multi-tenant local app, but should not be deferred indefinitely.

### Install-script warning analysis

`npm ls esbuild sharp unrs-resolver` traces the blocked-postinstall packages to their consumers:

```text
drizzle-kit@0.31.10        → esbuild@0.18.20, esbuild@0.25.12   (dev-only, migrations tool — currently unused, no migrations exist yet)
eslint-config-next@16.2.2  → unrs-resolver@1.11.1                (dev-only, lint-time TS import resolution)
next@16.2.2                → sharp@0.34.5                        (optional native image-optimization backend)
tsx@4.21.0                 → esbuild@0.27.7                      (dev/runtime — powers `npm test`, CLI, MCP execution)
```

None of these blocked postinstall scripts caused a functional problem in this pass: `npm test`, `npm run lint`, and `npm run build` all passed cleanly, and `tsx`-driven execution (CLI `auth whoami`, MCP server boot) worked correctly — meaning `esbuild`'s prebuilt binary was already resolvable without its postinstall step. `sharp` (used for Next's optional image optimization) not having its native binary confirmed via postinstall is a **latent risk only for future thumbnail-handling work** (spec §35), not for anything in Phase 0/1 scope, since no code path currently calls image optimization. No action taken; flagged for whoever picks up thumbnail work later to run `npm install-scripts approve sharp` (or verify the binary loads) before relying on it.

### Live smoke-test results (read-only / dry-run only — no credentials available)

`.env.local` does not exist in this environment, so `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are unset. The following checks were run to validate the app **fails closed and boots correctly without credentials**, rather than to exercise a real OAuth/YouTube round trip:

| Check | Command | Result |
|---|---|---|
| CLI auth check (no active session) | `node --import tsx src/cli/video-metadata.ts auth whoami` | Exit code 1, structured JSON: `{"ok":false,"error":{"code":"AUTH_USER_NOT_FOUND","message":"No active auth context. Run \`auth login\` first.","details":{"reason":"active_user_missing"}}}` — correct fail-closed behavior, no crash, no stack trace leaked |
| CLI channel list (no active session) | `node --import tsx src/cli/video-metadata.ts auth list-channels` | Same `AUTH_USER_NOT_FOUND` structured error, exit code 1 |
| MCP server boot | `node --import tsx src/mcp/server.ts` (started, given 8s, then terminated) | Exited cleanly (code 0 on termination), zero stderr output — server starts and registers all tools without requiring credentials up front, as documented (`docs/interfaces.md`: "MCP server does not expose login flow") |
| Web UI boot (no OAuth env vars) | `npm run dev -- -p 3911`, then `curl http://localhost:3911/` | `HTTP_STATUS:200`, valid HTML returned (sign-in landing page) — app does not crash at boot despite missing `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; dev server was stopped afterward (verified port no longer responding) |

**Explicitly not run** (require real Google OAuth credentials and a real/test YouTube channel — outside this pass's scope and this environment's capability):

- `auth login` / `auth login --device` (real PKCE/device OAuth round trip)
- `auth select-channel`, `whoami` with an actual authenticated identity
- Any MCP tool call that requires `ResolvedCredentials` (`list`, `transcript`, `preview`, `apply`, `playlist_*`)
- Signing in through the Web UI (`Sign in with Google` → `/dashboard`)
- Any `apply`/`playlist_*` call in `dryRun: true` or live mode against a real channel

These remain the recommended next verification step once OAuth credentials are configured, but their absence is not a Phase 0/1 blocker: every safety-critical code path they would exercise (guardrail matched/mismatch/unresolved, dry-run parity, scope enforcement, structured error shapes for both CLI and MCP) already has passing unit/integration test coverage against mocked adapters (see §4).

### Remaining blockers before Phase 2

None that block *starting* Phase 2 planning/implementation of read-only sync (per the approved Phase 2 scope: channel/video sync + persistence, no YouTube writes). The only genuine blocker is environmental, not architectural: **no Google OAuth credentials are configured in this environment**, so a live end-to-end smoke test (sign-in → list real channel videos) has never been run against this baseline. This should be done by whoever has real credentials before the *first* live write-capable feature ships, but does not block Phase 2's read/sync work, which can be developed and tested against mocked adapters exactly as the existing `video-metadata`/`playlist-management` modules already are.

---

## 7. What Was *Not* Exercised (Either Pass)

Per Phase 0/1 scope (`AGENTS.md`, spec §326–414), the following require live Google OAuth credentials and a real/test YouTube channel and have **not** been run against this baseline in either verification pass (no `.env.local` / credentials exist in this environment):

- Real Google OAuth round trip: `auth login` (PKCE loopback) or `auth login --device`, and Web UI `Sign in with Google`
- Any operation that requires a resolved, authenticated identity: `auth whoami`/`list-channels`/`select-channel` with real tokens, `dashboard` manual-mode video/playlist browsing, any MCP tool beyond boot
- Any `apply`/`playlist_*` write call (dry-run or real) against a real YouTube channel

§6a's read-only/dry-run pass confirms the app **boots and fails closed correctly** without credentials (CLI structured errors, MCP clean boot, Web UI 200 response) — this is a meaningfully stronger signal than "untested," but is not a substitute for one real authenticated round trip. This remains the single recommended next step once real credentials are available, and is not a Phase 0/1 blocker: `npm test` already exercises the equivalent logic against mocked adapters for every safety-critical path (guardrail matched/mismatch/unresolved, dry-run parity, scope enforcement, structured MCP error shapes).

---

## 8. Baseline Tag / Marker

Recommended: tag the commit that adds `docs/UPSTREAM_ANALYSIS.md` and `docs/UPSTREAM_BASELINE.md` (this Phase 0/1 deliverable) as:

```bash
git tag upstream-baseline
```

This marks "last known-good, fully-tested, TubeMaster-derived baseline before any Phase 2+ product-specific extension work begins." Existing tags `v0.1.0`, `v0.1.1` predate this Phase 0/1 documentation pass and are unrelated version markers, not baseline markers.

---

## 9. Conclusion and Baseline Readiness

Phase 1 baseline requirements from `docs/PROJECT_SPEC.md` §366–414:

- [x] project installs successfully (`npm install`, no changes needed)
- [x] application builds (`npm run build`, clean — re-verified after cleanup pass)
- [x] tests pass (`npm test`, 164/164 — re-verified after cleanup pass)
- [x] lint/type checks pass (`npm run lint` clean — re-verified after cleanup pass)
- [x] app boots and fails closed correctly without credentials (CLI, MCP, Web UI — §6a read-only smoke tests)
- [ ] real OAuth round trip / authenticated CLI-MCP-WebUI smoke test — **not exercised**, no credentials available in this environment (§7); does not block Phase 2 read/sync work, which is developed and tested against mocked adapters exactly like the existing modules
- [x] existing metadata functions work (test suite: `applyMetadata`, guardrails, dry-run parity)
- [x] existing playlist functions work (test suite: CRUD + membership + ownership preflight)
- [x] repository cleaned (`.idea/` gitignored, `package-lock.json` reverted to committed state)
- [x] `npm audit` reviewed and documented (24 findings; 2 critical/`next`+`next-auth` have non-major fixes available; deliberately not applied in this pass — see §6a)
- [x] blocked install-scripts reviewed and traced to their consumers; none affect current functionality (§6a)

No source code (`src/**`) changes were made in either pass. Only non-functional repository hygiene (`.gitignore` addition, lockfile revert) and this documentation were changed.

### Exact recommendation

**READY FOR PHASE 2** — for the approved Phase 2 scope specifically (channel/video synchronization + local persistence, read-only, no YouTube writes, per the plan in this document's original §Recommended-Phase-2-plan / the earlier session's summary). The codebase, tests, lint, and build are all green; the app fails closed correctly without credentials; and the two things that remain open — a real OAuth round trip and the `next`/`next-auth` security patch — are both orthogonal to building read-only sync against mocked adapters, which is exactly how the existing `video-metadata` and `playlist-management` modules were built and tested.

This repository is also **ready for a final baseline commit and the `upstream-baseline` tag** (see §8) once the user confirms — the working tree is clean of unintended changes (only the two new docs, the `.gitignore` line, and the lockfile revert, which restores rather than changes committed state).

**Two items should be scheduled early in Phase 2 (not blockers, but should not be deferred indefinitely):**
1. Apply the `next`→`16.3.5` and `next-auth` security patches (non-major, fixes 2 critical + several high findings) — recommend as the very first small task before or alongside Phase 2, since it's isolated from sync/localization work.
2. Run one real authenticated smoke test (`auth login` → `auth whoami` → `list`) as soon as Google OAuth credentials are available, to validate the live path the mocked tests stand in for.
