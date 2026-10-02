"""Downloads the SpeechBrain ECAPA voice-print model (and pyannote, if HF_TOKEN is set).
   Run once, with internet access."""
import io, os, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.environ.get('MODELS_DIR', 'C:/medminute/whisper-models').replace('\\', '/')
os.environ.pop('HF_HUB_OFFLINE', None)
from huggingface_hub import snapshot_download

# Voice print: ECAPA-TDNN, 192-dim vector. Ungated.
dst = f'{ROOT}/ecapa-voxceleb'
print(f'[ecapa] speechbrain/spkrec-ecapa-voxceleb -> {dst}', flush=True)
snapshot_download(repo_id='speechbrain/spkrec-ecapa-voxceleb', local_dir=dst,
                  allow_patterns=['*.ckpt', '*.yaml', '*.txt', '*.json'])

# pyannote — only if the user put a token into HF_TOKEN and accepted the terms on the website
token = os.environ.get('HF_TOKEN') or os.environ.get('HUGGING_FACE_HUB_TOKEN')
if token:
    for repo, folder in [('pyannote/speaker-diarization-3.1', 'pyannote'),
                         ('pyannote/segmentation-3.0', 'pyannote-segmentation')]:
        try:
            p = snapshot_download(repo_id=repo, local_dir=f'{ROOT}/{folder}', token=token)
            print('[pyannote] ok', p)
        except Exception as e:
            print('[pyannote] no access:', repo, type(e).__name__, str(e)[:160])
else:
    print('[pyannote] HF_TOKEN not set — diarization will use VAD + ECAPA (this is fine)')

print('done:', ROOT)
