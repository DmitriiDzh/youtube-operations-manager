# ADR 0030: Production → Setup settings shared between devices; every conflict decided at startup

- Status: accepted (owner, Telegram 2026-10-07, msgs 2008, 2011, 2013)
- Plan: `docs/roadmap/plans/PRODUCTION_SETTINGS_SYNC_PLAN.md` (BL-150)

## Context

The owner wants the Production → Setup settings to be the same on every computer, including the fallback GPU list (msg 2008).

These are not simple preferences. They hold spend limits, factory limits, the GPU, and the network volume, and the volume is what open sessions and transfers are bound to.

## Decision

- **Family.** A new sync-gateway family `media-settings` holds one global Automerge document: an opaque map of setting values. It uses the same runner and transport as `ai-connections-catalog`.
  - The document starts from a deterministic genesis change (fixed actor, time 0). Two devices that each start it on their own therefore share history and merge field by field, instead of being refused as divergent lineages.
  - The same value written on both devices is not reported as a conflict.
- **What media-generation owns** (the family never imports it, §M):
  - which fields are shared: every Setup field except the derived GPU price;
  - publishing the fields a save actually changed;
  - seeding the fields the document lacks;
  - applying received values through its own `updateSettings` validation, on the media watcher tick:
    - a value that fails validation is held and not retried until the shared value changes;
    - a volume or datacenter change waits while the volume is in use;
    - the volume, datacenter and template are applied only when both devices report the same RunPod account.
- **Conflicts** (owner msg 2011, option a). A field set differently on the two devices is never applied: each keeps its own value, so a spend limit never changes by itself.
- **Every conflict is decided at startup** (owner msgs 2011, 2013). After the startup work, the browser shows one blocking window with every conflict this device knows of, decided in one go:
  - Setup settings;
  - the snapshot divergence;
  - the active channel's change drafts and editorial profile (the server answers these for the session's active channel only,
    ADR 0004; another channel's appear once it is active);
  - AI connections.

  Each conflict shows the two versions side by side, with named fields, values in words, and the differing words or list items highlighted. Only the browser waits; the server, syncing, MCP and the operator keep working. If a choice cannot be saved (recovery mode, an import holding the lock), the window offers "Decide later" so it never traps the owner. The same screen, not blocking, replaces the Merge tab's conflict list. After each server restart the coding agent checks for this window in Chrome and tells the owner.
- **Safety rules added after the independent review.**
  - A Setup card sends only the fields the owner changed (never a stale value).
  - Every document operation runs one at a time.
  - A tick, a save and a choice never interleave.
  - Only a value Production calls invalid is held until the shared values change; outages are retried, and coupled fields are tried together.
  - A GET only reads.

## Consequences

- RunPod/S3 keys stay per device (ADR 0027).
- A field a newer build adds is seeded by the first device that runs that build.
- The Merge tab's old conflict list is replaced by the same screen (same scope: the active channel's drafts and profile, plus device-wide conflicts).
