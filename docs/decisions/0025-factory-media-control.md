# 0025. Factory media control: the Factory Operator writes models and templates; job input media

Status: Accepted

**Date:** 2026-10-06. **Requested** by the Factory Operator (`FO-REQ-0003`) and decided by the owner (decisions D1–D5 relayed in `FO-MSG-0005`,
plan accepted with answers O1–O5 in `FO-MSG-0006`, "Принимаю"). Plan and acceptance criteria: `docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md`
(BL-132). Amends ADR 0022 (the factory role was read-only) and extends ADR 0023 (Phase 14).

## Context

The owner moved model selection, model testing and generation templates to the Factory Operator, with ONE model set and ONE template set for
every channel and device. Phase 14 left all of it to the human operator: models pulled by hand with no hash check, templates imported per device
with random ids, no way to pass an input file (reference image, start frame, audio) to a job.

## Decision

1. **The factory role writes, through a closed list.** Factory API 1.0.0 → 1.1.0 adds eight tools (`factory_media_*`): four reads (storage status,
   models with hash and `usedBy`, pulls, templates) and four writes (pull a model, cancel a pull, delete a model, sync templates). The writes run
   **without a second approval in the Web UI** (owner D1: agreed in chat beforehand), are audited with actor `factory` in `media_control_events`,
   and pass the same device mutation gate as mutating channel tools. No factory tool sets a path, a workspace or a token, or touches sessions or
   jobs (D4: tests run on behalf of a channel with owner-approved sessions). `FACTORY_WRITE_TOOL_NAMES` and the inventory test pin this.
2. **Model pulls are hash-verified (D2).** Hugging Face only, public repos only (gated repos: BL-134). Before any pod: the Hub's metadata (new gateway
   child `media-gateway/huggingface.ts`, same "Media gateway" toggle, counter `huggingface_api`) resolves the revision to a commit and gives size and
   LFS SHA-256; a requested hash that differs, a gated/private repo, a missing file or a file larger than the volume's free space is refused. The
   pod downloads that commit into `ytm-staging/<pullId>/`, hashes it, moves it into `models/` only on a match, and writes its verdict to
   `ytm-pulls/<pullId>.json`; the pull is settled only by the verdict, so a file is never visible at its final key unverified. Refused (not
   queued) while sessions hold the volume (AC-P14-18/23 unchanged).
3. **Deletion guard (plan §2.2, owner addition A1).** A factory deletion is refused while any template uses the file — the registry's templates,
   this device's factory templates AND local (owner-imported) templates — and is refused when the registry cannot be read (fail closed). The owner's
   Web deletion shows the same check first and is never blocked. Every deletion is refused while a session or a pull holds the volume.
4. **Template registry (D3, O1, O3).** A new logical path `media_templates` (factory-only, a seeded NAME; each device sets its own value). It is the
   one place this app reads inside a logical path (an exception to ADR 0022 decision 1): only `index.json` and `<templateId>.v<version>.json`
   directly in the folder, regular files ≤ 5 MB whose real path stays in the folder. Sync installs `factory` rows under the registry id (identical on
   every device) and version; refuses a lower version and a same-version content change; changes nothing when the index cannot be read; leaves a
   listed-but-missing file `pending`; removes only ids a readable index no longer lists; never touches local templates. Known ComfyUI loader nodes may
   reference only declared models. It runs at start and every 60 s when the files changed, on the factory tool and on a Web button. Factory rows are
   read-only in the Web UI and CLI.
5. **Job input media (D5, O2, O5).** Template parameters gain types `image`/`audio`/`video` (with `accept`, `maxBytes` ≤ 500 MB). A job value is a
   path relative to the channel workspace's `99 Data Exchange/Sent to YTM/`, resolved by the shared `workspace-exchange` module with containment
   proofs; every input is checked before the job exists, then streamed (two-pass SigV4: hash, then body) to `exchange/in/<jobId>-<param>-<name>` before
   the prompt is submitted; the loader input gets that flat name. The janitor deletes an uploaded input by ledger (`media_exchange_inputs`) once its
   job is terminal; the operator's own `exchange/in/` files are never touched; the source file in `Sent to YTM` is never deleted (O2). Agent API
   3.4.0 → 3.5.0 (additive).

## Consequences

- Schema v61 (additive, device-local): `media_control_events`, `media_exchange_inputs`, `media_workflow_templates.source/registry_sha256/models_json`,
  the `media_templates` logical-path name.
- A leaked factory token can now spend a little money and delete unused models without a click (RISK-109); the bounds are listed there.
- Not verified live yet (owner go-ahead needed for paid calls): ComfyUI loaders accepting the flat input name, RunPod S3 accepting the streamed PUT
  with an explicit Content-Length, the pull pod's `hf download --revision` + `sha256sum` + `mv` on `python:3.12-slim`.
- This ADR records the interface the Factory Operator consumes; it contains no operating instructions for that role (`AGENTS.md` §B).
