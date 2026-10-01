#!/usr/bin/env python3
"""Private serial IndexTTS worker. JSON IPC is the only public output."""
import base64
import contextlib
import inspect
import json
import os
from pathlib import Path
import socket
import sys
import time
from indextts_audio import validate_audio, AudioError

OUTPUT = sys.stdout
MODEL = None
MODULE = None
CONFIG = None
CAPS = None


class WorkerError(Exception):
    pass


def emit(request, event="done", **fields):
    OUTPUT.write(json.dumps(dict(id=request["id"], event=event, **fields)) + "\n")
    OUTPUT.flush()


def offline():
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1", TOKENIZERS_PARALLELISM="false")
    def audit(event, args):
        if event == "socket.getaddrinfo":
            raise WorkerError("NETWORK_DISABLED")
        if event == "socket.connect" and args[0].family in (socket.AF_INET, socket.AF_INET6):
            raise WorkerError("NETWORK_DISABLED")
    sys.addaudithook(audit)


def installation(config):
    try:
        data = json.loads((Path(config["modelDir"]) / "installation.json").read_text())
        if data["version"] != config["version"]:
            raise WorkerError("MODEL_MISSING")
        return data
    except (OSError, ValueError, KeyError):
        raise WorkerError("MODEL_MISSING") from None


def probe(config):
    import importlib
    import torch
    data = installation(config)
    manifest = data["manifest"]
    if torch.__version__ != manifest["torch"]:
        raise WorkerError("DEPENDENCY_MISMATCH")
    sys.path.insert(0, str(Path(data["runtime"]) / "source"))
    spec = manifest["models"][data["version"]]
    module = importlib.import_module("indextts." + spec["module"])
    ctor = inspect.signature(module.IndexTTS2.__init__).parameters
    infer = inspect.signature(module.IndexTTS2.infer).parameters
    devices = [dict(id="cpu", label="CPU · slow", precisions=["fp32"])]
    for i in range(torch.cuda.device_count()):
        try:
            with torch.cuda.device(i):
                torch.empty(1, device=f"cuda:{i}")
                precisions = ["fp32"]
                if "use_bf16" in ctor and torch.cuda.is_bf16_supported():
                    precisions.insert(0, "bf16")
                if "use_fp16" in ctor:
                    precisions.insert(0, "fp16")
                devices.append(dict(id=f"cuda:{i}", label=torch.cuda.get_device_name(i), precisions=precisions, memory=torch.cuda.get_device_properties(i).total_memory))
        except (RuntimeError, AssertionError):
            continue
    import shutil
    cuda_home = os.environ.get("CUDA_HOME", "/usr/local/cuda")
    compiler = bool((shutil.which("nvcc") or (Path(cuda_home)/"bin/nvcc").is_file()) and shutil.which("c++") and shutil.which("ninja"))
    caps = dict(version=data["version"], languages=spec["languages"], sampleRate=spec["sampleRate"],
                durationControl="duration_factor" in infer, precisionFlag="use_bf16" if "use_bf16" in ctor else "use_fp16",
                devices=devices, cudaKernel=compiler and "use_cuda_kernel" in ctor,
                deepspeed=importlib.util.find_spec("deepspeed") is not None and "use_deepspeed" in ctor,
                emotionModes=["same-as-speaker", "reference-audio", "vector"] + (["synthesis-text", "text-description"] if data["emotion"] and "use_emo_text" in infer else []),
                emotionInstalled=data["emotion"], emotionBytes=sum(f["size"] for f in manifest["artifacts"][data["version"]]["files"] if f.get("optional") == "emotion"),
                streaming=hasattr(module.IndexTTS2, "infer_generator") and "stream_return" in infer,
                streamingGranularity="segment", tokenStreaming=False)
    return module, caps


