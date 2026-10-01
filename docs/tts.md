# Local speech

Cere reads the last assistant response after a successful desktop turn, once,
across Codex, Claude and Ollama. Pin a conversation to also hear each finished
conversational message, including commentary and questions, while it runs in the
background. Tools, activity indicators, agent activity and unfinished streaming
fragments do not speak. Unpinned child agents and remote-controlled sessions stay
silent. Playback runs outside the response pipeline; a missing audio service
cannot fail a conversation.

Pinned replies also appear in a bubble beside the desktop avatar, even when the
chat window is open. It follows the reply being spoken, or the latest reply when
silent; hover over it or use Previous
and Next to read at your own pace. Open conversation returns to that reply's
conversation. Hide Cere hides the bubble too. Unpinning or archiving clears that
conversation's bubble replies and stops its queued speech. Recent bubble replies
survive UI reconnects but are not replayed after a broker restart; full messages
remain in the transcript. The bubble retains up to 100 recent messages within a
512 KiB preview budget, showing up to 16,000 characters per message.

**Settings → Voice** controls **Read replies aloud** (enabled by default) and
`voice` (default `en_US-amy-medium`). These settings persist in Cere's existing
SQLite settings store. Voice adjustments work with Piper and Kokoro:

**Speak replies from** adds independent automatic-speech switches for Codex,
Claude Code, Ollama, AntiGravity, OpenAI API, Claude API and Google AI API. All
start enabled, preserving existing behavior. The master switch and Quiet mode
still apply. A provider switch covers ordinary replies and pinned conversational
updates with any selected speech engine. Disabling one stops its current and
queued speech, without interrupting other providers or hiding avatar bubbles.
Re-enabling it does not replay old replies. Test voice remains available.

Click the Cere head at the top left of either window layout to toggle **Read
replies aloud**. Muting immediately stops current and queued speech; an amber
crossed-speaker badge marks the muted state. Click again to enable future replies.
Keyboard Space/Enter and the accessible button action do the same. Your volume,
voice and provider-specific switches are preserved; Quiet mode still applies.

- **Speaking speed:** 0.5–2×, using the selected engine's synthesis speed.
- **Pitch:** −6 to +6 semitones, without changing speaking speed.
- **Cere's volume:** 0–100% of the voice's normal output, independent of system
  volume. 0% also silences Test voice and stops current and queued speech.

**Test voice** previews the saved adjustments. **Reset voice adjustments** restores
1× speed, neutral pitch and 100% volume without changing the selected voice.
Changes apply to newly queued speech; a sentence already playing keeps its
settings. Quiet mode mutes automatic speech and cancels pending
playback. **Stop speaking** cancels Cere's current and queued speech. Pinned
replies queue in arrival order without replacing one another. Up to three pending
unpinned replies are retained; newer unpinned replies replace the oldest unpinned
one. Pinning respects the voice, Quiet mode and brief-reading settings. Code fences,
markdown formatting and link destinations are omitted; spoken prose is bounded
to 8,000 characters. Text remains unchanged in the transcript.

Use **Test voice**, type **`/tts-test`** in a desktop conversation, or run
`cere tts-test` while the broker is running. The canned line intentionally plays
even when automatic speech is disabled or quiet mode is enabled. The local broker
also exposes `tts.test`, `tts.stop`, `tts.voices` and `tts.status`. For development:

```sh
node broker/cli.ts tts-test
node broker/cli.ts tts.status
```

The command returns immediately with `queued`; inspect `tts.status` or Settings
for the actual backend and any playback error. A successful dispatcher submission
confirms acceptance, not that a physical speaker is audible. Once a dispatcher
accepts a message Cere never retries it through another backend, avoiding double
speech. Errors before acceptance use the direct fallback.

Pitch and volume use local SoX processing between synthesis and playback. Install
`sox` for workspace or per-user installations; the Arch package requires it.
When any adjustment differs from its default, Piper uses direct playback so
Speech Dispatcher cannot silently ignore the adjustment. A missing processor
reports an error; reset pitch and volume to use the original playback path.
Audio is streamed through pipes, with no temporary recordings or network access.

## Offline fallback and builds

