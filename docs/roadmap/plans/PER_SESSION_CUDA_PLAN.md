# A minimum CUDA version per session and per template (BL-159, FO-REQ-0011)

**Requested** by the Factory Operator in FO-REQ-0011 (2026-10-09). In session `ab8c1f6a` (RTX 4090, EU-RO-1) the 36 ACE-Step
jobs with LM codes off ran, and all 8 with `lm_codes: true` failed with "CUDA driver version is insufficient for CUDA runtime
version": the LM path needs a newer host driver than the owner's shared minimum (12.8, BL-155), the plain path does not.
**Assigned** by the owner in Telegram on 2026-10-09 (msgs 2187–2190), with the decision: **the operator may only raise the
minimum; the owner's setting stays the floor** (the image itself is built for CUDA 12.8).

## How it works today (BL-155)

- One shared owner setting `minCudaVersion` (Servers → Setup, "12.8"). Every create-pod sends `gpu.allowedCudaVersions` = the
  known versions at or above it; after RUNNING the host's CUDA is read (only when a minimum is set) and a host below it is
  terminated and re-placed (at most 2 extra placements), then `media_gpu_host_incompatible`.
- The host's CUDA version is read but never stored or shown. RunPod's API as the app uses it gives the CUDA version only
  (`machine.machineSystem.cudaVersion`), not a driver number.
- A session's GPU plan (`gpu: { candidates, minVramGb?, maxPricePerHr? }`, from the call or else the template) may only
  tighten the owner's VRAM/price limits.

## Design and acceptance criteria (written before the code)

- **AC-SC-01: a session's own minimum, only raising.**
  - `factory_media_start_session` takes `minCudaVersion?` (top level, not inside `gpu`, so no GPU list has to be restated):
    one of the accepted versions (below); anything else is refused at input.
  - A registry template may declare a top-level `minCudaVersion`. A session started with `templateId` uses the template's
    value unless the call gives its own (the call wins, also when it is lower than the template's).
  - The minimum used for a placement = the higher of the owner's setting and the session's own value, computed at every
    placement (the owner's setting is shared and can change before a capacity retry). A lower session value is clamped to the
    owner's, never refused. With no owner setting, the session's own value alone applies.
  - Examples (owner "12.8"): session "13.0" → 13.0; session "12.4" → 12.8; no session value → 12.8. Owner none, session
    "13.0" → 13.0; owner none, no session value → no filter (today).
  - The used minimum drives everything BL-155 does: `allowedCudaVersions`, the host check before `running`, re-placement and
    `media_gpu_host_incompatible`.
- **AC-SC-02: the host's CUDA version is visible.**
  - After the pod is RUNNING its host CUDA version is read whether or not a minimum is set (an unknown version never blocks,
    as before) and stored on the session; a re-placement clears it until the new host is known.
  - Session reads (`factory_media_get_session`, the sessions list, the Agent API's session reads) carry `minCudaVersion`
    (the session's own, null = none), `usedMinCudaVersion` (the minimum of the last placement, null = no filter) and
    `hostCudaVersion` (null = not known yet).
  - The capacity log's `placed` entry carries `hostCudaVersion`: from the create-pod answer when RunPod gives it, else filled
    in when the host check reads it. Other entries carry null.
- **AC-SC-03: the accepted versions are listed.** `factory_media_get_settings` returns `gpu.cudaVersions` = the versions
  RunPod accepts for `allowedCudaVersions` (11.8, 12.0–12.9, 13.0 as of 2026-10-08), ascending.
- **AC-SC-04: a run refused before it can fail.** `factory_media_create_job` and `factory_plan_run_stage`/`factory_plan_rerun`
  refuse with `media_gpu_host_incompatible` (nothing created) when the job's template declares a minimum above the session
  host's known CUDA version. An unknown host version never refuses. In a plan run the code is not turned into `plan_mismatch`.
- **Compatibility.** Template files are strictly validated: a build without BL-159 marks a template that carries
  `minCudaVersion` invalid and keeps its installed version. Both computers update before such a template is written (the
  same one-time cost as the v2 plans report). Session columns and the capacity log are device-local (no sync report change).
- **Contract.** Factory API 1.9.0 (additive). The Agent API's session and template reads gain the same output fields; per `AGENT_API_VERSION`'s own rule an additive output field is no version bump, so it stays 3.8.0. Schema v71: `media_sessions.min_cuda_version`,
  `used_min_cuda_version`, `host_cuda_version`; `media_capacity_attempts.host_cuda_version`; `media_workflow_templates`
  keeps the template's minimum in a new `min_cuda_version` column. MCP/API texts stay English.

No live RunPod call is part of development or the tests (fakes only). FO-REQ-0011 §3's "an LM job runs on that session" is
the operator's acceptance run after the release, a paid call.

One branch `feature/per-session-cuda-filter`.