def load(config):
    global MODEL, MODULE, CONFIG, CAPS
    import torch
    # Bound CPU reference preparation and avoid competing BLAS thread pools.
    # An explicit operator thread setting still takes precedence.
    if "OMP_NUM_THREADS" not in os.environ:
        torch.set_num_threads(min(4, os.cpu_count() or 1))
    if MODEL is not None:
        raise WorkerError("BUSY")
    MODULE, CAPS = probe(config)
    device = next((d for d in CAPS["devices"] if d["id"] == config["device"]), None)
    if not device or config["precision"] not in device["precisions"]:
        raise WorkerError("UNSUPPORTED_HARDWARE")
    if config.get("cudaKernel") and (not CAPS["cudaKernel"] or not config["device"].startswith("cuda:")):
        raise WorkerError("COMPILER_MISSING")
    if config.get("deepspeed") and (not CAPS["deepspeed"] or not config["device"].startswith("cuda:")):
        raise WorkerError("DEPENDENCY_MISSING")
    if config.get("textEmotion") and not CAPS["emotionInstalled"]:
        raise WorkerError("EMOTION_MISSING")
    model_dir = Path(config["modelDir"])
    data = installation(config)
    # Never invoke upstream's unpinned fallback downloader, even with offline flags.
    import indextts.utils.model_download as downloads
    def denied(*args, **kwargs):
        raise WorkerError("MODEL_MISSING")
    downloads.ensure_models_available = denied
    downloads.snapshot_download = denied
    kwargs = dict(cfg_path=str(model_dir / "config.yaml"), model_dir=str(model_dir), device=config["device"],
                  use_cuda_kernel=bool(config.get("cudaKernel")), use_deepspeed=bool(config.get("deepspeed")),
                  use_qwen_emo=bool(config.get("textEmotion")), **{CAPS["precisionFlag"]: config["precision"] != "fp32"})
    if "aux_paths" in inspect.signature(MODULE.IndexTTS2.__init__).parameters:
        kwargs["aux_paths"] = {"w2v_bert":str(model_dir/"hf_cache/w2v-bert-2.0"), "semantic_codec":str(model_dir/"hf_cache/semantic_codec_model.safetensors"), "campplus":str(model_dir/"hf_cache/campplus_cn_common.bin"), "bigvgan":str(model_dir/"hf_cache/bigvgan")}
    # Upstream Qwen uses device_map='auto', independent of the selected TTS device.
    # Scope that loader to the selected device, without modifying the pinned source.
    original = MODULE.AutoModelForCausalLM.from_pretrained
    def selected_device(*args, **kw):
        kw.update(device_map={"":config["device"]}, local_files_only=True)
        if config["device"] == "cpu":
            kw["torch_dtype"] = torch.float32
        return original(*args, **kw)
    MODULE.AutoModelForCausalLM.from_pretrained = selected_device
    offload_reference = (config["version"] == "2.5" and config["device"].startswith("cuda:")
                         and device.get("memory", 0) < 10 * 1024**3)
    try:
        with reference_on_cpu(MODULE.Wav2Vec2BertModel, offload_reference):
            MODEL = MODULE.IndexTTS2(**kwargs)
    finally:
        MODULE.AutoModelForCausalLM.from_pretrained = original
    if offload_reference:
        route_reference_embeddings(MODEL, config["device"])
    if str(MODEL.model_version) not in (data["version"], data["version"]+".0"):
        raise WorkerError("DEPENDENCY_MISMATCH")
    CONFIG = config
    CAPS.update(lowVram=bool(getattr(MODEL, "low_vram", False)), device=config["device"], precision=config["precision"],
                cudaKernelActive=bool(MODEL.use_cuda_kernel), textEmotionLoaded=MODEL.qwen_emo is not None,
                referenceDevice="cpu" if offload_reference else config["device"])
    return CAPS


@contextlib.contextmanager
def reference_on_cpu(encoder_class, enabled):
    """Keep the reference-only encoder off small GPUs during construction too."""
    if not enabled:
        yield
        return
    original = encoder_class.to
    own_method = encoder_class.__dict__.get("to")
    def to_cpu(encoder, *args, **kwargs):
        return original(encoder, "cpu")
    encoder_class.to = to_cpu
    try:
        yield
    finally:
        if own_method is None:
            del encoder_class.to
        else:
            encoder_class.to = own_method


def route_reference_embeddings(model, device):
    # Both statistics belong with the encoder. Keep upstream's exact extraction
    # and normalization; transfer only its result back for GPU synthesis.
    model.semantic_mean = model.semantic_mean.cpu()
    model.semantic_std = model.semantic_std.cpu()
    original = model.get_emb
    def get_emb(input_features, attention_mask):
        return original(input_features.cpu(), attention_mask.cpu()).to(device)
    model.get_emb = get_emb



