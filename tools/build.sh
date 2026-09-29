#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ -d .local-deps/usr ]]; then
  export PATH="$PWD/.local-deps/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$PWD/.local-deps/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export CMAKE_PREFIX_PATH="$PWD/.local-deps/usr${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}"
fi
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build --parallel 4
