# scripts/media — operator/agent scripts for remote media generation (Phase 14)

Every script wraps the operator CLI `npm run media -- <command>` (`src/cli/media.ts`), which uses the
RunPod / S3 keys entered in **Settings → Media** (encrypted on this computer). No key is ever an
argument or an environment variable. Requirements: `npm install` done, **Settings → AI Agent →
"Operator CLI access"** on. Each script has `--help`, exits non-zero on failure and ends with one
machine-readable `RESULT …` line. Windows: Git Bash or WSL.

Setup order (slice 0):

1. Settings → Media: save the RunPod API key (+ the S3 key pair), load the catalog, pick datacenter and
   GPU. `scripts/media/credentials-test.sh` confirms the keys.
2. `scripts/media/volume-create.sh --name models --dc EU-RO-1 --size 150`, then select it in Settings.
3. `scripts/media/volume-bootstrap.sh` — uploads `pod/pod-start.sh`, `pod/Caddyfile`,
   `pod/extra_model_paths.yaml` to `ytm/` on the volume and creates the `models/*` folders.
4. `scripts/media/models-pull.sh my.manifest` — a CPU pod downloads the models straight onto the
   volume, then terminates itself (format: `pod/models.manifest.example`).
5. `scripts/media/template-create.sh` — creates the pod template (`pod/template.json`); put the id in
   Settings → Media → Compute.
6. `scripts/media/pod-create.sh` — starts a ComfyUI pod with a fresh token; `pod-terminate.sh <id>`
   when done. `pod-watch.sh` terminates anything running past the limit (cron-able).
7. `scripts/media/s3.sh ls exchange/` — files on the volume without a pod.
8. With a session approved in Settings → Media → Sessions and a workflow template imported:
   `scripts/media/job-run.sh --template <id> --channel <UC…> --param prompt="a cat"` submits a job and
   waits; outputs land in `<workspace>/99 Data Exchange/From YTM/media/<jobId>/`.
9. `scripts/media/exchange-janitor.sh [--delete]` — leftovers of finished jobs under `exchange/` on
   the volume (dry run by default; the server also runs it daily).

There is deliberately no "stop pod" anywhere: a stopped pod's disk is billed at twice the running
rate, so the only idle state is "terminated"; models survive on the network volume.
