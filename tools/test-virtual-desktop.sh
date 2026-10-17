#!/usr/bin/env bash
# Run a command on a private, headless Wayland desktop. No host input devices,
# desktop sockets, session bus, profile, or display controller enter the sandbox.
# Requires bubblewrap, Hyprland, Cage, and a GPU render node (no DRM card node).
# CERE_CAGE_BINARY supports a project-local extracted Cage installation.
set -euo pipefail
if [[ ${1-} == --inside || ${1-} == --display-environment ]]; then
  root=${CERE_SOURCE_ROOT:?Missing isolated source root}
else
  root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fi
if [[ ${1-} == --display-environment ]]; then
  [[ ${CERE_VIRTUAL_DESKTOP-} == 1 && ! -e /dev/uinput && ! -e /dev/input ]] || exit 2
  printf '%s\n' "${DISPLAY-}" > "$CERE_VIRTUAL_EVIDENCE/xdisplay"
  printf '%s\n' "${XAUTHORITY-}" > "$CERE_VIRTUAL_EVIDENCE/xauthority"
  exit
fi
if [[ ${1-} != --inside ]]; then
  [[ $# -gt 0 ]] || { echo "Usage: $0 COMMAND [ARGS...]" >&2; exit 2; }
  out=${CERE_VIRTUAL_EVIDENCE:-$root/build/virtual-desktop/$(date +%s)-$$}
  mkdir -p "$out/tmp"
  out=$(realpath "$out")
  # A long-running command must not read a partially updated runner on return.
  cp -- "$root/tools/test-virtual-desktop.sh" "$out/runner.sh"
  render=${CERE_RENDER_NODE:-/dev/dri/renderD128}
  [[ -c $render && $render == /dev/dri/renderD* ]] || { echo "Choose a GPU render node with CERE_RENDER_NODE" >&2; exit 2; }
  cage_binary=${CERE_CAGE_BINARY:-/usr/bin/cage}
  exec bwrap --die-with-parent --new-session --unshare-all --ro-bind / / --proc /proc --dev /dev \
    --dev-bind "$render" "$render" --tmpfs /run --dir /run/user/$(id -u) \
    --tmpfs "$HOME" --bind "$root" "$root" --bind "$out/tmp" /tmp \
    --chdir "$root" -- \
    env -i HOME="$HOME" USER="$(id -un)" LOGNAME="$(id -un)" PATH=/usr/bin:/bin \
    LANG=C.UTF-8 TZ="${TZ:-America/New_York}" XDG_RUNTIME_DIR=/run/user/$(id -u) \
    CERE_VIRTUAL_DESKTOP=1 CERE_SOURCE_ROOT="$root" CERE_VIRTUAL_EVIDENCE="$out" CERE_CAGE_BINARY="$cage_binary" CERE_RENDER_NODE="$render" \
    CERE_TTS_DISABLED=1 CERE_HOST_EXEC="$root/build/cere" QTEST_FUNCTION_TIMEOUT=900000 \
    dbus-run-session -- bash "$out/runner.sh" --inside "$@"
fi
shift
[[ ${CERE_VIRTUAL_DESKTOP-} == 1 && ! -e /dev/uinput && ! -e /dev/input ]] || exit 2
out=$CERE_VIRTUAL_EVIDENCE
mkdir -p "$HOME/.config" "$HOME/.cache" "$HOME/.local/state" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache" XDG_STATE_HOME="$HOME/.local/state"
export CERE_STATE_DIR="$XDG_STATE_HOME/cere" CERE_RUNTIME_DIR="$XDG_RUNTIME_DIR/cere"
export HYPRLAND_NO_SD_VARS=1 HYPRLAND_NO_SD_NOTIFY=1 HYPRLAND_NO_RT=1
export XDG_CURRENT_DESKTOP=Hyprland XDG_SESSION_TYPE=wayland
WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_RENDERER=gles2 WLR_RENDER_DRM_DEVICE="$CERE_RENDER_NODE" \
  "$CERE_CAGE_BINARY" -- sh -c 'printf "%s" "$WAYLAND_DISPLAY" > "$CERE_VIRTUAL_EVIDENCE/parent-display"; exec sleep infinity' \
  > "$out/cage.log" 2>&1 &
parent_pid=$!
hypr_pid=
cleanup() {
  for log in "$XDG_RUNTIME_DIR"/hypr/*/hyprland.log; do
    [[ ! -f $log ]] || cp "$log" "$out/hyprland-runtime.log"
  done
  [[ -z $hypr_pid ]] || kill "$hypr_pid" 2>/dev/null || true
  kill "$parent_pid" 2>/dev/null || true
  sleep .2
  [[ -z $hypr_pid ]] || kill -KILL "$hypr_pid" 2>/dev/null || true
  kill -KILL "$parent_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT
for ((n=0;n<100;n++)); do [[ -s $out/parent-display ]] && break; kill -0 "$parent_pid" || { cat "$out/cage.log"; exit 1; }; sleep .1; done
[[ -s $out/parent-display ]] || { cat "$out/cage.log"; exit 1; }
parent_display=$(cat "$out/parent-display")
export WAYLAND_DISPLAY=$parent_display
Hyprland --config "$root/tests/fixtures/virtual-hyprland.lua" > "$out/hyprland.log" 2>&1 &
hypr_pid=$!
for ((n=0;n<150;n++)); do
  for socket in "$XDG_RUNTIME_DIR"/wayland-*; do [[ -S $socket && ${socket##*/} != "$parent_display" ]] && export WAYLAND_DISPLAY=${socket##*/}; done
  [[ $WAYLAND_DISPLAY != "$parent_display" ]] && break
  kill -0 "$hypr_pid" || { tail -60 "$out/hyprland.log"; exit 1; }
  sleep .1
done
[[ $WAYLAND_DISPLAY != "$parent_display" ]] || { tail -60 "$out/hyprland.log"; exit 1; }
for ((n=0;n<150;n++)); do
  for instance in "$XDG_RUNTIME_DIR"/hypr/*; do [[ -S $instance/.socket.sock ]] && export HYPRLAND_INSTANCE_SIGNATURE=${instance##*/}; done
  [[ -n ${HYPRLAND_INSTANCE_SIGNATURE-} ]] && break
  kill -0 "$hypr_pid" || { tail -60 "$out/hyprland.log"; exit 1; }
  sleep .1
