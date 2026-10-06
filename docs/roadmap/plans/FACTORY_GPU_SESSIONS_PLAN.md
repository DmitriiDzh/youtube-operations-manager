# Factory GPU sessions within owner limits, GPU fallback, capacity wait and log — plan

**Status: PLAN, awaiting the owner's acceptance and answers to O1–O5. Nothing implemented.** Backlog item: BL-133 (FO-REQ-0004,
approved as a request by the owner 2026-10-06). Branch for the implementation: `feature/factory-gpu-sessions` (one branch, one merge
approval). Safety-critical per `AGENTS.md` §L: an agent token starts paid GPU pods.

**Sources:** FO-REQ-0004; FD-0007 (factory selects and tests models); FO-MSG-0005 §4 (factory tests run on behalf of Tropico Jazz);
ADR 0023 with amendments 1–2; ADR 0025; research of 2026-10-06 (below).

## 1. What exists today (`dev` at `7650cb5`)

- **One GPU per device setting.** `gpuTypeId`, `cloudType` and `datacenterId` are copied into the session at request time, and approve
  refuses the request if they changed since. `createPod` sends one `gpu.id` and one datacenter.
- **RunPod REST v2 has no GPU list, priority or price cap** on create-pod. "No capacity" is HTTP 400 "This GPU and data center
  combination could not be placed", with no machine code (the same status as a rule violation). Today it simply fails the session
  (`media_session_start_failed`); there is no retry.
- **The GPU catalog gives** `memoryInGb`, the on-demand price per cloud (not per datacenter) and a per-datacenter `estimatedAvailability`
  string, but no stock count.
- **Limits.**
  - Request: an advisory estimate.
  - Approve (Web only): the daily cap including other sessions' remaining estimates, unchanged settings, the volume lock, and
    `maxConcurrentSessions`.
  - Watcher: minutes, per-session USD, daily cap, idle, `releaseWhenDone`.
  - No monthly cap; the "day" is the machine's local day, computed from session rows.
- **One network volume** (one datacenter) is assumed everywhere: the mount, S3 endpoint/region, pulls, janitor and volume lock.
- **The factory endpoint** has no session or job tool (D4).

## 2. Design

### 2.1 Factory limits (owner settings, Production → Setup → "Factory Operator limits")

- Settings: `factoryMaxUsdPerSession`, `factoryMaxMinutesPerSession`, `factoryMaxUsdPerDay` and `factoryMaxUsdPerMonth` (local
  calendar month), plus `factorySessionsEnabled` (master switch, **off by default**).
- These limits come on top of the device's existing limits (`maxUsdPerDay`, `maxConcurrentSessions`), which still apply to every session.
- **Spend counts:** a "factory" session is one whose `requestedBy` is `factory` (new value). Its spend counts in both the factory limits
  and the device limits.

### 2.2 Factory-started sessions

- **`factory_media_start_session` `{ channelId, maxMinutes?, maxUsd?, gpu?: { candidates, minVramGb?, maxPricePerHr? } | templateId?, releaseWhenDone? }`**
  - `channelId` is the channel whose workspace receives the outputs (D4: for now the owner names the test channel, e.g. Tropico Jazz).
    It must be a connected channel with a workspace on this device.
  - **Within every limit** (the session caps fit the factory per-session caps; today's and this month's factory spend plus this
    estimate fit; the device daily cap and concurrency fit): the session is approved by the factory itself (`approvedBy: factory`)
    and started at once.
  - **Above any limit:** it is created `pending` with the reason, and the owner approves it in the Web UI as today. The tool says
    which limit was hit.
- **`factory_media_stop_session` `{ sessionId }`** stops any session the factory started. The owner can stop any session as before.
- **Jobs in factory sessions:** `factory_media_create_job`, `factory_media_get_job` and `factory_media_cancel_job`, limited to sessions
  the factory started. They behave exactly like the channel tools (inputs from that channel's `Sent to YTM`, outputs and manifest into
  its `From YTM`), so the factory does not need a channel token (O1).
- **Approving/starting stays fenced** for channel agents and the CLI. The factory gets the start path only through
  `factory_media_start_session`, which approves only within the owner's limits. An inventory test pins this.

### 2.3 GPU fallback (per session request)

- **Candidates:** an ordered list of GPU type ids, an optional minimum VRAM and an optional `maxPricePerHr`.
  - Given in the request, or taken from a registry template's new optional field `gpu: { candidates, minVramGb, maxPricePerHr }`
    (ytm.media-template v1, additive).
  - Without a list, the device's single GPU setting is used (today's behaviour).
- **Start loop:**
  - Candidates are filtered by `memoryInGb ≥ minVramGb`, price ≤ `maxPricePerHr`, available in **the volume's datacenter** per the
    catalog, and the cloud type.
  - `createPod` is tried in order. A 400 "could not be placed" moves to the next candidate. Any other error ends the attempt as today:
    - 402: balance;
    - 403/422: a bad request;
    - 5xx: retried by the next round.
- **The session row records what it got** (`gpuTypeId`, `costPerHr` from the pod). The estimate and the limits are re-checked against the
  actual price **before** createPod: a candidate whose price would break a limit is skipped.

### 2.4 Waiting for capacity

- When every candidate is unplaceable, the session waits in a new status **`waiting_capacity`**.
  - It holds no pod, so it costs nothing.
  - It counts against `maxConcurrentSessions` and holds the volume shared, like `approved`.
