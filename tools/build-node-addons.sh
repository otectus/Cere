#!/usr/bin/env bash
# Builds only the two Node-API modules the broker tests load (same-user peer credentials and the
# telemetry watcher) into build/, without Qt or CMake. The full desktop build produces the same files.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
node_root=$(dirname -- "$(dirname -- "$(command -v node)")")
headers=
for candidate in "$node_root/include/node" /usr/include/node; do
  [[ -f $candidate/node_api.h ]] && { headers=$candidate; break; }
done
[[ -n $headers ]] || { echo "Node-API headers not found next to $(command -v node) or in /usr/include/node" >&2; exit 1; }
mkdir -p build
for addon in peercred telemetry; do
  "${CXX:-g++}" -std=c++20 -O2 -shared -fPIC -I"$headers" "native/$addon.cpp" -o "build/cere-$addon.node"
done
echo "Built build/cere-peercred.node and build/cere-telemetry.node against $headers"
