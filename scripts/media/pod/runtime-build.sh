#!/usr/bin/env bash
# BL-200 (ADR 0043): builds one pod runtime profile on the network volume, on a pod with the GPU template's image (the cheapest GPU of the list; the GPU is not used).
# Usage (the pod's entrypoint): bash /workspace/ytm/runtime-build.sh <runtimeId>
# Reads ytm/runtimes/<id>/runtime.json; clones ComfyUI and each node pack at their exact commits; creates a venv from the
# image's Python with a .pth to the image's dist-packages (torch is never downloaded again -- probe 1, 2026-10-18); installs
# requirements without torch/torchvision/torchaudio and the pinned pip extras; writes .ready LAST, then build.json
# { ok, seconds, error, finishedAt } (via .part + rename) and idles until the app terminates the pod.
# .lock (a file holding the pod id) stops a second build of the same profile; one older than 2 h is a dead build's and is
# taken over. The app deletes it when it ends a build that did not finish (timeout, pod gone).
# Never contains or receives a RunPod key. BL-230 (ADR 0043 amendment 1): it MAY receive the owner's GitHub read token in the env
# (YTM_GIT_TOKEN) -- sent only to github.com, as a one-shot header on git's own command (never in a URL, a remote, .git/config or
# the log), unset after the clones; the build fails without .ready if the token appears anywhere in the runtime folder.
set -uo pipefail

# --- BL-230 helpers (also sourced by scripts/media/pod/runtime-build.test.ts; they read only their arguments and the two vars). ---
# The token for the leak check, NOT exported (pip and its builds never see it); YTM_GIT_TOKEN itself is unset after the clones.
GUARD_TOKEN="${YTM_GIT_TOKEN:-}"
# git with the token as a one-shot `http.https://github.com/.extraheader` for a github.com URL ($1) when YTM_GIT_TOKEN is set; plain
# git otherwise. The -c goes before the sub-command, so nothing is written to any config; tracing is off while the header exists.
git_net() { # url git-args...
  local url="$1"; shift
  local lower; lower=$(printf '%s' "$url" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    https://github.com/*)
      if [ -n "${YTM_GIT_TOKEN:-}" ]; then
        local traced=0 rc=0 hdr
        case "$-" in *x*) traced=1; set +x ;; esac
        hdr="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$YTM_GIT_TOKEN" | base64 | tr -d '\n')"
        git -c "http.https://github.com/.extraheader=$hdr" "$@" || rc=$?
        hdr=""
        [ "$traced" = 1 ] && set -x
        return "$rc"
      fi ;;
  esac
  git "$@"
}
clone_at() { # repo commit dest
  git init -q "$3" && git -C "$3" remote add origin "$1" && git_net "$1" -C "$3" fetch -q --depth 1 origin "$2" && git -C "$3" checkout -q FETCH_HEAD \
    || { rm -rf "$3"; git_net "$1" clone -q --filter=blob:none "$1" "$3" && git -C "$3" checkout -q "$2"; }
}
# 0 when the folder ($1) holds neither the token nor its base64 header form (or no token was given); 1 otherwise. Prints nothing.
leak_free() { # dir
  [ -n "$GUARD_TOKEN" ] || return 0
  local traced=0 b64 rc=0
  case "$-" in *x*) traced=1; set +x ;; esac
  b64=$(printf 'x-access-token:%s' "$GUARD_TOKEN" | base64 | tr -d '\n')
  if grep -rqsF -e "$GUARD_TOKEN" -e "$b64" "$1" 2>/dev/null; then rc=1; fi
  b64=""
  [ "$traced" = 1 ] && set -x
  return "$rc"
}
# A failed clone's hint: a private github.com repository needs the owner's token.
clone_hint() { # repo
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    https://github.com/*) [ -n "$GUARD_TOKEN" ] || printf '%s' " (a private GitHub repository needs the GitHub token in Settings -> Cloud APIs)" ;;
  esac
}
# Sourced (the test): stop here, before anything touches /workspace.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi

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
  # BL-230: a credential in the folder (any file, build.log included) removes everything but the profile and the lock; never .ready.
  if ! leak_free "$R"; then
    find "$R" -mindepth 1 -maxdepth 1 ! -name runtime.json ! -name .lock ! -name build.log -exec rm -rf {} +
    : > "$R/build.log"
    set -- false "a credential was found in the runtime folder; it was removed and the build refused"
    log "leak check failed"
  fi
  if [ -n "${2:-}" ]; then err=$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()[:500]))'); fi
  printf '{"ok":%s,"seconds":%s,"error":%s,"finishedAt":"%s"}\n' "$1" "$(( $(date +%s) - t0 ))" "$err" "$(date -u +%FT%TZ)" > "$R/build.json.part"
  mv "$R/build.json.part" "$R/build.json"
  [ "$(cat "$R/.lock" 2>/dev/null)" = "${RUNPOD_POD_ID:-unknown}" ] && rm -f "$R/.lock"
  log "YTM_BUILD_DONE ok=$1"
  sleep infinity
}
[ -f "$R/runtime.json" ] || { log "no runtime.json"; finish false "runtime.json is missing on the volume"; }
[ -f "$R/.ready" ] && finish true ""
ME="${RUNPOD_POD_ID:-unknown}"
# The lock is taken atomically (noclobber); one older than 2 h is a dead build's and is replaced. A pod that loses the lock EXITS
# without writing build.json -- a verdict here would be read as the other, still running build's (review) -- and the app fails
# its own build at once on "pod exited before build.json".
if [ -f "$R/.lock" ] && [ "$(cat "$R/.lock" 2>/dev/null)" != "$ME" ] && [ $(( $(date +%s) - $(stat -c %Y "$R/.lock") )) -ge 7200 ]; then
  log "replacing a stale lock ($(cat "$R/.lock" 2>/dev/null))"
  rm -f "$R/.lock"
