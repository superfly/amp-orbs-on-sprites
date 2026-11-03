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
hold
/usr/local/bin/amp orb bootstrap &
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
