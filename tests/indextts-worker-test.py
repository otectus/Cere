import importlib.util
import math
from pathlib import Path
import struct
import sys
import tempfile
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "broker"))
from indextts_audio import validate_audio, AudioError
spec = importlib.util.spec_from_file_location("worker", Path(__file__).resolve().parents[1]/"broker/indextts-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def wav(path, seconds=4, channels=2, value=None):
    with wave.open(str(path), "wb") as f:
        f.setparams((channels, 2, 16000, 0, "NONE", "not compressed"))
        f.writeframes(b"".join(struct.pack("<h", value if value is not None else int(5000*math.sin(i*2*math.pi*220/16000))) * channels for i in range(int(seconds*16000))))


with tempfile.TemporaryDirectory() as directory:
    source, target = Path(directory)/"source.wav", Path(directory)/"target.wav"
    wav(source)
    original = source.read_bytes()
    info = validate_audio(source, target)
    assert info["sampleRate"] == 22050 and abs(info["duration"]-4) < .001
    assert source.read_bytes() == original and target.stat().st_mode & 0o777 == 0o600
    with wave.open(str(target)) as f:
        assert f.getnchannels() == 1 and f.getframerate() == 22050
    for args, code in [({"seconds":2}, "REFERENCE_DURATION"), ({"seconds":16}, "REFERENCE_DURATION"), ({"value":0}, "REFERENCE_SILENCE"), ({"value":32767}, "REFERENCE_CLIPPING")]:
        wav(source, **args)
        try:
            validate_audio(source, target)
            raise AssertionError(code)
        except AudioError as error:
            assert str(error) == code
    source.write_bytes(b"corrupt")
    try:
        validate_audio(source, target)
        raise AssertionError("corrupt accepted")
    except AudioError as error:
        assert str(error) == "REFERENCE_CORRUPT"

for version in ("2", "2.5"):
    assert worker.emotion_params({"source":"same-as-speaker"}) == dict(emo_alpha=1., use_random=False)
    assert worker.emotion_params({"source":"reference-audio", "reference":"private.wav"})["emo_audio_prompt"] == "private.wav"
    assert worker.emotion_params({"source":"vector", "vector":[.1]*8})["emo_vector"] == [.1]*8
    assert worker.emotion_params({"source":"synthesis-text"}) == dict(emo_alpha=.6, use_random=False, use_emo_text=True, emo_text=None)
    assert worker.emotion_params({"source":"text-description", "text":"happy"})["emo_text"] == "happy"
    for e in [{"source":"vector", "vector":[2]*8}, {"source":"vector", "vector":[0]}, {"alpha":float('nan')}, {"source":"unknown"}]:
        try:
            worker.emotion_params(e)
            raise AssertionError("bad emotion accepted")
        except worker.WorkerError:
            pass
print("Reference validation and emotion mapping passed")

# CPU reference routing preserves upstream normalization and restores the
# constructor hook even when loading fails. These checks need no torch/GPU.
class FakeTensor:
    def __init__(self, device):
        self.device = device
    def cpu(self):
        return FakeTensor("cpu")
    def to(self, device):
        return FakeTensor(device)

class EncoderBase:
    def to(self, device):
        self.device = device
        return self

class Encoder(EncoderBase):
    pass

for enabled in (False, True):
    encoder = Encoder()
    try:
        with worker.reference_on_cpu(Encoder, enabled):
            assert encoder.to("cuda:0").device == ("cpu" if enabled else "cuda:0")
            raise RuntimeError("load failed")
    except RuntimeError:
        pass
    assert "to" not in Encoder.__dict__
    assert encoder.to("cuda:0").device == "cuda:0"

class FakeModel:
    semantic_mean = FakeTensor("cuda:0")
    semantic_std = FakeTensor("cuda:0")
    def get_emb(self, features, mask):
        assert features.device == mask.device == self.semantic_mean.device == self.semantic_std.device == "cpu"
        return FakeTensor("cpu")

model = FakeModel()
worker.route_reference_embeddings(model, "cuda:0")
assert model.get_emb(FakeTensor("cuda:0"), FakeTensor("cuda:0")).device == "cuda:0"
print("Reference encoder offload and constructor cleanup passed")

# Downloader regression: resume offsets, checksum failures, and verified cache reuse.
import hashlib
import http.server
import threading
setup_spec = importlib.util.spec_from_file_location('setup', Path(__file__).resolve().parents[1]/'tools/setup-indextts.py')
setup = importlib.util.module_from_spec(setup_spec)
setup_spec.loader.exec_module(setup)
payload = b'pinned model fixture' * 1000
requests = []
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        offset = int(self.headers.get('Range', 'bytes=0-').split('=')[1].split('-')[0])
        requests.append(offset)
        self.send_response(206 if offset else 200)
        if offset:
            self.send_header('Content-Range', f'bytes {offset}-{len(payload)-1}/{len(payload)}')
        self.end_headers()
        self.wfile.write(payload[offset:])
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory)/'model.bin'
        target.with_suffix('.bin.partial').write_bytes(payload[:500])
        url = f'http://127.0.0.1:{server.server_port}/model'
        checksum = hashlib.sha256(payload).hexdigest()
        setup.download(url, target, checksum, len(payload))
        assert requests == [500] and target.read_bytes() == payload
        setup.download(url, target, checksum, len(payload))
        assert requests == [500]
        try:
            setup.download(url, target, '0'*64, len(payload))
            raise AssertionError('wrong checksum accepted')
        except setup.InstallError as error:
            assert str(error) == 'CHECKSUM_MISMATCH'
        assert not target.with_suffix('.bin.partial').exists()
finally:
    server.shutdown()
    server.server_close()
print('Download resume and integrity checks passed')
