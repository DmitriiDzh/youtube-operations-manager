# 0029. Generation plans: progress derived from jobs, factory-driven runs, review in the app

Status: Accepted

**Date:** 2026-10-07. **Requested** by the Factory Operator (FO-REQ-0006; design review FO-MSG-0008). **Decided** by the owner in Telegram
on 2026-10-07 (msgs 1929, 1931, 1933, 1939). Plan and acceptance criteria: `docs/roadmap/plans/GENERATION_PLANS_PLAN.md` (BL-143). Extends
ADR 0023, ADR 0025 and ADR 0026.

## Context

Media work is planned in waves (R-0001: 8 waves, 47 items, about 300 attempts). The status lived only in the Factory Operator's log and in
Telegram. Each wave needed 8–14 hand-built job calls. The owner gave listening verdicts in chat.

## Decision

1. **A separate feature module, `src/lib/generation-plans/`** (AGENTS.md §M).
   - It depends on `media-generation`, never the reverse.
   - The media core works unchanged without it.
2. **Progress is derived, never copied.**
   - In-app stage results are read from `media_jobs` through new nullable `plan_id`, `stage_id`, `item_key` and `seed` columns.
   - The plan's own results table holds only external-stage reports and verdicts. It has one row per (plan, stage, item, attempt),
     and a repeat report replaces the row.
   - Spend, ETA (per GPU type), budget warnings and events are computed when read.
3. **Plans are device-local and owned by one device.** Other devices get a read-only report in phase 2, through a sync family,
   following the pattern of ADR 0028.
4. **The factory drives runs; the app never starts anything by itself.**
   - Items store the job parameters and seeds.
   - `factory_plan_run_stage` and `factory_plan_rerun` create jobs only when the factory calls them.
   - Those jobs run only in a running session the factory started for the plan's channel, within ADR 0026's limits. The check
     covers all of them before the first job is created.
   - The budget is a warning only (owner Q2).
5. **Review in the app** (owner Q1: also relayed by the factory).
   - The review screen uses a player with the waveform (`wavesurfer.js`, front end only).
   - Verdicts carry: a rating out of 10, reasons, time markers and a comment.
   - The file is served by plan, item and attempt, never by path. It must sit inside the channel workspace (`Sent to YTM` for
     the factory's audition file, `From YTM/media/<jobId>` for a job output).
   - Allowed types are listed, Range requests are supported, symlinks are refused, and only loopback requests are served.
6. **Factory API 1.5.0** (additive): eleven `factory_plan_*` tools, plus optional plan fields on `factory_media_create_job` and
   `factory_media_start_session`.

## Phase 2 (2026-10-07): other devices

Plan: `docs/roadmap/plans/GENERATION_PLANS_PHASE_2_PLAN.md`; scope decided by the owner in msgs 1951/1952.

- **Transport:** a sync-gateway family, `generation-plans`.
  - Each device publishes its own plans report: plans, derived progress, the review queue with the job output as
    `media/<jobId>/<file>`, and its outgoing verdicts. It keeps the latest report of each peer.
  - The per-device report mechanics were extracted from `media-sessions` into `sync-gateway/per-device-report`, so both
    families share one implementation.
- **Other devices are read-only for plans.** The owner may give a verdict there.
  - The verdict is stored as an outgoing verdict (schema v67) and carried in that device's report.
  - The owning device applies it on its tick as an owner verdict noting the device. The newest verdict wins, so applying
    the same one twice changes nothing.
- **The audio plays from the receiving device's own copy of the channel workspace,** through the same checks.
- **Deferred:** jobs of one plan run on several devices. Only one Factory Operator runs at a time (msg 1952).
- **Trust:** a device in the owner's Syncthing folder is trusted like a local plan.
  - A device's report must name the device its file is named after.
  - A peer report chooses the channel of its plans, so a peer can make this device play an allowlisted file from that
    channel's `Sent to YTM` or `From YTM/media/*`. That plays only to a browser on this computer, and the folders are the same
    ones a local plan may use.
  - Peer verdicts are applied once per `verdictId`. A verdict dated more than 5 minutes ahead is not taken.
  - Outgoing verdicts are not part of a device snapshot: a handoff drops the ones not yet applied.

## Phase 3 (2026-10-07): notices, agent reads, listening tools

Plan: `docs/roadmap/plans/GENERATION_PLANS_PHASE_3_PLAN.md`.

- **Notices** are derived from progress, like everything else.
- **Channel agents** read their own channel's plans only: no params and no error texts (Agent API 3.8.0).
- **Listening tools:**
  - loudness match (BS.1770, computed in the browser when the validator gives no LUFS);
  - the spectrogram, with the validator's frequencies marked;
  - region loop;
  - A/B against reference tracks the factory copies into the channel's Sent to YTM and names in the plan (schema v68
    `reference_ids_json`). They are served by id only, under the audition's rules.

## Alternatives rejected

- **A status file written by the factory** (DEV-RESP-0008 §3 option A): it would have two writers.
- **Mirroring job status into plan rows through a hook:** a crash between the two writes leaves a stale row, and the media
  module would gain a listener.
- **Plans that start sessions or jobs by themselves:** they would spend without anyone calling.

## Consequences

- **Schema v66** (additive, device-local):
  - `generation_plans` (the definition as one JSON document, compare-and-swap on `revision`), `generation_plan_results` and
    `generation_plan_events`;
  - columns on `media_jobs` and `media_sessions`.
- **RISK-109 grows:** one factory call can create several jobs. The bounds stay the session caps and the factory limits.
- **Schema v67** (phase 2): `generation_plan_peer_verdicts`.
- **Not changed:** agent tools (phase 3) and the YouTube write and read paths.

## Amendment (2026-10-08, BL-157, ADR 0031)

- **Channel move.** A plan can move to another connected channel with `factory_plan_move`. Its files must already be in the
  new channel's Sent to YTM. A job's output stays in the channel the job ran on.
- **Report version 2.** The plans report is version 2. It adds the job channel, the verdict history, the waves' context, the
  owner's wave note (`ownerNote`) and review claims.
- **Owner verdicts.**
  - Each verdict is kept in a history, with its device.
  - A replacement needs the owner's confirmation (`plan_verdict_exists`).
  - A verdict sent from another device counts as given on the owning device before its tick applies it.
- **Media scoping.** The owner's Web routes are scoped to the active channel (Media).

