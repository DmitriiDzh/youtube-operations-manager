# Generation plans, phase 2: plans on other devices, verdicts from any device (BL-143)

**Decided** by the owner in Telegram on 2026-10-07:
- msg 1931: all three phases;
- msg 1949: phase 1 merged, phase 2 started;
- msg 1951: scope.

Design: DEV-RESP-0008 §3 (option C), ADR 0028 (the `media-sessions` family this copies), ADR 0029 (phase 1). Phase 1 plan:
`GENERATION_PLANS_PLAN.md`.

**Scope:**
- (1) a device's plans are visible, read-only, on the other devices;
- (2) the owner can give a listening verdict on any device, and it reaches the device that owns the plan.

**Deferred** (subject to the owner's answer to msg 1951): jobs of one plan run on several devices. The Factory Operator works on one
computer today.

## 1. Design

- **Transport:** a new sync-gateway family `generation-plans` (`src/lib/sync-gateway/generation-plans*`), shaped exactly like
  `media-sessions`.
  - Each device writes only its own report into its own file in the Syncthing subfolder `generation-plans`, and keeps the latest
    report of each peer.
  - An older report never replaces a newer one. A report dated more than 5 minutes in the future is refused. A peer silent for
    7 days is forgotten. No Automerge, no conflicts.
- **Report** (`ytm-generation-plans`, version 1): `{ deviceId, hostname, updatedAt, plans[≤50], verdicts[≤1000] }`.
  - **plans[]:** this device's active plans, plus those closed in the last 30 days. Each carries:
    - the header (id, title, channel, status, budget, times);
    - stages, groups (with notes), and items without `params`;
    - the derived `progress`;
    - the last 50 events;
    - the review entries (≤ 500 per plan), each with its stages' rows (checks, metrics, notes, `auditionFile`), the verdict, and
      the job output's path **relative to `From YTM`** (`media/<jobId>/<file>`) when the attempt has one.
  - Never a local absolute path, token, key, URL or file content.
  - **verdicts[]:** the verdicts this device gave on OTHER devices' plans, kept 30 days, each with a unique `verdictId`.
- **Publishing:** the plans module builds its report on the media watcher tick, next to `publishSessionsShare`. The sync scheduler
  carries it.
- **Taking verdicts in:** on the same tick, the owning device reads the peers' `verdicts[]` for its own plans and records each as an
  owner verdict (`reportedBy: owner`, note "(from <hostname>)").
  - The newest verdict wins: a verdict older than the owner verdict already stored for that attempt is skipped.
  - Recording is idempotent: the same `verdictId` twice changes nothing.
  - Unknown, closed or another device's plans, and unknown attempts, are skipped. Nothing else is written.
- **Storage on the giving device:** a new device-local table `generation_plan_peer_verdicts` (schema v67).
- **Web (any device):**
  - Production → Plans gets an "Other devices" section: each peer's plans, read-only, with the device name and the report's age,
    marked stale after 5 minutes.
  - The review screen works for a peer plan: its queue comes from the report. The audition file is resolved **in this device's
    own copy of the channel workspace**, with the same `workspace-exchange` helpers and the same loopback, type and Range rules.
    Missing locally → "not on this device".
  - A verdict there is stored as an outgoing verdict and shown as "sent, waiting for <device>" until that device's report
    shows it applied.

## 2. Acceptance criteria (written before the code)

- AC-GP2-01: a report is built only from this device's plans, has no absolute path and no item `params`, and respects every bound.
  The review entries do carry their item's `params`, as generation details for the review screen. A plan closed more than
  30 days ago is not in it.
- AC-GP2-02: merge rules as `media-sessions`:
  - its own report is ignored;
  - a newer report replaces an older one; an older one is not accepted;
  - an invalid or future-dated report is refused with a reason (visible in the Merge tab);
  - a peer silent 7 days is not listed.
- AC-GP2-03: a verdict given on a peer plan is stored with a new `verdictId` and appears in this device's next report. It is refused
  when the peer plan or attempt is not in that peer's latest report, or the plan is closed there.
- AC-GP2-04: the owning device applies a peer verdict for its own plan, once (idempotent per `verdictId`), as an owner verdict noting
  the device. It skips a verdict older than the stored owner verdict for that attempt, one for another device's plan, a closed
  plan, or an unknown attempt.
- AC-GP2-05: the peer audition route serves only a file named by the peer report's entry for that attempt, resolved inside this
  device's workspace for the channel:
  - `Sent to YTM/<auditionFile>`;
  - or `From YTM/media/<jobId>/<file>`.

  Not present → 404 with a message. A path in the query, another attempt, a symlink or a disallowed type → refused (as AC-GP-14).
- AC-GP2-06: the Plans tab lists peer plans read-only, with device and age, stale after 5 minutes. They offer no close or edit.
- AC-GP2-07 (§M): the plans module reaches the sync family only through the `sync-gateway` barrel. `media-generation` still imports
  nothing from either.

## 3. Slices (one branch `feature/generation-plans-phase-2`)

1. Family + report building + publish/merge (AC-01, 02, 07).
2. Peer verdicts: outgoing table (v67), applying on the owning device (AC-03, 04).
3. UI: other devices' plans, peer review and audition (AC-05, 06).
