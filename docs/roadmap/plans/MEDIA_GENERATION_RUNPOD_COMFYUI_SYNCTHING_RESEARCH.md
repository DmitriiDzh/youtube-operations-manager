# Research: remote media generation — RunPod + ComfyUI + Syncthing + YouTube Operations Manager (as of 2026-10-05)

**Requested by the owner (Telegram, msg 1471, 2026-10-05).** Goal of the future phase: a channel-managing
agent asks this product to run generation jobs (images, video, music) on RunPod/ComfyUI; the server keeps
only the models it needs, every output is pulled to the local machine (the one running this app) over
Syncthing, and is deleted from the server as soon as it is no longer needed there. Everything that can be
a script must be a script, so the agent and the operator run commands instead of typing procedures
(token economy for the agent).

**This is research and a proposal, not an assignment** (`docs/roadmap/FUTURE_PHASES.md` §9: planning only).
Nothing here authorizes real RunPod spend, a real pod, or a paid call (`AGENTS.md` §K.4). Prices and API
facts below were checked on 2026-10-05 against the vendors' own pages where linked; secondary sources are
marked. Several items are explicitly "verify in slice 0" because they depend on live behaviour that cannot be
read from docs.

Related prior work: `FUTURE_PHASES.md` §6b "Media Production Automation" (this is its first concrete piece),
§11 Phase 11 (channel workspace path), `docs/decisions/0021-agent-collection-requests.md` (agent requests,
human approves, cost estimated up front — the precedent this proposal copies), `src/lib/asset-catalog/`
(where generated files get registered), `docs/decisions/0008-cloud-connection.md` (pattern for a
device-local, encrypted, feature-owned credential).

---

## 0. Summary of conclusions

