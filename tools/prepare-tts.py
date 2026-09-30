#!/usr/bin/env python3
"""Stage the pinned, offline Piper runtime, Amy voice, notices and source archives."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import tarfile
import tempfile
import urllib.request

REPO = Path(__file__).resolve().parent.parent


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=REPO / 'build/tts')
    parser.add_argument('--cache', type=Path, default=REPO / '.local-deps/tts-downloads')
    parser.add_argument('--arch', choices=['x86_64', 'aarch64'], default=platform.machine())
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    if args.arch not in ('x86_64', 'aarch64'):
        parser.error('Bundled Piper supports Linux x86_64 and aarch64')
    manifest = json.loads((REPO / 'packaging/tts-assets.json').read_text())
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    for asset in manifest:
        name = asset['name']
        if name.startswith('piper_linux_') and name != f'piper_linux_{args.arch}.tar.gz':
            continue
        cached = args.cache / name
        if not cached.is_file() or digest(cached) != asset['sha256']:
            if args.offline:
                raise RuntimeError(f'Missing or corrupt cached TTS asset: {name}')
            print(f'Downloading {name}', flush=True)
            with tempfile.NamedTemporaryFile(dir=args.cache, delete=False) as temporary:
                download = Path(temporary.name)
                try:
                    with urllib.request.urlopen(asset['url'], timeout=90) as response:
                        shutil.copyfileobj(response, temporary)
                    temporary.flush()
                    if digest(download) != asset['sha256']:
                        raise RuntimeError(f'SHA-256 mismatch: {name}')
                    os.replace(download, cached)
                finally:
                    download.unlink(missing_ok=True)
        if name.startswith('piper_linux_'):
            # Re-extract only after a version/architecture change. Data filtering
            # rejects archive traversal while retaining upstream library symlinks.
            stamp = args.output / 'piper.sha256'
            if not (args.output / 'piper/piper').is_file() or not stamp.exists() or stamp.read_text() != asset['sha256']:
                with tempfile.TemporaryDirectory(dir=args.output) as temporary:
                    with tarfile.open(cached) as archive:
                        archive.extractall(temporary, filter='data')
                    target = args.output / 'piper'
                    if target.exists():
                        shutil.rmtree(target)
                    shutil.move(str(Path(temporary) / 'piper'), target)
                    # Unused Arabic model/helper executables are not part of Cere.
                    for unused in ('espeak-ng', 'piper_phonemize', 'libtashkeel_model.ort'):
                        (target / unused).unlink(missing_ok=True)
                    shutil.rmtree(target / 'pkgconfig', ignore_errors=True)
                    stamp.write_text(asset['sha256'])
        else:
            folder = 'voices' if name.startswith('en_US-amy-medium.') or name == 'MODEL_CARD' else 'sources' if name.endswith('-source.tar.gz') else 'licenses'
            target = args.output / folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.is_file() or digest(target) != asset['sha256']:
                shutil.copyfile(cached, target)
    shutil.copyfile(REPO / 'packaging/tts-assets.json', args.output / 'manifest.json')
    shutil.copyfile(REPO / 'packaging/tts-NOTICES.md', args.output / 'NOTICES.md')
    print(f'Offline Piper and {args.arch} Amy voice bundle ready: {args.output}')


if __name__ == '__main__':
    main()
