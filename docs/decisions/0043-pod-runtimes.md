# 0043. Pod runtimes on the network volume, managed by the Operator

Status: Accepted

**Date:** 2026-10-18. **Assigned by** the owner (Telegram 2026-10-18, msgs 3015, 3018/3020, 3022) for FO-REQ-0029. Plan:
`docs/roadmap/plans/POD_RUNTIMES_PLAN.md`.

## Context

Sessions run ComfyUI baked into the third-party image `runpod/comfyui` (v0.35.0); its version changes only with the image tag.
New models need newer nodes (FLUX 3 Image Klein, 2026-10-15), and the Operator cannot change the pod's software. Probe 1 (paid,
~$0.18) showed that a current ComfyUI checkout on the network volume runs against the image's torch/CUDA, through a venv whose
`.pth` points at the image's dist-packages. It first builds in ≈ 9 min, then boots in ≈ 30–50 s.

## Decision

1. **A runtime profile** pins ComfyUI and custom-node packs to exact commits, plus pinned pip extras.
   - It is stored as one immutable `ytm/runtimes/<id>/runtime.json` on the shared network volume. Build and test results sit
     beside it.
   - Every computer already shares that volume, so profiles need no new sync family.
   - The active profile is a shared media setting. `null` is the image's built-in ComfyUI.
2. **Build with the GPU template's image** (owner msg 3022: on a CPU pod). **Amended 2026-10-18 (probe 2, owner msg 3035):** a `cpu3c` host never started the multi-GB CUDA image (45 min pulling); the build runs on the cheapest GPU of the owner's list in the volume's datacenter, which has the image cached. The GPU is not used; the cap is 30 min.
   - The venv refers to the image's Python, so the image must match.
   - A `.ready` marker is written last, under a per-profile lock.
   - The build does **not** take the network-volume lock (`volume-lock.ts`), a deliberate exception to that lock's "every writer
     takes it" rule. A build writes only `ytm/runtimes/<id>/`, which nothing reads before `.ready` exists. Taking the exclusive
     lock would block every GPU session for the ~9 min build, and would refuse a build while any session runs. Two builds of one
     profile are stopped by the app's job list and by the profile's own `.lock` file (it holds the pod id; after 2 h it counts as
     a dead build's).
   - A session on a profile without `.ready` is refused: it never silently falls back to the built-in ComfyUI.
3. **Sources (owner answer Б).**
   - Only HTTPS repos under an owner-set allow-list. The default is comfyanonymous, Comfy-Org, kijai and ltdrdata on GitHub,
     plus huggingface.co.
   - Commits are exactly 40 hex characters; tags are resolved to commits by a new GitHub gateway child at create time.
   - pip extras are pinned `name==version`.
4. **Accepted trade-off.** The pod runs the profile's code with the network volume mounted read-write: models and exchange files
   can be read and changed.
   - It never receives a RunPod key or any secret except the per-session proxy token (`COMFY_TOKEN`) and the runtime id.
   - The allow-list and pinned commits are the owner's control over what code that is.
5. **The Operator** may create and test profiles. It may also activate them while the owner's switch
   `factoryMayActivateRuntime` is on (default on, answer А). A test costs at most `runtimeTestMaxUsd` (default $0.5, answer В).
6. **Templates are checked before any pod starts.** A template needs the node types of its graph: the `class_type` values. No
   separate `requiredNodes` field is added; the plan's stage 3 explains why. A runtime whose tested node list lacks one refuses it with `media_runtime_incompatible`. The built-in runtime
   has no tested list and is not checked.

## Consequences

- Each profile takes ≈ 2.1 GB on the volume. Pruning is manual for now (RISK entry).
- An older build rejects a template file with the new optional field. The owner updates Mac and Windows together (answer Д).
- Factory API minor bump (new tools, `runtimeId` on start_session, `media_runtime_incompatible`).

## Amendment 1 — a GitHub read token for private repositories (BL-230, 2026-10-27)

**Assigned by** the owner, Telegram msg 3689, option A. Plan: `docs/roadmap/plans/PRIVATE_RUNTIME_REPOS_PLAN.md`.

- Decision 4's "never receives … any secret except `COMFY_TOKEN`" no longer holds for **build** pods: a build pod gets the
  owner's GitHub read token as `YTM_GIT_TOKEN` when the token is stored on this computer (device-secret slot `github`, ADR
  0042) and the profile names an `https://github.com/` repository. Session pods still get no token.
- The build script sends it only to github.com, as a one-shot `http.extraheader` on `git`'s own command, never in a URL, a remote
  or `.git/config`; it unsets the variable after the clones and refuses `.ready` when the token, or its header form, appears
  anywhere in the runtime folder.
- Decision 3: at creation every github.com source is checked on GitHub (`/commits/{ref}`), without a token first and with it only
  after a 404. A hidden repository with no token stored is `runtime_repo_private_needs_token`. The allow-list is unchanged.
- Accepted: the token lives in the build pod's env for the build's life (RISK-137), as `HF_TOKEN` does on the pull pod.
