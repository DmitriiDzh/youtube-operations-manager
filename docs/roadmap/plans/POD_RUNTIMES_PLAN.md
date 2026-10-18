# BL-200 — Pod runtimes managed by the Operator over MCP (FO-REQ-0029); first use FLUX 3 Image Klein

**Assigned by** the owner, Telegram 2026-10-18:
- msg 3015: take FO-REQ-0029;
- msg 3018: answers A–Д, confirmed in msg 3020;
- msg 3022: the build runs on a CPU pod.

ADR 0043.

## Probe 1 (2026-10-18, paid, ~$0.18, RTX 4090 EU-RO-1, owner-approved Г)

- A ComfyUI checkout on the network volume runs against the image's torch 2.10.0+cu128 when it has:
  - its own venv created from the image's `/usr/bin/python3`;
  - a `.pth` file adding the image's dist-packages, so torch is never downloaded again.
- Current ComfyUI (0.41.0, commit `6607f36b`) has `ReferenceMultiLatent`, `Flux3LayoutPrompt`, `CreateBoundingBoxes` and CLIP type
  `flux3` (988 nodes).
- First build ≈ 9 min (pip ≈ 7 min); boot ≈ 50 s; second boot of the built runtime ≈ 30 s; ≈ 2.1 GB per runtime on the volume.

## Design

1. **A runtime profile** is one immutable JSON on the network volume: `ytm/runtimes/<runtimeId>/runtime.json`.
   - It holds `comfy: { repo, commit }`, `customNodes: [{ repo, commit }]`, `pip: ["name==version"]`, `createdAt` and
     `createdBy`.
   - The volume is the single store every computer already shares (the same RunPod volume, a shared setting), so no new sync
     family is needed.
   - Build and test results live beside it: `build.json` is written by the build pod, `test.json` by the app.
   - A profile is never edited; a change is a new profile.
2. **Sources (owner answer Б).**
   - Allow-list, by URL prefix, case-insensitive, HTTPS only: `github.com/comfyanonymous/`, `github.com/Comfy-Org/`,
     `github.com/kijai/`, `github.com/ltdrdata/`, `huggingface.co/`.
   - Every `commit` is exactly 40 hex characters. A ComfyUI `ref` (tag) is resolved to its commit through the new GitHub gateway
     child at create time, and only the commit is stored.
   - `pip` entries must be pinned `name==version`.
   - The owner edits the allow-list in Settings → Servers (a shared setting).
3. **Build on a CPU pod** (owner msg 3022).
   - The pod uses the same image as the GPU template (the venv points to the image's Python).
   - `ytm/runtime-build.sh <id>` clones ComfyUI and each node pack at their commits, then creates the venv and the `.pth` file.
   - It installs `requirements.txt` without torch / torchvision / torchaudio, the node packs' requirements filtered the same way,
     and the pinned pip extras.
   - A lock file stops two builds of one profile. The `.ready` marker is written last.
   - It writes `build.json` `{ ok, seconds, error }`. The app polls it like a model pull and terminates the pod.
   - A half-built directory never has `.ready`.
4. **Sessions on a runtime.**
   - `pod-start.sh` gets `YTM_RUNTIME_ID`. With `<id>/.ready` present it runs that runtime's ComfyUI with its venv; without
     `.ready` it refuses (no silent fallback to the image's ComfyUI).
   - It writes `ytm/logs/runtime-<podId>.json`, recording what it actually ran.
   - The app uploads the current pod-side scripts to the volume before a runtime build or session whenever their content
     differs.
   - `factory_media_start_session` takes `runtimeId?` and uses the active runtime by default. Null means the image's built-in
     ComfyUI, the behaviour before this change.
   - The session shows its `runtimeId` and the ComfyUI version from `/system_stats`.
5. **Test.** `factory_media_test_runtime` runs four steps:
   - build if not built;
   - a short GPU session on the runtime: boot, then `/object_info` and `/system_stats`, then release;
   - write `test.json` with the ComfyUI version, the node list and, per registry template, ok or the missing node types;
   - report cost and boot time.

   The cost cap is `runtimeTestMaxUsd`, default $0.5 (answer В). The GPU minutes are capped from it at the session's price.
6. **Active runtime.**
   - `activeRuntimeId` is a shared media setting.
   - `factory_media_set_active_runtime` needs a passed test. The Operator may do it while `factoryMayActivateRuntime` is on
     (default on, answer А). The owner can always do it in the UI.
   - Rollback means activating the previous profile, or `null` for the built-in.
7. **Refused before a pod starts.**
   - The node types a template needs are its graph's `class_type` values plus an optional `requiredNodes`.
   - A job or factory session on a runtime whose tested node list lacks one is refused with `media_runtime_incompatible`,
     listing the missing nodes.
   - The built-in runtime has no tested list, so it is not checked, as before.
8. **Audit.** Every create, build, test and activation goes to `media_control_events` (who, what, when) and shows in Media.

## Stages (one branch, one merge)

1. Profiles on the volume, the GitHub child, the create / list / get / list-releases tools, the three settings, audit.
2. The CPU build, the pod-side scripts and their upload, `runtimeId` on sessions, and the runtime and ComfyUI version on the
   session.
3. Test, activation and rollback, the pre-pod refusal, the template's optional `requiredNodes`, and the Servers UI.

## Acceptance criteria

Expected values are derived from the rules above.

- **AC-RT-01**: a profile with a node repo outside the allow-list, a commit that is not 40 hex characters, an unpinned pip entry,
  or an `http://` URL is refused with `validation_failed`, and nothing is written.
- **AC-RT-02**: a ComfyUI tag is resolved through GitHub to a 40-hex commit, and the stored `runtime.json` holds the commit.
  Profiles cannot be overwritten: the same id twice is refused.
- **AC-RT-03**: the build pod is a CPU pod with the GPU template's image and the command `runtime-build.sh <id>`.
  - `build.json` `ok` gives the status built; `ok: false` gives build_failed with the error.
  - The pod is terminated in both cases.
  - No `.ready` means not built.
- **AC-RT-04**: a session on a runtime passes `YTM_RUNTIME_ID` in env, never a secret. A runtime that is not built is refused
  before any pod starts.
- **AC-RT-05**: the test writes the per-template result. A template using a `class_type` absent from the node list is failed
  with that missing type.
- **AC-RT-06**:
  - set-active needs a passed test;
  - with `factoryMayActivateRuntime` off, the Operator's set-active is refused while the owner's still works;
  - rollback to the previous profile and to `null` both work.
- **AC-RT-07**: a job or factory session whose template needs a node the active runtime's tested list lacks is refused with
  `media_runtime_incompatible` (missing list) before any pod starts. On the built-in runtime nothing is checked.
- **AC-RT-08**: settings defaults are switch on, the five-prefix allow-list and $0.5. They are shared.
- **AC-RT-09**: the test's GPU minutes never exceed `runtimeTestMaxUsd` at the session's price.

## Not in scope

- Our own Docker image (not needed, probe 1).
- Pruning old runtimes from the volume (≈ 2.1 GB each). The owner deletes them with the Models-style delete later; listed as a
  RISK.
- Running a template's smoke job in the test: only node presence is checked.