Linux x86_64 and aarch64 packages include the standalone Piper runtime, Amy's
22,050 Hz ONNX/JSON pair, attribution, license texts and engine source archives.
No runtime download, Python virtual environment or `pip install` is needed for
direct playback. Install `alsa-utils` (`aplay`) and your sound server's ALSA
integration: `pipewire-alsa` on Arch/PipeWire, or the PulseAudio ALSA plugin
(`pulseaudio-alsa` on Arch, `libasound2-plugins` on Debian/Ubuntu). The Arch package
requires the ALSA routing configuration and `pulse-native-provider`, satisfied by
either `pipewire-pulse` or `pulseaudio`. `aplay` uses the
default device, so normal PipeWire/PulseAudio volume and output selection apply.

CMake stages these assets into `build/tts/` with Python 3.12 or newer; the first
configure downloads pinned assets and verifies SHA-256 checksums. Later builds
reuse the verified `.local-deps/tts-downloads/` cache. To prefetch or validate an
offline build:

```sh
python3 tools/prepare-tts.py
python3 tools/prepare-tts.py --offline
```

Installation puts the bundle under `<prefix>/share/cere/tts/`. The fallback is
equivalent to the following pipeline, implemented with argument arrays and pipes
without a shell; the rate is read from the selected voice's JSON:

```sh
piper --model /path/to/en_US-amy-medium.onnx --output_raw |
  aplay -r 22050 -f S16_LE -c 1 -t raw
```

## Optional Speech Dispatcher integration

Install `speech-dispatcher` (Arch includes the Python `speechd` client) or
`speech-dispatcher python3-speechd` on Debian/Ubuntu. Then run the included setup:

```sh
# Packaged install; for ~/.local installs replace /usr with ~/.local.
node /usr/share/cere/tools/setup-speech.ts
# Source checkout instead:
node tools/setup-speech.ts
```

Setup copies Amy's pair and attribution to
`$XDG_DATA_HOME/piper/voices/` (normally `~/.local/share/piper/voices/`), without
overwriting existing voice files. It writes the Cere-owned module
`$XDG_CONFIG_HOME/speech-dispatcher/modules/cere-piper.conf` and adds:

```conf
AddModule "cere-piper" "sd_generic" "cere-piper.conf"
```

Existing modules and defaults are preserved. A new dispatcher configuration uses
`AudioOutputMethod "pulse"` and `DefaultModule "cere-piper"`. For an existing
configuration, set that default yourself if you also want other applications to
use Piper. Cere always explicitly requests its own module and selected voice.
The module uses `piper --output_raw` through Cere's helper and `aplay` on the
default PipeWire/PulseAudio output. Dispatcher priorities and cancellation work;
Piper pitch/rate controls are not implemented by this generic module.

Restart the user daemon after setup (`systemctl --user restart speech-dispatcher`
on distributions with that unit; otherwise restart the user daemon through its
normal launcher). This can interrupt other applications' speech. Verify:

```sh
spd-say -o cere-piper -L
cere tts-test
cere tts.status
```

The backend should report `speech-dispatcher`. If the daemon, Python client or
selected module/voice is absent, it reports `piper` and a fallback reason.
The helper uses `speechd.SSIPClient`, bounded connection/playback timeouts and
`cancel(SELF)`; it never sends global stop/cancel commands.

## Custom voices and diagnostics

Drop `NAME.onnx` and `NAME.onnx.json` (or `NAME.json`) into
`~/.local/share/piper/voices/`, then **Refresh voices** and select `NAME`.
The JSON must contain `audio.sample_rate`. Cere also searches its config
directory's `voices/` folder, a `voices/` folder beside `broker/`, and its bundled
voices. Config overrides take precedence. Missing or invalid pairs are omitted
from the selector, and an invalid selected pair reports an error rather than
silently switching voices. Custom voices use their own sample rate.

Rerun dispatcher setup and restart its daemon after adding voices. Setup registers
voices from the same directories and with the same precedence as Cere. Each custom model's license
remains its owner's responsibility; retain its model card and attribution.

Environment overrides: `CERE_PIPER_BIN`, `CERE_APLAY_BIN`, `CERE_SOX_BIN`, `CERE_TTS_PYTHON`,
`CERE_VOICES_DIR` (exclusive search directory), and `CERE_TTS_DISABLED=1` (disable
all playback, including tests). Normal `npm test` sets the latter; focused speech
tests use private fake executables and never access a speaker. The setup tool
accepts `--config-dir DIR --voices-dir DIR` for isolated dispatcher validation.

