# GPU start fixes E + F + D (BL-208, FO-REQ-0035)

Source: DEV-RESP-0037 options E, F, D; the Operator's choice FO-MSG-0020 (2026-10-21), the owner's go (Operator Telegram 2138,
«ок, все кроме А»). Option A (second volume) is not part of this. H and the two live tests are separate, paid, and need the
owner's own confirmation in this chat first.

## E: a briefly empty catalog does not end a start

Today `startApproved` (`sessions.ts`) fails the session at once (`media_session_start_failed`, "No GPU candidate qualifies")
when every candidate was skipped, including when the only reasons came from RunPod's live stock (the GPU is missing from the
catalog, or the catalog does not list the volume's datacenter for it). On 19.10 that ended 5 starts in seconds, while the
catalog is known to be wrong both ways (pods were placed while it showed EU-RO-1 empty).

- Each skipped candidate gets a `kind`: `stock` (missing from the catalog; datacenter not listed) or `config` (VRAM under the
  minimum; price over the cap; no price under a cap).
- All skips `stock` (or a mix where no candidate is left and at least one skip is `stock`): the session goes to
  `waiting_capacity`, exactly as when every createPod got "could not be placed". The watcher retries every
  `capacityRetrySeconds` and re-reads the catalog; after `capacityWaitMinutes` it fails `media_no_capacity`, naming the reasons.
- All skips `config`: unchanged, fails at once (a wrong cap must not wait 30 min for nothing).
- An empty catalog (`[]`) is treated like an unreadable one (`null`): the candidates are tried as listed.
- Decision: wait-only, as FO-MSG-0020 asks. A stock-skipped candidate is not tried with createPod.

## D: skipped candidates named in the answer and the error

- Every skip reason names which bound applied: `(Settings cap $X/h)` or `(session cap $Y/h)`, `(Settings minimum N GB)` or
  `(session minimum N GB)`.
- `factory_media_start_session`'s answer carries `gpuSkipped: [{ gpuTypeId, kind, reason }]` from a catalog read made at start
  (before approval when the start returns earlier than the placement), or null when the catalog could not be read.
- The `waiting for capacity: …`, `media_no_capacity` and `media_session_start_failed` texts list the skipped candidates with
  their reasons, besides the createPod failures.

## F: snapshots at every CUDA minimum in use

- Minimums read per snapshot tick: the Settings minimum plus every installed template's `minCudaVersion`, non-null, without
  repeats, ascending (today 12.8 and 13.0). No minimum anywhere: one snapshot without a filter, as today.
- Schema v102: `media_gpu_availability_snapshots` gets the primary key `(at, min_cuda_version)`, `min_cuda_version` NOT NULL
  (`''` = no minimum). Existing rows are kept with their value.
- Each minimum is read and stored on its own: one minimum failing (empty catalog) does not drop the other's snapshot. The
  due check and the back-off look at the snapshots of each minimum separately.
- Every read (`list`, `summary`, `factory_media_get_gpu_stats`) is under one minimum: input `minCudaVersion`, default the
  Settings minimum. The answer echoes the minimum used and lists the minimums that have snapshots in the range.
- Factory API 1.28.0 (additive).

## I: the CUDA minimum as RunPod's `minCudaVersion` (added 2026-10-21, coordinator, same branch)

createPod sent `gpu.allowedCudaVersions` = our known versions ≥ the minimum (12.8 → 12.8/12.9/13.0). RunPod's v2 openapi (POST
/pods, `gpu`): "allowedCudaVersions … Matching is exact, so a version no machine reports yields a capacity error"; `gpu.minCudaVersion`
is the "lowest acceptable CUDA version for the host machine, as major.minor, compared numerically", mutually exclusive with a
non-empty `allowedCudaVersions` (400 if both). The live catalog shows hosts reporting only CUDA 13.2 (4090, L4, PRO 4500 in EU-RO-1),
which the exact list excluded -- read back as "could not be placed". Fix: a session pod sends `gpu: { id, count: 1, minCudaVersion }`
when a minimum is set, neither field without one. The host check after placement (BL-155) compares numerically and accepts 13.1/13.2.

## Acceptance (written before the code)

- **AC-SF-01 (E)** Catalog lists the 4090 without EU-RO-1 (volume in EU-RO-1), plan = [4090]: the session is `waiting_capacity`,
  not failed; no createPod was sent; its error names "not offered in EU-RO-1".
- **AC-SF-02 (E)** Same with an empty catalog `[]`: createPod is tried for the 4090 (as with an unreadable catalog).
- **AC-SF-03 (E)** Only price-cap skips (4090 at $0.69 under a $0.50 Settings cap): fails at once with
  `media_session_start_failed`, as before.
- **AC-SF-04 (E)** Waiting from AC-SF-01, the next round's catalog lists EU-RO-1: createPod is sent and the pod is placed.
- **AC-SF-05 (E)** Waiting from AC-SF-01 past `capacityWaitMinutes`: fails `media_no_capacity`, and the message names the
  datacenter reason.
- **AC-SF-06 (D)** A 5090 at $1.19 under a $1 Settings cap: the reason reads "$1.19/h is over the $1/h cap (Settings)"; with a
  session cap of $0.80 under a $2 Settings cap the reason names the session cap.
- **AC-SF-07 (D)** `factory_media_start_session` returns `gpuSkipped` with `kind` and reason for a skipped 5090.
- **AC-SF-08 (F)** Settings 12.8, templates 12.8 and 13.0: one tick reads the catalog twice (minCudaVersion 12.8 and 13.0) and
  stores two snapshots with the same `at`.
- **AC-SF-09 (F)** The 13.0 read returns no GPU: the 12.8 snapshot is stored; the tick reports the 13.0 failure; the next tick
  15 min later retries 13.0.
- **AC-SF-10 (F)** Summary over 4 ticks with both minimums: under `minCudaVersion: "12.8"` the snapshot count is 4 (not 8) and
  the stock counts come only from the 12.8 rows; without the input the Settings minimum is used and echoed.
- **AC-SF-11 (F)** v102 migration keeps the existing snapshot rows and their minimum; a second snapshot at the same `at` with a
  different minimum is stored, a repeat with the same minimum is not.
- **AC-SF-12 (I)** A 13.0 minimum: createPod's `gpu` is `{ id, count: 1, minCudaVersion: "13.0" }` with no `allowedCudaVersions`;
  no minimum: neither field is sent; a pod on a 13.2 host passes the 13.0 host check and runs.
