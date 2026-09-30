#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly COMPOSE_FILE="$PROJECT_DIR/packaging/memory-compose.yml"
readonly NEO4J_VERSION="5.26.31"
readonly NEO4J_SHA256="f8fc23340561405f1ff10ca6ac2d317d095d3c74509a616883c45d7a61f5cfec"
readonly QDRANT_VERSION="1.19.1"
readonly QDRANT_SHA256_X86_64="eef986e769d4d3e806dd2d546e1b4ecdd416211e54d34b4ed764fac7c58e1085"
readonly QDRANT_SHA256_AARCH64="0e607c11705fab22f7d667f4749bc0b6b60a8fa9e91de71880a6ebafbbda1b26"
readonly DEPS_HOME="${CERE_MEMORY_DEPS_HOME:-${XDG_STATE_HOME:-${HOME}/.local/state}/cere-memory/dependencies}"
readonly ENV_FILE="${CERE_MEMORY_ENV_FILE:-${XDG_CONFIG_HOME:-${HOME}/.config}/cere-memory/dependencies.env}"

usage() {
  echo "usage: $0 {up|down|status|logs|local-install|local-start|local-stop|check}"
}

check_env_file() {
  [[ -f "$ENV_FILE" ]] || { echo "missing private environment file: $ENV_FILE" >&2; return 1; }
  local mode
  mode="$(stat -c '%a' "$ENV_FILE")"
  [[ "$mode" == "600" || "$mode" == "400" ]] || { echo "environment file must have mode 600 or 400: $ENV_FILE" >&2; return 1; }
}

compose() {
  check_env_file
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    podman compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  else
    echo "Docker Compose and Podman Compose are unavailable; use local-install/local-start." >&2
    return 1
  fi
}

verified_download() {
  local url="$1" destination="$2" expected="$3"
  mkdir -p -- "$(dirname -- "$destination")"
  if [[ ! -f "$destination" ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 --output "$destination.part" "$url"
    mv -- "$destination.part" "$destination"
  fi
  printf '%s  %s\n' "$expected" "$destination" | sha256sum --check --status || {
    echo "checksum mismatch: $destination" >&2
    return 1
  }
}

local_install() {
  local downloads neo4j_archive
  downloads="$DEPS_HOME/downloads"
  neo4j_archive="$downloads/neo4j-community-$NEO4J_VERSION-unix.tar.gz"
  verified_download "https://dist.neo4j.org/neo4j-community-$NEO4J_VERSION-unix.tar.gz" "$neo4j_archive" "$NEO4J_SHA256"
  if [[ ! -x "$DEPS_HOME/neo4j/bin/neo4j" ]]; then
    mkdir -p "$DEPS_HOME/neo4j"
    tar -xzf "$neo4j_archive" --strip-components=1 -C "$DEPS_HOME/neo4j"
  fi

  local architecture qdrant_target qdrant_sha qdrant_archive
  architecture="$(uname -m)"
  case "$architecture" in
    x86_64) qdrant_target="x86_64-unknown-linux-gnu"; qdrant_sha="$QDRANT_SHA256_X86_64" ;;
    aarch64|arm64) qdrant_target="aarch64-unknown-linux-musl"; qdrant_sha="$QDRANT_SHA256_AARCH64" ;;
    *) echo "unsupported Qdrant architecture: $architecture" >&2; return 1 ;;
  esac
  qdrant_archive="$downloads/qdrant-$qdrant_target-$QDRANT_VERSION.tar.gz"
  verified_download "https://github.com/qdrant/qdrant/releases/download/v$QDRANT_VERSION/qdrant-$qdrant_target.tar.gz" "$qdrant_archive" "$qdrant_sha"
  if [[ ! -x "$DEPS_HOME/qdrant/qdrant" ]]; then
    mkdir -p "$DEPS_HOME/qdrant"
    tar -xzf "$qdrant_archive" -C "$DEPS_HOME/qdrant"
    chmod 700 "$DEPS_HOME/qdrant/qdrant"
  fi
  echo "installed locked dependencies under $DEPS_HOME"
}

load_secrets() {
  check_env_file
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  : "${NEO4J_PASSWORD:?NEO4J_PASSWORD is required}"
  : "${QDRANT_API_KEY:?QDRANT_API_KEY is required}"
}

# Qdrant PID records hold "pid start-time executable". A record is trusted only while
# the live process has the same owner, executable and kernel start time, so a reused
# PID can never receive a signal meant for Qdrant. PIDs 0 and 1 are never valid.
readonly QDRANT_RECORD="$DEPS_HOME/run/qdrant.pid"
process_start() {
  local stat
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  stat="${stat##*) }"
  # shellcheck disable=SC2086
  set -- $stat
  [[ -n "${20:-}" ]] && printf '%s\n' "${20}"
}
qdrant_executable() { realpath -e -- "$DEPS_HOME/qdrant/qdrant" 2>/dev/null; }
record_qdrant() {
  local pid="$1" start executable
  start="$(process_start "$pid")" || return 1
  executable="$(readlink -f "/proc/$pid/exe" 2>/dev/null)" || return 1
  (umask 077 && printf '%s %s %s\n' "$pid" "$start" "$executable" >"$QDRANT_RECORD")
}
qdrant_pid() {
  [[ -f "$QDRANT_RECORD" ]] || return 1
  local pid="" start="" executable="" expected
  read -r pid start executable <"$QDRANT_RECORD" || true
  expected="$(qdrant_executable)" || expected=""
  if [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && "$start" =~ ^[0-9]+$ && -n "$executable" && "$executable" == "$expected" ]] &&
    [[ "$(stat -c '%u' "/proc/$pid" 2>/dev/null)" == "$(id -u)" ]] &&
    [[ "$(readlink -f "/proc/$pid/exe" 2>/dev/null)" == "$executable" ]] &&
    [[ "$(process_start "$pid")" == "$start" ]]; then
    printf '%s\n' "$pid"
    return 0
  fi
  echo "removing stale Qdrant PID record without signaling" >&2
  rm -f -- "$QDRANT_RECORD"
  return 1
}

