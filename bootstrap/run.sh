#!/usr/bin/env bash
# A supervised service owns this wrapper and its children. Keep Amp's outbound
# connection alive until Amp sends pause; releasing the hold permits idle sleep.
set -euo pipefail
amp_pid=''
sleep_pid=''
hold() { /.sprite/bin/sprite-env keep-awake --for 2m >/dev/null; }
release() { /.sprite/bin/sprite-env keep-awake --release >/dev/null; }
cleanup() {
  trap - EXIT INT TERM
  release 2>/dev/null || true
  if [[ -n "$sleep_pid" ]]; then kill "$sleep_pid" 2>/dev/null || true; fi
  if [[ -n "$amp_pid" ]]; then
    kill "$amp_pid" 2>/dev/null || true
    wait "$amp_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
# Amp updates itself into ~/.amp/bin/amp and then restarts by re-executing the
# path it was started from. Started from the pinned /usr/local/bin/amp, that
# restart runs the old binary again and loops without ever connecting, so run
# the copy Amp's own updater maintains once a working one exists.
amp_bin=/usr/local/bin/amp
updated_bin="$HOME/.amp/bin/amp"
if [[ -x "$updated_bin" ]] && "$updated_bin" --version >/dev/null 2>&1; then amp_bin=$updated_bin; fi
hold
"$amp_bin" orb bootstrap &
amp_pid=$!
while kill -0 "$amp_pid" 2>/dev/null; do
  sleep 30 &
  sleep_pid=$!
  wait "$sleep_pid"
  sleep_pid=''
  if ! kill -0 "$amp_pid" 2>/dev/null; then break; fi
  if ! hold; then
    printf 'Unable to renew Sprite activity hold; restarting bootstrap.\n' >&2
    exit 1
  fi
done
wait "$amp_pid"
