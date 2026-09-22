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
// Today's only child: `data-api.ts` (YouTube Data API v3 -- channels/videos/playlists
// reads). `docs/roadmap/plans/PHASE_8_PLAN.md`'s `youtube-analytics.ts` (YouTube
// Analytics API reads) becomes a second child here once that branch merges.
// ---------------------------------------------------------------------------

export * from "./data-api";