done
[[ -n ${HYPRLAND_INSTANCE_SIGNATURE-} ]] || exit 1
hyprctl output create headless CERE-TEST > "$out/create-output.txt"
for ((n=0;n<150;n++)); do
  hyprctl -j monitors > "$out/monitors.json"
  if node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1])).length ? 0 : 1)' "$out/monitors.json"; then break; fi
  sleep .1
done
node -e 'if (!JSON.parse(require("fs").readFileSync(process.argv[1])).length) throw Error("No virtual output")' "$out/monitors.json"
hyprctl configerrors > "$out/config-errors.txt"
[[ -z $(cat "$out/config-errors.txt") ]] || { cat "$out/config-errors.txt"; exit 1; }
# Qt's offscreen OpenGL backend still opens an X connection. Obtain only the
# nested compositor's Xwayland environment; no host DISPLAY or cookie is used.
hyprctl dispatch "hl.dsp.exec_cmd(\"bash '$out/runner.sh' --display-environment\")" > "$out/xwayland-environment.txt"
for ((n=0;n<100;n++)); do [[ -f $out/xauthority ]] && break; sleep .1; done
[[ -s $out/xdisplay && -f $out/xauthority ]] || { echo "Missing private Xwayland environment" >&2; exit 1; }
export DISPLAY=$(cat "$out/xdisplay")
export XAUTHORITY=$(cat "$out/xauthority")
hyprctl -j devices > "$out/devices-before.json"
printf 'private_pid_namespace=%s\nprivate_network_namespace=%s\nwayland=%s\nhyprland=%s\nsession_bus=%s\n' \
  "$(readlink /proc/self/ns/pid)" "$(readlink /proc/self/ns/net)" "$WAYLAND_DISPLAY" "$HYPRLAND_INSTANCE_SIGNATURE" "$DBUS_SESSION_BUS_ADDRESS" > "$out/isolation.txt"
if [[ -d $root/.local-deps/usr ]]; then
  export PATH="$root/.local-deps/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$root/.local-deps/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export QT_PLUGIN_PATH="$root/.local-deps/usr/lib/qt6/plugins"
fi
export QT_QPA_PLATFORM=wayland QT_QUICK_BACKEND=rhi QSG_RHI_BACKEND=opengl QT_QUICK_CONTROLS_STYLE=Basic
status=0
"$@" || status=$?
printf '%s\n' "$status" > "$out/command.exit"
hyprctl -j devices > "$out/devices-after.json" || true
exit "$status"