def emotion_params(emotion):
    source = emotion.get("source", "same-as-speaker")
    alpha = emotion.get("alpha", .6 if source in ("synthesis-text", "text-description") else 1.)
    if not isinstance(alpha, (int, float)) or not 0 <= alpha <= 1:
        raise WorkerError("INVALID_EMOTION")
    result = dict(emo_alpha=alpha, use_random=bool(emotion.get("random", False)))
    if source == "same-as-speaker":
        result.update(emo_alpha=1., use_random=False)
    elif source == "reference-audio":
        if not emotion.get("reference"):
            raise WorkerError("REFERENCE_MISSING")
        result["emo_audio_prompt"] = emotion["reference"]
    elif source == "vector":
        vector = emotion.get("vector", [])
        if len(vector) != 8 or any(not isinstance(v, (int, float)) or not 0 <= v <= 1 for v in vector):
            raise WorkerError("INVALID_EMOTION")
        result["emo_vector"] = vector
    elif source in ("synthesis-text", "text-description"):
        result["use_emo_text"] = True
        result["emo_text"] = emotion.get("text") if source == "text-description" else None
        if source == "text-description" and not result["emo_text"]:
            raise WorkerError("INVALID_EMOTION")
    else:
        raise WorkerError("INVALID_EMOTION")
    return result


def synthesize(request):
    if MODEL is None:
        raise WorkerError("MODEL_NOT_LOADED")
    import numpy as np
    lang = request["language"]
    if lang not in CAPS["languages"]:
        raise WorkerError("UNSUPPORTED_LANGUAGE")
    duration = request.get("durationFactor", 1.)
    if not .5 <= duration <= 2 or (not CAPS["durationControl"] and duration != 1):
        raise WorkerError("INVALID_DURATION")
    emotion = request.get("emotion", {})
    if emotion.get("source", "same-as-speaker") not in CAPS["emotionModes"]:
        raise WorkerError("EMOTION_MISSING")
    kwargs = emotion_params(emotion)
    if CAPS["durationControl"]:
        kwargs.update(lang=lang, duration_factor=duration)
    seq = 0
    for text in request["chunks"]:
        # Calling the generator avoids the annotation-unsafe low-VRAM infer splitter.
        generator = MODEL.infer_generator(spk_audio_prompt=request["reference"], text=text, output_path=None,
                                          stream_return=True, interval_silence=200, verbose=False, **kwargs)
        for tensor in generator:
            if not hasattr(tensor, "numel") or not tensor.numel():
                continue
            pcm = np.clip(tensor.detach().cpu().numpy().reshape(-1), -32767, 32767).astype("<i2")
            # Bounded transport frames. These are completed model segments, not token streaming.
            for start in range(0, len(pcm), 22050):
                emit(request, "chunk", generationId=request["generationId"], seq=seq, sampleRate=CAPS["sampleRate"], pcm=base64.b64encode(pcm[start:start+22050].tobytes()).decode())
                ack = json.loads(sys.stdin.readline())
                if ack.get("ack") != request["id"] or ack.get("seq") != seq:
                    raise WorkerError("IPC_ERROR")
                seq += 1
    emit(request, generationId=request["generationId"], chunks=seq)


def main():
    offline()
    with open(os.devnull, "w") as sink:
        for line in sys.stdin:
            request = {"id":"invalid"}
            try:
                if len(line) > 1024*1024:
                    raise WorkerError("IPC_ERROR")
                request = json.loads(line)
                # Never forward upstream prints, warnings, paths or exception strings.
                with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                    op = request["op"]
                    if op == "probe":
                        _, caps = probe(request["config"])
                        emit(request, capabilities=caps)
                    elif op == "load":
                        start = time.monotonic()
                        caps = load(request["config"])
                        emit(request, capabilities=caps, loadSeconds=time.monotonic()-start)
                    elif op == "validate":
                        emit(request, **validate_audio(request["source"], request["target"], request.get("sampleRate", 22050)))
                    elif op == "synthesize":
                        synthesize(request)
                    elif op == "offline-test":
                        try:
                            socket.create_connection(("huggingface.co",443), timeout=1)
                        except WorkerError:
                            emit(request, networkDenied=True)
                        else:
                            raise WorkerError("NETWORK_ENABLED")
                    else:
                        raise WorkerError("IPC_ERROR")
            except BaseException as error:
                code = str(error) if isinstance(error, (WorkerError, AudioError)) else "INFERENCE_FAILED"
                torch = sys.modules.get("torch")
                if torch and isinstance(error, torch.OutOfMemoryError):
                    code = "OUT_OF_MEMORY"
                    torch.cuda.empty_cache()
                elif isinstance(error, (ImportError, ModuleNotFoundError)):
                    code = "DEPENDENCY_MISSING"
                emit(request, "error", code=code)
                if code == "OUT_OF_MEMORY":
                    return 2  # releasing the process also frees model-owned allocations
    return 0


if __name__ == "__main__":
    sys.exit(main())
