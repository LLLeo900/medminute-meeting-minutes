# Third-party notices

MedMinute's own code is licensed under the [MIT License](LICENSE). It uses the third-party
components below. None of them places copyleft obligations on MedMinute's code.

## Bundled in this repository

| Component | Where | License | Notes |
|---|---|---|---|
| Montserrat (variable font) | `site/public/fonts/` | SIL Open Font License 1.1 | Copyright The Montserrat Project Authors. Full license text: `site/public/fonts/OFL-Montserrat.txt`. The font may not be sold by itself. |

## Installed by `npm ci` (not committed)

| Component | License | Notes |
|---|---|---|
| [node-sqlite3-wasm](https://github.com/tndrle/node-sqlite3-wasm) | MIT | Copyright Tobias Enderle. Contains SQLite, which is in the public domain. |

## Installed separately by the operator (not distributed with MedMinute)

| Component | License | Notes |
|---|---|---|
| [n8n](https://github.com/n8n-io/n8n) | [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md) (fair-code, not OSI) | Free for internal business, personal and non-commercial use. Hosting n8n for third parties as a paid service requires a commercial license from n8n. The workflow files in `n8n/` are MedMinute's own content (MIT). |
| [FFmpeg](https://ffmpeg.org/legal.html) | LGPL-2.1+ / GPL-2.0+ (depends on the build) | Run as a separate program. Do not commit an FFmpeg binary to this repository; if you redistribute one, follow its license. |
| [Ollama](https://github.com/ollama/ollama) | MIT | |
| Google Chrome / Microsoft Edge | proprietary | Used only to print PDFs. |
| Python: faster-whisper, CTranslate2, onnxruntime | MIT | |
| Python: numpy, scikit-learn, PyAV | BSD-3-Clause (numpy: BSD-3-Clause and others) | |
| Python: huggingface_hub, speechbrain | Apache-2.0 | |
| Python: torch | BSD-3-Clause and others | |
| Python: pyannote.audio (optional) | MIT | |

## Models downloaded at setup time (not distributed with MedMinute)

| Model | License | Notes |
|---|---|---|
| [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) via [deepdml/faster-whisper-large-v3-turbo-ct2](https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2) | MIT | |
| [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) | MIT | |
| Silero VAD (bundled in faster-whisper) | MIT | |
| [speechbrain/spkrec-ecapa-voxceleb](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb) | Apache-2.0 | |
| [onnx-community/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM) | CC-BY-4.0 | WeSpeaker ResNet34-LM speaker embedding model, trained on VoxCeleb. Attribution required if you redistribute the model. |
| [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1), [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) (optional) | MIT | Gated: accept the conditions on Hugging Face first. |
| [Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B) (`qwen3:8b` in Ollama) | Apache-2.0 | |

## Online services

Online mode calls the OpenAI API (`gpt-4o-transcribe`, `gpt-4o-transcribe-diarize`, `gpt-4.1`)
under OpenAI's terms of use. This is not a software license, but it does mean that audio and
transcripts leave the machine. See [SECURITY.md](SECURITY.md).
