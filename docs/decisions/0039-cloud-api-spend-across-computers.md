# 0039. Cloud API spend and limits shared by every computer on one account; one file for every cloud key

Status: Accepted

**Date:** 2026-10-16. **Decided** by the owner (Telegram, 2026-10-16, msgs 2864/2867, BL-193): RunPod and Gemini on one Settings
sub-tab; a Gemini card in Servers; the spend shown and checked for every computer that uses the same API account; the Gemini limits
"да, общие" (shared); the keys carried to another computer as one password-encrypted file (variant 1). Amends ADR 0035 ("the limits
are per computer") and ADR 0027 (the file carried only RunPod/S3). Extends ADR 0028 §5 and ADR 0030.

## Context

- RunPod: the daily cap already counted the other computers on the same RunPod account (ADR 0028 §5), but the Servers header
  showed this computer's spend only.
- Gemini: every computer counted only its own jobs against its own limits (ADR 0035 §4). Two computers on one key could each spend
  the full daily and monthly limit.
- Google offers no API that names the account behind a Gemini key, and no balance to read.
- The shared jobs list (`media-jobs`, ADR 0028 amendment) carries only the newest jobs, so a month's spend cannot be summed from it.

## Decision

1. **RunPod spend shown account-wide.** `getLimits` adds `accountSpentTodayUsd` (this computer plus the other computers' reported
   spend on the same account, the figure the cap already used) and `otherDevicesSpentTodayUsd`; `spentTodayUsd` stays this
   computer's (its own report publishes it, so making it account-wide would double-count). The read uses the reports only, never
   RunPod's pod list. Agent API 3.19.0 (additive).
2. **Gemini spend report: a new per-device family `gemini-spend`** (`ytm-gemini-spend` v1: device, hostname, key fingerprint,
   `spentTodayUsd`, `spentMonthUsd`, `updatedAt`; strict and bounded). gemini-media publishes it itself (every 30 s when it changed,
   at least every 5 minutes), as media-generation publishes `media-sessions`. A new family, not a new field in `media-jobs`: that
   report is strict, so a new field would need a version bump that makes an older build refuse the whole jobs report (ADR 0031 §4);
   an older build simply ignores a family it does not know.
3. **The key fingerprint.** `HMAC-SHA256(key = "ytm/gemini-key-fingerprint/v1", message = API key)`, the first 32 hex characters
   (128 bits). The label is a fixed, public domain separator, not a secret: a per-device salt would make every computer's
   fingerprint different, and nothing would ever be added up. The key stays unrecoverable because of its own entropy (~35 random
   characters); the label keeps the value from matching anyone's plain SHA-256 of the key. Never the key, its last characters or a
   plain hash. No usable key on a computer = fingerprint `null` = nothing is matched there (as an unknown RunPod account, ADR 0028 §2).
4. **Account-wide Gemini spend (ADR 0028 §5's rule).** Other computers count when their report carries the same fingerprint:
   toward today when written since this computer's local midnight, toward the month when written since the 1st; a stale report
   still counts (spend is history); one dated more than 5 minutes ahead does not. Reports that cannot be read count 0 and are
   logged (best effort, as RunPod). A create's per-day and per-month checks use this sum; per job and active jobs stay this
   computer's. `factory_gemini_get_status` gains `spend.account`; a refusal's details gain `otherComputersUsd` when others spent
   (Factory API 1.19.0).
5. **Gemini limits shared: a new Automerge family `gemini-settings`**, the media-settings engine (ADR 0030) on its own document
   (`ytm-gemini-settings`, its own genesis actor), so each settings map has one owner. gemini-media owns the field list
   (`maxUsdPerJob`, `maxUsdPerDay`, `maxUsdPerMonth`, `maxActiveJobs`) and ADR 0030's rules: a save publishes only what it changed;
   missing fields are seeded; received values go through gemini-media's own validation; a field set differently on two computers
   is never applied until the owner picks one on the startup conflict screen (its own "Gemini limits" group); a value refused as
   invalid is held until it changes. **The switch (`enabled`) is not shared:** it lets this computer's operator spend with this
   computer's key, and turning it on elsewhere must stay a decision made there.
6. **One file for every cloud key** (ADR 0027 variant A extended). A shared module, `src/lib/cloud-credentials-transfer/`, builds
   the file `ytm-cloud-credentials` v1 from each feature module's own public export (RunPod + S3 from media-generation, the
   Gemini key from gemini-media); neither module knows the other. Import accepts the old `ytm-runpod-credentials` file too. Only the
   sections present in the file are applied: a file without Gemini never touches the stored Gemini key, and the other way round.
   Before anything is stored every present key is checked with its provider (and RunPod's "volume busy" refusal is checked); if
   any check fails nothing is stored. The routes are `POST /api/cloud-credentials/export` and `/import`; the old
   media-generation routes are removed.

## Consequences

- Cross-computer limits are not atomic: two computers creating at the same moment can overshoot by one job each (as RISK-111 for
  RunPod); a computer's spend reaches the others within about a minute or two (its report, the sync, Syncthing).
- Two different keys on the same Google project are not recognised as one account (each fingerprint is summed on its own); the
  monthly spend cap in Google AI Studio remains the account-wide guard.
- Days and months mix each computer's local calendar, as RunPod's daily cap does.
- Changing the fingerprint label changes every fingerprint: all computers must update together.
