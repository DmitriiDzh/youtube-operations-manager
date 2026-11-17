> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 41. GPU availability per datacenter, now and every 15 minutes (BL-172, FO-REQ-0016; BL-206, FO-REQ-0033)

Plan: `docs/roadmap/plans/GPU_AVAILABILITY_PLAN.md` (AC-GA-01..09). Schema v81. Part of the media core (`src/lib/media-generation/`);
RunPod reads only through the media gateway (`src/lib/media-gateway/`), so its switch and traffic log apply.

- **Gateway.** `listGpuTypes({ cloud, minCudaVersion? })` passes RunPod's v2 `minCudaVersion` filter (stock counted only on hosts with
  at least that CUDA) and maps `cudaVersions: [{ version, available }]` (per GPU type, not per datacenter). `RUNPOD_S3_DATACENTERS`
  (`runpod-s3.ts`) is RunPod's documented S3-endpoint list; the v2 catalog has no S3 field.
- **Live read** (`getGpuAvailability`, `services.ts`): input checked by `gpuAvailabilityInputSchema`, then the two catalog reads in
  parallel, always Secure Cloud (network volumes exist only there), with the Settings' CUDA minimum (an input version replaces it), then
  the pure `buildGpuAvailability`
  (`gpu-availability.ts`): GPUs at or above the memory minimum (input, else Settings, else 24 GB), each with its datacenters' stock,
  `networkVolume` (the datacenter lists a volume tier) and `s3Api`; `cudaAvailable` = some listed version ≥ the minimum is available
  (with a minimum set, RunPod lists only versions at or above it, so an empty list is `false`; null only with no minimum and no list).
- **Log** (`gpu-availability-log.ts`). `snapshotGpuAvailabilityIfDue` returns `taken` / `skipped` (`fresh`: newest snapshot under 14 min
  -- `GPU_AVAILABILITY_SNAPSHOT_DUE_MS`, nominally every 15 min, `GPU_AVAILABILITY_SNAPSHOT_INTERVAL_MS`; 3 h before BL-206;
  `backoff`: under 15 minutes since the failed tick's start (an hour before BL-206), kept in memory; `gateway_off` / `not_configured`: checked before any client is resolved, so a
  switched-off gateway records no blocked traffic) / `failed` (logged, never thrown). It always reads Secure Cloud (network volumes
  exist only there) and stores GPUs of 24 GB or more (fixed, so raising the Settings minimum does not shrink the log), through
  `buildGpuAvailabilitySnapshotRows`: per GPU an overall `*` row (always) plus one row per datacenter with a volume tier where the GPU
  is listed there with a level other than NONE (BL-206; before it NONE rows were stored too -- 92 % of the rows -- and they are not
  rewritten; a missing row means NONE). A GPU catalog with nothing of 24 GB or more, or a datacenter catalog with no volume tier anywhere, is a failure, not
  a snapshot (it would otherwise count as fresh and hide the gap). The timer in `src/instrumentation.ts` ticks every 5 minutes
  (first after 5; every 15 before BL-206) behind `assertDeviceAvailableForMutation`, so the gap stays about 15-20 minutes. BL-208
  (`GPU_START_FIXES_PLAN.md` §F): a tick reads every CUDA minimum in use -- the Settings' plus every installed template's
  (`listMediaWorkflowTemplateMinCudaVersions`), ascending (`orderCudaMinimums`, `cuda-host.ts`); none anywhere = one read without a
  filter (key `''`). The datacenter catalog is read once per tick, the GPU catalog once per due minimum; each minimum has its own due
  check (`latestAt(minimum)`) and back-off, and one minimum's failure never drops another's snapshot. With more than one minimum the
  tick's outcome lists each one's result in `minimums`.