See the installed `tts/NOTICES.md` and [bundle notices](../packaging/tts-NOTICES.md)
for license provenance: the original engine is MIT, its eSpeak dependency is
GPL-3.0-or-later, and Amy's model card points to Mimic 3's CC-BY-SA-4.0 license.

## ElevenLabs API speech

Choose **Settings → Voice → Speech provider → ElevenLabs · API**. Add your API
key in the password field, choose **Save key**, then **Refresh voices and models**.
Select an account voice (including an existing clone) and a text-to-speech model,
or enter their IDs manually. The initial model ID is `eleven_flash_v2_5`.
Enable **Allow sending spoken text to ElevenLabs**, then use **Test voice**.
No account key is shipped, no cloud provider is activated automatically, and
automatic speech follows the same master/provider switches and Quiet mode.

The key is stored in the owner-only `credentials/provider-credentials.json`
under Cere's state directory, outside shared settings, transcripts and reviewed
backups. `ELEVENLABS_API_KEY` is also supported; a saved key takes precedence.
Removing a saved key reveals an environment key if one is configured. API calls
go only to `https://api.elevenlabs.io`, refuse redirects and never log keys,
spoken text, audio or raw server error bodies. Account catalog refresh sends no
conversation text. Speech sends the cleaned spoken reply, consumes account
credits and is subject to ElevenLabs' account/data-retention terms. Cere does
not claim provider-side zero retention.

Your IndexTTS reference files, including CERE.mp3, are not uploaded or converted
into ElevenLabs voices. Create a clone in your ElevenLabs account if desired,
then refresh and select its voice ID. Local providers and profiles are retained.

The adapter uses the [streaming speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)
with 24 kHz signed 16-bit mono PCM, bounded streaming buffers and SoX/aplay.
Playback starts before the response finishes. Speed, pitch and volume use local
SoX processing; no optional Python runtime or ElevenLabs SDK is needed.
Long replies are split into sentence-aware requests, at most 1,000 characters
or the selected catalog model's lower request limit. Stop aborts the network
request, drops pending speech and reaps the audio processes. Switching speech
providers also unloads IndexTTS.

