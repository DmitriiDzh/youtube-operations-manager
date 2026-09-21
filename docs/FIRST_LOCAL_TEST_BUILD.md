# First Local Test Build — operator guide

Operator-facing instructions for running the **first user-facing local test build** on Windows
or macOS. This is a local test build, not a public release: no installer and no GitHub release
exist or are in scope (`AGENTS.md` §K, §H task boundaries). `start.sh`/`start.bat` never touch
git, the network, or the remote — the operator is solely responsible for keeping their git
checkout current (project owner instruction, 2026-09-21; an earlier version of these scripts did
run `git pull --ff-only` itself, removed at the owner's explicit request: "за актуальностью гита
я буду следить сам"). They do, however, detect a **stale build** automatically (§3/§4) — see
below — and a standalone `published/<version>/` copy (no `.git`) still has no installer or
auto-updater at all, per `docs/RELEASE_LAYOUT.md` §1.

Technical setup content only, per `AGENTS.md` §B — this file never contains channel-specific
editorial guidance, YouTube SEO strategy, or operations-agent instructions.

---

## 1. Prerequisites

- Node.js 20 LTS or newer, on PATH.
- A Google Cloud OAuth client (Web application type) — see `docs/getting-started.md` §1 for the
  exact steps and required scopes. You need real values here; there is no way around configuring
  real Google OAuth credentials to sign in, even for local testing.
- If you plan to test AI Connections with a real provider credential (not the built-in mock
  provider): an `AI_CONNECTIONS_ENCRYPTION_KEY` (see `.env.example`).
- If you plan to test the cross-device Syncthing handoff: Syncthing already installed and a
  shared folder configured on this device (`docs/RELEASE_LAYOUT.md` §1, §3) — optional, the
  application works fully in local-only mode without it.

## 2. First-time environment configuration

1. Copy `.env.example` to `.env.local` in the project root.
2. Fill in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from your OAuth client.
3. Generate a `NEXTAUTH_SECRET`:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
4. Leave `NEXTAUTH_URL=http://localhost:3000` unless you changed the port.
5. `.env.local` is gitignored — never commit it, never share it (`AGENTS.md` §F).

## 3. Launching on Windows

From the project root:

```
scripts\windows\start.bat
```

This script (double-clickable from Explorer, or run from a terminal):

1. Checks Node.js is installed.
2. Checks `.env.local` exists (fails with a clear message and stops if not — see §2).
3. Runs `npm install` if `node_modules` is still missing (first run only).
4. **Rebuild-staleness check (2026-09-21, replacing the earlier `git pull`-based auto-update —
   see below):** in an actual git checkout of the repository, compares the currently checked-out
   commit (`git rev-parse HEAD`) against `.next-build-commit.txt`, a marker file recording which
   commit `.next` was actually built from. If they differ (or the marker/`.next` is missing),
   rebuilds automatically (`npm run build`) and updates the marker — this is what makes the
   operator's own `git pull`, done outside this script, actually take effect on the next
   `start.bat`, instead of silently continuing to serve a stale build just because `.next`
   happens to already exist. A standalone `published/<version>/` copy has no `.git` and no commit
   to compare against — it falls back to the original, simpler check (rebuild only if `.next` is
   entirely missing); `update.bat` remains its one, explicit, human-triggered rebuild step (see
   `docs/RELEASE_LAYOUT.md` §1, `AGENTS.md` §K.4 — no installer/auto-updater exists for that
   distribution form).
5. Starts the production server in its own window titled **"YouTube Operations Manager"** and
   opens `http://localhost:3000` in your default browser.

**This script never touches git, the network, or your working tree** — no `git pull`, no
`git fetch`, nothing. An earlier version did run `git pull --ff-only` on your behalf before the
staleness check above; removed 2026-09-21 at the project owner's explicit request ("за
актуальностью гита я буду следить сам" — keeping the checkout current is the operator's own job,
not this script's).

**To stop safely:** run `scripts\windows\stop.bat`, or just close the
"YouTube Operations Manager" window.

**To update a standalone `published/<version>/` copy** after replacing these program files with a
newer version by hand: run `scripts\windows\update.bat` first (stops any running instance,
reinstalls dependencies, rebuilds), then `start.bat` as usual. Your database and settings are
never in this folder — see §6 — so replacing the program files themselves never touches your
data. (A git checkout running directly from `dev` doesn't need this manual step either, per §3.4
above — `git pull` yourself, then just run `start.bat`; `update.bat` still works there too, if you
ever want to force a rebuild by hand.)

> **Status of this procedure:** the launcher script has been written and reasoned about against
> the documented Next.js 16 CLI behavior (`node_modules/next/dist/docs/.../cli/next.md`), but has
> **not** been executed on a real Windows machine — none was available in the environment this
> task was implemented in. Treat the steps above as the primary remaining manual verification
> before this build is operator-ready on Windows (see §7). The rebuild-staleness logic in §3.4 was
> verified against isolated throwaway git repositories on macOS (`sh`'s POSIX behavior, not
> `cmd.exe`'s), and the equivalent `.bat` logic was reasoned through by hand but not executed —
> this remains open, same as the rest of this document's Windows status.

## 4. Launching on macOS

From the project root:

```
./scripts/macos/start.sh
```

Same behavior as the Windows script: checks Node.js and `.env.local`, installs dependencies if
needed, then runs the same rebuild-staleness check described in §3 step 4 (git-commit-marker
comparison in a checkout, falling back to "rebuild only if `.next` is missing" otherwise), starts
the server, opens your default browser, and prints where its data lives. Never touches git, the
network, or your working tree — no `git pull`, nothing (see §3's note on why, and what changed
2026-09-21).

**To stop safely:** run `./scripts/macos/stop.sh` (or Ctrl+C the running `start.sh`).

**To update a standalone `published/<version>/` copy:** run `./scripts/macos/update.sh`, then
`./scripts/macos/start.sh`. A git checkout running directly from `dev` doesn't need this manual
step either — `git pull` yourself, then just run `start.sh`; `update.sh` still works there too, if
you ever want to force a rebuild by hand.

> **Status of this procedure:** unlike the Windows launcher, this one **was actually executed** on
> real macOS hardware during this task's implementation — `start.sh` (server came up, returned
> HTTP 200, database initialized at the real `~/Library/Application Support/YouTubeOperationsManager/`
> location), `stop.sh` (process actually stopped, port freed), and `update.sh` (rebuild completed,
> restarted cleanly) all ran for real, not just against `npm run build`. This is real (if partial —
> see §7) progress against `docs/TECHNICAL_DEBT.md` RISK-17, which tracked macOS as entirely
> unvalidated. **The rebuild-staleness step (this section, rewritten 2026-09-21 to replace the
> earlier `git pull`-based auto-update)** was actually executed for real on this same macOS
> machine: a genuine stale-marker case (an existing `.next` built from an older commit) was
> confirmed to trigger a real rebuild, and an up-to-date marker was confirmed to skip it, both
> against the real repository, not a throwaway fixture — see the BL-048 `ROADMAP_STATUS.md` row
> for the exact scenarios run. The equivalent Windows `.bat` logic was reasoned through by hand
> and syntax-checked, but not executed on real Windows — that remains open, same as the rest of
> this document's Windows status above.

## 5. First run, either platform

1. Launch via §3/§4.
2. In the browser, sign in with Google (this is a real interactive login you perform yourself —
   the task automating this build never performs Google OAuth login on your behalf,
   `AGENTS.md` §G / §K).
3. The app creates its database at the platform-aware location on first boot (§6) — you do not
   create or initialize anything manually.
4. Open the **Device** tab if you want to configure Syncthing-based handoff to another device
   (`docs/RELEASE_LAYOUT.md` §3); leave it unset to stay in local-only mode.

## 6. Where your data lives

| Platform | Location |
|---|---|
| Windows | `%APPDATA%\YouTubeOperationsManager\` |
| macOS | `~/Library/Application Support/YouTubeOperationsManager/` |

This is **outside** the project/program folder. Replacing the program files (an update) never
touches it. Full detail, including the one-time non-destructive migration from a legacy
`<repo>/data/playlist-manager.db` if one exists: `docs/RELEASE_LAYOUT.md` §2.

If you already have an existing installation with real data on this machine, **do not** run a
build that changes the schema without first confirming you're comfortable with an automatic
migration — the application takes its own pre-migration backup into
`<app-data>/backups/migrations/` before touching anything (`src/lib/db.ts`), but you should still
know this is happening rather than discover it after the fact. This test build task performed
all of its own database exercises against isolated/disposable locations (an overridden `HOME`),
never against a machine's real app-data directory with real data in it.

## 7. Manual smoke-test checklist (operator-run)

Everything below requires a real, signed-in browser session and therefore could not be executed
by an automated agent under this task's safety boundaries (`AGENTS.md` §G — no automatic Google
OAuth login). What *could* be verified without a session is marked "automated" below; everything
else is the manual work still required before calling this build fully operator-validated.

- [x] *(automated, macOS)* Server starts; `GET /` returns HTTP 200.
- [x] *(automated, macOS)* Database initializes at the correct platform-aware path on first boot,
  with the expected schema (`schema_meta.value = 3`, all Phase 4–6 and cross-platform tables
  present).
- [x] *(automated, macOS)* Unauthenticated API routes correctly return `401` (auth gate is active).
- [x] *(automated, macOS)* Restarting the server leaves the database byte-for-byte unchanged (no
  silent re-init).
- [x] *(automated, macOS, disposable data)* Simulated update (rebuild + restart) preserves a
  seeded test channel/rule row and schema version — see
  `docs/reports/FIRST_LOCAL_TEST_BUILD_SESSION.md` for the full session log of this task.
- [ ] Sign in with Google; confirm the OAuth flow completes and lands on the dashboard.
- [ ] **Settings** — open, change a setting, restart the app, confirm it persisted.
- [ ] **AI Connections** — create a connection (mock provider is safe/free), test it, confirm it
  lists correctly, confirm a stored credential round-trips without ever being exposed in logs or
  the browser console.
- [ ] **AI Localization** — generate a proposal against a real or test channel using the mock
  provider (real-provider calls are a separate, explicitly-gated, cost-bearing decision — do not
  configure a real paid connection for this smoke test).
- [ ] **Channel editorial profiles** — create/edit a profile, confirm it merges into a subsequent
  AI Localization generation.
- [ ] **Change Sets** — import or generate one, review a diff, approve/reject individual changes.
- [ ] **Batch dry-run UI** — prepare a batch, confirm it runs in dry-run mode, confirm no real
  YouTube write occurs (the write barrier is unconditional and code-level, but this is exactly
  the kind of thing worth an operator's own eyes before trusting the build).
- [ ] **Device settings** — if testing Syncthing handoff, follow `docs/RELEASE_LAYOUT.md` §4 on
  two real devices.
- [ ] Full application restart after using real features (not just first boot) — confirm
  settings/history survive.
- [ ] Windows: run through §3 end-to-end on a real Windows machine (not yet done — see §3's
  status note).

## 8. Known limitations

- **Windows launcher is untested on real Windows** (§3). This is the single largest gap in this
  test build, given the task's stated Windows priority — see §7's last checklist item.
- **No browser automation was available** in the implementing environment (no configured
  `claude-in-chrome` session), so even the macOS checks above stop at the HTTP/database layer —
  they are not a substitute for the manual UI checklist in §7.
- **Phase 5 live YouTube writes remain disabled** by an unconditional, two-layer barrier
  (`docs/TECHNICAL_DEBT.md` Gate B) — this build cannot and does not perform real YouTube
  mutations regardless of what you click.
- **No real AI-provider integration** — AI Localization uses the deterministic mock provider
  unless you explicitly configure and select a real `AI_CONNECTIONS`-backed connection yourself
  (a separate, cost-bearing decision, `docs/ai-localization/PROVIDER_INTEGRATION_PLAN.md`).
- **No installer, no auto-updater, no public release** — by design, out of scope for this task.
- Existing pre-release items from `docs/TECHNICAL_DEBT.md` remain open: RISK-05 (no live
  browser/OAuth verification performed by an agent — by design, see above), the Phase 5
  `LIVE VALIDATION` track, and the 20 non-critical `npm audit` findings (RISK-06).
