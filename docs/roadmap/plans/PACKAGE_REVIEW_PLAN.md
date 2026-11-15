# Owner review of the final release package (BL-257, ADR 0070)

Owner: TG 2298 (via the Producer), msgs 4514/4516 (2026-11-15). WWE only for now; Tropico/Japan keep clip approval.

## Stages (one branch, one merge)

1. **Module + family + gate.** `src/lib/sync-gateway/package-reviews/` (+ sync runner), `src/lib/package-reviews/` (contracts,
   model: status of a manifest from decisions; services: view, set required, decide; adapters), the scan port `ownerReview(channelId)`
   in `createPackageScanReads`, problem codes `owner_review_pending` / `owner_review_returned`, plan cache invalidation on a decision,
   tried-hash exception for approved + only-cancelled manifests.
2. **Routes + UI.** `GET/POST /api/channels/[channelId]/package-reviews` (list with state, switch), `POST …/decision`, `GET …/video` and
   `…/thumbnail` (stream the package's files, owner session, Range). Media tab «Видео на проверку» (player, thumbnail, texts, actions,
   switch). Week plan line for the two codes. Texts en/ru.
3. **Agents.** Wake file kind `package`; API bumps; docs (SYSTEM_MAP, ARCHITECTURE, interfaces, BACKLOG, AGENTS §F note: not a
   YouTube writer).

## Acceptance (written before the code)

- AC-PR-01 A channel without a review document scans exactly as before (same states and problems).
- AC-PR-02 Gate on, package ready otherwise, no decision → `not_ready` with `owner_review_pending`; not offered to the plan, not
  queued by the automatic upload, refused by the Producer's queue add and the owner's upload approval.
- AC-PR-03 Approved for manifest A (and its thumbnail hash) → ready; manifest B (re-packaged) → pending again; a changed thumbnail file
  → pending again.
- AC-PR-04 Returned (comment required) → `owner_review_returned`, stays out; a later approval of the same manifest → ready.
- AC-PR-05 Approval refused when the manifest has no video `sha256`, or this computer's mp4 does not hash to it.
- AC-PR-06 An uploaded package is not affected (no new problem after upload).
- AC-PR-07 A review document that cannot be read → every package pending (fail closed).
- AC-PR-08 Only the owner's Web UI routes decide or switch; no MCP tool, agent or factory path reaches them (boundaries test).
- AC-PR-09 The video route streams the package's own mp4 (Range 206), only for a package of that channel under `04 Videos/`.
- AC-PR-10 A decision invalidates the plan's package cache (the slot moves without waiting 60 s).
- AC-PR-11 An approved manifest whose upload rows are all cancelled without a video id is taken by the automatic upload; a manifest
  with any other row stays tried.
- AC-PR-12 The decision syncs to the other computer (family document).
- AC-PR-13 The Producer gets `REVIEW-DECISION-package-<video>-<decisionId>.md` once per decision.
- AC-PR-14 The weekly plan slot of a pending / returned package shows the review state.
