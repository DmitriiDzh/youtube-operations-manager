# 0027. RunPod credentials carried to another device as a password-encrypted file

Status: Accepted

**Date:** 2026-10-06. **Decided** by the owner (Telegram, 2026-10-06, msgs 1702–1704): of three variants offered — (A) a
password-encrypted export/import file, (B) automatic sync through Syncthing, (C) a separate RunPod key per device — the owner chose A
(BL-137). Amends ADR 0023's "keys are entered in Settings on each device" (per-device key file, AC-P14-21).

## Context

The RunPod API key and the S3 key pair are stored encrypted under a key file each device creates itself (ADR 0023); they are not in
the snapshot or in sync. Every device therefore needed the three keys typed in by hand.

## Decision

1. **Export** (Settings → RunPod → "Export credentials…", `POST /api/media-generation/credentials/export`): the operator types a
   password (≥ 12 characters, twice); the server derives a key with scrypt (N = 2^17, r = 8, p = 1, random 16-byte salt;
   `src/lib/shared-crypto`) and encrypts the credential set with AES-256-GCM. The browser downloads
   `runpod-credentials-<date>.ytmkeys`: format, version, date, the public hints (key prefix, S3 access key id) and the ciphertext.
   The password is never stored or logged.
2. **Import** (`POST /api/media-generation/credentials/import`): the file and the password; a wrong password or a damaged file
   changes nothing; the RunPod key is checked with one read before anything is stored; then the set is stored exactly like typed
   keys (this device's key file, the same "volume busy" refusal). The file's scrypt parameters are bounded so a crafted file cannot
   make a decrypt allocate gigabytes.
3. Web UI only: no MCP, Factory or agent tool exports or imports credentials.

## Consequences

- One RunPod key on several devices: a leak means rotating it everywhere (the owner's choice over C).
- The file can be attacked offline; its strength is the password's (TECHNICAL_DEBT RISK-110).
- Variant B (sync) stays out: it would keep a copy of the secrets in a shared folder and still needs a secret typed on each device.
