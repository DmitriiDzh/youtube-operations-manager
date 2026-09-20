# Device-Handoff Auto-Sync Plan — auto-export, auto-import, and an update notification

Produced 2026-09-20, per the project owner's Telegram request (msg 128): "часть процесса
закрытия сессии должно подразумевать сохранения файлов... и/или мы это сохраняем каждый раз как
что-то меняем... При старте должна так же подгружаться последняя актуальная информация...
Можно добавить справа сверху иконку с уведомлениями... программа предложит обновиться на
последние." **This is a plan, not an implementation.** Nothing here is authorized to run until
its own explicit assignment (`AGENTS.md` §C); several pieces below touch the device-handoff
safety machinery directly and need extra care, not just a UI pass.

## 1. What this is not

**This does not make concurrent multi-device editing safe.** The existing design
(`docs/RELEASE_LAYOUT.md` §4, "Variant A: one active device at a time") is explicit that the UI
cannot confirm another device has actually stopped working, and a divergent lineage (two devices
that both made changes since the last shared snapshot) is treated as an exceptional case requiring
a human decision — never auto-resolved by timestamp. Keeping the shared folder *fresher* (this
plan's actual goal) reduces how often a real handoff hits a stale/missing snapshot, but does
**not** turn this into a system where two people can safely work on the same channel at the same
time. That is the separate, harder, already-tracked problem in
`docs/roadmap/plans/FUTURE_DIRECTIONS_RESEARCH.md` (`BL-006`) — this plan must not be read as
solving it, and nothing here should be built in a way that implies concurrent-safe multi-device
work now exists.

## 2. Real constraints this plan has to respect (confirmed by reading the actual code)

- **Export is expensive, not free.** `exportHandoff` (`src/lib/device-handoff/services.ts`)
  acquires the **exclusive, app-wide operation lock** (blocks every other mutating action across
  Web/CLI/MCP for its duration), then does a full consistent DB copy, scrubs non-allowlisted
  tables, and **`VACUUM`s** the copy to actually reclaim/overwrite the dropped tables' pages —
  cost scales with database size. **Running this after every single save/approve/apply, as
  literally as the owner's message suggests, would serialize and block all other work on every
  such action.** A debounced/periodic or shutdown-only trigger is the safe interpretation of "мы
  это сохраняем каждый раз," not a literal per-mutation hook.
- **Import has a failure mode that requires a human, by design.** `verifySnapshotForImport`
  throws on a divergent lineage (two independently-advanced histories) — this is intentional,
  documented fail-closed behavior, not a bug to route around. Fully-unattended auto-import at
  startup must catch exactly this case and fall back to "notify, don't apply" (§4), never retry
  or force it.
- **No graceful-shutdown hook exists anywhere in this codebase today.** `stop.sh` sends a plain
  `kill` (SIGTERM); nothing in `src/**` registers a `process.on('SIGTERM'|'SIGINT', ...)` handler,
  so Node's default behavior (immediate exit, zero cleanup) is what happens today. "Save on
  session close" requires building this mechanism from scratch, with a **bounded timeout** (it
  must not hang shutdown indefinitely if the export is slow or the lock is held by something
  else).
- **A browser tab closing is not the same event as the server process stopping**, and there is no
  reliable way to make a closing browser tab await an async server-side export
  (`beforeunload` cannot do this). "Session closing," for this app's actual architecture, can only
  meaningfully mean **the server process stopping** (`stop.sh` / a SIGTERM), not a browser tab.
- **No existing logic compares the local device's lineage against what's actually sitting in the
  Syncthing folder** — `GET /api/device-handoff/status` today only reports local lock/recovery/
  lineage state. `listPublishedSnapshotIds` (filesystem adapter) already exists and is cheap to
  poll (a local directory listing), so this is genuinely new but low-risk logic to add, not a
  missing capability that needs a new dependency (no file-watcher needed — periodic polling of a
  local directory listing is proportionate).

## 3. Proposed design

### 3.1 Auto-export on graceful shutdown (the literal "session closing" case)