wait_port() {
  local name="$1" port="$2"
  [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || { echo "invalid $name port: $port" >&2; return 1; }
  for _ in $(seq 1 60); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then exec 3>&-; exec 3<&-; return 0; fi
    sleep 0.25
  done
  echo "$name did not become ready on loopback port $port" >&2
  return 1
}

local_start() {
  load_secrets
  [[ -x "$DEPS_HOME/neo4j/bin/neo4j" && -x "$DEPS_HOME/qdrant/qdrant" ]] || { echo "run local-install first" >&2; return 1; }
  local java_major
  java_major="$(java -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p')"
  [[ "$java_major" =~ ^[0-9]+$ && "$java_major" -ge 17 ]] || { echo "Neo4j $NEO4J_VERSION requires Java 17 or newer" >&2; return 1; }
  mkdir -p "$DEPS_HOME/run" "$DEPS_HOME/qdrant-storage"
  chmod 700 "$DEPS_HOME" "$DEPS_HOME/run" "$DEPS_HOME/qdrant-storage"
  local neo4j_config="$DEPS_HOME/neo4j/conf/neo4j.conf"
  sed -i '/^# CERE_MEMORY_BEGIN$/,/^# CERE_MEMORY_END$/d' "$neo4j_config"
  printf '%s\n' \
    '# CERE_MEMORY_BEGIN' \
    'server.default_listen_address=127.0.0.1' \
    "server.bolt.listen_address=127.0.0.1:${NEO4J_BOLT_PORT:-7687}" \
    "server.http.listen_address=127.0.0.1:${NEO4J_HTTP_PORT:-7474}" \
    'dbms.usage_report.enabled=false' \
    '# CERE_MEMORY_END' >>"$neo4j_config"
  if [[ ! -f "$DEPS_HOME/neo4j/data/dbms/auth.ini" && ! -f "$DEPS_HOME/neo4j/data/dbms/auth" ]]; then
    "$DEPS_HOME/neo4j/bin/neo4j-admin" dbms set-initial-password "$NEO4J_PASSWORD" >/dev/null
  fi
  NEO4J_server_default__listen__address=127.0.0.1 \
  NEO4J_server_bolt_listen__address="127.0.0.1:${NEO4J_BOLT_PORT:-7687}" \
  NEO4J_server_http_listen__address="127.0.0.1:${NEO4J_HTTP_PORT:-7474}" \
    "$DEPS_HOME/neo4j/bin/neo4j" start
  if qdrant_pid >/dev/null; then
    echo "Qdrant is already running"
  else
    QDRANT__STORAGE__STORAGE_PATH="$DEPS_HOME/qdrant-storage" QDRANT__SERVICE__HOST=127.0.0.1 \
    QDRANT__SERVICE__HTTP_PORT="${QDRANT_HTTP_PORT:-6333}" QDRANT__SERVICE__API_KEY="$QDRANT_API_KEY" QDRANT__TELEMETRY_DISABLED=true \
      nohup "$DEPS_HOME/qdrant/qdrant" >"$DEPS_HOME/run/qdrant.log" 2>&1 &
    local started="$!"
    for _ in $(seq 1 20); do [[ "$(readlink -f "/proc/$started/exe" 2>/dev/null)" == "$(qdrant_executable)" ]] && break; sleep 0.05; done
    record_qdrant "$started" || { echo "Qdrant exited before its identity could be recorded" >&2; return 1; }
    chmod 600 "$DEPS_HOME/run/qdrant.log"
  fi
  wait_port Neo4j "${NEO4J_BOLT_PORT:-7687}"
  wait_port Qdrant "${QDRANT_HTTP_PORT:-6333}"
  echo "Neo4j and Qdrant are ready on loopback"
}

local_stop() {
  "$DEPS_HOME/neo4j/bin/neo4j" stop 2>/dev/null || true
  local pid
  if pid="$(qdrant_pid)"; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do
      qdrant_pid >/dev/null 2>&1 || break
      sleep 0.1
    done
    # Identity is rechecked immediately before escalation.
    if [[ "$(qdrant_pid 2>/dev/null)" == "$pid" ]]; then kill -KILL "$pid" 2>/dev/null || true; fi
    rm -f -- "$QDRANT_RECORD"
  fi
}

local_check() {
  local state_file="$DEPS_HOME/run/adapter-check-state.json"
  rm -f -- "$state_file"
  trap 'local_stop' EXIT
  local_start
  node "$PROJECT_DIR/tools/check-memory-adapters.ts" --phase prepare --state "$state_file"
  local_stop
  local_start
  node "$PROJECT_DIR/tools/check-memory-adapters.ts" --phase verify --state "$state_file"
  local_stop
  trap - EXIT
}

case "${1:-}" in
  up) compose up -d --wait ;;
  down) compose down ;;
  status) if command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1; then compose ps; else "$DEPS_HOME/neo4j/bin/neo4j" status 2>/dev/null || true; if pid="$(qdrant_pid)"; then ps -p "$pid" -o pid=,stat=,cmd=; fi; fi ;;
  logs) compose logs --tail=200 ;;
  local-install) local_install ;;
  local-start) local_start ;;
  local-stop) local_stop ;;
  check) local_check ;;
  *) usage; exit 2 ;;
esac
