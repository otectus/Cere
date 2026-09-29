#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ ! -x build/cere ]]; then ./tools/build.sh; fi
if [[ -d .local-deps/usr ]]; then
  export LD_LIBRARY_PATH="$PWD/.local-deps/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export QT_PLUGIN_PATH="$PWD/.local-deps/usr/lib/qt6/plugins${QT_PLUGIN_PATH:+:$QT_PLUGIN_PATH}"
fi
export QT_QUICK_CONTROLS_STYLE=Basic
exec ./build/cere --root "$PWD" "$@"
