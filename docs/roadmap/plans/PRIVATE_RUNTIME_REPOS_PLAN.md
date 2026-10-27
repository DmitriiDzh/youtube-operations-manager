# BL-230 — Private GitHub repositories in pod runtimes

**Assigned by** the owner, Telegram msg 3689, option A. Backlog: BL-230. ADR 0043, Amendment 1. Builds on BL-134/BL-199
(`DEVICE_SECRETS_PLAN.md`, ADR 0042) and BL-200 (`POD_RUNTIMES_PLAN.md`).

## Why

The Operator needs a ComfyUI node pack from a private GitHub repository (`https://github.com/DmitriiDzh/ComfyUI-See-through` at
`cd93ccb9880cee561e88ee59b61dff384867066d`) in a pod runtime. `runtime-build.sh` clones over plain https with no credential, so
a private repository fails, and only on the paid build pod.

## What is built

1. **A device-secret slot `github`** in `src/lib/device-secrets/` (no schema change: a row of `device_secrets`).
2. **`media-generation/github-token.ts`**, modelled on `hf-token.ts`: set (checked first) / view / test / clear.
   - Accepted forms, refused before any call: `github_pat_` + 60–251 of `[A-Za-z0-9_]` (fine-grained) or `ghp_` + 36–251 of
     `[A-Za-z0-9]` (classic).
   - The check is `GET /user` through the existing media-gateway child `media-gateway/github.ts`, with `Authorization: Bearer`
     and no redirect followed. The answer gives the login, and the header `github-authentication-token-expiration` the expiry.
   - The view: `state`, `login`, `status` (`ok` | `invalid`), `expiresAt`, `verifiedAt`, `updatedAt`. Never the token.
   - Errors: `github_token_missing` (test with none stored), `github_token_invalid` (GitHub answered 401 to the token),
     `github_token_forbidden` (a 403 to the token that is not a rate limit: no Contents read, or the organization's SSO not
     authorized; review M2).
3. **Web:** a «GitHub» card after the Hugging Face card in Settings → Cloud APIs (`GithubTokenSettings`), routes
   `/api/media-generation/github-token` (GET/PUT/DELETE) and `/test` (POST), session required. The input is the masked
   `type="text"` `MaskedSecretInput`. Texts in en and ru. Remove asks through `ConfirmDialog`.
4. **Creation check (`createRuntime`):** every `https://github.com/` source of the profile (ComfyUI and every node pack) is
   checked on GitHub at creation: `GET /repos/{o}/{r}/commits/{ref}`. This is new for node packs and for an exact ComfyUI commit.
   - First without a token. GitHub answers 404 for a repository it does not show (missing **or** private) and 422 for an unknown
     commit in a repository it shows.
   - 404 and no token stored: `runtime_repo_private_needs_token` (`details.repo`). Nothing is written.
   - 404 and a token stored: the same request again with the token. 404 again: `runtime_repo_not_visible_to_token`. 401:
     `github_token_invalid`.
   - 422 (no such commit, tag or branch): `not_found`, as before. A pack's answer must be its own commit.
   - Other hosts (`huggingface.co`) are not checked, as before. The owner's allow-list applies first, unchanged.
   - `runtime.json` keeps its schema (v1, strict): nothing about privacy is stored. The build decides by URL.
5. **Build pod:** when the token is stored **and** the profile names at least one `https://github.com/` repository, the build pod
   gets it as the env var `YTM_GIT_TOKEN`. Never in `entrypoint`, never in a job record, audit or error: the build start replaces
   the token in any error text with `[redacted]` before it is stored or thrown. `redactPodEnv` already masks every `*TOKEN*`
   name in pod reads.
6. **`runtime-build.sh`:**
   - github.com URLs are fetched and cloned with a one-shot header:
     `git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic <base64 of x-access-token:TOKEN>" …`, only when
     `YTM_GIT_TOKEN` is set. The `-c` goes before the sub-command, so nothing is written to `.git/config`. The remote URL has no
     credential. Tracing (`set -x`) is switched off while the header is built and used.
   - A git command refused with the header is retried once without it: GitHub answers 401 to an expired or revoked token even for
     a public repository, so a dead token must not break ComfyUI's own clone. `GIT_TERMINAL_PROMPT=0`: git never waits for a user.
   - After the clones, `unset YTM_GIT_TOKEN`: later child processes do not inherit it. It is NOT gone: it stays in the pod's PID 1
     env (`/proc/1/environ`) for the pod's life, so pip, build backends and any profile code CAN read it, and the RunPod console
     shows it in the pod's env (review L5).
   - The fallback's checkout of the partial clone fetches blobs, so it carries the header too (review M1). Git tracing variables
     are unset and `GIT_TRACE_REDACT=1`; tracing is off whenever the token is near, so `set -x` never prints it. The retry
     without the header is logged. A leak check that cannot read the folder (grep exit 2) counts as a leak.
   - A leak check runs before `.ready` and in every `finish`: `grep -rqF` of the token and of its base64 header form over the whole
     runtime folder, `build.log` included. On a hit, everything in the folder except `runtime.json` and `.lock` is deleted,
     `build.log` is emptied, and the build fails with `a credential was found in the runtime folder; it was removed`. The check
     never prints a matching line.
   - A failed github.com clone says that a private repository needs the GitHub token in Settings → Cloud APIs, or, with a token
     given, that it may have expired or cannot see the repository.
