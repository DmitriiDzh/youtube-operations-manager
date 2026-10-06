# Research → Discover (channel search): analysis and improvement proposal

Owner request (Telegram 2026-10-07, msg 1900): analyse how search works in Research, how the menu could be better, what
information and actions to add, and check that every function and button in Research works as it should.
**Status:** owner decisions 2026-10-07 (msg 1904: counts yes but no country; Watch = add to the regularly scanned list;
search by genre instead of channel names; tests allowed). Implemented on `feature/research-discover-v2`: P1–P4, P6–P8,
the counts (§3, without country), Track, and the genre search. Not done: P5 (every query per candidate), search history,
bulk actions, the region/language/order options; P9 (video duration) is its own item, BL-146 -- the cause is
`videos.batchGetStats` returning no `contentDetails`. Backlog: BL-145.

## 1. How search works today

1. **Discover → Search** (or an agent's search request approved in the Inbox) calls YouTube `search.list` once:
   `type=channel`, `part=snippet`, `maxResults=25`, default order (relevance), no region, no language, no second page.
2. Per result only `channelId`, `title` and the channel `description` are kept. A channel already on the watchlist is
   skipped; one already a candidate gets `lastSeenAt`/title/description refreshed (status unchanged); the rest become
   candidates with status **New**.
3. A search uses YouTube's separate `search.list` bucket: 100 calls per Pacific day, counted from
   `market_discovery_runs` (failed runs count too). It does not spend the 10,000-unit pool.
4. Candidates: New → Watch / Ignore / Archive, or **Promote** (typed reason) → a watchlist entry. Promote does not collect
   anything yet; the next collection (dashboard load, 24 h) does. New candidates not seen again for 30 days are deleted;
   decided ones keep the row but lose title and description (YouTube policy).
5. Agents: `agent_create_market_research_request` (query + rationale) → Inbox → the owner approves → the same search
   runs. Agents read candidates through `agent_list_market_records` (only those assigned to their channel).

**On this device the search has never been used:** 0 searches, 0 candidates, 0 agent search requests. All 38 watchlist
channels were added by hand in the Web UI (03–04.10). Everything below about Discover is therefore checked in code and
tests, not on real results.

## 2. Problems found (verified in code)

| # | Problem | Effect | Fix |
|---|---|---|---|
| P1 | An agent search request accepts a query up to 500 characters, the search itself only up to 200 | A 201–500 character request can be approved and then always ends in `execution_failed` | One limit (200) at request creation |
| P2 | Search is refused while Settings → API has no daily **unit** budget, although a search does not use that budget | "Automatic collection is off" also silently blocks manual search; the UI text says the quotas are separate | Drop that precondition for search (keep the reads toggle and the 100-search cap) |
| P3 | The "N of 100 searches left" counter refreshes only on opening Discover and after its own search | Stale after an Inbox approval, or after midnight Pacific | Refresh from the summary poll |
| P4 | Candidates found by an approved agent request are not made visible to that agent's channel | The agent that asked cannot see the result unless the owner assigns each candidate | Assign them to the requesting channel on approval |
| P5 | A candidate found again keeps only its first query; one whose 30 days lapsed comes back as New without being counted as new | "Found 25, 0 new" can hide re-found channels; the query history of a candidate is lost | Keep every query (or the last one) and count re-found ones |
| P6 | Queries are stored untrimmed; a whitespace-only query passes the API | Duplicates and empty searches spend a search | Trim and reject blank |
| P7 | The quota history (BL-117) may count a search as 1 unit of the 10k pool | Minor, but contradicts "separate bucket" | Check and label it as the search bucket |
| P8 | Stale comments (a search "costs 100 units"), a mislabelled adapter comment; `niche-discovery.ts` is dead code (BL-106 dropped) | Maintenance only | Clean up |
| P9 | **Outside Discover:** video duration is not captured on real data — all 7,739 stored video snapshots have no duration, including ones collected after the 04.10 change that added it | The duration column in Research exports and any duration filter stay empty | Investigate the batch statistics call (it likely returns no `contentDetails`) |

Other Research functions checked (code, tests, and the 2026-10-06 live check of the redesigned tab): Inbox approve/reject,
Channels table and drawer (snapshot fetch asks first), Videos paging and filters, Topics & trends, Music chart (1 unit,
cached 30 min, only on the button). No defect found there beyond P9.

## 3. What a search result could show (more informative)

Today a candidate row is a title, the query and "last seen". Proposed, all from one extra `channels.list` call per search
(up to 50 channels per call, **1 unit of the 10k pool** per search):

- avatar, subscribers (or "hidden"), number of videos, total views, country, channel creation date;
- the description (now only in the drawer), the rank in the results, every query that found it;
- "already on the watchlist" / "already decided" markers instead of silently skipping;
- optionally, the latest upload date and the last 3 video titles (the uploads playlist: +1 unit per channel, only on
  request in the drawer).

Policy note (Phase 13, III.E.4): only observed values with their date, kept 30 days; no derived ranking.

## 4. Actions to add

- **Search options:** region, language, order (relevance / subscribers / video count / newest), "more results" (the next
  page = another search), and **search by videos** (`type=video`, then group by channel) — finds active channels in a
  niche better than matching channel names.
- **Bulk actions** on the list: select → Watch / Ignore / Archive.
- **Promote** with the reason pre-filled from the query, and an option "collect now" (one collection run for that
  channel, from the 10k pool, with the usual confirm).
- **Search history:** past searches (query, date, found, new) with "repeat"; `market_discovery_runs` already holds it.
- **Watching** today means only "shortlisted"; either rename it to **Shortlist**, or make it a light watch (refresh the
  basic counts on the daily collection).
- **Agents:** the result of an approved search request goes back to the requesting channel (P4), and the Inbox card shows
  the outcome (found / new) after the run.

## 5. Suggested order

1. **Fixes (small, one branch):** P1, P2, P3, P4, P6, P8, and the P9 investigation.
2. **Richer results:** the enrichment call (§3), every query per candidate (P5), search history.
3. **Search options and bulk actions** (§4).

## 6. Open questions for the owner

1. Is one extra unit (10k pool) per search acceptable for subscriber/video counts and country on every result?
2. "Watching": rename to Shortlist, or turn it into a light daily refresh?
3. Search by videos as a second search mode: wanted?
4. Should we run one real test search now (1 of 100 daily searches; it adds up to 25 candidates you can then Ignore)?
