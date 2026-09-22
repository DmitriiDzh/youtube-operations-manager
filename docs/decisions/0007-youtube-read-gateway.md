# 0007. A single umbrella gateway, with category-specific children, is the only path any code may use to read from a YouTube-family API

Status: Accepted

Decided directly with the project owner over Telegram, 2026-09-22.

## Context

`docs/decisions/0005-youtube-write-gateway.md` established `src/lib/youtube-write-gateway/` as the
one module allowed to call a mutating YouTube Data API v3 method. That ADR's own Decision section
left reads explicitly out of scope: "`src/lib/youtube.ts` keeps every read function unchanged
(reads are out of this instruction's scope)."

Before this change, `src/lib/youtube.ts` was in fact the *de facto* single read wrapper for the
YouTube Data API v3 — every domain module's `adapters/youtube-api.ts` already went through it, and
no read call site bypassed it. This was true by convention and by the accident of how the codebase
grew, not by a documented, named decision the way the write side has one, and not mechanically
enforced the way the write side is. Separately, `docs/roadmap/plans/PHASE_8_PLAN.md`'s Intelligence
Foundation work (on `feature/phase-8-intelligence-foundation`, not yet merged) introduces
`src/lib/youtube-analytics.ts`, a second, distinct low-level `googleapis` wrapper for the YouTube
Analytics API — a different Google API product with its own client/auth surface, so it cannot
simply be folded into `youtube.ts` as one more function.

The project owner raised this directly (Telegram, verbatim): *"Прежде чем продолжим, давай обсудим
модальный подход (будет отчасти применяться не только это ветке, но в целом на проекте). В моем
понимании для нашей текущей задачи нужно так же сделать модуль API. У нас уже есть модуль для
записи через API, теперь нужен модуль для получения данных. Все запросы на получения данных должны
идти через него и никак иначе. Проверь сделано ли так уже. Если нет, то сделай рефакторинг."*

## Problem

Two things needed deciding:

1. **Is a single read module the right shape, given that reads already span (or will soon span)
   more than one distinct Google API product?** A literal mirror of the write gateway — one file,
   one client type — does not fit once YouTube Analytics reads exist alongside YouTube Data API v3
   reads; they authenticate and shape requests differently enough that forcing them into one file
   would blur, not clarify, the "single funnel" property the write gateway already demonstrates is
   valuable.
2. **How does the "no other file may reach a real read client" invariant get enforced mechanically**
   (matching the write gateway's own `gateway-inventory.test.ts`), given that the underlying
   import-level check ("no production file outside an approved gateway/`auth.ts` imports
   `googleapis` at runtime") is not specific to writes — it is a joint invariant that protects both
   gateways at once?

The project owner proposed the resolution directly (Telegram, verbatim): *"Согласен, что для
разных групп API нужны разные модули. Можем просто сделать одну небольшую надстройку модуль,
который будет выступать как общий шлюз, а дальше уже будет расходиться на дочерние шлюзы / модули
в зависимости от категории API"* — and confirmed the concrete plan presented for it: *"Согласен,
приступай."*

## Alternatives

- **A: Documentation-only formalization.** Leave `youtube.ts` where it is; simply write down, in
  `AGENTS.md`/`docs/DEVELOPMENT_PLAYBOOK.md`, that it is the one approved read path. Cheapest, but
  provides no mechanical enforcement (unlike the write gateway, which already has one), and gives
  the not-yet-merged Analytics reads no natural home consistent with a "one gateway" story.
- **B: Full physical move into a directory, one flat module.** Move `youtube.ts` into
  `src/lib/youtube-read-gateway/` as a single file, later adding Analytics functions to the same
  file. Rejected: a YouTube Analytics client has a different scope
  (`YOUTUBE_ANALYTICS_READ_SCOPE`), a different underlying `googleapis` sub-client
  (`youtubeAnalytics_v2` vs `youtube_v3`), and different response shapes — cramming both into one
  file mixes two unrelated request/response vocabularies for no benefit, and makes the file's own
  size and cohesion worse over time as more read categories are added.
- **C (chosen): Umbrella + category-specific children.** One directory,
  `src/lib/youtube-read-gateway/`, with a thin `index.ts` barrel that only re-exports, and one
  child file per distinct Google API product (`data-api.ts` for YouTube Data API v3 today,
  `analytics-api.ts` for YouTube Analytics API once that branch merges). Every external caller
  imports only from the barrel, never from a child directly — enforced mechanically, exactly
  mirroring the write gateway's own enforcement style.

## Decision

- **`src/lib/youtube-read-gateway/`** is the only module any code in this repository may use to
  reach a real YouTube-family read client. `src/lib/youtube.ts` (526 lines: `createYoutubeClient`,
  `getAuthenticatedYoutube`, `getAuthenticatedYoutubeFromTokens`, `getMyChannelId`,
  `listVideosByChannel`, `getChannelForSync`, `listUploadsPlaylistVideoIds`,
  `getVideosMetadataContextBatch`, `getVideoById`, `getVideoSnippet`, `getVideoMetadataContext`,
  `getVideoDetailsContext`, `normalizePlaylistPrivacyStatus`, `mapPlaylistMetadata`,
  `listPlaylistsForAuthenticated`, `getPlaylistForUpdate`, `listPlaylistItemIdsByVideo`,
  `listSupportedLanguages`, plus associated types) moved here unchanged in behavior, as
  `data-api.ts` — the YouTube Data API v3 child. Its own test file moved with it
  (`youtube.test.ts` → `data-api.test.ts`).
- **`index.ts`** is a thin barrel (`export * from "./data-api"`), never a place request logic
  lives. A future category (a second child, e.g. the still-unmerged `youtube-analytics.ts` becoming
  `analytics-api.ts`, or a future YouTube Content ID / Reporting API child) is added the same way:
  its own file in this directory, re-exported here.
- **Enforcement is mechanical, not conventional, via two tests in a new
  `read-gateway-inventory.test.ts`:**
  1. No production file outside `youtube-read-gateway/`, `youtube-write-gateway/`, or `auth.ts`
     (the OAuth client factory both gateways build on) has a runtime (non-`type`-only) import from
     `googleapis` — an import-level check, not a call-shape regex, so it also catches a future
     `const v = youtube.videos; v.list(...)` or bracket-notation call a call-shape regex would
     miss. This check used to live in the write gateway's own `gateway-inventory.test.ts`; it moved
     here because it protects a joint invariant (both gateways' entry points at once), not a
     write-specific one.
  2. No production file outside this gateway imports a specific child module (`data-api.ts`, etc.)
     directly instead of the barrel (`@/lib/youtube-read-gateway`) — keeps the umbrella genuinely
     the one thing callers need to know about, and means a future re-shuffling of which child owns
     which function never touches a caller's import path.
- **This module deliberately does not resolve credentials, OAuth scope, or do identity checks** —
  those stay exactly where they already were, in each domain module's own `services.ts`/adapters,
  mirroring the write gateway's own equivalent restraint (§ Decision of ADR 0005).
- All import call sites were updated to `@/lib/youtube-read-gateway` (never the child module
  directly): `src/app/api/youtube/{channel-info,videos}/route.ts`,
  `src/lib/write-context/adapters/youtube-api.ts`,
  `src/lib/channel-sync/adapters/youtube-api.ts`,
  `src/lib/video-details/adapters/youtube-api.ts`,
  `src/lib/video-metadata/adapters/{youtube-api,transcript-provider}.ts`,
  `src/lib/batches/adapters/youtube-api.ts`,
  `src/lib/playlist-management/adapters/youtube-api.ts`, and
  `src/lib/youtube-write-gateway/index.ts` (its own read-only dependency on `mapPlaylistMetadata`
  and the playlist metadata types).

## Rationale

The umbrella-plus-children shape is the direct implementation of the project owner's own proposed
resolution, and it keeps the property the write gateway already proved valuable — one name a
caller imports from, one place an enforcement test protects — while not forcing two genuinely
different Google API products (different auth scope, different client type, different response
shapes) into one file merely for the sake of a single flat module. Moving the shared
`googleapis`-import check out of the write gateway's test file and into the read gateway's
(excluding both directories) avoids either duplicating it or leaving it arbitrarily owned by only
one side, since it has always protected both.

## Consequences

**Easier:** a future read category (Analytics, or anything else) has an obvious, already-proven
place to go — its own child file, re-exported from the barrel — without reopening this decision.
Any accidental direct `googleapis` import, or a bypass of the barrel via a direct child import, now
fails the build immediately instead of relying on code review to notice.

**No behavioral change:** every moved function's implementation is byte-for-byte unchanged; only
its file location and how the rest of the codebase imports it changed. `npm test` (705/705 before
this file, verified again after), `npm run lint`, and `npm run build` all pass against the full
moved and rewired state.

**Follow-up left out of this change, explicitly deferred:** `feature/phase-8-intelligence-foundation`
still has its own `src/lib/youtube-analytics.ts`, built before this refactor existed. Folding it in
as this gateway's second child (`analytics-api.ts`) is a follow-up task on that branch once it
merges — that branch itself still cannot merge to `dev` without the project owner's own separate,
explicit consent (an unrelated, standing restriction on that branch, not affected by this
refactor).

## Compatibility / migration impact

No schema change. No data migration. No change to the shape of any existing API/MCP response — only
import paths changed (`@/lib/youtube` → `@/lib/youtube-read-gateway`), and only within this
repository's own source; no external contract is affected.
