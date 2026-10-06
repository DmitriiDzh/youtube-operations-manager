# BL-136 — Migrate the RunPod network volume to a smaller one

**Status:** plan, awaiting the owner's agreement. Assigned by the owner (Telegram 2026-10-06, msg 1704) after asking for it (msg 1695).
**Why:** RunPod never shrinks a network volume ("Volume size can be increased later but cannot be decreased", network-volumes docs;
`PATCH` refuses a smaller `size`). The only way to rent less is a new, smaller volume holding the same data.

## Facts this plan rests on (RunPod docs, read 2026-10-06)

- A pod mounts exactly one network volume (it replaces `/workspace`; attached only at deploy time).
- RunPod's own migration method: two running pods (source volume, destination volume), `rsync -avzP --inplace` over SSH
  (or `runpodctl send/receive`).
- The S3-compatible API (endpoint per datacenter, bucket = volume id) lists `CopyObject` ("copy objects between locations"),
  multipart upload (parts ≤ 500 MB), but **not** `UploadPartCopy`. Whether a `CopyObject` source may be **another volume** is
  not documented, and whether a multi-GB server-side copy completes is not documented either.

## Step 0 — probe (decides A or B)

An operator CLI command (`npm run media -- volume-copy-probe`) run once, by the owner (it is billable): creates a 20 GB test
volume in the same datacenter (≈ $1.40/month, deleted at the end — cents in total), `CopyObject` of the smallest file and then of
the largest model up to 18 GB from the current volume to it, `HeadObject` to check size, then deletes the test volume. It prints what worked.

- **A — server-side copy works:** the app copies the volume over the S3 API alone (list → `CopyObject` → `HeadObject`), no pods.
- **B — it does not:** two short-lived CPU pods and rsync over SSH, as RunPod documents. To verify there first: a Secure Cloud CPU
  pod with TCP 22 exposed and `RUNPOD_PUBLIC_IP`; the one-time SSH key pair is written to each volume over S3
  (`ytm-migrate/<id>/`), never into pod environment variables (those are readable via `GET /pods`).

## Flow (common to A and B)

1. **Preconditions.** Exclusive volume lock for the whole migration (new owner `migrate:<id>`): no session, pull or operator pod.
   Same datacenter. New size ≥ live used size + a margin (the UI offers the janitor first).
2. **Create** the new volume (confirmation with its monthly price).
3. **Copy everything** on the volume (models, `exchange/`, pull verdicts), except RunPod's `.s3compat_uploads/` staging.
4. **Verify before switching:** every object present with the same size; SHA-256 equal wherever the app knows it (model registry).
   For B both pods write a manifest that the app compares.
5. **Switch** `networkVolumeId` through the existing validated settings path.
6. **Delete the old volume:** a separate button, enabled only after a successful switch, its own confirmation naming the volume
   and its monthly price; new gateway function `DELETE /v2/network-volumes/{id}`. Never automatic.
7. **Failure:** pods terminated, lock released, the new volume kept and shown with its own delete button; the migration's state is
   stored (`app_settings`) so the card survives a reload or restart.

## Boundaries

- Operator UI (Production → Setup → Network volume) only: creating and deleting volumes changes the bill and destroys data, so no
  MCP / Factory tool.
- Cost: the new volume's monthly price; copying costs cents (A) or two CPU pods for the copy time (B).