Catalog discovery uses [paginated account voices](https://elevenlabs.io/docs/api-reference/voices/search)
and [available TTS models](https://elevenlabs.io/docs/api-reference/models/list).
Transient HTTP responses use the shared bounded retry/backoff helper. Interrupted
audio streams and ambiguous network failures are not replayed; a retry can cost
credits, so Cere never silently switches to another cloud provider. Authentication,
permissions/plan restrictions, quota, rate limiting, invalid selections, network
and playback failures have concise recovery messages. Check the ElevenLabs
dashboard for account-specific details if access is rejected. Catalog/key access
does not prove that a paid synthesis request will succeed.

Offline fixtures cover streaming, PCM boundaries, cancellation, provider switching,
catalog pagination, redaction, settings and credentials. A real SoX pipeline is
tested with a private audio sink; no live ElevenLabs synthesis or latency claim
is made without a configured account and explicit playback.

## IndexTTS voice cloning

**Settings → Voice → Speech provider → IndexTTS** selects the optional local
cloning engine. Existing Piper/Kokoro voices remain available through **Local
voices**. IndexTTS-2.5 is primary (Chinese, English, Japanese, Spanish, Arabic);
IndexTTS-2 is an optional Chinese/English checkpoint. Only one checkpoint is
loaded. Linux x86_64 is the acceptance platform; other platforms and Linux ARM
are unvalidated. MPS/XPU are deliberately not offered.

Review the linked bilibili model license and disclaimer before the first
**Download / repair**. Commercial use is conditional, including authorization
for the reference voice. The license requires separate written permission above
its organization-size thresholds (100 million monthly active users or RMB 1
billion annual revenue), retains notices, and restricts training other AI models.
The separate disclaimer also restricts unauthorized commercial use of synthesized
voices. Read both documents rather than treating this summary as a license grant:

- [Pinned license](https://github.com/index-tts/index-tts/blob/d9e41aac89fd00b3d71497fddb287b7f24613712/LICENSE)
- [Pinned disclaimer](https://github.com/index-tts/index-tts/blob/d9e41aac89fd00b3d71497fddb287b7f24613712/DISCLAIMER)

The checked-in `packaging/indextts-manifest.json` pins upstream commit
`d9e41aac89fd00b3d71497fddb287b7f24613712`, every selected Hugging Face repository
revision and file SHA-256, Python 3.11.13, Torch/Torchaudio 2.8.0+cu128 and CUDA
12.8. It is installed alongside the application. The host's Python and npm
packages are not modified. The installer uses upstream's frozen `uv.lock`.

The model download is roughly 6.6 GiB for 2.5 plus 1.13 GiB for optional Qwen
emotion. The installed Python/Torch runtime and cache can use another 18 GiB.
Allow **30 GiB free** for initial installation; the installer checks space on the
model and runtime filesystems. The model directory is configurable. The default
layout is:

```text
$XDG_DATA_HOME/cere/models/indextts/<version>/
  installation.json                  # app-readable installed provenance
  hf_cache/                          # pinned local auxiliary models
  qwen0.6bemo4-merge/                 # optional emotion weights
$XDG_DATA_HOME/cere/runtimes/indextts/<commit>/
  source/                            # pinned upstream source and uv.lock
  source/.venv/                      # isolated runtime
  python/                            # uv-managed Python
  cache/                             # removable dependency download cache
  runtime.json                       # source integrity records
$XDG_DATA_HOME/cere/voices/indextts/<profile-id>/
  *.original                         # byte-for-byte originals
  *.wav                              # validated mono references
```

`XDG_DATA_HOME` defaults to `~/.local/share`. Profile directories are private
(0700), recordings 0600. Deleting a profile removes its original and converted
recordings. Unload/Stop exits the inference process. To remove the runtime,
switch back to Local voices, exit Cere, and remove the specific IndexTTS runtime
directory above; remove the model directory separately if desired. Do not remove
Cere's shared data directory. Reinstallation recreates the runtime from the pin.

For command-line installation (equivalent to the UI license acknowledgment):

```sh
python3 tools/setup-indextts.py --accept-license
# Add Qwen for text emotion:
python3 tools/setup-indextts.py --accept-license --emotion
# Optional second checkpoint, sharing the isolated runtime:
python3 tools/setup-indextts.py --version 2 --accept-license
python3 tools/setup-indextts.py --verify
```

Use `--model-dir /absolute/path` and `--runtime-dir /absolute/path` to relocate.
`--uv /absolute/path/to/uv` selects an existing uv. Otherwise setup searches PATH,
then Cere's private Kokoro uv, then bootstraps a checksum-pinned Linux x86_64 uv.
On other platforms install uv yourself; upstream dependencies may still fail.
Partial downloads resume and completed files are checksum-verified before reuse.
**Verify installation** also checks source integrity and Python/Torch versions.
No checkpoint or runtime is downloaded at ordinary app startup.

Only usable CUDA devices and CPU are listed after **Refresh devices**. Select
BF16 for 2.5 or FP16 for 2; FP32 is available on both, and required on CPU.
Precision applies to the upstream mixed-precision implementation, not uniformly
to every network. CPU may be substantially slower than audio playback. A 6 GiB
GPU is tight even for BF16; other GPU applications can make model loading fail.

Compiled CUDA kernels require `nvcc`, a C++ compiler and Ninja. Use CUDA Toolkit
**12.8 or newer** compatible with the pinned cu128 wheels. Without that toolchain,
leave compiled kernels disabled; the ordinary Torch path remains available.
DeepSpeed is experimental, separately installed with `--deepspeed`, and can be
slower. Torch compile and the separate flash-attention acceleration extra are not
exposed by this integration.

### Voices, emotion and previews

Add a voice name, language and clean 3–15-second WAV/FLAC/OGG reference. Validation
rejects corrupt, quiet/silent and clipped recordings. The 15-second maximum matches
upstream's truncation; the three-second minimum is Cere's policy, not a claimed
upstream minimum. Speaker audio is converted to mono 22,050 Hz; emotion audio uses
16,000 Hz. Original bytes are retained privately. Profiles record timestamps and
the model version against which they were validated; changing models requires an
appropriate profile. **Set default** persists the selected profile. **Preview**
uses a fixed short sample in its language through the normal cancelable pipeline.

Choose one emotion source: same as speaker, reference recording, eight-dimensional
vector, synthesis text, or a separate text description. The vector order is
**happy, angry, sad, afraid, disgusted, melancholic, surprised, calm**. Components
and strength are 0–1; upstream performs additional normalization. Audio strength
defaults to 1.0, text modes to 0.6. Random sampling reduces cloning fidelity.
Text modes stay disabled until Qwen is installed. On first text-emotion use, the
worker reloads the model with Qwen enabled. Qwen adds about 1.1 GiB of FP16 weight
memory plus buffers; CPU uses FP32. Its device selection is constrained to the
selected TTS device instead of upstream's independent automatic placement.

The duration slider is **2.5 only**, 0.5–2.0: values below 1 shorten speech and
values above 1 lengthen it. IndexTTS-2 duration control is not released and is
neither offered nor forwarded. The existing Piper/Kokoro speed control is hidden
for IndexTTS. Pitch and volume still apply through SoX.

### Playback, cancellation and privacy

This is **chunk-level pipelining**, not token streaming. Upstream's generator
yields complete synthesized segments. Cere preserves sentence boundaries,
including CJK punctuation, and never splits a `<word|pronunciation>` annotation.
The character target defaults to 160; a loaded low-VRAM model uses at most 40 as
its target. An indivisible annotation may exceed that target. Upstream's token
segmentation still applies inside a chunk.

The worker converts PCM-scale tensors to signed 16-bit mono audio at 22,050 Hz.
Generation/sequence IDs prevent stale or out-of-order playback; acknowledged IPC
frames bound buffering. SoX resamples to the 48,000 Hz playback stream and applies
pitch/volume. Upstream's 200 ms inter-segment silence joins segments. Playback can
begin before the remaining chunks have been synthesized.

**Stop speaking** drops pending replies, closes playback, and terminates the
worker (SIGTERM followed by SIGKILL if needed). A subsequent request reloads it.
Provider changes and app exit also unload. Otherwise the default idle timeout is
ten minutes, configurable from one to 120 minutes. Hardware memory release is
verified by worker process exit, not merely `empty_cache()`.

Text and recordings travel only through private local files or pipes. Upstream
stdout/stderr is suppressed; app logs contain only fixed states and error codes.
Neither synthesized text, reference audio nor emotion descriptions are logged.
At runtime, HF/Transformers offline modes are enabled, upstream download fallbacks
are disabled, and Python DNS/Internet-connect audit events are denied. The worker
has a network-denial test. This is an application-level offline guard, not an OS
sandbox for arbitrary replacement native code.

### Troubleshooting and validation

- **DOWNLOAD_FAILED:** resume after fixing connectivity. Set an HTTPS
  `HF_ENDPOINT` mirror in the broker/installer environment; the revision and
  SHA-256 checks remain mandatory. Package index mirrors are a separate uv setting.
- **OUT_OF_MEMORY:** choose BF16/FP16 where supported, shorten chunks, disable text
  emotion or use CPU. There are no automatic retries or silent device switches.
- **DEPENDENCY_INSTALL_FAILED / UV_MISSING:** check uv, free disk and access to
  Python, PyPI and `download.pytorch.org`; rerun setup. Do not install upstream's
  dependencies into system Python.
- **COMPILER_MISSING:** disable CUDA kernels or install the matching toolkit,
  C++ compiler and Ninja. DeepSpeed needs its optional runtime extra.
- **CHECKSUM_MISMATCH / MODEL_MISSING:** use Download / repair, then Verify.
- **WORKER_CRASH / IPC_ERROR:** unload and reload; check available memory.
- **REFERENCE_*:** follow the specific duration, clipping, silence or decode error.
  Replacing a reference preserves the previous profile until validation succeeds.

Normal tests use a fake subprocess backend and synthetic recordings, with no
checkpoint/GPU requirement:

```sh
node --test tests/indextts.test.ts tests/indextts-integration.test.ts tests/tts.test.ts
npm test
npm run typecheck
npm run build
/usr/lib/qt6/bin/qmllint -I qml --unqualified info qml/IndexTTSSettings.qml qml/VoiceSettings.qml
```

`--unqualified info` accounts for this project's runtime-injected `App` context
property. Actual QML construction/provider switching is also exercised by the
`indexTtsSettings` desktop test slot. The opt-in integration test is skipped unless
both the installed model and explicit environment flag/reference are present:

```sh
CERE_INDEXTTS_INTEGRATION=1 CERE_INDEXTTS_DEVICE=cpu \
  CERE_INDEXTTS_REFERENCE=/absolute/authorized-reference.wav \
  node --test tests/indextts-integration.test.ts
CERE_INDEXTTS_REFERENCE=/absolute/authorized-reference.wav \
  node tools/benchmark-indextts.ts
```

The benchmark writes sanitized measurements to `/tmp/cere-indextts-evidence/` by
default (`CERE_INDEXTTS_EVIDENCE` overrides it). No physical speaker is used by
these synthesis tests. CPU timings depend strongly on thread settings; record
`OMP_NUM_THREADS`/`MKL_NUM_THREADS` alongside results.

### Measured Linux behavior (September 30, 2026)

Small-GPU update: IndexTTS-2.5 now keeps its reference-only Wav2Vec2-BERT encoder
on CPU for CUDA devices with less than 10 GiB VRAM. Speech generation remains on
GPU; upstream reference embeddings are cached for subsequent chunks and replies.
This also avoids placing the encoder on GPU during initial loading. CPU reference
work defaults to four Torch threads; an explicit `OMP_NUM_THREADS` overrides it.
The installed upstream source and checkpoint files remain unchanged.

With the full 15-second CERE reference and Ollama still resident, the RTX 4050
loaded in 21.70 s. First audio after loading took 12.84 s when preparing the
reference, then **4.02 s with the cached reference**. A 66-character sample took
12.11 s to synthesize 9.17 s of audio on the warm run. Total GPU memory reached
5,130 MiB and returned to 681 MiB after worker exit. These single-run figures
replace the earlier all-GPU allocation behavior below for small GPUs. Cold
startup still costs model loading plus reference preparation; a longer idle
timeout keeps the model and prepared reference available at the cost of memory.
Larger Ollama models can still compete for GPU memory. Text-emotion Qwen has its
own additional memory cost.

Earlier baseline, before reference-encoder offload:

RTX 4050 Laptop (6,141 MiB), driver 615.71.09, 31 GiB RAM; pinned Torch 2.8.0+cu128,
`OMP_NUM_THREADS=4 MKL_NUM_THREADS=4`, default non-random emotion selection, Qwen
disabled unless stated. These are single runs with stochastic synthesis, not a
performance guarantee. The 200-character English input uses the configured
sentence-aware targets (40 on the low-VRAM GPU, 160 on CPU).

| IndexTTS-2.5 mode | Load | Loaded / peak total VRAM | First audio after load | RTF | Stop to worker exit |
|---|---:|---:|---:|---:|---:|
| CUDA BF16 | 23.36 s | 5,255 / 5,777 MiB | 3.06 s | 0.78 | 0.184 s |
| CUDA FP32 | OOM after 19.00 s | peak 5,830 MiB | unavailable | unavailable | worker exited |
| CPU FP32 | 20.59 s | CPU inference; CUDA probing creates a small context | 42.83 s | 7.63 | 0.245 s |

The BF16 worker's exit returned total VRAM to its 3 MiB baseline. Another Ollama
process subsequently loaded, so later whole-GPU totals were 685 MiB; the IndexTTS
worker had exited and was absent from NVIDIA's compute-process list. Do not infer
a model leak from another application's allocations. An earlier BF16 load also
failed under competing GPU memory pressure: keep other GPU models out of memory
or explicitly select CPU. There is no automatic device fallback.

The end-to-end saved-profile preview (including cold load, pitch/volume and 48 kHz
resampling into a test sink) reached audio in 22.91 s. Lazy Qwen loading plus a
short CPU text-emotion synthesis completed in 47.16 s. Stop timing measures the
software worker boundary; physical speaker/device buffering was not measured.
All five 2.5 languages passed on CUDA BF16; both 2 languages passed on CPU FP32.
The optional IndexTTS-2 FP16 CUDA load exhausted memory after 23.39 s (5,822 MiB
peak total VRAM) while another application occupied about 674 MiB. After worker
exit, total VRAM returned to its 685 MiB baseline. GPU synthesis timings for that
checkpoint are therefore unavailable; this does not establish whether it fits
an otherwise empty 6 GB GPU.
CUDA kernels, DeepSpeed, MPS/XPU and other operating systems remain unvalidated.
