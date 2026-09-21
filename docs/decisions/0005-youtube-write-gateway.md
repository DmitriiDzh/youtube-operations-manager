# 0005. A single gateway module is the only path any code may use to write to YouTube

Status: Accepted

Decided directly with the project owner over Telegram, 2026-09-21.

## Context

Before this change, four independent places in the codebase called a mutating `youtube_v3`
method directly: `src/lib/youtube.ts` (`applyVideoMetadataUpdate`, `applyVideoDetailsUpdate`,
`createPlaylistForAuthenticated`, `updatePlaylistForAuthenticated`, `addVideoToPlaylistForAuthenticated`,
`deletePlaylistItemById`) and `src/lib/playlist-management/adapters/youtube-api.ts` (an inline
`youtube.playlists.delete` call). Each grew out of a different feature slice (Phase 4 single-item
metadata writes, the Studio-parity "Details" edit, playlist management), and each had its own,
independently-evolved safety posture.

The trigger was a direct consequence of a separate conversation about Gate B (the "Live writes"
toggle, `docs/decisions/0004-active-channel-read-scoping.md`'s sibling safety mechanism, BL-045):
the project owner asked why the MCP server exposed write-capable tools (`apply`, `playlist_*`) by
default, given that Batches — a different, later-built write pipeline for the same underlying
`videos.update` call — was carefully gated behind a two-layer live-write barrier. Investigation
confirmed a real, unintended gap: `apply` and `playlist_*` had the identity guardrail
(`assertWriteChannel`) but **no live-write barrier at all** — Gate B's "Live writes" toggle only
ever protected the Batches pipeline, because the check (`assertLiveWritesAuthorized`) lived
entirely inside `src/lib/batches/adapters/write-executor.youtube.ts`, with no equivalent anywhere
else. The project owner's instruction, verbatim: *"Делаем новый модуль, который будет отвечать за
отправку какой-либо информации на YouTube. Он должен быть единственным путем как информация может
попасть в 'релиз'... Никакие будущие модули не имеют права записывать / изменять / отправлять
данные на YouTube в обход этого модуля."*

## Problem

Two things needed deciding:

1. **Where does the physical write call live?** Four call sites across two files, each domain
   module reaching directly into `src/lib/youtube.ts` for its own write function, made it
   structurally possible (and, as this task found, actually true) for a future write path to skip
   whatever safety check another path happened to add — there was no single place to add a
   check that would automatically apply to every writer.
2. **Where does the "is live writing currently allowed" policy check live, and how does adding
   it avoid breaking `write-executor.youtube.test.ts`'s existing tests?** Those tests call
   `performYoutubeWrite` (the raw request/response handling) directly, without enabling live
   writes, specifically to prove it "never bypasses the barrier — it has none, that is
   `attemptWrite`'s job." Putting the check inside the gateway's own raw write primitives would
   have broken that design and those tests.

## Decision

- **`src/lib/youtube-write-gateway/`** is the one module allowed to call `videos.update`,
  `playlists.insert/update/delete`, or `playlistItems.insert/delete` — or any future mutating
  YouTube Data API v3 method. Every write function that used to live in `src/lib/youtube.ts`
  moved here unchanged in behavior (`applyVideoMetadataUpdate`, `applyVideoDetailsUpdate`,
  `createPlaylistForAuthenticated`, `updatePlaylistForAuthenticated`,
  `addVideoToPlaylistForAuthenticated`, `deletePlaylistItemById`), plus one new function
  (`deletePlaylistForAuthenticated`) replacing the inline `youtube.playlists.delete` call that
  previously lived directly in `playlist-management/adapters/youtube-api.ts`. `src/lib/youtube.ts`
  keeps every read function unchanged (reads are out of this instruction's scope).
- **Enforcement is mechanical, not conventional:** `gateway-inventory.test.ts` greps the entire
  `src/**` tree (excluding the gateway's own directory) for any call matching a broad,
  verb/resource-agnostic pattern covering every documented mutating YouTube Data API v3 method
  across every resource — not just the handful this repository happens to call today — and fails
  if it finds one anywhere else.
- **The gateway's own write primitives stay raw** (no policy check inside them), mirroring
  `performYoutubeWrite`'s pre-existing "it has none, that's the caller's job" design — this is
  what keeps `write-executor.youtube.test.ts`'s existing tests passing completely unmodified.
- **`assertLiveWritesAuthorized`** (the Gate B "Live writes" policy check) moved into the gateway
  as the single, canonical implementation. `write-executor.youtube.ts` (Batches, Layer 2) now
  imports it instead of keeping its own duplicate copy — same behavior, same `DomainError` shape,
  zero test changes needed. The three previously-ungated single-item adapters
  (`video-metadata/adapters/youtube-api.ts`, `video-details/adapters/youtube-api.ts`,
  `playlist-management/adapters/youtube-api.ts`) now each call it themselves, immediately before
  their own gateway write call — this is the actual fix for the gap this task started from.
  `write-executor.ts`'s Layer 1 (never constructing a real `WriteExecutor` unless the setting is
  on) is unchanged.
- **Credential/OAuth-scope resolution stays where it already was** — each domain module's
  `services.ts` resolving `YOUTUBE_WRITE_SCOPE` before calling its adapter. This is a distinct
  concern from "which file makes the network call," and folding it into the gateway too would
  have been a much larger change than what was asked for.

## Rationale

A single, mechanically-enforced funnel means any future write surface (a new domain module, a new
MCP tool, a new batch-like feature) automatically inherits the current safety posture the moment
it reuses the gateway's functions, and automatically fails its own tests if it tries to bypass
them — the safety property no longer depends on every future author remembering to check what
Batches did. Keeping the policy check (`assertLiveWritesAuthorized`) as one shared implementation,
called from each write surface's own call site rather than baked into the raw primitive, preserves
Batches' existing two-layer design exactly as built (`AGENTS.md` §K's "don't collapse a
defense-in-depth design" principle) while still closing the apply/playlist gap with the same
underlying policy and the same persisted setting.

## Consequences

**Easier:** any future write path reusing the gateway's functions is safe by construction with
respect to "does this go through the one allowed funnel" — the inventory test catches a mistake
immediately, in CI, rather than relying on code review to notice a new direct call. Turning on
"Live writes" in Settings now genuinely gates every write path in the application, not only
Batches.

**Behavioral change (intentional, this is the actual fix, not a side effect):** the single-item
`apply` MCP/API tool and every `playlist_*` MCP tool/API route (`create`, `update`, `delete`,
`add_videos`, `remove_videos`) now refuse with a `live_writes_disabled` `DomainError` unless the
Settings tab's "Live writes" toggle is on — previously they only checked channel identity. Any
existing integration relying on these tools writing without that toggle enabled will need to turn
it on first, exactly like Batches already required.

**Harder / follow-up left out of this change:** the identity guardrail
(`write-context.assertWriteChannel`) and MCP's read/propose/apply tool classification are
unchanged — this refactor only consolidates the physical write call and the live-writes policy
check, not every safety mechanism a write path might need. `docs/DEVELOPMENT_PLAYBOOK.md` §6.4/§6.5
were corrected in the same change to point future agents at the gateway instead of `youtube.ts`
for any new write.

## Compatibility / migration impact

No schema change. No data migration. No change to the shape of any existing API/MCP response —
only to whether a live write attempt succeeds or is refused with `live_writes_disabled` while the
toggle is off (which is already every session's default state, per Gate B, `docs/TECHNICAL_DEBT.md`
RISK-09).
