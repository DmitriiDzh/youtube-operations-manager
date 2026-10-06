# 0026. Factory GPU sessions within owner limits; GPU fallback; capacity wait and log

Status: Accepted

**Date:** 2026-10-06. **Requested** by the Factory Operator (`FO-REQ-0004`, approved as a request by the owner) and decided by the owner
(Telegram, 2026-10-06, msgs 1660–1663: plan accepted; the factory runs jobs in its own sessions with its own token; no job queue inside YT
Manager; retry every 30 s; the fallback list also for the owner's sessions). Plan and acceptance criteria:
`docs/roadmap/plans/FACTORY_GPU_SESSIONS_PLAN.md` (BL-133). Amends ADR 0023 (only the owner approved sessions) and ADR 0025 (the factory had no
session or job tools).

## Context

The factory tests models and templates; making each test wait for an owner click is the bottleneck. The volume pins pods to one datacenter,
and when the one configured GPU type is not free there the session simply failed. RunPod's REST v2 create-pod takes one GPU id, with no
priority list or price cap, and reports "no capacity" as HTTP 400 with a human-readable message only.

## Decision

1. **Owner limits for factory sessions:**
   - The limits are a master switch (off by default) plus four caps: per session (USD, minutes), per day and per month for the factory's
     own sessions (this machine's local calendar). They are settings in Production → Setup.
   - A factory start (`requestedBy: factory`) is **approved by the factory itself** only when it fits every one of them **and** every device
     limit the owner's approve checks: the daily cap, concurrency, the volume lock, and unchanged settings.
   - Otherwise it stays `pending` for the owner, with the limit named.
   - A running factory session counts with its full USD cap until it ends, so quick successive starts cannot slip under a limit.
   - The owner's approve and the factory's self-approve share one path (`approveInner`); `approvedBy` records which one it was.
2. **The factory's own sessions and jobs:**
   - Factory API 1.2.0 adds `factory_media_start_session`, `factory_media_get_session`, `factory_media_stop_session`,
     `factory_media_create_job`, `factory_media_get_job`, `factory_media_cancel_job` and `factory_media_capacity_log`.
   - Each sees only sessions the factory started; any other session is reported as not found.
   - Jobs are created with `createdBy: factory`. They use the session's channel workspace for inputs and outputs.
   - The writes pass the device mutation gate.
   - Channel agents and the CLI still cannot approve or start a session; the fence test now also fences `factoryStartSession` and
     `factoryStopSession` from them.
3. **GPU fallback:**
   - The candidates are the session's plan (from a request, or a registry template's new optional `gpu` field). Without a plan, the device
     GPU followed by `gpuFallbackIds`.
   - Candidates are filtered by `gpuMinVramGb`, `gpuMaxPricePerHr` and availability in the volume's datacenter, using the catalog when it
     can be read, and are tried in order.
   - A 400 "could not be placed" moves on to the next candidate. 429, 5xx or no answer counts as transient and is retried. Any other answer
     (402, 403, 422, other 400s) ends the start, as before.
   - The orphan-pod name search still runs after every failed attempt. The row records the GPU and price it actually got.
4. **Capacity wait:**
   - When no candidate can be placed, the session goes to the new status `waiting_capacity`. It has no pod, so nothing is billed, but it
     keeps its concurrency slot and holds the volume shared.
   - The watcher retries every `capacityRetrySeconds` (30 s) in the background, and the loop ticks at least that often.
   - After `capacityWaitMinutes` (30) the session fails with `media_no_capacity`.
   - Stop and release end a waiting session at no cost. The boot sweep leaves waiting sessions to the watcher.
5. **Capacity log:** `media_capacity_attempts` records every createPod attempt (placed, no_capacity or error), kept for 90 days. It is shown
   in Production and readable by the factory.

## Consequences

- Schema v64 (additive, device-local): the `media_sessions` columns `approved_by`, `gpu_plan_json` and `capacity_*`, the
  `media_workflow_templates.gpu_json` column, and the `media_capacity_attempts` table.
- RISK-109 grows: a leaked factory token can now spend GPU money without a click, bounded by the factory limits, the device limits and the
  switch.
- Not changed: the agent API, a single network volume, and Global Volumes (beta, no API, no atomic rename; plan §3).
