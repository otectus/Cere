"""Reference validation; ordinary PCM WAV tests require no third-party packages."""
import array
import math
import os
import struct
import wave


class AudioError(Exception):
    pass


def decode(source):
    try:
        with wave.open(str(source), "rb") as wav:
            channels, rate, frames, width = wav.getnchannels(), wav.getframerate(), wav.getnframes(), wav.getsampwidth()
            if not 3 <= frames / rate <= 15:
                raise AudioError("REFERENCE_DURATION")
            if channels > 8 or not 8000 <= rate <= 192000 or width not in (1, 2, 3, 4):
                raise AudioError("REFERENCE_CORRUPT")
            data = wav.readframes(frames)
            if len(data) != frames * width * channels:
                raise AudioError("REFERENCE_CORRUPT")
            scale = 2 ** (width * 8 - 1)
            if width == 1:
                samples = [(x - 128) / 128 for x in data]
            elif width in (2, 4):
                samples = [x[0] / scale for x in struct.iter_unpack("<h" if width == 2 else "<i", data)]
            else:
                samples = [int.from_bytes(data[i:i+3], "little", signed=True) / scale for i in range(0, len(data), 3)]
            return samples, channels, rate
    except AudioError:
        raise
    except Exception:
        # Optional runtime decoder adds FLAC/OGG and floating-point WAV support.
        try:
            import soundfile as sf
            info = sf.info(source)
            if not 3 <= info.duration <= 15:
                raise AudioError("REFERENCE_DURATION")
            if info.channels > 8 or not 8000 <= info.samplerate <= 192000:
                raise AudioError("REFERENCE_CORRUPT")
            samples, rate = sf.read(source, dtype="float32", always_2d=True)
            return samples.reshape(-1).tolist(), info.channels, rate
        except AudioError:
            raise
        except Exception:
            raise AudioError("REFERENCE_CORRUPT") from None


def validate_audio(source, target, rate=22050):
    samples, channels, sr = decode(source)
    if not samples or not all(math.isfinite(x) for x in samples):
        raise AudioError("REFERENCE_CORRUPT")
    if sum(abs(x) >= .999 for x in samples) / len(samples) > .001:
        raise AudioError("REFERENCE_CLIPPING")
    mono = [sum(samples[i:i+channels]) / channels for i in range(0, len(samples), channels)]
    if math.sqrt(sum(x*x for x in mono) / len(mono)) < .003 or max(map(abs, mono)) < .01:
        raise AudioError("REFERENCE_SILENCE")
    if sr != rate:
        try:
            from scipy.signal import resample_poly
            divisor = math.gcd(sr, rate)
            mono = resample_poly(mono, rate//divisor, sr//divisor).tolist()
        except ImportError:
            # Dependency-free validation tests; production uses the pinned resampler.
            positions = (i * sr / rate for i in range(round(len(mono)*rate/sr)))
            mono = [mono[min(int(p),len(mono)-1)]*(1-p%1)+mono[min(int(p)+1,len(mono)-1)]*(p%1) for p in positions]
    pcm = array.array("h", (max(-32767, min(32767, round(x*32767))) for x in mono))
    import sys
    if sys.byteorder != "little":
        pcm.byteswap()
    with wave.open(str(target), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm.tobytes())
    os.chmod(target, 0o600)
    return dict(duration=len(mono)/rate, sampleRate=rate)
