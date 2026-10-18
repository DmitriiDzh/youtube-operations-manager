#!/usr/bin/env bash
# BL-200 (ADR 0043): builds one pod runtime profile on the network volume, on a CPU pod with the GPU template's image.
# Usage (the pod's entrypoint): bash /workspace/ytm/runtime-build.sh <runtimeId>
# Reads ytm/runtimes/<id>/runtime.json; clones ComfyUI and each node pack at their exact commits; creates a venv from the
# image's Python with a .pth to the image's dist-packages (torch is never downloaded again -- probe 1, 2026-10-18); installs
# requirements without torch/torchvision/torchaudio and the pinned pip extras; writes .ready LAST, then build.json
# { ok, seconds, error, finishedAt } (via .part + rename) and idles until the app terminates the pod.
# .lock (a file holding the pod id) stops a second build of the same profile; one older than 2 h is a dead build's and is
# taken over. The app deletes it when it ends a build that did not finish (timeout, pod gone).
# Never contains or receives a RunPod key or any token.
set -uo pipefail
ID="${1:-}"
case "$ID" in ''|*[!a-z0-9-]*) echo "bad runtime id"; sleep infinity ;; esac
R="/workspace/ytm/runtimes/$ID"
mkdir -p "$R"
exec >>"$R/build.log" 2>&1
t0=$(date +%s)
log() { echo "[$(( $(date +%s) - t0 ))s] $*"; }
finish() {
  # $1 = true|false, $2 = error text (plain) or empty
  local err="null"
  if [ -n "${2:-}" ]; then err=$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()[:500]))'); fi
  printf '{"ok":%s,"seconds":%s,"error":%s,"finishedAt":"%s"}\n' "$1" "$(( $(date +%s) - t0 ))" "$err" "$(date -u +%FT%TZ)" > "$R/build.json.part"
  mv "$R/build.json.part" "$R/build.json"
  rm -f "$R/.lock"
  log "YTM_BUILD_DONE ok=$1"
  sleep infinity
}
[ -f "$R/runtime.json" ] || { log "no runtime.json"; finish false "runtime.json is missing on the volume"; }
[ -f "$R/.ready" ] && finish true ""
ME="${RUNPOD_POD_ID:-unknown}"
if [ -f "$R/.lock" ] && [ "$(cat "$R/.lock" 2>/dev/null)" != "$ME" ] && [ $(( $(date +%s) - $(stat -c %Y "$R/.lock") )) -lt 7200 ]; then
  log "another build ($(cat "$R/.lock" 2>/dev/null)) holds the lock"
  sleep infinity
fi
printf '%s\n' "$ME" > "$R/.lock"
rm -f "$R/build.json"
log "build $ID start $(date -u +%FT%TZ)"
rm -rf "$R/ComfyUI" "$R/venv" "$R/req.txt"

BASE=""
for py in /usr/bin/python3 /usr/local/bin/python3 /opt/venv/bin/python; do
  [ -x "$py" ] && "$py" -c "import torch" 2>/dev/null && { BASE="$py"; break; }
done
[ -n "$BASE" ] || finish false "no Python with torch in the image"
log "base python $BASE"

spec() { "$BASE" - "$R/runtime.json" "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); what = sys.argv[2]
if what == "comfy": print(d["comfy"]["repo"], d["comfy"]["commit"])
elif what == "nodes":
    for n in d["customNodes"]: print(n["repo"], n["commit"])
elif what == "pip": print("\n".join(d["pip"]))
PY
}
clone_at() { # repo commit dest
  git init -q "$3" && git -C "$3" remote add origin "$1" && git -C "$3" fetch -q --depth 1 origin "$2" && git -C "$3" checkout -q FETCH_HEAD \
    || { rm -rf "$3"; git clone -q --filter=blob:none "$1" "$3" && git -C "$3" checkout -q "$2"; }
}

read -r CREPO CCOMMIT < <(spec comfy)
log "comfy $CREPO@$CCOMMIT"
clone_at "$CREPO" "$CCOMMIT" "$R/ComfyUI" || finish false "could not fetch ComfyUI $CREPO at $CCOMMIT"
[ "$(git -C "$R/ComfyUI" rev-parse HEAD)" = "$CCOMMIT" ] || finish false "ComfyUI is not at $CCOMMIT"

while read -r NREPO NCOMMIT; do
  [ -n "$NREPO" ] || continue
  NAME=$(basename "$NREPO")
  log "node $NAME@$NCOMMIT"
  clone_at "$NREPO" "$NCOMMIT" "$R/ComfyUI/custom_nodes/$NAME" || finish false "could not fetch $NREPO at $NCOMMIT"
  [ "$(git -C "$R/ComfyUI/custom_nodes/$NAME" rev-parse HEAD)" = "$NCOMMIT" ] || finish false "$NAME is not at $NCOMMIT"
done < <(spec nodes)

log venv
BASEEXE=$("$BASE" -c "import sys;print(getattr(sys,'_base_executable',sys.executable))")
"$BASEEXE" -m venv "$R/venv" || finish false "venv creation failed"
VSITE=$("$R/venv/bin/python" -c "import site;print(site.getsitepackages()[0])")
"$BASE" -c "import site;print('\n'.join(site.getsitepackages()))" > "$VSITE/zz-image-site.pth"
"$R/venv/bin/python" -c "import torch" || finish false "the image's torch is not visible from the venv"

filter() { grep -viE '^[[:space:]]*(torch|torchvision|torchaudio)([<>=~ ;[]|$)' "$1" | grep -vE '^[[:space:]]*(#|-e |--)' ; }
: > "$R/req.txt"
filter "$R/ComfyUI/requirements.txt" >> "$R/req.txt"
for f in "$R"/ComfyUI/custom_nodes/*/requirements.txt; do [ -f "$f" ] && filter "$f" >> "$R/req.txt"; done
spec pip >> "$R/req.txt"
log "pip ($(grep -c . "$R/req.txt") lines)"
"$R/venv/bin/python" -m pip install --disable-pip-version-check -q -r "$R/req.txt" || finish false "pip install failed (see build.log)"
"$R/venv/bin/python" -c "import torch, sys; print('torch', torch.__version__)" || finish false "torch broken after pip"

touch "$R/.ready"
finish true ""
