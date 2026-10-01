#!/usr/bin/env python3
"""Install Cere's optional Kokoro runtime without changing system Python."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


UV_URL = "https://github.com/astral-sh/uv/releases/download/0.12.21/uv-x86_64-unknown-linux-gnu.tar.gz"
UV_SHA256 = "23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0"
ASSETS = {
    "fp16": (
        "kokoro-v1.0.fp16.onnx",
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.fp16.onnx",
        "f3a290d384fbb27966d462905c71a46cef9e5fd00516b40df32a0b4afe77ac96",
    ),
    "int8": (
        "kokoro-v1.0.int8.onnx",
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.int8.onnx",
        "ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c",
    ),
}
VOICES = (
    "voices-v1.0.bin",
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin",
    "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def download(url: str, target: Path, expected: str) -> None:
    if target.is_file() and digest(target) == expected:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
        request = urllib.request.Request(url, headers={"User-Agent": "Cere-Kokoro-Setup/1"})
        with urllib.request.urlopen(request) as response:
            shutil.copyfileobj(response, temporary)
    try:
        if digest(temporary_path) != expected:
            raise RuntimeError(f"checksum mismatch for {target.name}")
        temporary_path.chmod(0o600)
        temporary_path.replace(target)
    finally:
        temporary_path.unlink(missing_ok=True)


def uv_binary(root: Path) -> Path:
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise RuntimeError("the pinned Kokoro setup currently supports x86_64 Linux")
    binary = root / "bootstrap" / "uv"
    if binary.is_file() and os.access(binary, os.X_OK):
        return binary
    archive = root / "bootstrap" / "uv.tar.gz"
    download(UV_URL, archive, UV_SHA256)
    with tarfile.open(archive, "r:gz") as package:
        member = next((item for item in package.getmembers() if Path(item.name).name == "uv" and item.isfile()), None)
        if not member:
            raise RuntimeError("uv archive did not contain its executable")
        source = package.extractfile(member)
        if source is None:
            raise RuntimeError("could not read uv executable")
        binary.parent.mkdir(parents=True, exist_ok=True)
        with binary.open("wb") as output:
            shutil.copyfileobj(source, output)
    binary.chmod(0o700)
    return binary


def run(command: list[str], env: dict[str, str]) -> None:
    subprocess.run(command, check=True, env=env)


def main() -> None:
    default_root = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "cere/kokoro"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=default_root)
    parser.add_argument("--precision", choices=tuple(ASSETS), default="fp16", help="fp16 favors voice quality; int8 saves about 50 MB")
    parser.add_argument("--preview-dir", type=Path, help="write Heart and Bella WAV comparisons without playing them")
    args = parser.parse_args()
    root = args.root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    uv = uv_binary(root)
    environment = dict(os.environ)
    environment.update({
        "UV_CACHE_DIR": str(root / "cache"),
        "UV_PYTHON_INSTALL_DIR": str(root / "python"),
        "UV_PYTHON_PREFERENCE": "only-managed",
    })
    venv = root / "venv"
    python = venv / "bin/python"
    if not python.exists():
        run([str(uv), "python", "install", "3.12"], environment)
        run([str(uv), "venv", "--python", "3.12", str(venv)], environment)
    run([str(uv), "pip", "install", "--python", str(python), "kokoro-onnx==0.6.1"], environment)

    model_name, model_url, model_hash = ASSETS[args.precision]
    model = root / model_name
    voice_data = root / VOICES[0]
    download(model_url, model, model_hash)
    download(VOICES[1], voice_data, VOICES[2])
    manifest = {
        "version": 1,
        # Keep the venv launcher itself. Resolving this symlink would bypass its
        # site-packages and leave kokoro-onnx unavailable at playback time.
        "python": str(python.absolute()),
        "model": str(model.resolve()),
        "voiceData": str(voice_data.resolve()),
        "voices": ["af_heart", "af_bella"],
    }
    manifest_path = root / "manifest.json"
    temporary = root / "manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(manifest_path)

    if args.preview_dir:
        preview_dir = args.preview_dir.expanduser().resolve()
        preview_dir.mkdir(parents=True, exist_ok=True)
        helper = Path(__file__).resolve().parents[1] / "broker/kokoro-synth.py"
        line = json.dumps({"text": "Hello, I'm Cere. Local voice is ready. Let's make a little trouble."}) + "\n"
        for voice in manifest["voices"]:
            target = preview_dir / f"kokoro-{voice}.wav"
            subprocess.run([str(python), str(helper), "--model", str(model), "--voices", str(voice_data), "--voice", voice, "--speed", "1", "--wav", str(target)], input=line, text=True, check=True, env=environment)
    # The installed interpreter and venv are self-contained. Package/download
    # caches only duplicate them and the pinned assets, so do not retain those.
    shutil.rmtree(root / "cache", ignore_errors=True)
    (root / "bootstrap" / "uv.tar.gz").unlink(missing_ok=True)
    print(json.dumps({"manifest": str(manifest_path), "model": model_name, "voices": manifest["voices"], "previews": str(args.preview_dir.resolve()) if args.preview_dir else None}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Kokoro setup failed: {error}", file=sys.stderr)
        raise SystemExit(1)
