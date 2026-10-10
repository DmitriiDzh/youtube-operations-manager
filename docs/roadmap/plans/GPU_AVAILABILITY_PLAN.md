# GPU availability by datacenter, its log, and moving the media volume (BL-172, FO-REQ-0016)

**Status: PROPOSED, waiting for the owner's go to build.** Owner, Telegram 2026-10-10 (msg 2501, «да, бери FO-REQ-0016»): plan first.
Reply to the Operator: DEV-RESP-0019.

## 1. Facts (code read and RunPod docs checked 2026-10-10; one live read-only catalog read)

- **YT Manager already reads RunPod's catalog.** The media gateway (`src/lib/media-gateway/runpod-api.ts`, REST v2) calls
  `GET /v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=…` and `GET /v2/catalog/datacenters`. The Web UI's Compute card shows them.
  No Factory tool exposes them.
- **What the catalog gives** (official v2 docs; GraphQL retires in early 2027, REST v1 on 2026-11-15):
  - Per GPU: `price.secure` (Secure on-demand USD/hr, per GPU type, **not per datacenter**), `memory`, `availability` (NONE | LOW |
    MEDIUM | HIGH) and `dataCenters: [{ id, availability }]`.
  - Also `cudaVersions: [{ version, available }]` for the GPU as a whole, not per datacenter. Filters `minCudaVersion=` / `cudaVersions=`
    restrict availability to hosts with that CUDA.
  - Per datacenter: `networkVolumeTypes` (empty = no network volume possible), region, country.
  - No threshold is published for what LOW/MEDIUM/HIGH mean. The docs warn that stock can change between a catalog read and a pod start.
- **Rate limits:** none are published. Responses carry `RateLimit` / `RateLimit-Policy` headers and a 429 with `Retry-After`. Two reads
  every 3 hours is negligible.
- **Live read, 2026-10-10 ~11:50 (UTC+3):**
  - 34 datacenters, 17 of them with network volumes: AP-JP-1, CA-MTL-1, CA-MTL-3, CA-MTL-4, EU-FR-1, EU-RO-1, EUR-IS-3, EUR-NO-1,
    EUR-NO-2, US-CA-2, US-CO-1, US-IL-1, US-MD-1, US-MO-1, US-NC-2, US-NE-1, US-TX-3.
  - Of these, CA-MTL-1, EU-FR-1, EUR-NO-2 and US-CA-2 offer only HIGH_PERFORMANCE volumes, and CA-MTL-4 both kinds.
  - In EU-RO-1 at that moment:

    | GPU | Stock |
    |---|---|
    | RTX 4090 | MEDIUM |
    | L4 | LOW |
    | RTX 5090 32 GB | LOW |
    | RTX PRO 4500 Blackwell 32 GB | HIGH |
    | RTX PRO 6000 Blackwell 96 GB | LOW |
    | B200 | LOW |
    | Any 48 GB card | none |

  - 48 GB cards elsewhere:
    - A40 HIGH in CA-MTL-1 and EU-SE-1;
    - L40S LOW in six datacenters, of which US-IL-1 has standard network volumes;
    - RTX A6000 LOW in EU-SE-1.

    EU-SE-1 has no network volume at all.
- **Moving a volume:**
  - A volume's datacenter is immutable. A pod mounts one network volume, in its own datacenter.
  - The S3 API has one endpoint per datacenter (`s3api-<dc>.runpod.io`), and server-side CopyObject is documented within a datacenter
    only.
  - No API moves or copies a volume.
