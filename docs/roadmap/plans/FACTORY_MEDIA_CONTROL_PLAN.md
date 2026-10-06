# Factory Operator control of media models, storage, templates and job inputs — plan

**Status: ACCEPTED by the owner 2026-10-06 (relayed in FO-MSG-0006, "Принимаю"); O1–O5 answered (§5a). IMPLEMENTED (slices M1–M5 + docs) on `feature/factory-media-control`; ADR 0025; not merged; live RunPod checks pending the owner's go-ahead (§7).** Backlog item: BL-132. Branch for the implementation:
`feature/factory-media-control` (all slices on one branch, one merge-approval request, `AGENTS.md` §K.1/§K.2). Safety-critical per §L:
it gives an agent token actions that cost money and delete data, so the full §A reading list applies.

**Sources.**
- `FO-REQ-0003`: Factory Operator, approved by the owner 2026-10-06.
- My answers to its §0: `DEV-RESP-0005`.
- Owner decisions relayed in `FO-MSG-0005` (owner, Telegram, 2026-10-06):
  - **D1 direct:** model pull, model delete and template add/replace/delete requested by the Factory Operator run without a second approval in the Web UI. Everything stays visible in the Web UI with who requested it, and the owner can cancel or undo. A model a current template references cannot be deleted. A pull that collides with sessions follows the existing lock rules.
  - **D2:** Hugging Face only (`repo` + `file` + optional `revision`), with a **mandatory SHA-256**. A mismatch deletes the file and fails the pull.
  - **D3:** the templates are identical on every device. The factory registry (files in `factory_shared`, synced by Syncthing) is the source. Replacing a template removes the old one.
  - **D4:** tests run on behalf of Tropico Jazz through the channel endpoint with owner-approved sessions. No factory session for now.
  - **D5:** jobs take input media (reference image, start frame, audio) declared as template parameters, and inputs are cleaned up like outputs.

## 1. What exists today (`dev` at `9ecbe0f`)

- **One RunPod network volume** (global setting `networkVolumeId`) is mounted at `/workspace` by every GPU pod. Models live under `models/<folder>/`. RunPod reports the volume's `sizeGb` and `usedSizeGb`.
- **Model pulls** (`src/lib/media-generation/models.ts`):
  - a CPU pod runs `hf download repo file` straight into `models/<folder>/`;
  - the pull counts as done when the S3 key exists with a size above 0. There is **no hash check**;
  - only one pull runs at a time, and the pull holds the volume EXCLUSIVELY (`media_volume_lock`, AC-P14-18/23). It is refused with `media_session_conflict` while sessions hold the volume;
  - pull records are a JSON list in `app_settings` holding the last 20 entries;
  - the only surfaces are the Web Production → Models panel and the operator CLI.
- **Templates** (`media_workflow_templates`):
  - device-local rows with a random UUID id and a version that is bumped automatically;
  - imported by the operator (Web/CLI);
  - channel agents only list them.
- **Inputs:** ComfyUI reads `/workspace/exchange/in/`. Nothing uploads there except the operator CLI's generic `s3-put`. The janitor never touches `exchange/in/`.
- **Factory endpoint** (`/api/mcp/factory`, ADR 0022): four READ tools. ADR 0022 also says the logical-path registry "never opens, lists or reads inside a path".
- **Gateways:** `src/lib/media-gateway/` is the only module that reaches RunPod (REST, S3, ComfyUI proxy), behind one "Media gateway" toggle. The S3 client has `putObject(key, Uint8Array | string)`, which buffers the whole body; there is no streaming upload.

## 2. Design

### 2.1 Model pulls with mandatory SHA-256 (D2)

- **Input:**
  - `{ repoId, file, revision?, folder, sha256 }`;
  - `sha256` is 64 hex characters and required for the factory;
  - in the Web form, `sha256` defaults to the hash Hugging Face declares for the file (see the pre-check), so every pull, owner or factory, is verified.
