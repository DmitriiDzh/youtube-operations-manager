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

## Alternatives rejected

- **A status file written by the factory** (DEV-RESP-0008 §3 option A): it would have two writers.
- **Mirroring job status into plan rows through a hook:** a crash between the two writes leaves a stale row, and the media
  module would gain a listener.
- **Plans that start sessions or jobs by themselves:** they would spend without anyone calling.

## Consequences

- **Schema v66** (additive, device-local):
  - five `generation_plan*` tables;
  - columns on `media_jobs` and `media_sessions`.
- **RISK-109 grows:** one factory call can create several jobs. The bounds stay the session caps and the factory limits.
- **Not changed:** agent tools (phase 3), cross-device visibility (phase 2), and the YouTube write and read paths.
