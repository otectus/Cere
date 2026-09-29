#!/usr/bin/env python3
"""Tiny, dependency-free Fish event emitter. It never imports Cere application code."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import uuid


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(add_help=False)
    result.add_argument("--print-session-id", action="store_true")
    result.add_argument("--event", choices=("start", "exit", "cwd", "postexec", "posterror", "focus_in", "focus_out"))
    result.add_argument("--session-id")
    result.add_argument("--sequence", type=int)
    result.add_argument("--cwd")
    result.add_argument("--status", type=int)
    result.add_argument("--pipeline-status", action="append", type=int, default=[])
    result.add_argument("--duration-ms", type=int)
    result.add_argument("--kitty-window-id")
    result.add_argument("--socket")
    result.add_argument("--timeout-ms", type=int, default=15)
    return result


def socket_path(explicit: str | None) -> str:
    if explicit:
        return explicit
    configured = os.environ.get("CERE_MEMORY_SOCKET")
    if configured:
        return configured
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime:
        raise ValueError("XDG_RUNTIME_DIR is unavailable")
    return os.path.join(runtime, "cere-memory", "memory.sock")


def main() -> int:
    args = parser().parse_args()
    if args.print_session_id:
        sys.stdout.write(str(uuid.uuid4()))
        return 0
    if not args.event or not args.session_id or args.sequence is None or args.sequence < 1 or args.cwd is None:
        return 2
    params: dict[str, object] = {
        "source": "fish",
        "source_epoch": args.session_id,
        "source_sequence": args.sequence,
        "event": args.event,
        "shell_session_id": args.session_id,
        "cwd": args.cwd,
    }
    if args.status is not None:
        params["status"] = args.status
    if args.pipeline_status:
        params["pipeline_status"] = args.pipeline_status
    if args.duration_ms is not None and args.duration_ms >= 0:
        params["duration_ms"] = args.duration_ms
    if args.kitty_window_id:
        params["terminal_binding"] = {"kind": "kitty_window_id", "id": args.kitty_window_id}
    request = {
        "protocol_version": 1,
        "request_id": str(uuid.uuid4()),
        "method": "collector.emit",
        "params": params,
    }
    encoded = (json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(encoded) > 64 * 1024:
        return 2
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(max(1, args.timeout_ms) / 1000)
    try:
        client.connect(socket_path(args.socket))
        client.sendall(encoded)
    except (OSError, ValueError):
        return 0
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