Add a `process.on('SIGTERM', ...)`/`SIGINT` handler (new — none exists today) that, if a
Syncthing folder is configured and there's anything worth exporting, runs one best-effort
`exportHandoff` before the process actually exits, bounded by a timeout (e.g. a few seconds) so a
slow or already-locked export can't hang shutdown indefinitely — if it can't finish in time, skip
it and exit anyway rather than block the operator from stopping the app. `stop.sh`/`stop.bat`
need no change themselves (they already just send the signal and wait for the port to free); the
new behavior lives entirely in the server process.

### 3.2 Auto-export on a debounced/periodic basis (the "every time something changes" half)

Given §2's cost finding, **not** a literal per-mutation hook. Proposed instead: track a simple
"dirty since last export" flag (set on any mutating action that would matter to a snapshot —
change-set approval, batch completion, etc.), and export at most once per some minimum interval
(e.g. every N minutes) **only if** dirty and the operation lock is free — a background,
low-priority action, never blocking the action that triggered it. This is explicitly a separate,
optional slice from 3.1 (shutdown export) — 3.1 alone already covers "don't lose data on
unexpected close" for the common case (a clean stop/crash still lets the OS deliver SIGTERM in
most cases); 3.2 additionally covers a true crash that skips even that (power loss, `kill -9`),
at the cost of periodic background export overhead. **Needs an explicit owner decision on
interval and whether the added overhead is worth it**, given export's real cost (§2).

### 3.3 Detecting a newer snapshot while running (the notification bell)

Extend the device-handoff status logic with a new, read-only check: compare the local device's
lineage against the newest snapshot actually present in the Syncthing folder (via
`listPublishedSnapshotIds`, already exists) — "is there a snapshot newer than what I last
imported." The dashboard polls this periodically (e.g. every 30-60s, cheap local-filesystem
read) while the app is open. A new bell/notification icon in the top-right of `app-shell.tsx`'s
header (alongside the existing active-channel/switch-channel/sign-out controls) lights up when
a newer snapshot is detected, and offers to import it — reusing the **existing** import action
and all its existing safety checks unchanged (checksum, divergent-lineage rejection, recovery-mode
handling). This is purely a "tell the operator sooner, with one less manual check" feature, not a
new import code path.

### 3.4 Auto-import at startup — only the safe case

On app startup, if a Syncthing folder is configured, check for a newer snapshot (§3.3's logic)
and attempt to import it **automatically only if it is a safe, non-divergent fast-forward** (same
verification the manual Import button already runs). If verification throws for any reason
(divergent lineage, checksum mismatch, incomplete snapshot), **do not auto-apply** — fall back to
surfacing it via the same bell/notification mechanism (§3.3) so a human decides, exactly as
today's explicit flow already requires for that case. This preserves every existing safety
invariant; the only new behavior is skipping the manual button-click for the case that was always
going to succeed anyway.

## 4. Proposed slices, once assigned

- **D1 — Graceful shutdown export hook** (§3.1). Foundational (nothing like it exists today);
  needed regardless of which other slices are approved. Needs care around the bounded timeout and
  verifying it doesn't interfere with `next start`'s own signal handling.
- **D2 — "Is there a newer snapshot than mine" check** (§3.3, backend half). Read-only, low-risk,
  extends existing status logic; no new import/export code path.
- **D3 — Notification bell UI** (§3.3, frontend half). Depends on D2; reuses the existing import
  action unchanged when the operator accepts the offer.
- **D4 — Safe-case auto-import at startup** (§3.4). Depends on D2; explicitly excludes the
  divergent-lineage case, which still routes to D3 instead of being forced.
- **D5 — Periodic/debounced auto-export while running** (§3.2). Independent of D1-D4; needs an
  explicit owner decision on interval given export's real cost (§2) before being assigned — this
  is the one slice with a genuine, unresolved cost/benefit tradeoff to sign off on, not just an
  implementation detail.

D1-D4 have no unresolved open design questions blocking them (the design choices in §3 are the
resolutions); D5 needs one explicit decision (interval / whether it's worth the overhead) before
it can be scoped precisely.
