# Local speech

Cere reads the last assistant response after a successful desktop turn, once,
across Codex, Claude and Ollama. Streaming commentary, tools, cancelled/failed
turns, child agents and remote-controlled sessions do not speak. Playback runs outside
the response pipeline; a missing audio service cannot fail a conversation.

**Settings → Voice** controls **Read replies aloud** (enabled by default) and
`voice` (default `en_US-amy-medium`). These settings persist in Cere's existing
SQLite settings store. Quiet mode mutes automatic speech and cancels pending
playback. **Stop speaking** cancels only Cere's utterance. Up to three pending
replies are retained; newer replies replace the oldest pending one. Code fences,
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

Environment overrides: `CERE_PIPER_BIN`, `CERE_APLAY_BIN`, `CERE_TTS_PYTHON`,
`CERE_VOICES_DIR` (exclusive search directory), and `CERE_TTS_DISABLED=1` (disable
all playback, including tests). Normal `npm test` sets the latter; focused speech
tests use private fake executables and never access a speaker. The setup tool
accepts `--config-dir DIR --voices-dir DIR` for isolated dispatcher validation.

See the installed `tts/NOTICES.md` and [bundle notices](../packaging/tts-NOTICES.md)
for license provenance: the original engine is MIT, its eSpeak dependency is
GPL-3.0-or-later, and Amy's model card points to Mimic 3's CC-BY-SA-4.0 license.
