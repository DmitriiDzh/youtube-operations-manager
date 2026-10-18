# 0042. One store for this computer's secrets

Status: Accepted

**Date:** 2026-10-18. **Assigned by** the owner (Telegram 2026-10-18, msg 3007): store the Hugging Face token like the RunPod key,
and bring RunPod, Gemini and new access tokens to one format and one way. Plan: `docs/roadmap/plans/DEVICE_SECRETS_PLAN.md`.

## Context

Secrets typed into Settings are kept per computer, encrypted under a key file the app creates (ADR 0023, AC-P14-21). By
BL-174 there were two copies of that idea:
- `media_credentials` + `media-generation.key` for RunPod/S3;
- `gemini_credentials` + `gemini-media.key` for Gemini.

The two had different payloads, error codes, "configured" rules, clear rules and timestamp units. FO-REQ-0028 adds a third
secret, a Hugging Face read token.

## Decision

1. **`src/lib/device-secrets/` is the one owner** of this computer's typed secrets:
   - one table `device_secrets` (one row per name, plaintext non-secret hints, status, verifiedAt and updatedAt in ms;
     the compare-and-set token is a version derived from the ciphertext, unique per save — a row counter restarted after a clear,
     review of BL-199);
   - one key file `device-secrets.key` (0600, `device-key-file`);
   - AES-256-GCM (`shared-crypto`).

   Feature modules (media-generation for RunPod/S3 and Hugging Face, gemini-media for Gemini) use it through a named slot and
   never touch the key file or the ciphertext.
2. **The OS keychain is not used.** FO-REQ-0028 asked for it. It needs a native module on two operating systems, which was
   already rejected in Phase 6, and the owner chose the RunPod way. The guarantees asked for still hold: per computer, not in
   synced folders, logs, API/MCP output or job records.
3. **Migration without re-entry, at runtime, idempotent:**
   - The schema step (v96) only creates the table.
   - On the first read of a slot with no row and no "migrated" marker, the legacy row is decrypted with its legacy key file,
     written to the store, read back and compared. Only then is the marker set.
   - The legacy tables and files are kept, never dropped: `resolveMergedNumberingCollision` depends on `media_credentials`.
     A legacy row is never read again once its slot is marked migrated.
   - A missing or unusable legacy key file means that one secret is entered again.
4. **One behaviour:**
   - "configured" means a row and a readable key file;
   - clearing a secret removes only its row; the shared file goes only when it is itself unusable;
   - the Gemini status update keeps its compare-and-set, on the version read before the check.
5. **Session tokens:**
   - The ComfyUI proxy tokens of new sessions are sealed with the store's key.
   - Opening falls back to the legacy `media-generation.key` while it exists. Running sessions are not re-sealed.
6. **Hugging Face token:**
   - It is read and sent only for a repo that needs it, so a public pull never depends on it (review of BL-134). It goes only to
     huggingface.co, from the media gateway's HF child.
   - For such a repo, a HEAD on the file checks access before any pod is created: conditions not accepted means
     `hf_gate_not_accepted`, at no cost.
   - The pull pod receives it as the env var `HF_TOKEN`, masked in every pod read by `redactPodEnv`, never in its command line.
   - `factory_media_get_settings` reports `hfToken: set | not set`.

## Consequences

- ADR 0023's "each module keeps its own key file" (and BL-174's two files) is superseded for typed secrets. Env-key based
  secrets (OAuth tokens, AI connections, cloud connection; RISK-07/48) are unchanged and out of scope.
- Losing `device-secrets.key` now loses every typed secret on that computer at once (they are re-entered or imported from a
  `.ytmkeys` file). RISK-106, which says there is no rotation or backup, now covers all of them.
- `media-generation.key` stays while sessions sealed with it may exist (RISK entry); `gemini-media.key` and the legacy rows
  stay inert.