- **Storage.** `media_gpu_availability_log` (`at`, `gpu_type_id`, `data_center_id`, `stock`, `price_per_hr`, `min_cuda_version`;
  indexes on `at` and on `(gpu_type_id, data_center_id, at)`). `insertMediaGpuAvailabilitySnapshot` writes a snapshot in one transaction
  (200 rows per insert; no rows = nothing stored, and a snapshot already stored at the same second makes a repeat store nothing) plus its row in `media_gpu_availability_snapshots` (schema v100: `at` PK, `rows`, `min_cuda_version`; the
  migration backfills every distinct `at` of the log with its row count; schema v102, BL-208: the snapshots move to the new table
  `media_gpu_availability_cuda_snapshots` (PK `(at, min_cuda_version)`, `min_cuda_version` NOT NULL with `''` = no minimum), which
  copies the v100 rows (`INSERT OR IGNORE`, NULL → `''`); a second minimum at the same second is stored, a repeat is not. Additive per
  ADR 0001: the v100 table stays, no longer read, written or pruned) and then prunes both tables older than
  `GPU_AVAILABILITY_LOG_RETENTION_DAYS` (90; a failed prune is ignored, like the capacity log). `getLatestMediaGpuAvailabilityAt` reads
  the snapshots table (since v102 `media_gpu_availability_cuda_snapshots`). Both classified `not_api_data`, device-local in snapshots.
- **Reads.** `listGpuAvailabilityLog` backs `factory_media_list_gpu_availability_log`: rows newest first (`listMediaGpuAvailabilityLog`,
  default 1,000, at most 5,000), or with `summary` the SQL `GROUP BY gpu_type_id, data_center_id, stock` over every matching row
  (`summarizeMediaGpuAvailabilityLog`), folded per GPU and datacenter by `summarizeGpuAvailabilityGroups`. BL-206: the summary's
  `snapshots`/`firstAt`/`lastAt` come from the snapshots table (time range only), and with `gpuSnapshots` (per GPU, the distinct `at`
  with any row of it) a datacenter entry's NONE = the GPU's snapshots − its other levels, identical for old (NONE stored) and new
  (NONE implied) snapshots; a GPU × datacenter named together with no row gets one all-NONE entry. BL-208: every read (latest,
  rows, summary, `countMediaGpuAvailabilityCells`) is under ONE minimum -- the input `minCudaVersion`, else the Settings' -- the log's
  nullable column compared as `coalesce(min_cuda_version, '')`; the answers echo `minCudaVersion` and list `minCudaVersions` present
  in the range (`listMediaGpuAvailabilityMinimums`).
- **Statistics (BL-206, `gpu-stats.ts`, `factory_media_get_gpu_stats`, Factory API 1.26.0).** `createGpuStatsServices` depends on two
  store reads and the Settings' GPU list only -- no RunPod client is in reach. `countMediaGpuAvailabilityCells` groups in SQL by UTC hour
  (`strftime('%H', at, 'unixepoch')`) and ISO weekday (`(%w + 6) % 7 + 1`): the snapshots taken, per GPU the distinct snapshots with a
  row of it, and the stored rows per GPU, datacenter and level; `buildGpuAvailabilityStats` applies the hour/weekday window to those
  cells and derives NONE per cell with the same `withImpliedNone` (`gpu-availability.ts`, the one place of that rule); `inStock` counts LOW / MEDIUM / HIGH, `unknown` the listings without a level (so 90 days never load row by row). Sessions: `listMediaSessionsFirstApprovedBetween` →
  `buildGpuWaitRecord` per row (candidates from its plan, else the Settings' list as it is now; wait = `readyAt − firstApprovedAt`;
  outcome ready / failed / stopped / open; failure reason = the error's leading `code:`, else `other`; candidates from `orderedGpuCandidateIds` in `gpu-plan.ts`, the list a start tries, null for an unreadable plan) → `buildGpuSessionStats` (median and p90 by
  nearest rank over ready sessions, failureRate = failed / (ready + failed), by candidate list and by GPU obtained). The window is
  checked in the core: `from` > `to`, more than 90 days, or an empty hour window → `invalid_request` before any read.
