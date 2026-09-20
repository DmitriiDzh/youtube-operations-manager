# Tab Auto-Refresh & Channel-Dropdown Removal Plan

Produced 2026-09-20, per the project owner's Telegram request (msg 128): remove channel-selection
dropdowns app-wide (the channel is already chosen — RISK-02's fix already means every list of
channels this app returns has at most one entry), and make each tab's data refresh automatically
when the operator switches to it, rather than requiring a manual action. **This is a plan, not an
implementation.**

## 1. What already happens today, for free (confirmed by reading `dashboard/page.tsx`)

Every tab body is rendered as `{tab === "x" && <Component/>}` — a **conditional**, not a
`display:none` toggle. Switching away from a tab unmounts its component; switching back mounts a
fresh instance. Since every tab component fetches its own data in a mount-time `useEffect`, **most
tabs already refresh their locally-stored data automatically on every tab switch, with no code
change needed**: Localizations, (soon-merged) AI Localization/Languages, Batches, Settings,
Device all already behave this way today. This significantly narrows the actual gap.

## 2. Real gaps found

1. **Rules tab.** `rules` state lives in the parent `Dashboard` component and is fetched exactly
   once, in a `useEffect` gated on `session` (component-mount time), **not** on switching to the
   "rules" tab specifically — because `Dashboard` itself never unmounts. A rule created/edited
   elsewhere would be visible immediately (via the explicit `onCreated={fetchRules}` callback),
   but if this app is ever driven by two windows/tabs, or a rule changes some other way, switching
   into "Rules" won't pick it up. Fix: move `rules` fetching into the `RuleForm`/`RuleList`'s own
   tab body the same way every other tab already fetches on its own mount, instead of the parent
   owning it.
2. **Sync tab — the one gap requiring a real decision, not just a refactor.** Switching to Sync
   already re-fetches the **locally stored** list of synced channels/videos (free, per §1). It
   does **not** automatically trigger a **live YouTube re-sync** — that still requires clicking
   "Sync my channel," and for good reason: a channel sync calls the YouTube Data API
   (`channels.list`/`playlistItems.list`/`videos.list`, batched) and consumes real, finite daily
   quota. Automatically re-syncing every single time the operator clicks into this tab could
   burn quota fast with no way to opt out. **Needs an explicit owner decision** on the actual
   policy before this can be built as "automatic" in the literal sense the request describes —
   see §4.
3. **Header `channel` (active-channel display).** Fetched once at dashboard-mount, not per-tab-
   switch. Low-priority — this rarely changes mid-session and already gets refreshed on next
   sign-in/dashboard load; not worth a special case unless the owner wants it live-updated too.

## 3. Channel-dropdown removal

Confirmed scope: the Sync tab's own channel `<select>` (`src/components/channel-sync.tsx`), plus
the Localizations and AI Localization tabs' own independent channel `<select>`s (already captured
as Slice L1 in `docs/roadmap/plans/LANGUAGES_TAB_MERGE_PLAN.md`, since RISK-02's fix already
means every one of these dropdowns can only ever show 0-1 option in practice). All three should
be removed in favor of implicitly using the single active channel already shown in the app-wide
header, consistent with how e.g. Batches already behaves. This is now a pure implementation
detail with no open design question — every component just needs to stop maintaining its own
`channelId` state and instead read the one active channel already known app-wide.

## 4. Open question requiring an owner decision

**Sync tab's live-resync policy** (§2, item 2). Three reasonable options, none obviously correct
without a decision:
   - **(a) Fully automatic, every tab switch** — matches the request most literally, but spends
     YouTube API quota on every navigation into this tab, with no user control over frequency.
   - **(b) Automatic, but staleness-gated** — auto-resync only if the locally-stored data is
     older than some threshold (e.g. 15-30 minutes), otherwise just show the cached local list
     instantly; a manual "Sync now" affordance remains for an explicit forced refresh. Balances
     freshness against quota cost.
   - **(c) Manual only, unchanged from today** — keep the explicit "Sync my channel" button as
     the only trigger, and interpret the owner's "auto-refresh" request as applying only to
     already-local data (§1), not to live YouTube calls.
   Recommend **(b)** as the best balance, but this is genuinely the owner's call, not a technical
   default — needs sign-off before being built either way.

## 5. Proposed slices, once assigned

- **T1 (no open questions):** remove the three redundant channel `<select>`s (§3); Sync/
  Localizations/AI-Localization(→Languages) all switch to the single implicit active channel.
- **T2 (no open questions):** fix the Rules tab's refresh gap (§2, item 1) — fetch on its own tab
  activation like every other tab already does.
- **T3 (blocked on §4):** implement whichever Sync live-resync policy the owner picks.

T1 and T2 are small, independent, and immediately assignable. T3 needs §4 resolved first.
