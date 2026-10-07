# 0028. RunPod sessions visible across devices; Stop from any device; shared limits per RunPod account

Status: Accepted

**Date:** 2026-10-06. **Requested** by the owner (Telegram, 2026-10-06, msg 1706) and decided on msg 1739: Stop works from any device;
devices on the same RunPod account share the limits. Plan: `docs/roadmap/plans/MEDIA_SESSIONS_CROSS_DEVICE_PLAN.md` (BL-138).
Amends ADR 0023 ("sessions are device-local").

## Decision

1. **Transport: a sync-gateway family `media-sessions`** (AGENTS.md §G/§M: one module for cross-device propagation). Each device
   publishes only its own report (strict JSON: per session status, channel, GPU, pod id, times, cost; the day's spend; hostname;
   the RunPod account id) on every media watcher tick; the generic sync runner (every minute, Syncthing folder subfolder
   `media-sessions`) carries it; each device keeps the latest report per peer, an older one never replaces a newer one, its own
   and invalid ones are ignored. No Automerge: nothing is merged, so there are no conflicts; "adopt the peer's copy" is a no-op.
   The shared transport still names the file `<deviceId>.automerge` although it holds JSON. Never in a report: the ComfyUI URL
   (it carries the proxy token), RunPod error text, any key or token.
2. **Account identity:** the RunPod account id from the legacy GraphQL `myself { id }`, not anything derived from a key. Unknown on
   either side = not the same account.
3. **Live check:** Production → Sessions → "Other devices" shows each peer's sessions checked against RunPod's live pod list
   (`pod running` / `pod gone` / `no pod yet` / `ended`), live `ytm-media-*` pods no device reports, and a report older than 5 min
   as stale. The header adds "(+N on other devices)".
4. **Stop from any device:** terminates the session's pod through RunPod (terminate-and-confirm) only if the session is in that
   device's latest report and not finished, both devices report the same account id, and the live pod carries the session's
   deterministic name `ytm-media-<id[0..8]>`. The owning device marks the session `interrupted` ("pod disappeared") when its watcher
   next runs. Approve/Reject stay on the owning device. Audited as `stop_peer_session`.
5. **Shared limits (same account):** concurrency counts the account's live `ytm-media-*` pods that are not this device's (from
   RunPod, not from reports); the daily cap adds the spend the same-account devices reported today. Both at approve (the guarded
   UPDATE stays the one atomic check, against the slots left) and in the watcher's daily-cap stop. Unknown account or RunPod
   unreachable = the other devices count as 0 (best effort). The factory limits (ADR 0026) are unchanged.

## Consequences

- Other devices' state is about 1–2 minutes behind (watcher tick + sync cycle + Syncthing).
- Cross-device limits are not atomic: two devices approving at the same moment can overshoot by one session (RISK-111).

## Amendment (2026-10-07, BL-148): job progress in the report

Owner, Telegram 2026-10-07, msg 1976. The report goes to **version 2**. Each open session may carry `jobs`:
- counts by status over the newest 200 jobs;
- up to 5 unfinished jobs with BL-144 live progress, without `detail`, so no ComfyUI error text is shared.

"Other devices" shows them about a minute behind. A device on this build still reads version 1 reports. An older build refuses
version 2 with "newer… update the app", so both devices must be updated. Plan: `docs/roadmap/plans/CROSS_DEVICE_JOB_PROGRESS_PLAN.md`.