7. **Session pods** get no token: they only run built runtimes, and the session module has no access to the slot.
8. **Factory API 1.36.0:** `factory_media_create_runtime` documents the check and the new errors. No tool sets, reads or shows
   the token; the owner enters it in the Web UI only.

**Out of scope:** the `.ytmkeys` transfer section, a `githubToken` flag in `factory_media_get_settings`, an MCP path to the
token, tokens for hosts other than github.com, model pulls from GitHub.

## Acceptance criteria

Expected values come from the rules above and GitHub's REST API docs (404 for a hidden repository, 422 for an unknown commit,
`Authorization: Bearer`, `github-authentication-token-expiration: 2026-11-26 00:00:00 UTC`). `T` below is a token-shaped fake
(`github_pat_` + 82 characters).

### Token

- **AC-PR-01**: set `{ token: T }` → one `GET https://api.github.com/user` with `authorization: Bearer T`, then the view
  `{ state: "set", login: <login>, status: "ok", expiresAt: "2026-11-26T00:00:00.000Z" }`. `JSON.stringify(view)` does not
  contain `T`.
- **AC-PR-02**: `"hf_x…"`, `"ghp_short"`, `"github_pat_"` + 10 characters, `"github_pat_" + 60 chars + " "` inside, `"gho_…"`,
  `""` and a token with a newline are refused with `validation_failed` and **no** HTTP call; nothing is stored.
- **AC-PR-03**: GitHub answers 401 → `github_token_invalid`, nothing stored. Test with no token → `github_token_missing`. Test
  answered 401 → status `invalid` on that token, error rethrown. Clear → `state: "none"`.
- **AC-PR-04**: the routes answer 401 without a session. After a save, no body of GET/PUT/POST test/DELETE contains `T`; a
  refusal's body does not either.

### Gateway

- **AC-PR-05**: without a token no request carries `authorization` (unchanged); with a token every request carries
  `Bearer T` and is sent with `redirect: "error"`. A 401 with a token is `github_token_invalid`; its message and details do not
  contain `T`.
- **AC-PR-06**: `resolveCommit` answers 404 as `not_found` with `details.missing = "repository"`, 422 as `not_found` with
  `details.missing = "ref"`.

### Creation

- **AC-PR-07**: a pack `https://github.com/DmitriiDzh/ComfyUI-See-through` (in the allow-list) answered 404 without a token, no
  token stored → `runtime_repo_private_needs_token`, `details.repo` = that URL; nothing written.
- **AC-PR-08**: the same with a token stored and GitHub answering 200 with the token → the profile is written; exactly one request
  for that pack carried the token; the public ComfyUI request carried none.
- **AC-PR-09**: 404 with the token too → `runtime_repo_not_visible_to_token`; 401 with the token → `github_token_invalid`;
  nothing written; no error text contains `T`.
- **AC-PR-10**: a repository outside the allow-list is still `validation_failed` with no GitHub call; a `huggingface.co` source
  is not checked; a 422 for a pack's commit is `not_found`.

### Build

- **AC-PR-11**: token stored + profile with a github.com repository → `createPod` has `env: { YTM_GIT_TOKEN: T }` and an
  `entrypoint` without `T`. No token stored, or a profile with no github.com repository → no `env`.
- **AC-PR-12**: a `createPod` failure whose message carries `T` → the job's `error`, the audit and the thrown error carry
  `[redacted]` and not `T`.
- **AC-PR-13**: `redactPodEnv({ YTM_GIT_TOKEN: T })` → `{ YTM_GIT_TOKEN: "[redacted]" }`.
- **AC-PR-14** (shell, the script's own functions against a local bare repository): with `YTM_GIT_TOKEN=T` a github.com fetch is
  given exactly `http.https://github.com/.extraheader=AUTHORIZATION: basic base64("x-access-token:T")`; another host and an
  unset variable get no header; after `clone_at` the checkout is at the commit, and `.git/config` holds neither `T` nor
  `extraheader`; the remote URL is the plain one. A header refused by the server is retried once without it (public repository +
  expired token still clones).
- **AC-PR-15** (shell): the leak check fails on a folder holding `T` or its base64 header form (in a nested file and in
  `build.log`), passes on a clean folder and when no token was given, and prints neither form.

## Risks

- An unreadable stored token (this computer's key file missing or unusable) fails every build start of a profile naming
  github.com — every profile — with `device_secret_unreadable`, as an unreadable HF token fails every pull that needs it; the
  owner removes and re-enters it (review L6).
- The token sits in the build pod's env for the pod's life (≤ 30 min), readable by the code the build runs (PID 1's env survives the
  `unset`) and shown in the RunPod console's pod env — the same class as
  `HF_TOKEN` on the pull pod. A fine-grained, read-only, one-repository token with an expiry bounds it (RISK-137).
- The header is in `git`'s argument list inside the pod while git runs (the pod is single-purpose; RunPod shows only `entrypoint`).
- Every profile names github.com (ComfyUI), so with a token stored every build pod receives it.
- Creation now asks GitHub once per github.com source (unauthenticated: 60 per hour per IP). A bad pack commit now fails at
  creation (`not_found`) instead of on the paid build pod; GitHub being down now fails creation (`github_unavailable`).
- A token entered on one computer is not on the other (device secret, not synced) — builds started there clone without it.
