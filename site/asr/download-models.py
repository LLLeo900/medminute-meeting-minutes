"""Downloads the offline models into C:/medminute/whisper-models. Run once, with internet access.
   After that the service works fully locally (HF_HUB_OFFLINE=1)."""
import io, os, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.environ.get('MODELS_DIR', 'C:/medminute/whisper-models').replace('\\', '/')
os.makedirs(ROOT, exist_ok=True)
os.environ.pop('HF_HUB_OFFLINE', None)

from huggingface_hub import hf_hub_download, snapshot_download

# 1. Transcription — Whisper large-v3-turbo in CTranslate2 format (int8, CPU)
ASR = [
    ('deepdml/faster-whisper-large-v3-turbo-ct2', 'faster-whisper-large-v3-turbo'),
    ('Systran/faster-whisper-small', 'faster-whisper-small'),  # fast fallback
]
for repo, folder in ASR:
    dst = f'{ROOT}/{folder}'
    print(f'[asr] {repo} -> {dst}', flush=True)
    snapshot_download(repo_id=repo, local_dir=dst,
                      allow_patterns=['*.bin', '*.json', '*.txt', '*.model'])

# 2. Voice ID — WeSpeaker ResNet34-LM, ONNX (256-dim voice embeddings, CPU, no torch)
VOICE = f'{ROOT}/voiceid'
os.makedirs(VOICE, exist_ok=True)
print(f'[voice] onnx-community/wespeaker-voxceleb-resnet34-LM -> {VOICE}', flush=True)
for f in ('onnx/model.onnx', 'config.json', 'preprocessor_config.json'):
    p = hf_hub_download(repo_id='onnx-community/wespeaker-voxceleb-resnet34-LM',
                        filename=f, local_dir=VOICE)
    print('   ', p)

print('done:', ROOT)