- **Retries:** every `capacityRetrySeconds` (owner setting, default 120) up to `capacityWaitMinutes` (default 30).
- **Then:** it ends `failed` with the error `media_no_capacity` and the attempts in its details.
- **Who sees it:**
  - the requester through `get_session` (status, attempts, the next retry);
  - the owner in the sessions table;
  - the owner can cancel it.
- **Jobs:** the factory cannot create jobs before the session runs, so "jobs wait" means the factory waits on the session status. No
  job queue is added to YT Manager (O3).

### 2.5 Capacity log

- New table `media_capacity_attempts(at, session_id, datacenter_id, gpu_type_id, price_per_hr, result: placed|no_capacity|error, detail)`.
  - One row per createPod attempt, for every session (owner and factory).
  - Device-local; kept 90 days.
- **Read access:** the factory tool `factory_media_capacity_log { since?, gpuTypeId? }`, and a "Capacity" list in Production.

### 2.6 Versions, audit, risk

- Factory API 1.1.0 → **1.2.0**: start/stop session, create/get/cancel job and the capacity log join the closed list; the session and job
  tools are writes behind the device mutation gate. The agent API is unchanged.
- **Audit:** session start/stop by the factory, and every limit refusal, go into `media_control_events`.
- **Risk:** RISK-109 is extended. A leaked factory token can now spend GPU money without a click, bounded by the owner's factory limits
  (per session, day, month), the device's daily cap and concurrency, and the master switch (off by default).

## 3. Answers to FO-REQ-0004's questions

1. **Global Volumes (beta, 2026-09):**
   - What they are: region-independent, GPU pods only, object-backed and eventually consistent.
   - What they lack, which this app needs: atomic rename (our pull's verified move), file locking, the S3 API and any REST API field
     (UI creation only).
   - Per-GB price: not published as of 2026-10-06.
   - **Not supported now.** Re-evaluate when they reach GA with API support. They could then suit model weights only, never
     `exchange/`.
2. **Second network volume:**
   - Today everything assumes one volume.
   - Adding one needs: a volume registry, a per-volume S3 client and lock, sessions recording their volume, pulls/janitor/storage per
     volume, and duplicated models (RunPod volumes do not sync; a pod with both volumes would copy them).
   - **Recommended order:** ship the fallback and the capacity log first, then decide with real data from the log.
   - If a second volume is needed, copy models through a pod (fast, same network) rather than re-downloading from Hugging Face, and
     re-check the copy against the recorded SHA-256.
3. **Custom nodes:**
   - The template uses `runpod/comfyui:1.4.0-comfyuiv0.35.0-cuda12.8`, started by our `pod-start.sh` from the image's baked ComfyUI
     (`/opt/comfyui-baked`).
   - The image ships ComfyUI-Manager, ComfyUI-KJNodes, Civicomfy and ComfyUI-RunpodDirect.
   - Nothing installs extra nodes today, and ComfyUI-Manager installs would not persist (container disk).
   - **Options:**
     - (a) pinned node repos stored on the volume, linked into `custom_nodes` and their requirements installed at pod start (slower
       starts);
     - (b) our own image with the nodes baked in (reproducible, a template change per node set).
   - **Recommended:** (a) as a separate small request once the factory names the nodes it needs.

## 4. Acceptance criteria (from FO-REQ-0004 and this plan)

| ID | Criterion |
|---|---|
| AC-FG-01 | With `factorySessionsEnabled` and limits set, `factory_media_start_session` within every limit starts a pod with no owner click; `approvedBy` is `factory` and the session shows in the Web table with that origin. |
| AC-FG-02 | A start that would break any factory limit (per-session USD/minutes, factory day, factory month) or a device limit is created `pending` and names the limit; nothing is started. With the switch off, every factory start is `pending`. |
| AC-FG-03 | The factory can stop only sessions it started; the owner can stop every session. |
| AC-FG-04 | Given candidates [A, B, C] with A unplaceable (HTTP 400 "could not be placed"), the pod is created with B; the row records B and its price; the log has one `no_capacity` row for A and one `placed` row for B. A candidate under `minVramGb`, over `maxPricePerHr`, or not in the volume's datacenter is never tried. |
| AC-FG-05 | With no candidate placeable the session is `waiting_capacity`, retries every `capacityRetrySeconds`, and after `capacityWaitMinutes` ends `failed` with `media_no_capacity`; no pod existed in between; the owner can cancel it. |
| AC-FG-06 | A 402/403/422 is not treated as "no capacity": the attempt ends at once with that error. |
| AC-FG-07 | Factory job tools work only in factory-started sessions; inputs and outputs follow the channel named at start. |
| AC-FG-08 | No channel tool or CLI command can approve or start a session; the factory start path is the only new one and approves only within limits (inventory test). |
| AC-FG-09 | Every factory start/stop and limit refusal is audited with actor `factory`. |

## 5. Open points for the owner

- **O1:** factory job tools on the factory endpoint (recommended), or the factory drives jobs through a channel agent?
- **O2:** default limit values. Proposed, all owner-editable:
  - per session $2 and 60 min;
  - factory day $5;
  - factory month $50;
  - switch off until you set them.
- **O3:** no job queue in YT Manager; the factory waits on the session status. Recommended.
- **O4:** capacity wait 30 min with a retry every 2 min. Recommended.
- **O5:** fallback lists also for your own Web sessions (a global fallback list in Setup)? Recommended: yes, the same mechanism.

## 6. Out of scope

- A second network volume and Global Volumes (§3; decided later with capacity-log data).
- Custom nodes (§3; a separate request).
- Serverless.
- Changing RunPod datacenters automatically.
- Any operating instruction for the factory (`AGENTS.md` §B).
