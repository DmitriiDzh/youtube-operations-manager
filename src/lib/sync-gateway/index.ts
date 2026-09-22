// ---------------------------------------------------------------------------
// The single module for cross-device propagation of draft/config/audit data (owner
// instruction, 2026-09-22, Telegram): "используем также правило 1 модуля и шлюза.
// Объединяем весь этот функционал в отдельный модуль. Он отвечает за отслеживание
// изменений, каталогизировать это отправлять на перенос. Транспортом пока занимается
// syncthing." -- mirrors this project's existing single-gateway pattern
// (`docs/decisions/0005-youtube-write-gateway.md`, `0007-youtube-read-gateway.md`).
//
// Three responsibilities, each document family reusing the same generic engine
// (`./automerge-core`, `AGENTS.md` §M -- shared logic extracted to its own module rather than
// copy-pasted per family) for change tracking, cataloging, and transport dispatch (see
// `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4 for the full rationale):
//
//   - `./change-drafts` + `./change-drafts-sync` -- the original draft-layer document (per
//     channel: change_sets/changes). Formerly its own top-level module
//     (`docs/decisions/0006-automerge-for-draft-layer.md`, CD1-CD7); moved here 2026-09-22 as a
//     pure relocation -- no logic changed, its own child modules and sync cycle untouched
//     (`AGENTS.md` §D -- already-shipped, safety-adjacent code is not refactored just to share
//     the new generic engine retroactively).
//   - `./editorial-profile` + `./editorial-profile-sync` -- a channel's editorial profile
//     (`channel_editorial_profiles`), added 2026-09-22 per the owner's "отдельными документами"
//     decision: its own document, its own independent sync cycle (own Syncthing subfolder), so a
//     bug in one family's sync never blocks the other's.
//   - `./automerge-core` -- the shared engine both families above build on (generic per-key
//     document store, merge-safety logic, filesystem transport, sync-cycle runner). Owns no
//     document shape or business logic itself.
//
// Every caller outside this directory imports only from this barrel, never a child
// directly -- enforced mechanically by `sync-gateway-inventory.test.ts`, the same way the
// read/write gateways enforce their own single-entry-point rule.
// ---------------------------------------------------------------------------

export { createChangeDraftsCoreForProduction } from "./change-drafts";
export { createChangeDraftsSyncCoreForProduction } from "./change-drafts-sync";
export { DomainError, isDomainError } from "./change-drafts/contracts";
export type { FieldConflict } from "./change-drafts/contracts";

export { createEditorialProfileCoreForProduction } from "./editorial-profile";
export type { EditorialProfileDocument, FieldConflict as EditorialProfileFieldConflict } from "./editorial-profile";
export { createEditorialProfileSyncRunnerForProduction } from "./editorial-profile-sync";
