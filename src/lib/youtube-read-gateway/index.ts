// ---------------------------------------------------------------------------
// The single funnel for every outbound YouTube-family READ call (owner instruction,
// 2026-09-22, Telegram): "Все запросы на получения данных должны идти через него и
// никак иначе" -- the read-side counterpart to `src/lib/youtube-write-gateway/`
// (`docs/decisions/0005-youtube-write-gateway.md`).
//
// This module is deliberately a thin umbrella, not a place where request logic lives:
// it re-exports every read function from its category-specific children, one per
// distinct Google API product (a different product has a different client/auth surface,
// so it cannot simply be one file -- see `docs/decisions/0007-youtube-read-gateway.md`).
// A future category (e.g. a YouTube Content ID or Reporting API child) is added the same
// way: its own file in this directory, re-exported here, picked up automatically by
// `read-gateway-inventory.test.ts`'s allowlist.
//
// Two children today: `data-api.ts` (YouTube Data API v3 -- channels/videos/playlists
// reads) and `analytics-api.ts` (YouTube Analytics API reads, folded in from Phase 8's
// `feature/phase-8-intelligence-foundation` branch, 2026-09-22, completing the deferred
// follow-up `docs/decisions/0007-youtube-read-gateway.md` itself named).
//
// Each read category also has its own "reads enabled" toggle (Settings tab, mirroring the
// write gateway's own "Live writes" toggle): `assertDataApiReadsAuthorized`/
// `assertAnalyticsReadsAuthorized`, re-exported below. Every caller that constructs a client
// for that category calls the matching assert function first -- enforced by
// `read-gateway-inventory.test.ts`, the same way the write gateway enforces
// `assertLiveWritesAuthorized`.
// ---------------------------------------------------------------------------

export * from "./data-api";
export * from "./analytics-api";