1. **Keep models on a RunPod network volume, never on a stopped pod.** Network volume: $0.07/GB/month
   (first TB). A *stopped* pod's volume disk costs $0.20/GB/month, a running one $0.10 — so "stop" is a
   trap; the pod must always be **terminated** when idle and recreated from a template on demand, with the
   same network volume attached ([network volumes](https://docs.runpod.io/storage/network-volumes),
   pricing confirmed by [several 2026 price summaries](https://hackceleration.com/labs/runpod-pricing)).
   150 GB of models ≈ $10.5/month flat; the GPU is billed per second only while a pod exists.
2. **Models reach the volume without a GPU.** RunPod's S3-compatible API gives direct read/write to a
   network volume with no pod running (`https://s3api-<DC>.runpod.io/`, AWS CLI/SDK, multipart over
   500 MB, max 4 TB) ([S3 API](https://docs.runpod.io/storage/s3-api)). A one-time "bootstrap the volume"
   script therefore costs only the storage, not GPU hours. Alternative for 50+ GB pulls: a cheap CPU pod
   attached to the volume downloading straight from Hugging Face (no local round trip).
3. **Transport of outputs: Syncthing works, with two constraints that shape the design.** A pod can
   expose a real TCP port (`ports: ["22000/tcp"]` → public IP + random external port, or a symmetrical
   port by requesting a number above 70000; Secure Cloud only has guaranteed public IPs)
   ([expose ports](https://docs.runpod.io/pods/configuration/expose-ports)); otherwise Syncthing falls
   back to public relays (slower, still works). Syncthing's identity and config must live on the network
   volume (`-home /workspace/.syncthing`), because the container disk is wiped on terminate — then the pod
   keeps the same device ID across recreations and the local side keeps trusting it. The exact
   external port changes per pod, so the local Syncthing's device address must be updated via its REST
   API each time a pod starts (`/rest/config/devices/<id>`, `addresses: ["tcp://IP:PORT"]`).
4. **"Take it and delete it there" = move the file out of the exchange folder locally.** With a
   `sendreceive` exchange folder on both sides, the app moves verified outputs from the exchange folder
   into its own inbox; Syncthing then propagates that deletion to the pod. A janitor over the S3 API
   deletes anything left in `exchange/` when no pod is alive. `ignoreDelete` is deliberately *not* used
   (Syncthing's own docs call it ill-considered; it leaves the folder permanently "out of sync").
5. **ComfyUI must never be exposed through the RunPod HTTP proxy without auth.** ComfyUI has no
   authentication; the proxy URL `https://<podId>-8188.proxy.runpod.net` is public to anyone who learns
   the pod id, and a March 2026 campaign hijacked 1,000+ exposed ComfyUI instances for crypto-mining
   ([CSA note](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-workload-exposure-cryptomining-20260408/)).
   Design: ComfyUI listens on `127.0.0.1`; a token-checking reverse proxy (Caddy) on the exposed port,
   token generated per pod by the start script and read by this app from the pod's env. SSH port
   forwarding is the alternative but needs a public IP pod (RunPod's `ssh.runpod.io` proxy has no port
   forwarding).
6. **Pod, not serverless, for this phase.** `runpod/worker-comfyui` (serverless) is cheaper for a few
   jobs a day (pay per execution second, images returned base64 or pushed to an S3 bucket), but it has no
   long-lived container for Syncthing and a cold start per job. The owner's design is pod-shaped; serverless
   is recorded as a later optimisation (D2).
7. **Approval granularity decides whether the agent can actually work.** Per-job human approval (as in
   ADR 0021) makes an iterative creative loop unusable. Proposal: a human approves a **generation session**
   (pod start) with a USD/time cap; inside an approved, running session the agent submits jobs freely;
   the session auto-terminates on idle or at the cap. This keeps "human approval for consequential
   operations" at the point where money starts flowing.
8. **The phase is a new feature module** (`AGENTS.md` §M): `src/lib/media-generation/` plus one gateway
   umbrella with three children (RunPod REST, ComfyUI HTTP, local Syncthing REST), following the
   `youtube-read-gateway` barrel/inventory-test pattern. If RunPod or Syncthing is down, nothing else in
   the app is affected.

---

## 1. Facts gathered

### 1.1 RunPod

| Topic | Fact | Source |
|---|---|---|
| API | REST at `https://rest.runpod.io/v1` (pods, network volumes, templates, endpoints); a v2 API at `api.runpod.io/v2` exists in parallel. Bearer API key; keys can be All / Restricted / Read-only (`rpa_` prefix). | [API overview](https://docs.runpod.io/api-reference/overview), [scoped keys](https://www.runpod.io/blog/scoped-api-keys-runpod) |
| Create pod | `POST /v1/pods` with `gpuTypeIds[]`, `imageName` or `templateId`, `ports` (`"8188/http"`, `"22000/tcp"`), `volumeInGb`/`volumeMountPath` (default `/workspace`), `networkVolumeId`, `env`, `cloudType` (`SECURE`/`COMMUNITY`), `dataCenterIds[]`, `interruptible` (spot), `supportPublicIp`, `containerDiskInGb`, `dockerStartCmd`. Response carries `id`, `publicIp`, `portMappings` (`{"22": 10341}`), `costPerHr`, `desiredStatus`. | [POST /pods](https://docs.runpod.io/api-reference/pods/POST/pods) |
| Pod lifecycle | Stop keeps the volume disk, status `EXITED`, storage billed at the doubled rate. Terminate deletes the pod and its local volume disk; an attached network volume is only detached. | [terminate](https://docs.runpod.io/api-reference-v2/pods/terminate-a-pod), [manage pods](https://docs.runpod.io/pods/manage-pods.md) |
| Network volume | Created in one datacenter; attaches at deploy time only (replaces `/workspace`); Secure Cloud only; moves with the volume between pods. `POST /v1/networkvolumes {dataCenterId, name, size}`. | [network volumes](https://docs.runpod.io/storage/network-volumes), [POST /networkvolumes](https://docs.runpod.io/api-reference/network-volumes/POST/networkvolumes) |
| S3 API | `https://s3api-<DC>.runpod.io/`, region = DC id, bucket = volume id, object key = file path. Separate "S3 API key" (access `user_…`, secret `rps_…`). Supports Get/Put/Delete/Copy/Head/List + multipart; **no** pre-signed URLs, no DeleteObjects, no bucket create. Single PUT < 500 MB, multipart above; max 4 TB. `ListObjects` slow above 10k files / 10 GB. Supported DCs include EU-RO-1, EU-CZ-1, EUR-IS-1, EUR-NO-1 and many US sites. | [S3 API](https://docs.runpod.io/storage/s3-api) |
| Storage prices | Network volume $0.07/GB/mo (≤1 TB), $0.05 beyond; high-performance tier $0.14. Pod volume/container disk $0.10/GB/mo running, $0.20 stopped. | docs + [hackceleration](https://hackceleration.com/labs/runpod-pricing), [spheron](https://www.spheron.network/blog/runpod-h100-pricing-2026/) (secondary — confirm in console) |
| GPU prices (secondary sources, 2026, per hour, per-second billing) | RTX 4090 24 GB: ~$0.34 community / ~$0.60–0.69 secure. RTX 5090 32 GB: ~$0.69–1.22. L40S 48 GB: ~$0.79–1.40. A100 80 GB: ~$1.19–2.10. H100 80 GB: ~$1.99–3.51. Sources disagree by tier and month. | [runpod pricing](https://www.runpod.io/gpu-cloud/pricing), [hivenet](https://www.hivenet.com/post/runpod-pricing-complete-guide-to-gpu-cloud-costs) |
| Ports | HTTP ports → `https://<podId>-<port>.proxy.runpod.net` (Cloudflare front; requests over ~100 s may be cut). TCP ports → public IP + random external port in `portMappings`; symmetrical by requesting a port ≥ 70000 (then `$RUNPOD_TCP_PORT_70000` inside the pod). | [expose ports](https://docs.runpod.io/pods/configuration/expose-ports), [proxy guide](https://www.runpod.io/blog/runpod-proxy-guide) |
| Templates | `POST /v1/templates` (image, disk sizes, `env`, `ports`, `dockerStartCmd`); a pod created from `templateId` inherits them. This is where the pod start script is fixed. | [POST /templates](https://docs.runpod.io/api-reference/templates/POST/templates.md) |
| Transfers without ports | `runpodctl send/receive` (one-time code, pre-installed in pods), SCP/rsync over the exposed SSH port, "cloud sync". | [transfer files](https://docs.runpod.io/pods/storage/transfer-files) |
| Official ComfyUI images | Pod template `runpod/comfyui` (ComfyUI + Manager + Jupyter); serverless `runpod/worker-comfyui` (`base`, `flux1-dev`, `flux1-schnell`, `sdxl`, `sd3` variants; `/run`, `/runsync`; images base64 or S3 upload via env; models from a network volume via `extra_model_paths.yaml`). | [worker-comfyui](https://github.com/runpod-workers/worker-comfyui), [serverless tutorial](https://docs.runpod.io/tutorials/serverless/comfyui) |

### 1.2 ComfyUI server API

| Route | Use | Source |
|---|---|---|
| `POST /prompt` `{prompt, client_id?, prompt_id?}` | Validate + enqueue an API-format workflow; returns `{prompt_id, number}` or `{error, node_errors}`. | [routes](https://docs.comfy.org/development/comfyui-server/comms_routes), [examples](https://docs.comfy.org/development/comfyui-server/api-examples) |
| `GET /history/{prompt_id}` | `{[id]: {outputs: {[nodeId]: {images: [{filename, subfolder, type}], …}}, status}}`. Audio/video save nodes add their own keys (`audio`, `gifs`/`images` for video) — verify per node in slice 0. | same |
| `GET /view?filename&subfolder&type` | Download an output (`type=output`). Not needed when Syncthing carries the files. | same |
| `POST /upload/image` (multipart `image`, `subfolder`, `overwrite`, `type`) | Push a reference image into `input/`. | same |
| `GET /queue`, `POST /interrupt`, `POST /free`, `GET /system_stats`, `GET /object_info`, `GET /models/{folder}` | Queue state, cancel, unload models, readiness probe, node schema, installed models. | same |
| `ws://…/ws?clientId=` | `executing` with `node: null` = done; `progress`, `execution_error`. Polling `/history` is enough and avoids long-lived connections through the proxy. | same |
| CLI flags that matter | `--listen 127.0.0.1`, `--output-directory /workspace/exchange`, `--extra-model-paths-config` (models on the volume), `--input-directory`. `filename_prefix` in Save nodes accepts subfolders (`<jobId>/img`), which is how outputs land in a per-job folder. | ComfyUI README / node docs (not re-verified today) |

### 1.3 Syncthing

| Topic | Fact | Source |
|---|---|---|
| REST auth | `X-API-Key` header (or Bearer); key in `config.xml` → `gui/apikey`, GUI default `127.0.0.1:8384`. | [REST](https://docs.syncthing.net/dev/rest.html) |
| Config | `GET/PUT/PATCH /rest/config/folders[/<id>]`, `/rest/config/devices[/<id>]`. Folder: `id`, `path`, `type` (`sendreceive`/`sendonly`/`receiveonly`), `devices[]`, `rescanIntervalS`, `fsWatcherEnabled`, `ignoreDelete`, `versioning`. Device: `deviceID`, `name`, `addresses` (`dynamic` or `tcp://ip:port`), `autoAcceptFolders`, `paused`. | [config](https://docs.syncthing.net/users/config.html), [forum: add via API](https://forum.syncthing.net/t/adding-folders-and-devices-via-rest-api/16991) |
| Progress | `GET /rest/db/completion?device=&folder=` → 0–100 incl. deletions; `GET /rest/events?since=&events=ItemFinished,FolderCompletion` long-poll; `POST /rest/db/scan?folder=` to force a rescan; `GET /rest/system/status` → own device ID; `/rest/system/connections` → whether the pod is connected directly or via relay. | [event API](https://man.archlinux.org/man/syncthing-event-api.7.en), [db/scan](https://docs.syncthing.net/rest/db-scan-post.html) |
| NAT | Listens on 22000 TCP+UDP; without an inbound port it uses global discovery + relays. Inside a container the listen address must be `tcp://0.0.0.0:22000`; the advertised port is wrong when RunPod maps it to another external port, hence the explicit `tcp://IP:PORT` device address on the local side. | [docker image](https://hub.docker.com/r/linuxserver/syncthing), [port guide](https://natchecker.com/blog/syncthing-port) |
| ignoreDelete | Exists as an advanced per-folder flag; the developers call it ill-considered, the folder shows permanently out of sync. Not used here. | [forum](https://forum.syncthing.net/t/ignore-deletes-done-right/18078) |
| In this app today | The app knows only a shared-folder *path* (`bootstrap_config.syncthingRootPath`, Settings → Sync) and never talks to Syncthing's REST API. Syncthing automation is new surface. | `src/lib/bootstrap-config/`, `src/components/sync-folder-settings.tsx` |

### 1.4 Models that ComfyUI runs natively in 2026 (for sizing the volume — not an editorial choice)

| Domain | Model | VRAM / size (approx.) | Licence note (verify before commercial use) |
|---|---|---|---|
| Image | FLUX.1 schnell / dev, SDXL, Z-Image, Qwen-Image | dev fp16 ~24 GB on disk, fp8 ~12 GB; 16–24 GB VRAM | FLUX.1 **dev** is non-commercial; **schnell** Apache-2.0 |
| Video | Wan 2.2 TI2V-5B (720p, 24 GB VRAM with offload) / A14B (27B total, ~80 GB VRAM) | 5B ~10 GB; 14B 28+ GB on disk | Apache-2.0 ([runpod guide](https://www.runpod.io/articles/guides/comfyui-wan-2-2), [vram guide](https://willitrunai.com/blog/wan-2-2-vram-requirements)) |
| Video+audio | LTX-2 (19B), native 4K/50 fps with synchronized audio, 12 GB VRAM fp8 / 24 GB bf16 | ~40 GB bf16 on disk | free commercial under $10M ARR ([comfy blog](https://blog.comfy.org/p/ltx-2-open-source-audio-video-ai)) |
| Music | ACE-Step 1.5 (native in ComfyUI since 2026-01) | < 4 GB VRAM, a few GB on disk; full song < 10 s on a 3090 | check model card ([comfy blog](https://blog.comfy.org/p/ace-step-15-is-now-available-in-comfyui), [docs](https://docs.comfy.org/tutorials/audio/ace-step/ace-step-v1-5)) |

A single 150–200 GB network volume covers one image family + one video family + ACE-Step + text
encoders/VAEs, i.e. $10–14/month. A 24 GB GPU (4090) runs everything except Wan 14B; a 5090/L40S/A100
widens the video options.

---

## 2. Proposed architecture

### 2.1 Modules (all new; nothing existing changes behaviour)

```
src/lib/media-gateway/            umbrella (barrel + inventory test, like youtube-read-gateway)
  runpod-api.ts                   rest.runpod.io: pods, network volumes, templates   (vendor API)
  runpod-s3.ts                    S3 API to the network volume (AWS SDK v3 or plain SigV4)
  comfyui-api.ts                  /prompt /history /queue /upload/image /system_stats /interrupt
  syncthing-api.ts                local 127.0.0.1:8384 REST: config, completion, events, scan
src/lib/media-generation/         feature module: contracts/schemas/services/adapters
  sessions                        pod lifecycle: approve → create → ready → idle-terminate
  jobs                            workflow template + params → prompt_id → outputs → inbox → asset
  exchange                        Syncthing folder/device management, completion, move-out, janitor
  workflow-templates              API-format workflow JSON with declared parameters (technical, no prompts)
  cost-ledger                     per-session seconds × costPerHr, per-day USD cap
scripts/media/                    operator/agent scripts (§4)
```

Credentials (RunPod API key, S3 key pair, Syncthing API key, per-pod ComfyUI token) live in a new
singleton table, encrypted with a feature-owned key `MEDIA_GENERATION_ENCRYPTION_KEY` (same AES-GCM
pattern as `cloud-connection`, deliberately a different key — ADR 0008's reasoning), device-local, never in
`SNAPSHOT_TRANSFERRED_TABLES`, never returned to an agent (`AGENT_OPERATIONS_INTERFACE.md` §8). Outbound
URLs go through the existing `endpoint-security` validator pattern (public HTTPS hosts only; the
Syncthing child is the one explicit loopback exception, because Syncthing *is* local).

### 2.2 Session lifecycle (the thing a human approves)

```
agent: agent_request_media_session {channelId, profile, maxMinutes, maxUsd}
  → pending (estimate shown: gpu costPerHr × maxMinutes, volume already paid)
human (Web, Media tab): Approve
  → create pod from template (network volume attached, ports 8189/http + 22000/tcp, env: COMFY_TOKEN, SYNC_FOLDER_ID)
  → wait: pod RUNNING, publicIp/portMappings known, GET /system_stats 200 through the token proxy
  → local Syncthing: PATCH device <podDeviceId> addresses=[tcp://ip:port]; ensure folder "media-exchange" shared
  → session RUNNING; agent may submit jobs
idle N minutes without jobs, or maxMinutes/maxUsd reached, or human Stop
  → wait for in-flight job + exchange completion (bounded) → terminate pod (never stop)
  → session DONE with seconds used and USD charged (from pod costPerHr), per-job outcomes
boot sweep: any session RUNNING at server start → check pod via API; terminate if alive; mark interrupted
```

The pod's Syncthing device ID is stable because its `-home` is on the volume: pairing is a one-time
operation (slice 0 script), only the address changes per pod.

### 2.3 Job lifecycle

```
agent_create_media_job {sessionId, templateId, params, references?: [assetId|inbox path]}
  → validate params against the template's declared parameter schema
  → upload references via /upload/image (small) or write them into exchange/<jobId>/in/ (Syncthing carries them up)
  → POST /prompt with Save-node filename_prefix = "<jobId>/<name>" (output dir = /workspace/exchange)
  → poll /history/{prompt_id} (every few seconds; proxy-safe) → outputs list
  → wait until every listed file exists locally in <syncthingRoot>/media-exchange/<jobId>/ and
     /rest/db/completion for the pod device reports 100% for the folder
  → move the folder to the inbox: <app-data>/media-generation/inbox/<channelId>/<jobId>/
     (the move deletes it from the exchange folder → Syncthing deletes it on the pod)
  → register each file in asset-catalog (referenceKind local_path, provenance = template id, params,
     model files, comfy version, pod id, seconds, USD)
  → job DONE; agent_get_media_job returns asset ids + local paths
```

Failure paths: `node_errors` at submit → job FAILED, no cost beyond the running session; execution error →
FAILED with the ComfyUI message; pod died mid-job → FAILED, session interrupted; files never arrived within
a bounded wait → job `transfer_timeout`, left in the exchange folder for retry, janitor never deletes
anything that belongs to a non-terminal job.

### 2.4 Why an inbox and not the Phase 11 channel workspace

Phase 11's safety posture is that this product never enumerates, reads or writes inside the channel
workspace path (`FUTURE_PHASES.md` §11). Writing outputs there would silently reverse that. The inbox is a
directory this feature owns under the app-data root; the agent, which has its own filesystem tools, moves
files from the inbox into its workspace itself if it wants them there. The asset-catalog entry keeps the
`local_path` either way. (Owner decision D4 below if the owner prefers to relax Phase 11 instead.)

### 2.5 Deletion on the server — the three cases

| Case | Mechanism |
|---|---|
| Job output pulled and verified | Move out of the local exchange folder → Syncthing propagates the delete to the pod; confirmed by `/rest/db/completion` for the pod device. |
| Reference still needed for a follow-up job | Stays in `exchange/<jobId>/in/`; the agent marks it kept (`keepUntil` or next job references it); the janitor skips it. |
| Pod terminated before propagation / orphaned files | Janitor (scheduled, and at session end) lists `exchange/` over the S3 API and deletes every path whose job is terminal and whose files are already in the inbox. Nothing outside `exchange/` is ever touched; `models/` is never listed by the janitor. |

Local disk: the inbox grows; the existing `retention` module pattern (Settings → retention) is the place
for an inbox retention rule later, out of this phase.

### 2.6 Agent surface (Agent API MINOR bump)

READ: `agent_list_media_templates`, `agent_get_media_session`, `agent_get_media_job`,
`agent_get_media_limits` (today's spend, cap, whether a session is running).
DRAFT (channel-bound, mutation-gated): `agent_request_media_session`, `agent_create_media_job`,
`agent_cancel_media_job` (own jobs only). Approve/stop a session: Web only, fenced by an inventory test
exactly like `market-research-request-approval-inventory.test.ts`.

What stays outside this repository (`AGENTS.md` §B): the prompts, the style guides, which workflow to use
for which channel. Workflow *templates* in the app are technical graphs with named parameters; prompt text
arrives as a job parameter and is stored only as provenance of that job.

---

## 3. Transport decision — Syncthing vs the S3 API vs runpodctl

| | Syncthing (owner's ask) | S3 API only | runpodctl / scp |
|---|---|---|---|
| Needs a running pod to download | yes | **no** (volume is reachable while terminated) | yes |
| Pod-side setup per pod | install binary from the volume, start with `-home` on the volume, 1 exposed TCP port (or relay) | none | none (pre-installed) / SSH port |
| Local setup | already running for device handoff; one new folder + one device | AWS SDK dependency, one key pair | manual codes; not scriptable for unattended runs |
| Push vs pull | push, resumable, block-hashed, fs-watcher | pull, must poll the listing | pull, interactive |
| Delete on server | by moving the file out locally (propagated) + janitor | explicit `DeleteObject` | manual |
| Large video files | fine (block transfer, resumable) | fine (multipart) | ok |
| Risk | relay-only speed when no public IP (Community Cloud); port churn per pod | `ListObjects` slow on large trees; no pre-signed URLs | not automatable |

**Recommendation:** Syncthing for job traffic (fits the owner's model, reuses the running local instance,
push-based so the app learns about completion through events) **and** the S3 API for the two things
Syncthing cannot do: putting models on the volume without a GPU, and cleaning `exchange/` when no pod is
alive. If slice 0 shows relay-only transfers to be too slow or port mapping too flaky, the fallback is to
switch the transport adapter to S3-pull without changing the job model — the `exchange` component is
written behind a transport interface for exactly that reason (same shape as `sync-gateway`'s transport
adapter).

---

## 4. Scripts (owner priority: scripts over manual procedures)

All under `scripts/media/`, POSIX shell + Node where JSON handling is needed, each with `--help`, each
idempotent, each reading secrets from env/`.env` (never arguments), each printing a one-line machine-
readable result at the end so an agent can parse it cheaply.

| Script | Runs where | Does |
|---|---|---|
| `volume-bootstrap.sh` | local | Create the network volume in the chosen DC if missing; create the S3 layout (`models/{checkpoints,diffusion_models,text_encoders,vae,loras,audio}`, `exchange/`, `syncthing/`); upload `extra_model_paths.yaml` and the pod start script. |
| `models-pull.sh models.manifest` | local → CPU pod | Start a CPU pod (`computeType: CPU`) with the volume, run `hf download` for every manifest line straight onto the volume, verify sha256, terminate the pod. For a single small file: `aws s3 cp` over the S3 API instead. |
| `pod-start.sh` (template `dockerStartCmd`) | pod | Start Syncthing from `/workspace/syncthing/` with `-home /workspace/.syncthing -gui-address 127.0.0.1:8384 -no-browser`; export `RUNPOD_TCP_PORT_*`; start ComfyUI `--listen 127.0.0.1 --port 8188 --output-directory /workspace/exchange --extra-model-paths-config …`; start Caddy on 8189 with `COMFY_TOKEN` bearer check → 8188. Logs to `/workspace/logs/`. |
| `session-start.sh --gpu "NVIDIA GeForce RTX 4090" --max-minutes 60` | local | Create the pod from the template with the volume; wait for RUNNING + `/system_stats`; print `podId`, `publicIp`, Syncthing port, ComfyUI URL; patch the local Syncthing device address. Used by the app's session service and by a human directly. |
| `session-stop.sh <podId>` | local | Wait for exchange completion (bounded), **terminate** (never stop), print seconds used and cost from `costPerHr`. |
| `syncthing-pair.sh` | local | One-time: read the pod's device ID from the volume (`/workspace/.syncthing` over S3), add the device and the `media-exchange` folder on the local Syncthing via REST; print the folder id and the local device ID to be placed on the pod side (also done once, via S3 into the pod's config). |
| `comfy-run.sh workflow.json --set 6.inputs.text="…" --wait` | local | Submit a workflow through the token proxy, poll `/history`, print the output list. Debug/manual tool; the app uses the gateway, not this script. |
| `exchange-janitor.sh [--dry-run]` | local | List `exchange/` over the S3 API, delete terminal-job leftovers; dry-run by default. |
| `status.sh` | local | One screen: pods alive (and their cost/h), volume size and monthly cost, Syncthing connection state (direct vs relay), inbox size. |

`scripts/macos` / `scripts/windows` wrappers follow the existing launcher pattern where a double-click
entry point is useful (`status`, `session-stop` as a panic button). Windows: the shell scripts need Git
Bash or WSL — stated in the script header, not hidden.

---

## 5. Costs for the owner's budget (illustrative; confirm current prices in the console)

| Item | Assumption | Monthly |
|---|---|---|
| Network volume | 150 GB × $0.07 | $10.50 |
| GPU, light use | 1 h/day RTX 4090 Secure at ~$0.69 | ~$21 |
| GPU, heavy use | 3 h/day RTX 5090/L40S at ~$1.00 | ~$90 |
| Idle pod left stopped by mistake | 100 GB volume disk × $0.20 | $20 (why the design never "stops") |
| Local disk | inbox of video outputs | 0 $, but grows — retention rule later |

Per-second billing means the idle-terminate timeout is the dominant cost lever; the estimate shown at
approval is `costPerHr × maxMinutes / 60` as an upper bound, in the same spirit as ADR 0021's "estimate =
upper bound".

---

## 6. Slices (one phase branch, several commits, in this order)

| # | Slice | Delivers | Needs app changes? |
|---|---|---|---|
| 0 | **Scripts + live spike** | `scripts/media/*` above; a real volume, a real pod, Syncthing paired, one image job end-to-end, measured: direct-vs-relay, transfer speed, cold start, cost. Resolves every "verify" below. | no |
| 1 | Gateways + settings | `media-gateway` children with inventory tests; encrypted credential store; Settings → Media sub-tab (keys, DC, volume id, template id, GPU profiles, caps, idle timeout). | yes |
| 2 | Sessions | session table + state machine, Web approve/stop with progress overlay, boot sweep, cost ledger. | yes |
| 3 | Jobs + exchange | workflow templates with parameter schemas, job table, ComfyUI submit/poll, Syncthing completion, move-to-inbox, asset-catalog registration, janitor. | yes |
| 4 | Agent surface | MCP tools above, Agent API bump, fencing inventory test, `AGENT_OPERATIONS_INTERFACE.md` section. | yes |
| 5 | Docs/ADR | ADR "remote media generation sessions", SYSTEM_MAP/ARCHITECTURE/interfaces, TECHNICAL_DEBT entries, ROADMAP_STATUS. | docs |

Slice 0 is deliberately first and deliberately code-free: it is cheap (a few dollars), it answers the
questions the docs cannot, and its scripts are useful on their own even if the owner stops there.

Acceptance criteria will be written per slice at assignment time from this document's requirements
(`AGENTS.md` §L), not after implementation. The ones that are fixed already:
- A session never ends with a pod in `EXITED` (stopped) state; after any terminal session state the pod
  is `TERMINATED` or absent (verified by the pods API, not by local state).
- No agent tool can approve, start or stop a session (inventory test over `src/mcp`, `src/lib/agent-operations`).
- A job's files are registered in `asset_catalog` only after they exist in the inbox and the pod-side
  copy is confirmed deleted or the pod is gone.
- The janitor never lists or deletes outside `exchange/`.
- No credential (RunPod key, S3 secret, Syncthing API key, ComfyUI token) appears in any agent response,
  log line, or snapshot.
- Disabling the feature (no credentials configured) changes nothing else in the app (`AGENTS.md` §M).

---

## 7. Things to verify in slice 0 (not derivable from docs)

1. Does a Secure Cloud pod reliably get a public IP + TCP mapping in the chosen DC, and how often is a
   Syncthing connection direct vs relayed? Relay throughput for a 300 MB video.
2. Does `runpod/comfyui` (or whichever image is chosen) honour `dockerStartCmd` for a custom start script,
   and does Syncthing's static binary run without root tricks in that image?
3. Whether a Restricted RunPod API key can be limited to pods + volumes (the docs describe per-endpoint
   restriction for serverless; pod-level granularity is not documented).
4. Exact `/history` output keys for `SaveAudio` (ACE-Step) and the video save nodes (LTX-2 / Wan).
5. Cold start: seconds from `POST /pods` to `/system_stats` 200, and first-job model load time from the
   network volume (network volume I/O is slower than local NVMe; the high-performance tier may be worth it
   for video models).
6. `filename_prefix` with a subfolder in every Save node type used.

---

## 8. Decisions needed from the owner before a plan is written

| ID | Question | Recommendation |
|---|---|---|
| D1 | Transport for job outputs: Syncthing (plus S3 for models and janitor), or S3-only? | Syncthing, per §3; S3-only as the fallback adapter if slice 0 measures poorly. |
| D2 | Pod sessions now; serverless `worker-comfyui` later? | Yes — pod now; record serverless as a future optimisation. |
| D3 | Approval granularity: per session with caps (agent free inside), or per job? | Per session with `maxMinutes`/`maxUsd` + idle auto-terminate; plus a per-day USD cap in Settings. |
| D4 | Outputs land in a feature-owned inbox (Phase 11 untouched) or directly in the channel workspace? | Inbox. |
| D5 | Initial datacenter, GPU profile(s), volume size and first model set (sizes the budget; licences for commercial use are the owner's call). | EU DC with S3 API (EU-RO-1 or EU-CZ-1), 4090/5090 profile, 150–200 GB, decide models with the operations side (outside this repo). |
| D6 | ComfyUI access: token reverse-proxy on an exposed HTTP port (recommended) or SSH tunnel? | Token proxy; simpler for scripts and for the app. |
| D7 | Who authors workflow templates: operator imports API-format JSON into the app; agent may only *use* them. | Operator imports; agent uses. Keeps prompts/editorial choices outside the repo. |
| D8 | Phase number and name for `FUTURE_PHASES.md` (next free is Phase 14), and whether slice 0 is assigned now. | "Phase 14 — Remote media generation (RunPod/ComfyUI)". |

Once D1–D4 and D8 are answered, the next step is a `PHASE_14_PLAN.md` with per-slice acceptance criteria,
a `FUTURE_PHASES.md` §16 entry, and a `BACKLOG.md` row — then slice 0 on its own feature branch.