- **Pre-check before any pod (no cost):**
  - a new gateway child `src/lib/media-gateway/huggingface.ts` (the single-gateway rule: a new external API gets its own child under the gateway, behind the same "Media gateway" toggle, with its own traffic counter) reads the Hub's file metadata for `repo@revision` (`paths-info`): size and LFS `sha256`;
  - the Hub declares a SHA-256 only for LFS files. Model files are LFS; a non-LFS file (no declared hash) skips the pre-check comparison and relies on the on-pod hash alone;
  - the pull is refused at once if:
    - the file does not exist;
    - the repo is gated or private (no HF token in this phase);
    - the declared hash differs from the requested one (`media_model_hash_mismatch`);
    - the size exceeds the volume's free space (`media_volume_full`, size and free space in the details);
  - the answer carries the size and the storage cost per month ($0.07 × GB).
- **On the pod:**
  - the file is downloaded into a staging folder **outside `models/` and `exchange/`**: `/workspace/ytm-staging/<pullId>/`;
  - the pod runs `sha256sum` on it;
    - on a match, the file is **moved** (same volume, a rename) to `models/<folder>/<name>`;
    - otherwise it is deleted;
  - in both cases the staging folder is removed (`trap … EXIT`), and the pod then writes a result object `ytm-pulls/<pullId>.json` = `{ ok, sha256, bytes }`;
  - the file is never visible under its final key unverified.
- **On the server:**
  - the watch loop reads the result object through the S3 gateway;
  - `ok` with a matching hash and size → `done`;
  - otherwise → `failed` with `hash mismatch` (nothing is left in `models/`);
  - the result object is deleted after it is read;
  - a pull past its cap is terminated as today, and its staging folder is removed by the pull sweep (`ytm-staging/<pullId>/` of terminal pulls only).
- **Lock:**
  - **refuse**, never queue: `media_session_conflict` with the active session count when sessions hold the volume, unchanged (AC-P14-18/23);
  - one pull at a time, unchanged;
  - an existing final key is refused, unchanged.
- **Pull records** move from the `app_settings` JSON list into a table `media_model_pulls`. Fields: `pull_id`, `repo_id`, `file`, `revision`, `folder`, `expected_key`, `expected_sha256`, `actual_sha256`, `bytes`, `status`, `requested_by` (`owner` | `factory`), `pod_id`, `started_at`, `finished_at`, `error`. The table is append-only and kept (the audit needs more than 20 entries). The migration carries the existing JSON entries over.

### 2.2 Storage status, model list, deletion guard (FO-REQ-0003 §1, §3)

- **Storage status:** `{ volumeId, dataCenterId, sizeGb, usedGb, freeGb, monthlyUsd }` from RunPod (`freeGb = sizeGb − usedGb`; `monthlyUsd = sizeGb × 0.07`, since RunPod bills the rented size).
- **Model list:**
  - the existing S3 listing of `models/` (`.cache/` and `ytm-staging/` excluded), plus `sha256` when a pull record on this device has it (otherwise `null`: the hash of an old file is not recomputed);
  - plus `usedBy`: the registry templates (§2.3) whose declared model list contains this file.
- **Deletion:**
  - the guard reads the registry index (§2.3), which is identical on every device, not this device's rows;
  - **Factory tool:** refused with `media_model_in_use` (listing the template ids) when any current registry template declares the file; registry not configured or unreadable on this device → **refused** (fail closed);
  - **Owner (Web):** shown the same check first: `usedBy`, or "registry not configured — cannot check"; the owner may still delete after confirming. The owner is never locked out of their own storage;
  - for both, refused while sessions or a pull hold the volume (a running job may be reading the file).
- **No undo for a deleted model** except pulling it again. The plan says this plainly; the Web UI shows it before the owner deletes.

### 2.3 Template registry (D3)

- **Location:** a new logical path **`media_templates`** (audience `factory_only`), set on each device in Settings to the folder inside `factory_shared` the factory chooses.
  - This is the only place where YT Manager reads inside a logical path. It needs an ADR 0022 amendment (in ADR 0025): only the paths named here, read only by the sync, never followed outside the folder (realpath containment, regular files only, size limit per file).
