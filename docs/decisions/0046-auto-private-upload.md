# 0046. Automatic private upload of ready release packages: a standing approval given by the owner's switch

Status: Accepted (owner, Telegram msgs 3331 and 3333; FO-REQ-0036 relayed by the Operator, Operator Telegram 2166). Amends ADR 0037 §1
and §3 for one case; everything else in ADR 0037 stands.

**Date:** 2026-10-22.
- **Request:** FO-REQ-0036 and DEV-RESP-0039 with its Addendum.
- **Plan:** `docs/roadmap/plans/AUTO_PRIVATE_UPLOAD_PLAN.md` (BL-209), acceptance AC-AU-01..12.

## Context

ADR 0037 lets the owner upload his release packages from the Web UI, each one on his approval: he picks the packages on a
confirmation screen that binds to the manifest hashes and settings shown, with a date or without one. The factory now finishes
packages unattended and writes the video's SHA-256 into the manifest (`yt-release-package/1`, top-level `sha256`). The owner asked
for the finished packages to reach YouTube by themselves, as private uploads he schedules later.

## Problem

ADR 0037 §3 requires an approval per upload, and §1 keeps every upload out of reach of agents. An automatic upload has no screen to
approve. What stands for the approval, and what keeps it from becoming a path an agent could use, or a way to publish?

## Alternatives

- **Keep the per-upload approval** and only notify the owner when packages are ready. Safe, but it is exactly what he asked to drop.
- **Let the Operator (an agent) queue uploads through a new tool.** Rejected: ADR 0037 §1 keeps uploads away from agents; an agent
  could then decide what reaches YouTube.
- **A standing approval given by the owner's own switch** in the Web UI, limited to the narrowest upload: private, no date. Chosen.

## Decision

1. **The switch is the approval.** A device-local setting `autoPrivateUploadEnabled` (`app_settings.auto_private_upload_enabled`),
   off by default, persistent, one for every channel on this computer, shown next to «Запись в YouTube» on the Live writes card.
   Turning it on is the owner's standing approval of `UPLOAD_PRIVATE` (never `PUBLISH`) for every package that passes the checks
   below. Only the Web UI's `POST /api/settings` sets it; no MCP tool, agent endpoint or CLI command reaches the setter or the
   automatic queue (AC-UP-14 extended, AC-AU-11).
2. **What it may queue.** A package that is `ready` by the same checks as the approval screen, whose manifest has a top-level
   `sha256`, whose video file has exactly the manifest's `sizeBytes` and that SHA-256 (the size first; the hash only when the size
   matches, once per manifest hash, size and mtime), that no upload row here and no other computer holds, and whose manifest hash was
   never auto-queued before (one try per manifest version: a failed or cancelled automatic upload is not retried by itself).
3. **The same queue and the same checks.** The row is queued by `upload-approval.ts` `queueAutomatic`, which shares every check with
   the owner's approval (ready, held here or by a peer at queue time, the `videos.insert` daily bucket, the quota pool, the tags) and
   differs only in having no screen to bind to and no date. A full bucket, a short or unknown quota, or publishing settings in
   conflict make it wait for a later tick; nothing is dropped. An unknown quota is never acknowledged on the owner's behalf.
4. **Never public, never scheduled.** An automatic row always has `publishAt = null`: the insert is private with no `publishAt`, and
   no date is written afterwards. The playlist step runs as for a manual upload (owner msg 3333).
5. **The same runner.** ADR 0037 §2, §4, §6 apply unchanged: the write gateway, the identity check (`assertWriteChannel`) with the
   channel's connected account, `assertLiveWritesAuthorized` before every gateway call (it pauses while Live writes is off), never
   twice.
6. **Traceable.** Each row is marked `automatic` (schema v103, additive); each automatic queue writes an audit event
   `publishing.upload_auto_queued` with the time, channel, video, manifest hash, the switch state and the upload id; a video whose
   SHA-256 differs from its manifest's is logged once per manifest hash (`publishing.auto_upload_hash_mismatch`). The Content page
   marks the row «автоматически»; the agents' calendar read reports `automatic`, `progressPercent` and `finishedAt` (Agent API
   3.20.0, Producer API 1.10.0).
7. **Switching it off** queues nothing new; rows already queued stay, and the owner cancels them as today.

## Rationale

The switch keeps the decision with the owner (he can turn it off at any time, and Live writes still stops every write), while the
upload it allows is the least consequential one YouTube offers: a private video nobody sees until he schedules it. The SHA-256 check
makes sure the file uploaded is the one the factory declared finished, not a half-written or replaced file. Reusing the approval's
checks and the runner means the automatic path cannot drift from the manual one.

## Consequences

- PROJECT_SPEC §58's lifted non-goal now also covers this standing approval, still only for the owner's own release packages.
- A package composed by the owner in «Новый пакет» (BL-192) carries no `sha256` today, so it uploads only on his approval.
- A wrong file that happens to match its manifest's size and hash would be uploaded private; the factory's hash is the trust anchor.

## Compatibility / migration impact

- Schema v103 adds `publishing_uploads.automatic INTEGER NOT NULL DEFAULT 0` (ADR 0001: additive; every existing row is an approval).
- `yt-release-package/1` gains an optional top-level `sha256`; manifests without it parse as before.
- Agent API 3.20.0 and Producer API 1.10.0: additive fields on `agent_get_publishing_calendar`'s `uploads`.