fi
if ! ( set -C; printf '%s\n' "$ME" > "$R/.lock" ) 2>/dev/null && [ "$(cat "$R/.lock" 2>/dev/null)" != "$ME" ]; then
  log "another build ($(cat "$R/.lock" 2>/dev/null)) holds the lock; exiting"
  exit 3
fi
rm -f "$R/build.json" "$R/build.json.part"
log "build $ID start $(date -u +%FT%TZ)"
rm -rf "$R/ComfyUI" "$R/venv" "$R/req.txt" "$R/constraints.txt"

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
read -r CREPO CCOMMIT < <(spec comfy)
log "comfy $CREPO@$CCOMMIT"
clone_at "$CREPO" "$CCOMMIT" "$R/ComfyUI" || finish false "could not fetch ComfyUI $CREPO at $CCOMMIT$(clone_hint "$CREPO")"
[ "$(git -C "$R/ComfyUI" rev-parse HEAD)" = "$CCOMMIT" ] || finish false "ComfyUI is not at $CCOMMIT"

while read -r NREPO NCOMMIT; do
  [ -n "$NREPO" ] || continue
  NAME=$(basename "$NREPO")
  log "node $NAME@$NCOMMIT"
  clone_at "$NREPO" "$NCOMMIT" "$R/ComfyUI/custom_nodes/$NAME" || finish false "could not fetch $NREPO at $NCOMMIT$(clone_hint "$NREPO")"
  [ "$(git -C "$R/ComfyUI/custom_nodes/$NAME" rev-parse HEAD)" = "$NCOMMIT" ] || finish false "$NAME is not at $NCOMMIT"
done < <(spec nodes)
# BL-230: the clones are done; nothing after this (pip, its builds) sees the token.
unset YTM_GIT_TOKEN

log venv
BASEEXE=$("$BASE" -c "import sys;print(getattr(sys,'_base_executable',sys.executable))")
"$BASEEXE" -m venv "$R/venv" || finish false "venv creation failed"
VSITE=$("$R/venv/bin/python" -c "import site;print(site.getsitepackages()[0])")
"$BASE" -c "import site;print('\n'.join(site.getsitepackages()))" > "$VSITE/zz-image-site.pth"
"$R/venv/bin/python" -c "import torch" || finish false "the image's torch is not visible from the venv"

filter() { grep -viE '^[[:space:]]*(torch|torchvision|torchaudio)([<>=~!; [@]|$)' "$1" | grep -vE '^[[:space:]]*(#|-e |--)' ; }
# The image's torch stack is pinned as a constraint, so no requirement (direct or transitive) can install another torch into the
# venv; the build fails if pip cannot satisfy that, and again if the venv's torch is not the image's afterwards (review).
"$BASE" - > "$R/constraints.txt" <<'PY'
from importlib import metadata
for name in ("torch", "torchvision", "torchaudio"):
    try:
        print(f"{name}=={metadata.version(name)}")
    except metadata.PackageNotFoundError:
        pass
PY
BASE_TORCH=$("$BASE" -c "import torch;print(torch.__version__)")
: > "$R/req.txt"
filter "$R/ComfyUI/requirements.txt" >> "$R/req.txt"
for f in "$R"/ComfyUI/custom_nodes/*/requirements.txt; do [ -f "$f" ] && filter "$f" >> "$R/req.txt"; done
spec pip >> "$R/req.txt"
log "pip ($(grep -c . "$R/req.txt") lines)"
"$R/venv/bin/python" -m pip install --disable-pip-version-check -q -r "$R/req.txt" -c "$R/constraints.txt" || finish false "pip install failed (see build.log)"
VENV_TORCH=$("$R/venv/bin/python" -c "import torch;print(torch.__version__)") || finish false "torch broken after pip"
[ "$VENV_TORCH" = "$BASE_TORCH" ] || finish false "pip replaced the image's torch $BASE_TORCH with $VENV_TORCH"

leak_free "$R" || finish false "a credential was found in the runtime folder"
touch "$R/.ready"
finish true ""
