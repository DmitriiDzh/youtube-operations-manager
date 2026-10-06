# BL-138 — RunPod sessions visible on every device

**Status:** plan, awaiting the owner's agreement. Requested by the owner (Telegram 2026-10-06, msg 1706: "Информация об арендованных
сессиях тоже должна передаваться между устройствами, чтобы везде отображалась актуальное текущее состояние"); started on msg 1735.

## Today

- `media_sessions` (and jobs, pulls, the volume lock) are device-local: not in the snapshot, not in sync-gateway (ADR 0023).
- Each device sees only the sessions it started. The RunPod account (pods, balance, network volume) is shared by all devices.
- Cross-device propagation has one module: `src/lib/sync-gateway/` (Automerge documents over the Syncthing folder, one family per
  document kind, run by the device-sync scheduler). AGENTS.md §G/§M: no parallel transport.

## Proposal

1. **A new sync-gateway family `media-sessions`**: one global document, a map `deviceId → { hostname, updatedAt, sessions[] }`.
   Each device writes **only its own entry** (no conflicts by construction) after every session change and on every watcher tick;
   it reads the others. A session entry carries what the table shows: id, channel, status, GPU, pod id, started/approved/stopped
   times, cost so far, limits, requested by. Never a token, URL secret or credential (the ComfyUI proxy token stays local).
2. **Live check against RunPod**: on the Sessions tab each device also lists the account's pods (one read, already used by the
   watcher). A peer's session shown as running whose pod no longer exists is marked "pod gone"; a live `ytm-media-*` pod no device
   reports is shown as "unknown pod (no device reports it)". So a stale entry from an offline device cannot hide or invent spend.
3. **UI**: Production → Sessions shows this device's sessions as today, plus "Other devices" (device name, last update, the same
   columns). The header's "sessions active" count covers all devices.
4. **Actions on another device's session** — see question 1.
5. **Limits** — see question 2.

## Questions for the owner

1. **Stop from any device?** Recommended: yes for **Stop** (it terminates the pod through RunPod directly, so it works even when the
   owning device is off; that device marks the session stopped when it next sees the pod gone). Approve/Reject stay on the device
   that owns the request.
2. **Account-wide limits?** Today "concurrent sessions" (1–4) and "max USD per day" count only this device, so two devices can
   together run 2× the limit. Recommended: count the other devices' running sessions and today's spend too (best effort: an
   offline device's last report).

## Out of scope

- Moving sessions themselves into a shared database (the snapshot is single-writer; sessions are live state).
- Jobs and model pulls across devices (can follow the same family later).
