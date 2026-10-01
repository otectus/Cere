# Cere local speech bundle

Cere redistributes the unmodified `en_US-amy-medium` model and JSON configuration
published by Michael Hansen / Rhasspy. The original model card is in
`voices/MODEL_CARD`. The pinned downloads, SHA-256 digests and source URLs are in
`manifest.json`. No model weights have been retrained or modified by Cere.

## Voice provenance

The [Piper voices repository](https://huggingface.co/rhasspy/piper-voices) has MIT
repository metadata. This is **not a blanket license statement for every training
dataset**. Amy's [model card](https://huggingface.co/rhasspy/piper-voices/blob/c10ece1aade47bb51c153c893d14e5bf8e5b7117/en/en_US/amy/medium/MODEL_CARD)
directs readers to [MycroftAI/mimic3-voices](https://github.com/MycroftAI/mimic3-voices)
for dataset licensing. That project's top-level license is **CC-BY-SA-4.0**, not
plain CC-BY. Cere preserves the model card, repository metadata and that full
license in `licenses/`, with attribution to Mycroft AI and the Mimic 3 contributors.
The card does not identify a particular Mimic 3 dataset; Cere makes no claim of
more specific dataset clearance. It also reports fine-tuning from Lessac medium.
Redistributors should retain this provenance rather than describe Amy as simply
an MIT-licensed voice. Custom voices retain their own authors' terms.

## Engine and dependencies

This bundle uses the original standalone **Rhasspy Piper 2023.11.14-2** release,
not the newer OHF Python engine. Piper and piper-phonemize are MIT licensed,
copyright Michael Hansen. ONNX Runtime 1.14.1 is MIT licensed, copyright Microsoft,
with additional third-party notices. fmt 10.0.0, spdlog 1.12.0 and uni-algo carry
their own included licenses. eSpeak NG is GPL-3.0-or-later; the executable bundle
must not be described as wholly MIT. Cere runs it as a separate process.

Full license texts and ONNX Runtime's notices are in `licenses/`. Source archives
for Piper, piper-phonemize, the Rhasspy eSpeak NG fork, fmt and spdlog accompany
the binaries in `sources/`. Piper's and piper-phonemize's CMakeLists and Dockerfiles
contain the upstream build recipes. The dependency source revisions are pinned
to the release-era versions; upstream's recipes used moving branch URLs. Retain
these files when redistributing the bundle. The unused Arabic model and standalone
phonemizer/eSpeak tools have been omitted; the Piper executable, shared libraries
and eSpeak data are unmodified.

Installed/system Piper overrides (including the GPL-3.0 OHF engine) have their
own distributions and notices; they are not relicensed by Cere.

## Optional IndexTTS

IndexTTS is downloaded only after license review. Its source/checkpoint provenance
and auxiliary model revisions/checksums are in `indextts-manifest.json`. Upstream
commit: `d9e41aac89fd00b3d71497fddb287b7f24613712`. The bilibili Model Use License
Agreement and separate DISCLAIMER apply; commercial use is conditional, including
reference-voice authorization and the license's organization-size thresholds.
See the pinned upstream LICENSE/DISCLAIMER and `docs/tts.md` before use.
Auxiliary model cards/notices are retained with the downloaded files. This optional
runtime does not change the licenses of the bundled Piper engine or voices.