- **Session wait facts (BL-206, schema v100).** `media_sessions.first_approved_at` is set only by `approve` (the guarded `pending →
  approved` UPDATE, once per session); a capacity retry (`waiting_capacity → approved`) and a re-placement (`starting → approved`, or a
  later placement in `placeOnce`) move `approved_at` -- the start budget's clock -- but never it. The migration backfills older sessions
  from their earliest `media_capacity_attempts.at` and sets `first_approved_approximate`. `startApproved` stores
  `resolveGpuCandidates().skipped` as `gpu_skipped_json` only while the row has none and the catalog could be read (so the first
  placement that could check the candidates is the one recorded), best effort like `usedMinCudaVersion`, also when no candidate qualifies.
- **Start fixes E + D + I (BL-208, `docs/roadmap/plans/GPU_START_FIXES_PLAN.md`, FO-REQ-0035, Factory API 1.28.0).** Every skip from
  `resolveGpuCandidates` has a `kind`: `stock` (not in RunPod's catalog; the catalog does not list the volume's datacenter for it) or
  `config` (VRAM under the minimum, price over the cap, no price under a cap); a bound skip's reason names it `(Settings)` or
  `(session)` (the session's value only when strictly tighter). An empty catalog (`[]`) is read like an unreadable one. When no
  candidate is left, `startApproved` goes to `waitForCapacity` if any skip is `stock` (no createPod for a stock-skipped candidate; the
  watcher re-reads the catalog every round, `media_no_capacity` after the wait) and fails at once (`media_session_start_failed`) only
  with `config` skips; the waiting / no-capacity / start-failed texts list the skips (`describeGpuSkips`) besides the createPod
  failures. `factoryStartSession` reads the catalog once before the approval, answers `gpuSkipped` (null when unreadable or when the
  request is held) and hands that catalog to the start (`prereadCatalog`, no second read). `parseGpuSkipped` keeps `kind` (older
  rows have none). Fix I: createPod sends RunPod's numeric `gpu.minCudaVersion` (the higher of the owner's and the session's minimum),
  never the exact `allowedCudaVersions` list, which ended at 13.0 and excluded hosts reporting 13.1/13.2; the host check compares
  versions numerically, so a 13.2 host passes a 13.0 minimum.

## BL-199 / BL-134 — one store for this computer's secrets; gated Hugging Face pulls (ADR 0042)

- **Store.** `src/lib/device-secrets/` owns every secret typed into Settings on this computer: the RunPod/S3 set, the Gemini key and
  the Hugging Face read token.
  - Storage: one table `device_secrets` (schema v96, device-local, never synced or snapshotted) and one key file
    `device-secrets.key` (0600, created on the first save).
  - Each feature module gets a slot (`state`, `info`, `read` / `readWithVersion`, `write`, `setStatus` compare-and-set on a version derived from the ciphertext, `clear`) and never
    sees the key or the ciphertext.
  - "Configured" means a row and a readable key file. Clearing removes one row; the shared file goes only when it is unusable.
- **Migration.** Done at runtime, idempotent, without re-entry: on a slot's first use its legacy row (`media_credentials` /
  `gemini_credentials`) is decrypted with its legacy file, written, read back and compared, then marked moved
  (`app_settings` `device_secret_migrated:<name>`). Legacy tables and files are kept (RISK-131). The migration was verified on a
  scratch copy of the owner's real database: both secrets moved with the same values and hints.
- **Key file creation (FO-MSG-0018 fix).** On the Mac's first v96 start, the RunPod set and the Gemini key moved at the same moment.
  Each move created its own `device-secrets.key`, and the last write won. The Gemini row was left sealed with a key nobody had, so
  the status read "set" while jobs failed `gemini_key_missing`; the owner re-entered the key.
  - `readOrCreateKey` now runs one creation at a time per process.
  - The file is created only if absent (temp file + `link`, also across processes), and the key returned is the one read back from
    the file.
  - A move is verified with the key read from the file, not the one in memory; a failed check deletes the moved row and leaves the
    legacy row unmarked.
- **Session tokens.** ComfyUI proxy tokens are sealed with the store's key. Opening falls back to the legacy media key for sessions
  opened before the update.