- **The S3 API is the other condition.** YT Manager reaches the volume only over S3: pulls, storage status, the model list and the
  delete guard all go through it. RunPod documents S3 endpoints for 15 datacenters: EU-CZ-1, EU-RO-1, EUR-IS-1, EUR-NO-1, US-CA-2,
  US-GA-2, US-IL-1, US-KS-2, US-MD-1, US-MO-1, US-MO-2, US-NC-1, US-NC-2, US-NE-1, US-WA-1.
  - Crossed with the live list of datacenters with standard network volumes, the real candidates are **EU-RO-1, EUR-NO-1, US-IL-1,
    US-MD-1, US-MO-1, US-NC-2 and US-NE-1**.
  - The v2 catalog has no S3 field (GraphQL's `s3apiEnabled` retires in early 2027).
  - EU-CZ-1 has a documented S3 endpoint, but the catalog listed no network-volume type for it at the time of the read. The log shows
    whether that holds.
- **Global Volumes:** still beta, with no API, no atomic rename and no locking, so they are not usable for model weights (unchanged
  from DEV-RESP-0007).
- **In YT Manager:**
  - The volume and its datacenter are one setting pair, changed together and validated: the volume must be in that datacenter, the GPU
    offered there. The change is refused while a session, pull or operator pod holds the volume.
  - The S3 endpoint follows the datacenter.
  - The GPU candidate filter keeps only GPUs offered in the volume's datacenter.
  - A model pull checks the live volume over S3, not the pull records, so pulling the same files into a new empty volume works.
  - Creating or deleting a volume is operator-only (Web UI / CLI), never an agent tool (VOLUME_MIGRATION_PLAN boundary).

## 2. Design

### A. `factory_media_get_gpu_availability` (READ, live, no pod, no cost)

- **Input:** `{ gpuTypeIds?, dataCenterIds?, minVramGb?, minCudaVersion? }`.
  - Default: every GPU with VRAM ≥ the settings' `gpuMinVramGb` (24 when unset), Secure Cloud, `minCudaVersion` from Settings (12.8).
  - The name follows the factory read-tool rule (`factory_media_get…`).
- **Output:** `{ checkedAt, volumeDataCenterId, minCudaVersion, gpus: [GPU], dataCenters: [DC] }`.
  - `GPU = { gpuTypeId, displayName, vramGb, pricePerHr, stock, cudaAvailable, dataCenters: [{ dataCenterId, stock, networkVolume }] }`:
    - `pricePerHr`: Secure on-demand, the price a session is checked against;
    - `stock`: overall;
    - `cudaAvailable`: whether hosts with that CUDA have capacity now, for the GPU as a whole.
  - `DC = { dataCenterId, region, countryCode, networkVolumeTypes, s3Api }`.
  - `s3Api` comes from RunPod's documented S3 endpoint list, kept in the gateway next to the endpoint pattern; the catalog has no such
    field. The description says so, and that storage status confirms it once a volume exists there.
- Two live RunPod reads per call, through the media gateway and its switch. The key never appears.
- The description states the catalog's own caveats: stock can change before a pod start; there is no per-datacenter price; CUDA is
  known only per GPU.

### B. Availability log (stored)

- **When:** a snapshot every **3 hours** in the server process (a timer next to the media timers in `instrumentation.ts`; the Mac
  service runs continuously).
  - Only while the media gateway is on and RunPod is configured.
  - The first snapshot comes about 5 minutes after start, or when the last is 3 h old.
  - Two RunPod reads each, with the Settings' CUDA filter.
- **Stored** (`media_gpu_availability_log`, new schema version): one row per snapshot, GPU and datacenter for every GPU ≥ 24 GB and every
  datacenter with network volumes, with columns `at`, `gpu_type_id`, `data_center_id`, `stock`, `price_per_hr` and `min_cuda_version`.
  - A datacenter the catalog leaves out of a GPU's list is stored as NONE, so "how often was it at least LOW" counts real zeros.
  - Plus one overall row per GPU (`data_center_id` `*`).
  - Kept 90 days (pruned on insert, like the capacity log), device-local.
  - Estimate: 8 snapshots a day × about 35 GPUs × 18 rows ≈ 5,000 rows a day, about 450,000 rows over 90 days of a few short columns.
- **Per computer:** each computer keeps its own log (device-local, 16 reads a day each). Until the Windows computer is updated, the
  Mac's log is the one to read.
- **Read:** `factory_media_list_gpu_availability_log { since?, until?, gpuTypeId?, dataCenterId?, limit? }` returns the rows, newest
  first, at most 5,000 per call.
  - Optionally `summary: true` gives per GPU and datacenter the share of snapshots at each stock level in the range. That is a count of
    our own stored RunPod readings.
- Factory API 1.9.0 → **1.10.0** (two READ tools).

### C. Moving the media volume — the order (no new code needed)

| Step | Who | How |
|---|---|---|
| 0 | Operator / owner | Choose the datacenter from B's log. It must have STANDARD network volumes **and the S3 API** (today: EU-RO-1, EUR-NO-1, US-IL-1, US-MD-1, US-MO-1, US-NC-2, US-NE-1), and the needed GPUs must have stock there with CUDA ≥ 12.8. |
| 1 | Owner | Wait until no session, pull or operator pod runs (Production shows it; the settings change refuses otherwise). |
| 2 | Owner | Create the new volume (e.g. 150 GB) in that datacenter: Settings → RunPod → network volumes, or `npm run media -- volume-create`. Never an agent tool. |
| 3 | Owner | Settings → RunPod: set **datacenter and volume together** and save. The save checks that the volume is in that datacenter and the GPU is offered there. The S3 endpoint and the GPU candidates follow. Re-check the GPU fallback list for that datacenter. **Before any pull, open the storage status:** it must list the new volume over S3. If it does not, the datacenter cannot be used; switch back and delete the new volume. The other computer takes the same pair through settings sync. |
| 4 | Operator | Re-pull the model files with `factory_media_pull_model` and their recorded SHA-256 (the pull checks the new volume, so nothing is "already there"). Templates are account-level (`factory_media_sync_templates` is unchanged). |
| 5 | Operator | One test session per template that matters; `factory_media_storage_status` shows the new volume and datacenter; the capacity log records the new datacenter on each attempt. |
| 6 | Owner | Delete the old volume: Settings → RunPod → delete unused volume, which refuses the configured one. |

- **Why re-pull instead of copy:** a pod sees one network volume, S3 copies stay inside a datacenter, and the files come from Hugging
  Face with a known SHA-256 anyway. A copy through two pods and rsync over SSH, or an S3 download and upload through the Mac, is possible
  but slower and needs new code. The 8 files (about 46 GB) re-pull in well under an hour at RunPod's datacenter bandwidth (estimate).
- **Cost of the overlap:** both volumes bill while both exist ($0.07/GB-month standard): 150 GB for a day is about $0.35.
- **Waiting sessions:** a `waiting_capacity` session is failed when the datacenter changes, and a pending one is re-checked at approval
  (existing rules).

### Build order (when the go comes)

1. Add the CUDA parameter to the gateway's catalog read. Probe it live through a core method while the schema is still 80 on the branch
   and on the Mac:
   - the field names (`minCudaVersion`, `cudaVersions[]`);
   - whether the per-datacenter stock changes under the CUDA filter, which decides what `cudaAvailable` may claim.
2. Only then the snapshot table (the next schema version). After that, no live probe from the branch.
3. The tools, the timer, the docs, then the review.

## 3. Acceptance criteria (fixed before the code)

- **AC-GA-01 (live tool, defaults).** With a stubbed catalog (RTX 4090 24 GB $0.89 overall HIGH: EU-RO-1 MEDIUM, EUR-IS-1 LOW; L40S 48 GB
  $1.09 HIGH: US-IL-1 LOW; RTX 2000 16 GB) and datacenters EU-RO-1 (STANDARD), US-IL-1 (STANDARD), EU-SE-1 (none), the tool returns:
  - 4090 and L40S; the 16 GB card is left out by the default minimum of 24 GB;
  - each GPU's datacenters, with `networkVolume` true for EU-RO-1 and US-IL-1 and false for EU-SE-1;
  - `volumeDataCenterId` EU-RO-1 and `minCudaVersion` 12.8;
  - the catalog called with `minCudaVersion=12.8`.
- **AC-GA-02 (filters).**
  - `gpuTypeIds` and `dataCenterIds` narrow the answer, and `minVramGb` 40 keeps only the L40S.
  - An unknown filter value gives an empty list, not an error.
- **AC-GA-09 (S3).** Each datacenter carries `s3Api`, true exactly for the documented list (EU-RO-1 and US-IL-1 true, EU-SE-1 false in
  the AC-GA-01 stub). The description names it the documented list, not a live check.
- **AC-GA-03 (no key, no switch).**
  - With the media gateway off: `media_gateway_disabled`.
  - Without credentials: `media_generation_not_configured`.
  - No key text in any answer or error.
- **AC-GA-04 (snapshot).** One snapshot stores, for each GPU ≥ 24 GB:
  - an overall row;
  - one row per datacenter with network volumes, with NONE where the catalog does not list that datacenter;
  - the same `at` on every row, plus the price and CUDA filter.

  Datacenters without network volumes are not stored.
- **AC-GA-05 (schedule).**
  - The timer takes a snapshot when none is younger than 3 h.
  - With the gateway off or no credentials it skips without error, and a RunPod failure is logged without stopping the timer.
  - Two catalog reads per snapshot.
- **AC-GA-06 (retention).** A row older than 90 days is deleted on the next insert; one younger stays.
- **AC-GA-07 (log read).**
  - `since`, `until`, `gpuTypeId` and `dataCenterId` filter, newest first, with `limit` capped at 5,000.
  - `summary: true` returns, for each GPU and datacenter in the range, the number of snapshots per stock level. Example: 3 snapshots
    with L40S/US-IL-1 = LOW, NONE, LOW give `{ LOW: 2, NONE: 1 }`.
- **AC-GA-08 (contract).** Factory API 1.10.0 with the two tools on its list, names matching the factory read-tool rule. The table is
  device-local and classified as YT Manager's own data, not YouTube API data.
