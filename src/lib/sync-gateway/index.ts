// ---------------------------------------------------------------------------
// The single module for cross-device propagation of draft/config/audit data (owner
// instruction, 2026-09-22, Telegram): "используем также правило 1 модуля и шлюза.
// Объединяем весь этот функционал в отдельный модуль. Он отвечает за отслеживание
// изменений, каталогизировать это отправлять на перенос. Транспортом пока занимается
// syncthing." -- mirrors this project's existing single-gateway pattern
// (`docs/decisions/0005-youtube-write-gateway.md`, `0007-youtube-read-gateway.md`).
//
// Three responsibilities, two children today (see
// `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4 for the full rationale):
//
//   1. Change tracking + 2. Cataloging -- `./change-drafts` (the per-channel Automerge
//      document: create/update/approve, conflict detection via `Automerge.getConflicts`,
//      the SQL read-projection). Formerly its own top-level module
//      (`docs/decisions/0006-automerge-for-draft-layer.md`, CD1-CD7); moved here 2026-09-22
//      as a pure relocation -- no logic changed, see the M1 commit for the before/after
//      test-suite comparison proving this.
//   3. Transport dispatch -- `./change-drafts-sync` (the sync-cycle runner) plus its own
//      `./change-drafts-sync/adapters/filesystem-transport.ts` (today's one
//      `ChangeDraftsSyncTransportAdapter` implementation: each device writes only its own
//      `<deviceId>.automerge` file into an operator-configured Syncthing folder). This is
//      the one piece meant to be swappable -- a future non-Syncthing transport becomes a
//      second adapter behind the same interface, with change tracking/cataloging above
//      needing no change for that swap.
//
// Every caller outside this directory imports only from this barrel, never a child
// directly -- enforced mechanically by `sync-gateway-inventory.test.ts`, the same way the
// read/write gateways enforce their own single-entry-point rule.
// ---------------------------------------------------------------------------

export { createChangeDraftsCoreForProduction } from "./change-drafts";
export { createChangeDraftsSyncCoreForProduction } from "./change-drafts-sync";
export { DomainError, isDomainError } from "./change-drafts/contracts";
export type { FieldConflict } from "./change-drafts/contracts";
