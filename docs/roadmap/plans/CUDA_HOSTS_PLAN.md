# Pods on hosts with a too-old CUDA driver (BL-155, FO-REQ-0007)

**Requested** by the Factory Operator in FO-REQ-0007 (2026-10-07). On 2026-10-07, session 557358b1 (RTX 4090, EU-RO-1) reached
`running`, but all 24 jobs failed with "CUDA driver version is insufficient for CUDA runtime version". The pod image
(`runpod/comfyui:…-cuda12.8`) needs a host driver that supports CUDA ≥ 12.8. **Assigned** by the owner in Telegram on
2026-10-08 (msg 2072).

## How it works today

- `startApproved` creates the pod with `gpu: { id, count: 1 }` only, so any host may be chosen. `CreatePodInput` already
  declares `gpu.allowedCudaVersions`, but nothing sets it.
- Readiness is "pod RUNNING, then `GET /system_stats` has `system` and `devices`". The device type and the host's CUDA are not
  checked. A readiness failure ends the session as failed. There is no second placement.
- A job's error is free text, with no code.
- Release-when-done always stops with "released after last job (1 min after the last job finished)", even when every job
  failed.

## RunPod facts (research 2026-10-08)

- `POST /pods` (v2, the shape the app uses): `gpu.allowedCudaVersions: string[]`. It is the same list as REST v1's top-level
  field. Known values are 11.8, 12.0–12.9 and 13.0. The value is the host driver's maximum supported CUDA. If no host matches,
  RunPod answers like "no capacity".
- After creation, GraphQL `pod { machine { machineSystem { cudaVersion } } }` gives the host's CUDA version.
- Sources: docs.runpod.io (POST /pods), graphql-spec.runpod.io, runpod-python `create_pod`.

## Design and acceptance criteria (written before the code)

- **AC-CU-01: minimum CUDA setting.**
  - Production → Setup gets `minCudaVersion` ("12.8" by default, matching the template image `…-cuda12.8`).
  - It is shared between computers (sync family `media-settings`).
  - An empty value means no create-pod filter and no host-version check (today's behaviour for placement); the CUDA-device
    check of AC-CU-02 always applies (review round 2).
  - Every pod creation then sends `gpu.allowedCudaVersions` = every known version ≥ the minimum.
  - A host without a matching driver is treated like no capacity: the fallback list, then waiting for capacity, as today.
- **AC-CU-02: host check before `running`.**
  - After the pod is RUNNING, the app reads the host's `cudaVersion` (GraphQL; only when a minimum is set). When
    `/system_stats` answers, it also requires a `cuda` device with VRAM > 0 -- always, with or without a minimum.
  - If the host's CUDA is below the minimum, or ComfyUI sees no CUDA device, the pod is terminated. The capacity log gets
    `result: error`, detail "CUDA driver too old: host 12.4 < 12.8" (or "no CUDA device"). The start then tries a new
    placement: the candidate list again, at most 2 extra placements per session.
  - When the placements run out, the session fails with code `media_gpu_host_incompatible`.
  - An unknown host CUDA version (the read failed) does not block.
- **AC-CU-03: failed sessions are recognisable.** With release-when-done, a session whose every job failed stops with
  `stopReason: "all jobs failed (release when done)"`. A mixed or successful one keeps today's text.
- **AC-CU-04: error code.**
  - A job whose error says the CUDA driver is too old carries `errorCode: "media_gpu_host_incompatible"` in the factory's
    job reads, derived from the error text, so nothing is stored.
  - Other failures carry no code.
  - The new `DomainErrorCode` gets its HTTP status and its `errors.*` words in every interface language.
- **Contract.** Factory API 1.7.0 (additive). MCP/API texts stay English.

No live RunPod call is part of development or the tests (fakes only). A live check of the filter needs the owner's go-ahead,
because it is a paid call.

## Slices (one branch `feature/cuda-hosts`)

1. Setting and the create-pod filter (AC-01).
2. Host check and re-placement (AC-02).
3. Stop reason and error code, then Factory API 1.7.0 and docs (AC-03, 04).
