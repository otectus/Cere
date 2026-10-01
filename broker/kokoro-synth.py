#!/usr/bin/env python3
"""One-shot, local Kokoro synthesis to raw signed 16-bit mono PCM."""

import argparse
import asyncio
import json
import re
import sys
import wave

import numpy as np
from kokoro_onnx import Kokoro


def chunks(text: str, limit: int = 420) -> list[str]:
    """Keep inference below Kokoro's phoneme limit without rushing long prose."""
    result: list[str] = []
    for paragraph in re.split(r"\n+", text):
        current = ""
        sentences = re.split(r"(?<=[.!?])\s+", " ".join(paragraph.split()))
        for sentence in sentences:
            if not sentence:
                continue
            while len(sentence) > limit:
                split = sentence.rfind(" ", 0, limit + 1)
                if split < limit // 2:
                    split = limit
                head, sentence = sentence[:split].strip(), sentence[split:].strip()
                if current:
                    result.append(current)
                    current = ""
                if head:
                    result.append(head)
            candidate = f"{current} {sentence}".strip()
            if current and len(candidate) > limit:
                result.append(current)
                current = sentence
            else:
                current = candidate
        if current:
            result.append(current)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--voice", choices=("af_heart", "af_bella"), required=True)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--wav")
    args = parser.parse_args()
    if not 0.5 <= args.speed <= 2.0:
        parser.error("speed must be between 0.5 and 2.0")
    request = json.loads(sys.stdin.readline())
    text = request.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 8000:
        raise ValueError("text must contain 1 to 8000 characters")

    kokoro = Kokoro(args.model, args.voices)
    wav = wave.open(args.wav, "wb") if args.wav else None
    if wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)

    async def synthesize() -> None:
        index = 0
        for part in chunks(text):
            async for samples, sample_rate in kokoro.create_stream(part, voice=args.voice, speed=args.speed, lang="en-us"):
                blocks: list[np.ndarray] = []
                if index:
                    blocks.append(np.zeros(int(sample_rate * 0.08), dtype=np.int16))
                blocks.append((np.clip(samples, -1.0, 1.0) * 32767).astype("<i2"))
                for block in blocks:
                    if wav:
                        wav.writeframes(block.tobytes())
                    else:
                        sys.stdout.buffer.write(block.tobytes())
                if not wav:
                    sys.stdout.buffer.flush()
                index += 1

    try:
        asyncio.run(synthesize())
    finally:
        if wav:
            wav.close()


if __name__ == "__main__":
    main()