- **Files:**
  - `index.json` = `{ schema: "ytm.media-template-index", schemaVersion: 1, templates: [{ templateId, version }] }`;
  - one file per template, `<templateId>.v<version>.json` = `{ schema: "ytm.media-template", schemaVersion: 1, templateId, version, name, description, workflow, parameters, models: [{ folder, file, sha256 }] }`;
  - `templateId` matches `^[a-z0-9][a-z0-9-]{1,62}$` and is the id channel agents use, **identical on every device** (no random UUID for factory templates);
  - `version` is a positive integer set by the factory.
- **Sync** (one function, `syncTemplatesFromRegistry`):
  - reads `index.json`;
  - for every listed `{ templateId, version }`, takes the matching file;
  - **validates** it with the existing template rules (graph shape, parameter targets, defaults, no `filename_prefix` parameter), plus the declared models: every literal model name in a known loader node (`CheckpointLoaderSimple.ckpt_name`, `UNETLoader.unet_name`, `VAELoader.vae_name`, `CLIPLoader`/`DualCLIPLoader` `clip_name*`, `LoraLoader.lora_name`, …) and every enum value of a parameter targeting one must be in `models`. A mismatch makes the template invalid. Only known loader class types are checked: for a custom loader (GGUF etc.) the declared `models` list is the factory's responsibility, and the deletion guard is only as good as that list;
  - **installs or replaces** the row `source: "factory"`. Replacing keeps one row per `templateId`, since only the current version is kept; jobs keep their recorded `templateVersion`;
  - **removes** factory rows whose id is no longer in the index.
- **Safety rules:**
  - **lower version than installed** → refused and reported (a stale Syncthing copy never rolls back);
  - **same version, different content** → refused (the factory must bump the version);
  - **index missing or unreadable**, or the folder not configured or not mounted → **no change at all** (an unmounted drive never deletes every template);
  - a listed file that has not arrived yet (Syncthing still copying) → that template stays as installed and is reported `pending`;
  - an invalid file → that template stays as installed and is reported `invalid` with the reason.
- **Triggers:**
  - (a) at server start and then every 60 s, if the content hash of `index.json` and the listed files changed (cheap local reads);
  - (b) the factory MCP tool;
  - (c) a Web button "Sync templates" in Production → Templates.
  - The last result is kept and shown: `{ at, trigger, installed[], updated[], removed[], pending[], invalid[] }`.
  - See open point O1 for an explicit-only alternative.
- **Factory rows are read-only** in the Web UI and CLI (no edit or delete there); the registry is their source. Owner-imported templates (`source: "owner"`) keep working as today, labelled local. Sync never touches them (O3).
- **Schema:** `media_workflow_templates` gets `source` (default `owner`), `registry_sha256` and `installed_at` (additive migration). The audit (§2.5) records each install, update and removal.

### 2.4 Job input media (D5)

- **Template parameters** gain input types `image`, `audio`, `video`, with optional `accept` (extensions) and `maxBytes`. The parameter still targets `nodeId` / `input`, for example `LoadImage.image`.
- **The job value** is a path **relative to the channel workspace's `99 Data Exchange/Sent to YTM/` folder** (the Factory Schema's buffer toward YT Manager).
  - `createJob` resolves it with the shared `src/lib/workspace-exchange/` module: realpath containment inside that folder, a regular file, an allowed extension, size ≤ `maxBytes` (default 500 MB).
  - Inputs from the factory workspace are **out of scope** while no factory session exists (D4).
