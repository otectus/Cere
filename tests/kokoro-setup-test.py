"""Offline regression for interrupted Kokoro downloads."""
import importlib.util
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location("kokoro_setup", Path(__file__).resolve().parents[1] / "tools/setup-kokoro.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    target = root / "model.onnx"
    target.write_bytes(b"previous verified target")
    original = target.read_bytes()
    real_open = setup.urllib.request.urlopen
    class InterruptedResponse:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self, _size=-1):
            raise ConnectionResetError("fixture interruption")
    setup.urllib.request.urlopen = lambda *_args, **_kwargs: InterruptedResponse()
    try:
        try:
            setup.download("https://fixture.invalid/model", target, "0" * 64)
            raise AssertionError("interrupted download unexpectedly succeeded")
        except ConnectionResetError:
            pass
    finally:
        setup.urllib.request.urlopen = real_open
    assert target.read_bytes() == original
    assert not list(root.glob("tmp*")), "interrupted temporary download must be removed"
print("Kokoro interrupted download preserves target and cleans temporary file")
