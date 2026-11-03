#!/usr/bin/env bash
# Runs as root through sprite exec. No Orb or provider token is passed here.
set -euo pipefail
binary_url=${1:?trusted raw Linux Amp binary URL required}
binary_sha=${2:?SHA-256 required}

# Use the native Sprite base. Fail rather than install distro packages on every spawn.
for executable in bash curl sha256sum install useradd groupadd getent sudo visudo git flock setsid timeout getconf sort; do
  command -v "$executable" >/dev/null || { printf 'Missing prerequisite: %s\n' "$executable" >&2; exit 1; }
done
[[ -x /usr/bin/git || -x /opt/git/bin/git ]]
getconf GNU_LIBC_VERSION >/dev/null
git_version=$(git --version | cut -d ' ' -f 3)
[[ "$(printf '2.34.0\n%s\n' "$git_version" | sort -V | head -n 1)" == '2.34.0' ]]

# This lock also serializes remote preparation left running after a controller timeout.
exec 9>/var/lock/amp-orb-prepare.lock
flock -w 20 9
getent group user >/dev/null || groupadd user
id user >/dev/null 2>&1 || useradd --create-home --gid user --shell /bin/bash user
install -d -m 0755 -o user -g user /home/user
sudoers=$(mktemp)
trap 'rm -f "$sudoers" "${binary_tmp:-}"' EXIT
printf 'user ALL=(ALL) NOPASSWD: ALL\n' >"$sudoers"
visudo -cf "$sudoers" >/dev/null
install -m 0440 "$sudoers" /etc/sudoers.d/amp-orb-user

if [[ ! -f /usr/local/bin/amp ]] || ! printf '%s  /usr/local/bin/amp\n' "$binary_sha" | sha256sum --check --status; then
  binary_tmp=$(mktemp)
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 180 "$binary_url" --output "$binary_tmp"
  printf '%s  %s\n' "$binary_sha" "$binary_tmp" | sha256sum --check --status
  install -m 0755 "$binary_tmp" /usr/local/bin/amp
fi
sudo -n -H -u user /usr/local/bin/amp --version >/dev/null
sudo -n -H -u user /usr/local/bin/amp orb bootstrap --help >/dev/null

# Sprites 2 guest CLI is outside sudo's default PATH.
sudo -n -H -u user /.sprite/bin/sprite-env keep-awake status >/dev/null
