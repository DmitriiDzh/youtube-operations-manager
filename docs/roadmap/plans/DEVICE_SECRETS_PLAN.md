# BL-134 / BL-199 — One store for this computer's secrets, and model pulls from gated Hugging Face repos

**Assigned by** the owner, Telegram 2026-10-18:
- msg 3005: check FO-REQ-0028;
- msg 3007: (1) take it; (2) store the HF token like the RunPod key, and bring RunPod, Gemini and new access tokens to one format
  and one way.

Request: FO-REQ-0028 (Operator, draft in the Developer Exchange Outbox, relayed by the owner). Backlog: BL-134 (gated pulls)
and BL-199 (the shared store). ADR 0042.

## Why

- Today each secret has its own table, key file, payload format and error codes:
  - RunPod + S3: `media_credentials` + `media-generation.key`;
  - Gemini: `gemini_credentials` + `gemini-media.key`.
- The two behave differently:
  - Gemini reports "configured" without checking its key file;
  - Gemini deletes its key file when the key is cleared, RunPod keeps its file;
  - timestamps are in seconds in one table and milliseconds in the other.
- `factory_media_pull_model` cannot download gated Hugging Face files (FLUX 3 Image Klein, the LTX IC-LoRA); today they answer
  `media_model_gated`.

## Scope

1. **`src/lib/device-secrets/`** — the one owner of this computer's secrets:
   - one table `device_secrets` (schema v96, device-local, never synced), one row per secret name;
   - one key file `device-secrets.key` (0600, created on the first save), encrypted with AES-256-GCM (`shared-crypto`);
   - plaintext, non-secret hints per secret (RunPod key prefix, S3 access key id, Gemini last 4, HF user name);
   - the per-session sealing of ComfyUI proxy tokens.
2. **Hugging Face token** (first user of the store, owned by `media-generation`):
   - a «Hugging Face token (read)» field on the Cloud APIs settings, masked, with «Проверить» (HF `whoami`, shows the user name);
   - per computer, never synced, never in logs, API or MCP output, or job records.
3. **Gated pulls** (`factory_media_pull_model`):
   - the Mac-side HF metadata calls send the token;
   - the pull pod gets it as the env var `HF_TOKEN` (already masked by `redactPodEnv`), never in its command line. The pod lives
     only for the download. RunPod's console shows pod env to the account holder, which is the owner's own account.
   - Errors:
     - a gated repo and no token: `hf_token_missing`;
     - `whoami` refuses the token: `hf_token_invalid`;
     - the token is valid but HF answers 401/403 for the repo or file: `hf_gate_not_accepted`, with the repo URL.
4. **Licence:** the pull records `licenseId` / `licenseUrl` from the repo's card (`cardData.license`) on the `ModelPull`. The
   model list shows them.
5. **Factory API:** `factory_media_get_settings` adds `hfToken: "set" | "not set"`, never the value. This is an additive minor
   version.
6. **Gemini and RunPod/S3 move onto the store** without re-entry:
   - On the first read of each secret, if the store has no row and the secret is not yet marked migrated, the old row is
     decrypted with its old key file, written to the store, read back and compared. Only then is the "migrated" marker set.
   - The old tables and key files are kept, never dropped, because `resolveMergedNumberingCollision` depends on
     `media_credentials` existing. Once marked migrated they are never read again, so clearing a secret cannot bring it back.
   - If an old key file is missing or unusable, the secret cannot be moved and is reported as needing re-entry. This is the one
     case where the owner enters a key again.
7. **One behaviour for every secret:**
   - "configured" = a row and a readable key file;
   - clearing a secret never deletes the shared key file, except when the file itself is unusable (the RunPod rule, AC-P14-21);
   - timestamps in milliseconds;
   - Gemini's `payment_required` status update keeps its compare-and-set, now on the row's `revision`.
8. **Session tokens:** new sessions are sealed with the store's key. Opening a token tries the store's key, then the legacy
   `media-generation.key` while it exists. Running sessions are never re-sealed. RISK entry: the legacy file is kept until no
   session sealed with it remains.
9. **`.ytmkeys` transfer** (ADR 0027/0039) gains a `huggingface` section through a `media-generation` port. The transfer module
   still imports no feature module.

**Out of scope:** OAuth tokens, AI-connection keys and the cloud-connection key, which use env keys (RISK-07/48); key rotation
(RISK-106).

**Stages (one branch, one merge):**
- (a) the store;
- (b) HF token and gated pulls;
- (c) Gemini onto the store;
- (d) RunPod/S3 onto the store.

If review stalls on (d), (a) + (b) + (c) are still a complete feature.

## Acceptance criteria

Expected values come from the rules above.

### Store

- **AC-DS-01**: write("x", "s3cr3t", hints) then read("x") returns "s3cr3t". The row's ciphertext does not contain "s3cr3t".
  The key file is created with mode 0600 on the first write.
- **AC-DS-02**: state is `none` without a row, `key_file_missing` with a row but no file, `key_file_invalid` with an unusable
  file, and `set` otherwise. A row whose ciphertext does not open with the file fails with `device_secret_unreadable`.
- **AC-DS-03**: clear("x") removes only row x. Other secrets and the key file stay. An unusable key file is removed together
  with the cleared row.
- **AC-DS-04**: setStatus with a stale revision changes nothing.
- **AC-DS-05**: seal/open round-trip with the store's key. A payload sealed with the legacy key opens through the fallback.
  Without either key it fails with `media_generation_not_configured`.

### Migration

- **AC-DS-06**: a legacy Gemini row and its file move on first read. The read returns the same key, the fingerprint is
  unchanged, and the marker is set.
- **AC-DS-07**: after migration, clear("gemini") leaves the store empty and a later read does not bring the legacy row back.
- **AC-DS-08**: a legacy row whose key file is missing is not moved. State is `key_file_missing` and no marker is set.
- **AC-DS-09**: RunPod/S3 move the same way. The prefix and S3 id hints are kept, and `verifiedAt` survives in ms.

### Hugging Face

- **AC-HF-01**: a gated repo with no token fails with `hf_token_missing`, and no HTTP call carries a token. A public repo still
  works without a token.
- **AC-HF-02**: when `whoami` refuses the token, the save and the pull fail with `hf_token_invalid`.
- **AC-HF-03**: a valid token with a 403 on the repo or file fails with `hf_gate_not_accepted`, with
  `details.repoUrl = https://huggingface.co/<repo>`.
- **AC-HF-04**: on the pull pod the token is in `env.HF_TOKEN` and not in `cmd`. The `ModelPull` record, the settings view and
  the error messages do not contain it. `factory_media_get_settings` shows `hfToken: "set"`.
- **AC-HF-05**: the licence is recorded from the repo's card:
  - `cardData.license = "other"` with `license_link: "LICENSE.md"` gives licenseId "other" and
    licenseUrl `https://huggingface.co/<repo>/blob/<commitSha>/LICENSE.md`;
  - `"apache-2.0"` without a link gives licenseId "apache-2.0" and the repo page as licenseUrl;
  - no card gives null for both.

**Not verifiable here:** FO-REQ-0028 acceptance 2 and 3 need the owner's real token and accepted gate. They wait for the owner.
The token must never be given to the developer agent.
