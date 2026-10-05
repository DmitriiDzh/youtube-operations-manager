# Phase 9 slice 9C — discovery (search.list-based expansion)

Continues on the same branch as 9A/9B (`AGENTS.md` §K.1, owner: "делаем всю фазу до конца в этой
ветке"). Scope derived from `docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md` §3/§4 and
`docs/roadmap/plans/PHASE_9_PLAN.md` §14's own 9C definition, per `AGENTS.md` §L. Design reviewed
with advisor before implementation; its constraints are folded in below rather than listed
separately.

## 1. Scope (deliberately narrower than the spec's full "Market Discovery Profile")

The owner spec (§3) describes a much larger vision -- seed profiles (queries/channels/topics/
languages/regions), discovery budgets, refresh policies, recursive expansion through newly observed
channels/videos/topics. Per `AGENTS.md` §C ("smallest safe implementation slice"), this slice ships
only:

- **One discovery action:** operator types a search query in the UI and clicks a button.
  `search.list` (channel-type only), one page (≤50 results), one call, 100 units -- never
  paginated, never recursive, never automatic (owner decision 4: "По запросу из UI пользователем").
- **Channel candidates only.** Video/topic/niche discovery (`TrendCandidate`/`NicheCandidate` from
  the spec's §2 entity list) are explicitly out of scope here -- 9E/9F's own concern.
- **A candidate lifecycle** (`new`/`watching`/`ignored`/`archived`/`promoted`, spec §4), with
  validated transitions, not a free-for-all status field.
- **No seed profiles, no refresh policies, no recursive expansion.** A query is typed fresh each
  time; nothing is remembered/re-run automatically. This is a deliberate, named simplification, not
  a silently dropped requirement -- tracked as future scope (§8 below).

## 2. Budget: shares 9B's single slider, never a second budget concept

Owner decision 2 ("добавим ползунок... от того числа строить логику") set ONE daily unit budget for
market intelligence as a whole, not one per sub-feature. Discovery therefore draws from the exact
same `marketIntelligenceDailyQuotaBudgetUnits` setting 9B already reads, and the exact same
"spent today" ledger sum -- **which must now cover both `market_intelligence_collection_runs` AND
this slice's own `market_discovery_runs`** (`getMarketIntelligenceUnitsSpentSince` is widened to sum
both tables; `market_intelligence_collection_runs.research_channel_id` is `NOT NULL` with an FK to
the watchlist, so a discovery run -- which isn't about any one watchlisted channel -- cannot use
that same table).

- `null`/unset budget means **no API spend at all**, discovery included -- `discoverChannels`
  refuses outright (`MARKET_INTELLIGENCE_QUOTA_DISABLED`), the same as 9B's own "budget unset ->
  zero calls" rule, extended here explicitly since this is a NEW assumption 9B's own plan never had
  to state (9B silently no-ops when unset; this slice's UI-triggered action instead surfaces a
  clear, styled error, since an operator who just clicked "Discover" needs to know why nothing
  happened).
- If `remaining < 100` (search.list's real, documented unit cost), the action refuses outright with
  `MARKET_INTELLIGENCE_QUOTA_EXCEEDED` and the exact remaining/required numbers in `details` --
  never silently truncated or queued.
- The Settings-tab slider's own label/tooltip is updated to state it now covers discovery too, not
  only auto-refresh.
- The UI shows the 100-unit cost in a styled confirm dialog before calling the API (`AGENTS.md`
  memory: never `window.confirm`).
- Charged before the `search.list` call resolves, same as every 9B call (a thrown request still
  costs a real unit per YouTube's own quota accounting).

## 3. Schema additions (SCHEMA_MIGRATIONS v25 -- v24 is already applied to the real local database

and must never be edited in place, `docs/TECHNICAL_DEBT.md` RISK-63)

```sql
CREATE TABLE IF NOT EXISTS market_discovery_candidates (
  id TEXT PRIMARY KEY,                 -- the real YouTube channel id
  title TEXT NOT NULL,
  status TEXT NOT NULL,                -- 'new' | 'watching' | 'ignored' | 'archived' | 'promoted'
  discovery_source TEXT NOT NULL,      -- 'youtube.search.list'
  discovery_query TEXT NOT NULL,       -- the query that (first) surfaced it
  reason_discovered TEXT,              -- the search result's own description, if any
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_via TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_discovery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  ran_at INTEGER NOT NULL DEFAULT (unixepoch()),
  status TEXT NOT NULL,                -- 'success' | 'failed'
  units_spent INTEGER NOT NULL,
  candidates_found INTEGER,
  candidates_new INTEGER,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS market_discovery_runs_ran_at_idx ON market_discovery_runs(ran_at);
```

`market_discovery_candidates` is a **lifecycle table, not an append-only observation series** (spec
§4's own "firstSeenAt/lastSeenAt" framing implies one row per candidate, touched over time) --
architecturally like `research_channels` itself, unlike 9A/9B's append-only snapshot tables.
Re-discovering an already-known candidate updates `last_seen_at` only, never inserts a duplicate row
and never overwrites an operator-set `status`. No FK to `research_channels` -- a candidate is
explicitly a PRE-watchlist entity; promotion creates a **separate** `research_channels` row via the
existing `insertResearchChannel` (never a second, parallel watchlist-insert path), and the candidate
row itself is kept (status: `promoted`) as a permanent historical record, not deleted.

**Naming, for `PHASE9-INV-02`'s own mechanical coverage:** both new table names and every new
exported db.ts symbol contain "market" (the inventory test's forbidden-symbol regex matches
`research` or `market`, case-insensitive) -- the two raw table name literals are added to the
test's own explicit list (regex-derivable camelCase exports are covered automatically; raw SQL
string literals are not). Verified via the same probe-file technique used for 9B's own equivalent
gap.

## 4. Read-gateway addition (`src/lib/youtube-read-gateway/data-api.ts`)

New `searchPublicChannels(youtube, query, maxResults = 25)`: one `search.list` call,
`part: ["snippet"]`, `type: ["channel"]`, never paginates (mirrors 9B's own
`listUploadsPlaylistFirstPageVideoIds` precedent: capping by page keeps the real unit cost exactly
and always 100, deterministically). Returns `{ channelId, title, description }[]` from
`item.id.channelId`/`item.snippet.title`/`item.snippet.description` -- an id-less result (malformed
API response) is simply omitted, never fabricated.

## 5. Market-intelligence module additions

- `discoverChannels({ query, credentialRef })`: budget-gated (§2), resolves credentials, calls
  `searchPublicChannels`, then for each result: skip if already on the watchlist (never create a
  candidate for something already watchlisted); if already a candidate, touch `last_seen_at` only;
  otherwise insert a new `status: "new"` candidate. Records one `market_discovery_runs` row
  regardless of outcome. Returns `{ candidatesFound, candidatesNew }` -- the UI calls
  `listDiscoveryCandidates` separately to refresh its own list (avoids ambiguity about "all
  candidates" vs. "just this run's new ones" in one payload).
- `listDiscoveryCandidates()`: read-only, all candidates, newest `lastSeenAt` first.
- `updateDiscoveryCandidateStatus({ channelId, status })`: `status` is `"watching" | "ignored" |
  "archived"` only (never `"new"` -- that's the initial state only; never `"promoted"` -- that
  requires the dedicated action below, since it has a real side effect). Rejects
  `DISCOVERY_CANDIDATE_ALREADY_PROMOTED` if the candidate's current status is already `"promoted"`
  -- a promoted candidate's own record is a closed historical fact, managed via the watchlist from
  that point on.
- `promoteDiscoveryCandidate({ channelId, reason })`: inserts a `research_channels` row (via
  `insertResearchChannel` directly, not the public `addToWatchlist` action -- mirrors
  `getWatchlistEntryContext`'s own established precedent of avoiding a redundant duplicate
  existence-check) UNLESS the channel is already watchlisted (idempotent in that case -- the
  desired end state already holds), then sets the candidate's own status to `"promoted"`. Returns
  both the resulting `ResearchChannel` and the updated candidate.

## 6. API routes (Web UI only -- owner decision 4, never MCP/CLI)

- `POST /api/market-intelligence/discover` -- `{ query }`, real mutation (writes candidate rows and
  a run-log row even on a "successful search, zero new candidates" outcome), gated by
  `src/proxy.ts` normally.
- `GET /api/market-intelligence/discovery-candidates` -- read-only list.
- `PATCH /api/market-intelligence/discovery-candidates/[channelId]` -- `{ status }`.
- `POST /api/market-intelligence/discovery-candidates/[channelId]/promote` -- `{ reason }`.

**No MCP tool, no CLI command for discovery** -- owner decision 4 restricts this to explicit
operator UI action; an agent-initiated discovery request belongs to 9G's own approval-gated draft
path (spec §29's DRAFT-class pattern), not this slice.

## 7. UI (Research tab, minimal -- full Discovery UI is 9H's scope)

A small "Discover channels" section: a text input + "Search (100 units)" button (styled confirm
dialog first, never `window.confirm`), a results/candidates list with per-candidate
Watch/Ignore/Archive/Promote actions. Shipped now (not deferred to 9H) because an API-only slice
with no caller is dead code the way 9A's own `market_video_snapshots` briefly was before 9B gave it
a writer -- this slice's own action needs a real trigger to be a genuinely complete, working
feature (`dev-merge-only-complete-features`).

## 8. Explicitly out of scope for 9C (named, not silently dropped)

- Seed profiles, refresh policies, recursive/automatic expansion through newly observed
  channels/videos/topics (spec §3's fuller vision) -- this slice is query-in, candidates-out, once,
  on explicit request.
- Video/topic/query discovery and their own watchlists (spec §5) -- channel candidates only.
- Any relevance-scoring/ranking beyond raw `search.list` order.
- The full §27 data-quality vocabulary beyond `success`/`failed` on the run log.
- Cross-device transfer of the two new tables (RISK-52/decision 5) -- bundled with 9A/9B's own
  still-open equivalent, presented to the owner once, not per-slice (already asked, awaiting reply).

## 9. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- With budget `null`/unset, `discoverChannels` makes zero real calls and throws
  `MARKET_INTELLIGENCE_QUOTA_DISABLED` before resolving credentials.
- With budget set but `remaining < 100` (accounting for BOTH collection and discovery spend already
  recorded today), `discoverChannels` throws `MARKET_INTELLIGENCE_QUOTA_EXCEEDED` before making any
  real call.
- A search result already on the watchlist is never turned into a candidate.
- A search result matching an existing candidate updates only `lastSeenAt`, never duplicates the
  row, and never overwrites an operator-set `status` (e.g. `"ignored"` stays `"ignored"` on
  rediscovery).
- A genuinely new result is inserted with `status: "new"`.
- `updateDiscoveryCandidateStatus` rejects a target of `"promoted"` and rejects any status change on
  an already-`"promoted"` candidate.
- `promoteDiscoveryCandidate` creates exactly one `research_channels` row (never a duplicate if
  already watchlisted) and sets the candidate's own status to `"promoted"`.
- A `search.list` call that throws still records its own real 100-unit spend on the run log
  (charged before the call, not after).
- `getMarketIntelligenceUnitsSpentSince` sums both `market_intelligence_collection_runs` and
  `market_discovery_runs` -- a 9B collection spend reduces what 9C's own budget check sees as
  remaining, and vice versa.
- `PHASE9-INV-02` catches a raw-SQL reference to either new table from outside the module (verified
  by probe file, per 9B's own precedent).
- Schema initialization succeeds against both a fresh empty database and the pre-migration re-apply
  path.

## 10. Live verification

Per `docs/TECHNICAL_DEBT.md` RISK-63, **no script in this repo may touch the real local app-data
database until the owner responds to that entry** -- every throwaway verification script for this
slice runs with `NODE_TEST_CONTEXT=1` set (this codebase's own real-path-redirect signal,
`src/lib/platform-paths/runtime.ts`), and prints `getProductionAppPaths().dbPath` first to confirm
it resolved to a temp path before doing anything else. A real `search.list` call additionally
spends real, non-refundable quota and needs its own separate owner approval regardless (already
asked, alongside RISK-63, in the same Telegram message) -- this slice ships code-complete, covered
by tests against a fake `youtubeApi`, and is live-verified only after that approval arrives.
