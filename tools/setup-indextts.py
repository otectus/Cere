#!/usr/bin/env python3
"""Pinned, resumable IndexTTS installation. Uses only the host standard library."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PIN = json.loads((ROOT / "packaging/indextts-manifest.json").read_text())


class InstallError(Exception):
    pass


def emit(state, **fields):
    print(json.dumps(dict(state=state, **fields)), flush=True)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""):
            h.update(b)
    return h.hexdigest()


def private(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise InstallError("INVALID_PATH")
    path.chmod(0o700)
    return path


def download(url, target, sha, size=0, progress=None):
    private(target.parent)
    if target.is_file() and digest(target) == sha:
        if progress:
            progress(size)
        return
    partial = target.with_name(target.name + ".partial")
    if partial.is_symlink() or target.is_symlink():
        raise InstallError("INVALID_PATH")
    offset = partial.stat().st_size if partial.exists() else 0
    if size and offset >= size:
        if offset == size and digest(partial) == sha:
            partial.replace(target)
            if progress:
                progress(size)
            return
        partial.unlink()
        offset = 0
    headers = {"User-Agent": "Cere-IndexTTS/1"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
        if offset and response.status != 206:
            offset = 0
        if offset and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
            raise InstallError("DOWNLOAD_FAILED")
        with partial.open("ab" if offset else "wb") as f:
            partial.chmod(0o600)
            last = 0
            while block := response.read(1024 * 1024):
                f.write(block)
                offset += len(block)
                if size and offset > size:
                    raise InstallError("CHECKSUM_MISMATCH")
                if progress and time.monotonic() - last > .3:
                    progress(offset)
                    last = time.monotonic()
    if (size and partial.stat().st_size != size) or digest(partial) != sha:
        partial.unlink(missing_ok=True)
        raise InstallError("CHECKSUM_MISMATCH")
    partial.replace(target)
    if progress:
        progress(size or offset)


def artifacts(version, emotion):
    for key in [version, *PIN["models"][version]["aux"]]:
        repo = PIN["artifacts"][key]
        for entry in repo["files"]:
            if entry.get("optional") == "emotion" and not emotion:
                continue
            yield dict(entry, repo=repo["repo"], revision=repo["revision"])


def run(args, env):
    # Never copy uncontrolled child output into application logs.
    with open(os.devnull, "wb") as sink:
        result = subprocess.run(args, env=env, stdout=sink, stderr=sink)
    if result.returncode:
        raise InstallError("DEPENDENCY_INSTALL_FAILED")


def verify(model, runtime, version):
    try:
        installed = json.loads((model / "installation.json").read_text())
        if installed["upstream"] != PIN["upstream"]["commit"] or installed["version"] != version:
            raise InstallError("CHECKSUM_MISMATCH")
        entries = list(artifacts(version, installed["emotion"]))
        for index, entry in enumerate(entries):
            path = model / entry["path"]
            if not path.is_file() or path.is_symlink() or digest(path) != entry["sha256"]:
                raise InstallError("CHECKSUM_MISMATCH")
            emit("verifying", progress=(index + 1) / len(entries))
        marker = json.loads((runtime / "runtime.json").read_text())
        if marker["commit"] != PIN["upstream"]["commit"] or not (runtime / "source/.venv/bin/python").is_file():
            raise InstallError("RUNTIME_MISSING")
        for name, expected in marker["sourceHashes"].items():
            if digest(runtime / "source" / name) != expected:
                raise InstallError("CHECKSUM_MISMATCH")
        code = "import importlib.metadata as m,sys; assert sys.version_info[:3]==(3,11,13); assert m.version('torch')=='2.8.0+cu128'; assert m.version('torchaudio')=='2.8.0+cu128'"
        run([str(runtime / "source/.venv/bin/python"), "-B", "-c", code], dict(os.environ))
        emit("installed", progress=1, verified=True)
    except (OSError, KeyError, ValueError):
        raise InstallError("MODEL_MISSING") from None


def install(args):
    model, runtime = private(Path(args.model_dir)), private(Path(args.runtime_dir))
    if args.verify:
        verify(model, runtime, args.version)
        return
    if not args.accept_license:
        raise InstallError("LICENSE_REQUIRED")
    entries = list(artifacts(args.version, args.emotion))
    needed = sum(e["size"] for e in entries if not (model / e["path"]).is_file() or digest(model / e["path"]) != e["sha256"])
    runtime_needed = (2 if (runtime / "runtime.json").is_file() else 20) * 1024**3
    same_disk = model.stat().st_dev == runtime.stat().st_dev
    model_needed = needed + 1024**3 + (runtime_needed if same_disk else 0)
    if shutil.disk_usage(model).free < model_needed or (not same_disk and shutil.disk_usage(runtime).free < runtime_needed):
        raise InstallError("DISK_SPACE")
    endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
    if urllib.parse.urlparse(endpoint).scheme != "https":
        raise InstallError("INVALID_ENDPOINT")
    total = sum(e["size"] for e in entries)
    completed = 0
    for entry in entries:
        emit("downloading", progress=completed / total)
        url = f"{endpoint}/{entry['repo']}/resolve/{entry['revision']}/{entry['file']}"
        download(url, model / entry["path"], entry["sha256"], entry["size"],
                 lambda n: emit("downloading", progress=min(1, (completed+n)/total)))
        completed += entry["size"]
    emit("downloading", progress=1, stage="runtime")
    uv = args.uv or shutil.which("uv")
    if not uv:
        existing = Path(os.environ.get("XDG_DATA_HOME", str(Path.home()/".local/share"))) / "cere/kokoro/bootstrap/uv"
        uv = str(existing) if existing.is_file() else None
    if not uv:
        if sys.platform != "linux" or os.uname().machine != "x86_64":
            raise InstallError("UV_MISSING")
        archive = runtime / "uv.tar.gz"
        download(PIN["uv"]["url"], archive, PIN["uv"]["sha256"])
        with tarfile.open(archive) as tf:
            member = next(m for m in tf if Path(m.name).name == "uv" and m.isfile())
            uv_path = runtime / "uv"
            with uv_path.open("wb") as f:
                shutil.copyfileobj(tf.extractfile(member), f)
            uv_path.chmod(0o700)
            uv = str(uv_path)
    archive = runtime / "source.tar.gz"
    download(PIN["upstream"]["url"], archive, PIN["upstream"]["sha256"])
    source = runtime / "source"
    if not (runtime / "runtime.json").exists():
        private(source)
        with tarfile.open(archive) as tf:
            # Only regular files/directories, strip the archive's commit prefix.
            for member in tf:
                parts = Path(member.name).parts[1:]
                if not parts or ".." in parts or member.issym() or member.islnk():
                    continue
                target = source.joinpath(*parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open("wb") as f:
                        shutil.copyfileobj(tf.extractfile(member), f)
    env = dict(os.environ, UV_CACHE_DIR=str(runtime / "cache"), UV_PYTHON_INSTALL_DIR=str(runtime / "python"), UV_PYTHON_PREFERENCE="only-managed")
    run([uv, "sync", "--frozen", "--project", str(source), "--python", PIN["python"], *(["--extra", "deepspeed"] if args.deepspeed else [])], env)
    hashes = {str(p.relative_to(source)): digest(p) for p in source.rglob("*.py") if ".venv" not in p.parts}
    for name in ["pyproject.toml", "uv.lock"]:
        hashes[name] = digest(source/name)
    (runtime / "runtime.json").write_text(json.dumps(dict(commit=PIN["upstream"]["commit"], sourceHashes=hashes, deepspeed=args.deepspeed)))
    installed = dict(schema=1, version=args.version, upstream=PIN["upstream"]["commit"], runtime=str(runtime), emotion=args.emotion, installedAt=int(time.time()), manifest=PIN)
    (model / "installation.json").write_text(json.dumps(installed, indent=2)+"\n")
    (model / "installation.json").chmod(0o600)
    verify(model, runtime, args.version)


def main():
    data = Path(os.environ.get("XDG_DATA_HOME", str(Path.home()/".local/share"))) / "cere"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", choices=["2.5", "2"], default="2.5")
    parser.add_argument("--model-dir")
    parser.add_argument("--runtime-dir", default=str(data / "runtimes/indextts" / PIN["upstream"]["commit"]))
    parser.add_argument("--uv")
    parser.add_argument("--accept-license", action="store_true")
    parser.add_argument("--emotion", action="store_true")
    parser.add_argument("--deepspeed", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    args.model_dir = args.model_dir or str(data / "models/indextts" / args.version)
    try:
        install(args)
    except InstallError as e:
        emit("error", code=str(e))
        return 1
    except Exception:
        emit("error", code="DOWNLOAD_FAILED")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