- **Hugging Face.**
  - The token is checked with `whoami` before it is saved.
  - It is read and sent only for a gated or private repo, so public pulls never depend on it. It goes only to huggingface.co, as a
    Bearer header from the media gateway's HF child.
  - For such a repo, a HEAD on the file runs before any pod is created.
  - The pull pod gets it in `env.HF_TOKEN` (masked by `redactPodEnv`), never in `cmd`; it is never on the `ModelPull` record or in
    any API/MCP output.
  - Gated without a token: `hf_token_missing`; token refused: `hf_token_invalid`; 403 with a valid token: `hf_gate_not_accepted`.
  - The licence comes from the repo card's `license` / `license_link`.

## BL-200 — pod runtimes the Factory Operator manages (FO-REQ-0029, ADR 0043)

- **Profiles.** A runtime is one immutable file on the network volume, `ytm/runtimes/<runtimeId>/runtime.json`: ComfyUI and node packs
  at exact 40-hex commits (a tag is resolved through the media gateway's GitHub child at create time) and pinned pip extras. Every
  repo must sit under the owner's allow-list. The volume is the store every computer shares, so profiles have no sync family.
- **Build** (`runtime-builds.ts`). A pod on the cheapest GPU of the owner's list in the volume's datacenter (40 GB disk; the next GPU on no capacity) runs the GPU template's own image (`imageName`; none = refused,
  never a fallback image) with the entrypoint `bash /workspace/ytm/runtime-build.sh <id>`, no ports, no env (BL-230: except `YTM_GIT_TOKEN`, below). The script clones each
  repo at its commit (verified with `rev-parse`), makes a venv from the image's Python with a `.pth` to the image's site-packages
  (torch is never downloaded: probe 1), installs the requirements without torch/torchvision/torchaudio, writes `.ready` last and
  then `build.json`. The watch loop reads the verdict and terminates the pod (a build is finished only once the pod is confirmed
  gone); a dead pod fails at once; the cap is 30 min. Probe 2 (2026-10-18): on a `cpu3c` host the CUDA image never started in 45 min, so the build moved to a GPU host, which has the image cached (owner msg 3035). `.ready` is the invariant: without it a runtime is not built.
  - It does not take the network-volume lock: it writes only under its own folder, nothing reads that before `.ready`, and the
    exclusive lock would block every session for the build's ~9 min. `.lock` (pod id, stale after 2 h) and the app's job list stop
    a second build of one profile.
  - `ensurePodScripts` uploads this version's `scripts/media/pod/{pod-start.sh,runtime-build.sh}` to `ytm/` when the volume's copy
    differs, before a build and before a session on a runtime. Both computers run from the repository checkout.
- **Private GitHub repositories (BL-230, ADR 0043 amendment 1).** The owner's GitHub read token lives in the device-secret slot
  `github` (Settings → Cloud APIs, `github-token.ts`). `createRuntime` checks every github.com source's ref or commit through the
  gateway's GitHub child, without a token first and with it only after a 404 (`runtime_repo_private_needs_token` /
  `runtime_repo_not_visible_to_token`). A build pod whose profile names github.com gets the token as `YTM_GIT_TOKEN` (env only,
  scrubbed from errors, masked in pod reads); the script sends it as a one-shot `http.extraheader` to github.com only, unsets it
  after the clones and refuses `.ready` if the token or its header form appears under the runtime folder. Session pods never get it.
- **Sessions.** `runtimeId` on a request: absent = the active runtime, `null` = the image's built-in ComfyUI. A runtime without
  `.ready` is refused (`media_runtime_not_ready`) before the row, and again at approve before the pod. The pod's env gets
  `YTM_RUNTIME_ID` next to its own `COMFY_TOKEN` and nothing else; `pod-start.sh` then runs that runtime's ComfyUI with its venv and
  refuses to fall back to the built-in one. Schema v97 adds `media_sessions.runtime_id` and `comfy_version` (from
  `/system_stats` `system.comfyui_version` at ready).