- **Upload:**
  - before `POST /prompt`, each input is uploaded through the S3 gateway to `exchange/in/<jobId>/<param>-<basename>`;
  - this needs a **streaming `putObject`** in the gateway (files up to 500 MB are never buffered in memory). The SigV4 signing is hand-written (ADR 0023): either `UNSIGNED-PAYLOAD`, if RunPod's S3 accepts it (to verify live), or two passes: hash the file for `x-amz-content-sha256`, then stream the body;
  - the graph input is set to `<jobId>/<param>-<basename>` (a path relative to ComfyUI's input folder);
  - an upload failure fails the job before any GPU work (`media_input_unavailable`).
- **Must be verified live before anything depends on it:** the streaming upload above, and that `LoadImage` / `LoadAudio` / the video loaders accept a subfolder-relative name. This is a slice-0-style check against a real pod. If it fails, the fallback is a flat unique file name `<jobId>-<param>-<basename>`.
- **Cleanup:**
  - inputs are recorded in a ledger `media_exchange_inputs(job_id, remote_key, bytes, sha256, uploaded_at, deleted_at)`;
  - the janitor deletes `exchange/in/<jobId>/…` of **terminal** jobs **by ledger only** (anything else in `exchange/in/` is still never touched).
- **The source file in `Sent to YTM` is not deleted** by YT Manager (§F data preservation). O2 asks the owner.
- **Agent API 3.4.0 → 3.5.0 (MINOR, additive):** `agent_list_media_templates` shows the new parameter types; `agent_create_media_job` accepts their values; `agent_get_media_job` lists `inputs[]`; a new error code.

### 2.5 Audit and the Web UI

- A table **`media_control_events`** records every model pull/cancel/delete and every template install/update/remove/sync: `{ at, actor: owner | factory | sync, action, subject, details }`. It is append-only and device-local.
- Production → Models and Templates show:
  - the storage status;
  - `usedBy`;
  - the source of each template;
  - the last sync result;
  - the event list with the actor;
  - **Cancel** for a running pull.
- "Undo" here means: cancel a running pull; for a removed template, the factory republishes it; for a deleted model, pull it again.

### 2.6 Factory endpoint tools (Factory API 1.0.0 → 1.1.0, additive)

| Tool | Class | What |
|---|---|---|
| `factory_media_storage_status` | READ | §2.2 storage status |
| `factory_media_list_models` | READ | §2.2 list with `bytes`, `sha256`, `usedBy` |
| `factory_media_pull_model` | WRITE | §2.1; answers `{ pull }` with size and monthly cost; refused while the volume is busy |
| `factory_media_get_pull` | READ | one pull or the recent list |
| `factory_media_cancel_pull` | WRITE | cancel a running pull |
| `factory_media_delete_model` | WRITE | §2.2 with the guard |
| `factory_media_list_templates` | READ | id, version, source, name, parameters, models, `modelsMissing` (declared but not on the volume), installed at |
| `factory_media_sync_templates` | WRITE | §2.3 sync now; `{ dryRun? }` returns what would change |

- `factory_get_capabilities` today reports the token's permissions as READ only; it will report READ and WRITE and list the new tools.
- Template add, replace and delete happen through the registry files plus sync. No tool takes a graph directly.
- The factory server keeps its closed allowlist. New names are added deliberately, each with its test. The import allowlist grows by `media-generation`, wired through injected deps from the route as today.
- The MCP master toggle, the "Media gateway" toggle, loopback, and per-call token re-verification all apply.
- The factory token gets no channel tool and no session/job tool (D4).
- **ADR 0025** records that the factory role is no longer read-only, the registry read exception, and D1 (no Web approval).

### 2.7 Risk added (`docs/TECHNICAL_DEBT.md`)

A leaked `ytom_fo_` token can now, with no approval:
- start CPU pods (small cost);
- fill the paid volume (up to its free space);
- delete unused models;
- change templates through the registry.

Mitigations:
- one pull at a time, free-space refusal, deletion guard, full audit, loopback only, token revocation;
- an optional daily pull cap (O4).

The same residual limit as RISK-105 applies: a process running as the same OS user can already read the token.

## 3. Slices (one branch, separate commits)

| Slice | Content |
|---|---|
| M1 | HF metadata gateway child; pull with `revision` + mandatory SHA-256 (pre-check, staging, on-pod hash, result object); `media_model_pulls` table + migration from JSON; `media_control_events`; Web pull form shows size, cost, hash. |
| M2 | Storage status, model list with `sha256`/`usedBy`, deletion guard (fail closed), Web Models panel. |
| M3 | Logical path `media_templates` (seed row); registry format; `syncTemplatesFromRegistry` with all §2.3 rules; template columns migration; periodic, Web and status; factory rows read-only. |
| M4 | Factory tools §2.6, Factory API 1.1.0, inventory tests (tool names, imports, no channel/session tools), ADR 0025, RISK entry. |
| M5 | Input media §2.4: streaming S3 put, parameter types, `Sent to YTM` resolution, upload, ledger, janitor, Agent API 3.5.0. Live check of the subfolder input name first. |
| M6 | Docs (`interfaces.md`, `AGENT_OPERATIONS_INTERFACE.md` §4q, factory contract, `AGENT_ISOLATION_SETUP.md`, `SYSTEM_MAP`, `ARCHITECTURE`), independent review, live smoke, merge request. |

**Live smoke needs paid RunPod calls** (a CPU pull of a small public file, and one GPU job with an input image). They are run only after the owner's explicit go-ahead for those calls (`AGENTS.md` §K.4).

## 4. Acceptance criteria (written before implementation, from FO-REQ-0003, FO-MSG-0005 and this plan)

| ID | Criterion |
|---|---|
| AC-FM-01 | A pull whose requested SHA-256 differs from the Hub's declared hash is refused before any pod is created; nothing is billed or written. |
| AC-FM-02 | A pull whose downloaded bytes hash differently from the expected value ends `failed` and leaves nothing under `models/` or `ytm-staging/`. A matching pull ends `done`, and the file appears in the model list with that `sha256`. |
| AC-FM-03 | During a pull, the final key never exists unverified: the file appears only after the hash matches (staging + rename). |
| AC-FM-04 | A pull while sessions hold the volume is refused with `media_session_conflict`, and the active count is in the details. A file larger than the free space is refused with `media_volume_full`. |
| AC-FM-05 | Storage status returns size, used, free and monthly cost. The model list excludes `.cache/` and `ytm-staging/`. |
| AC-FM-06 | A factory deletion of a model declared by a current registry template is refused with `media_model_in_use` naming the templates; with the registry not configured or unreadable, a factory deletion is refused. The owner's Web deletion shows the same check (or "cannot check") and proceeds only after confirmation. |
| AC-FM-07 | Sync installs a valid template under its registry `templateId` and version on any device. The same files on two app-data directories give identical ids, versions and parameters. |
| AC-FM-08 | Sync refuses a lower version and a same-version content change, and keeps the installed one. A missing or unreadable index changes nothing. A listed file not present yet is `pending`, and the installed version stays. |
| AC-FM-09 | A template removed from the index is removed from this device. Owner-imported templates are never touched by sync. |
| AC-FM-10 | A template whose loader nodes or parameter enums reference a model not in its declared `models` list is `invalid` and not installed. |
| AC-FM-11 | A job input path that escapes `Sent to YTM` (`..`, absolute, a symlink out), is not a regular file, has a wrong extension or is too large is refused before any upload or GPU work. |
| AC-FM-12 | A job with an input uploads it under `exchange/in/<jobId>-<param>-<name>` (§7) before the job row and the prompt exist, the graph input names it, and the janitor deletes it only after the job is terminal (or, for an input whose job row never appeared, after an hour) and only by ledger. An upload failure creates no job and deletes the inputs already uploaded. The source file in `Sent to YTM` is untouched. |
| AC-FM-13 | `factory_get_capabilities` reports the WRITE permission and the new tools. The factory server's tool list equals exactly the four existing tools plus §2.6. No session or job tool and no channel tool is reachable with a factory token. No `factory_*` tool appears in a channel session. |
| AC-FM-14 | Every pull, cancel, delete and template change appears in `media_control_events` with its actor (`owner`, `factory`, `sync`) and is shown in the Web UI. |
| AC-FM-15 | Factory API is `1.1.0` and Agent API is `3.5.0`. The full existing suite passes unchanged, and existing jobs, sessions and owner-imported templates behave as before. |

## 5. Open points for the owner

- **O1 — automatic sync.** Recommended: automatic (start + every 60 s on change), so a device with no factory agent running (for example Windows) stays identical. Alternative: explicit only (factory tool or Web button). Note that the folder is writable by anything with file access to it. That is the same OS-user trust limit as RISK-105, and a template only runs inside an owner-approved session.
- **O2 — `Sent to YTM` sources after upload.** Recommended: YT Manager does not delete them; the channel cleans its own buffer. If you want YT Manager to delete them after a successful upload, say so.
- **O3 — owner-imported templates and the current FLUX test template.** Recommended: keep the Web import as a "local" tool for you. They stay until the factory publishes a replacement, and you remove them yourself.
- **O4 — daily pull cap for the factory.** Recommended: none for now. Free space, one pull at a time and the audit are enough. Alternatively, N pulls or X GB per day.
- **O5 — input size cap.** Recommended: 500 MB per input with the streaming upload.

## 5a. Owner answers and additions (FO-MSG-0006, 2026-10-06)

- **O1** automatic sync: yes (start + every 60 s), plus the factory tool and the Web button.
- **O2** YT Manager never deletes inputs from `Sent to YTM`.
- **O3** owner-imported templates stay local; sync never touches them.
- **O4** no daily pull cap; the volume size is the limit.
- **O5** 500 MB per input.
- **Addition A1:** the deletion guard also covers **local** (owner-imported) templates. `usedBy` lists them, marked `local`. For a local template the models are the literal loader-node names found in its graph (§2.3's check), since it has no declared list.
- **Addition A2:** gated Hugging Face repos with the owner's HF token are a later follow-up (BL-134), not part of this build.
- **Registry folder:** `media_templates` = `<factory_shared>/media_templates/`, set by the owner per device; the factory creates the folder and `index.json`.

## 6. Out of scope

- Factory-side sessions and jobs; inputs from the factory workspace.
- Sources other than Hugging Face (Civitai etc.); gated or private HF repos (needs an HF token).
- Growing or creating the network volume from the factory.
- Template sync for owner-imported templates; channel-specific templates.
- Deleting files from `Sent to YTM` (unless O2 says so).
- Any operating instruction for the factory or channels (`AGENTS.md` §B).

## 7. Implementation notes and deviations (2026-10-06)

- **Pull records** stay the existing `app_settings` JSON list (now the last 100 finished + all running) instead of a new `media_model_pulls`
  table; the durable, append-only history the audit needs (AC-FM-14) is `media_control_events`. Reason: the pull list's atomic
  read-modify-write and its many review-round guarantees are kept unchanged.
- **Input names** are flat at the root of ComfyUI's input folder (`exchange/in/<jobId>-<param>-<name>`) instead of a per-job subfolder: a
  loader then needs no subfolder support at all (the fallback named in §2.4, taken up front).
- **Owner deletion** is never blocked by the guard on the server; the Web dialog shows `usedBy` (or "registry cannot be read") before the owner
  confirms. The factory path is enforced server-side.
- **Model usage** also counts the templates the registry lists but this device has not installed, so a model needed on another device is
  protected too; a local template's models are its known loader nodes' literal names, recorded at import (schema v61 `models_json`).
- **Still to verify live** (paid; only after the owner's go-ahead): the pull pod's `hf download --revision` + `sha256sum` + `mv` on
  `python:3.12-slim`; RunPod S3 accepting the streamed PUT with an explicit Content-Length; ComfyUI `LoadImage`/`LoadAudio` reading the flat
  input name.
- **After the independent review (2026-10-06):** inputs are uploaded before the job row exists (a long upload can no longer be failed by
  the resume pass's 5-minute grace for queued rows) and each upload counts as session activity; the uploader reads ONE descriptor opened
  with O_NOFOLLOW whose dev/inode must match the checked file and whose size must fit the parameter's `maxBytes`; the registry reader
  also reads from one O_NOFOLLOW descriptor and never quotes file content in errors; model usage counts a listed-but-unreadable
  template as "registry unavailable" (the factory deletion is refused) and never throws for the owner; the delete takes the volume lock
  before checking usage; a cancel after a verified verdict settles the pull as done; a verdict the volume contradicts fails at once; the
  60 s check's fingerprint includes this device's template rows.
