#!/usr/bin/env bash
# CI containers run as root, and root ignores the file permission bits that some tests rely on
# (an unwritable backup directory, a private runtime directory). Package installation stays root;
# everything that builds or tests the checkout runs as an ordinary user.
#   tools/ci-user.sh setup          as root: create the user and give it the checkout
#   tools/ci-user.sh run CMD [ARGS] run CMD as that user (directly when not root)
set -euo pipefail
user=cere-ci
workspace=${GITHUB_WORKSPACE:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
case ${1-} in
  setup)
    [[ $(id -u) == 0 ]] || { echo "setup needs root; already unprivileged" >&2; exit 0; }
    id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
    install -d -o "$user" "$workspace/reports"
    chown -R "$user:" "$workspace"
    # git refuses repositories owned by another user; the checkout now belongs to $user.
    runuser -u "$user" -- git config --global --add safe.directory "$workspace"
    ;;
  run)
    shift
    [[ $# -gt 0 ]] || { echo "usage: $0 run COMMAND [ARGS...]" >&2; exit 2; }
    if [[ $(id -u) != 0 ]]; then exec "$@"; fi
    home=$(getent passwd "$user" | cut -d: -f6)
    exec runuser -u "$user" -- env "PATH=$PATH" "HOME=$home" "$@"
    ;;
  *) echo "usage: $0 setup | run COMMAND [ARGS...]" >&2; exit 2 ;;
esac