- **Test** (`runtime-tests.ts`, advanced by the watch loop). Build if needed → a GPU session on the runtime (the Operator's through
  its factory limits, the owner's approved as the owner) with `maxUsd = runtimeTestMaxUsd` and `maxMinutes = min(15, floor(cap × 60 /
  price))`, at least 3 → `/object_info` (`getNodeTypes`, names only) and `/system_stats` → each template's `class_type` values against
  the list → the session stopped → `test.json`. A held session fails the test and is withdrawn.
- **Listing (FO-MSG-0019 fix).** `listRuntimes` reads only the folders under `ytm/runtimes/` (S3 ListObjectsV2 with delimiter `/`,
  `listFolders`, checked on RunPod 2026-10-18: 161 ms). It then reads each profile file and never lists the ~20 000 files of a venv;
  the old full listing timed out.
- **Activation.** `setActiveRuntime` (core) needs status `tested`; the Operator also needs `factoryMayActivateRuntime`. A plain
  settings save that changes `activeRuntimeId` is refused, while the sync applies a peer's value directly. Rollback is activating
  the previous id or `null`.
- **Pre-pod refusal.** `media_runtime_incompatible` (with the missing node types) at a factory start with `templateId` and at job
  create / validate, against the runtime's tested node list; an untested runtime and the built-in one are not checked. The graph's
  `class_type` values are the requirement; a separate `requiredNodes` field was not added (it would say nothing the API-format
  graph does not, and a strict registry schema would mark such files invalid on a build without it).
- **Input check (BL-201, FO-REQ-0030).** The first real job on `comfy-0410-flux3` failed at `/prompt`: ComfyUI 0.41.0 made
  `ImageScaleToTotalPixels.resolution_steps` required, and the node-presence test had passed.
  - The test now reads the whole `/object_info` and checks each graph statically (`runtime-graph-check.ts`):
    - a required input not set by value, link or parameter;
    - a list value not allowed;
    - an INT / FLOAT out of range or of the wrong type, or a non-boolean BOOLEAN;
    - an undeclared input, as a warning.
  - Linked, parameter-filled and file-list inputs are not value-checked.
  - `templateRuntimeProblems` / `runtimeIncompatibleError` (`runtimes.ts`) are the single check used by both the job create and
    the factory start, per template version.
- **Stuck container (BL-202, FO-REQ-0031, schema v98).** In the start loop (`sessions.ts`), a placed pod whose container reports no
  uptime within `containerStartMinutes` (shared setting, default 3) of placement is terminated at that limit. The attempt is logged
  `container_stuck` (with RunPod's `machineId` when the answer has one), and the session is placed again (`{ replace }`, as a
  BL-155 incompatible host) up to `containerStuckRetries` (default 1); after that the start fails with `media_container_stuck`.
  - The 8-min start budget still counts from placement (unchanged). A slow but healthy host can need more than the limit; the
    owner raises `containerStartMinutes` (≤ 7, below the budget) or the retries, and the refusal says so.
  - Counted apart: stuck re-placements (`containerStuckRetries`) and incompatible-host ones (`MAX_EXTRA_PLACEMENTS`). A re-placement
    that then finds no capacity fails with the code of what caused it.
  - The request's separate `container_running` stage is folded into `comfy_booting` (the container is up and ComfyUI boots). A
    terminal session keeps its last stage, which shows where a failed start stopped.
  - A build whose container was once seen running (`containerStartedAt`) is never judged stuck afterwards.
  - The row carries `start_stage` / `stage_since` (placed → pulling_image → comfy_booting → ready), and the `placed` capacity
    entry gets `container_seconds` / `boot_seconds` once ready.
  - Runtime build pods use the same limit and retry count (`runtime-builds.ts`).
  - RunPod's REST API cannot exclude a machine, so "avoid a bad host" (request item 3) is not done; a retry may land anywhere.
- **Not done.** Our own Docker image; pruning old runtimes from the volume (RISK-132); running a template's job in the test.

