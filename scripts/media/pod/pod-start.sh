#!/usr/bin/env bash
# Runs INSIDE the pod (the template's start command): ComfyUI on 127.0.0.1:8188 with models and outputs on
# the network volume, behind a bearer-token reverse proxy on 8189 -- the only port the app talks to.
# Lives on the volume at /workspace/ytm/pod-start.sh (uploaded by scripts/media/volume-bootstrap.sh).
# Env: COMFY_TOKEN (required, set per session), COMFY_DIR (optional, ComfyUI checkout; auto-detected),
# YTM_RUNTIME_ID (BL-200, optional: run that pod runtime profile built on the volume).
# Never contains or receives a RunPod API key.
set -uo pipefail

log() { printf '[ytm] %s\n' "$*" | tee -a /workspace/ytm/logs/pod-start.log; }
mkdir -p /workspace/ytm/logs /workspace/exchange/in /workspace/models

if [ -z "${COMFY_TOKEN:-}" ]; then
  log "COMFY_TOKEN is not set; refusing to expose ComfyUI without a token"
  sleep infinity
fi

# -- BL-200 (ADR 0043): a pod runtime profile built on the volume -----------------------------------
# With YTM_RUNTIME_ID set the session runs that runtime's ComfyUI with its venv, never the built-in one: a runtime that is
# not built (.ready missing) is refused, so a session cannot report success on the wrong runtime.
RUNTIME_PY=""
if [ -n "${YTM_RUNTIME_ID:-}" ]; then
  case "$YTM_RUNTIME_ID" in *[!a-z0-9-]*) log "bad YTM_RUNTIME_ID"; sleep infinity ;; esac
  RT="/workspace/ytm/runtimes/$YTM_RUNTIME_ID"
  if [ ! -f "$RT/.ready" ] || [ ! -f "$RT/ComfyUI/main.py" ] || [ ! -x "$RT/venv/bin/python" ]; then
    log "runtime $YTM_RUNTIME_ID is not built on the volume; refusing to start the built-in ComfyUI instead"
    sleep infinity
  fi
  COMFY_DIR="$RT/ComfyUI"
  RUNTIME_PY="$RT/venv/bin/python"
  printf '{"runtimeId":"%s","comfyDir":"%s","at":"%s"}\n' "$YTM_RUNTIME_ID" "$COMFY_DIR" "$(date -u +%FT%TZ)" > "/workspace/ytm/logs/runtime-${RUNPOD_POD_ID:-unknown}.json"
fi

# -- locate ComfyUI --------------------------------------------------------------------------------
COMFY_DIR="${COMFY_DIR:-}"
if [ -z "$COMFY_DIR" ]; then
  # /opt/comfyui-baked: runpod/comfyui (github.com/runpod-workers/comfyui-base) bakes ComfyUI there; its own /start.sh
  # would copy it to /workspace/runpod-slim/ComfyUI and run it unprotected on 8188 -- the template replaces that
  # entrypoint with this script, so ComfyUI runs from the image and only the token proxy is reachable (slice 0).
  for candidate in /opt/comfyui-baked /workspace/runpod-slim/ComfyUI /workspace/ComfyUI /ComfyUI /opt/ComfyUI /app/ComfyUI /comfyui; do
    if [ -f "$candidate/main.py" ]; then COMFY_DIR="$candidate"; break; fi
  done
fi
if [ -z "$COMFY_DIR" ] || [ ! -f "$COMFY_DIR/main.py" ]; then
  log "ComfyUI not found (set COMFY_DIR); candidates: /opt/comfyui-baked /workspace/runpod-slim/ComfyUI /workspace/ComfyUI /ComfyUI /opt/ComfyUI"
  sleep infinity
fi
log "ComfyUI at $COMFY_DIR"

# -- reverse proxy with a bearer check (Caddy static binary, cached on the volume) ----------------
CADDY=/workspace/ytm/bin/caddy
if [ ! -x "$CADDY" ]; then
  mkdir -p /workspace/ytm/bin
  arch="$(uname -m)"; case "$arch" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
  log "downloading caddy ($arch)"
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$arch" -o "$CADDY" && chmod +x "$CADDY" || log "caddy download failed"
fi
if [ -x "$CADDY" ]; then
  "$CADDY" run --config /workspace/ytm/Caddyfile --adapter caddyfile >> /workspace/ytm/logs/caddy.log 2>&1 &
  log "caddy on :8189 -> 127.0.0.1:8188 (bearer token required)"
else
  log "no caddy -> ComfyUI stays reachable on 127.0.0.1 only"
fi

# -- ComfyUI ---------------------------------------------------------------------------------------
cd "$COMFY_DIR"
PY="${COMFY_PYTHON:-python3}"
[ -x "$COMFY_DIR/venv/bin/python" ] && PY="$COMFY_DIR/venv/bin/python"
[ -n "$RUNTIME_PY" ] && PY="$RUNTIME_PY"
log "starting ComfyUI ($PY)"
exec "$PY" main.py \
  --listen 127.0.0.1 --port 8188 \
  --output-directory /workspace/exchange \
  --input-directory /workspace/exchange/in \
  --extra-model-paths-config /workspace/ytm/extra_model_paths.yaml \
  >> /workspace/ytm/logs/comfyui.log 2>&1
