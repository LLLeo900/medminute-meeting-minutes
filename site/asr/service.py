"""MedMinute ASR — local transcription and voice-id service. Works without internet.

Port 7778. No network requests after the models have been downloaded once.

  GET  /health                      — what is loaded and ready
  POST /transcribe {path,language?,prompt?,window?} — Whisper large-v3-turbo (CT2, CPU) →
                                    segments with words; window=15|5 cuts the recording into windows
                                    (like online). Without an explicit language it is detected once
                                    for the whole recording; the prompt goes into every window.
  POST /diarize    {path}           — "who spoke when" + names from reference voices
  POST /run        {path}           — transcription + diarization in one response (for n8n)
  GET  /voices                      — list of reference voices
  POST /voices/enroll {name,path}   — add a person's reference voice

Diarization: Silero VAD → cut into utterances → voice embedding (ECAPA / WeSpeaker ONNX)
→ agglomerative clustering. If HF_TOKEN holds a token and pyannote has been downloaded,
pyannote/speaker-diarization-3.1 is used instead.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Fully offline: huggingface_hub must not go anywhere
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
os.environ.setdefault('OMP_NUM_THREADS', str(max(1, (os.cpu_count() or 4) // 2)))

PORT = int(os.environ.get('ASR_PORT', '7778'))
MODELS_DIR = os.environ.get('MODELS_DIR', 'C:/medminute/whisper-models').replace('\\', '/')
VOICES_DIR = os.environ.get('VOICES_DIR', 'C:/medminute/voices').replace('\\', '/')
FFMPEG = os.environ.get('FFMPEG', 'C:/medminute/ffmpeg/bin/ffmpeg.exe')
WHISPER_MODEL = os.environ.get('WHISPER_MODEL', f'{MODELS_DIR}/faster-whisper-large-v3-turbo')
COMPUTE_TYPE = os.environ.get('WHISPER_COMPUTE', 'int8')
BEAM = int(os.environ.get('WHISPER_BEAM', '1'))
# Languages the meetings are actually held in. The first one is the default.
LANGS = [s for s in os.environ.get('ASR_LANGS', 'ro,ru,en').split(',') if s]
SR = 16000

os.makedirs(VOICES_DIR, exist_ok=True)


def log(*a):
    print(*a, flush=True)


# ---------- audio ----------

def load_wav(path: str, start: float | None = None, dur: float | None = None):
    """Reads any audio file via ffmpeg into mono float32 16 kHz."""
    import numpy as np
    cmd = [FFMPEG, '-nostdin', '-hide_banner', '-loglevel', 'error']
    if start:
        cmd += ['-ss', f'{start:.3f}']
    cmd += ['-i', path]
    if dur:
        cmd += ['-t', f'{dur:.3f}']
    cmd += ['-f', 'f32le', '-ac', '1', '-ar', str(SR), '-']
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype='<f4').copy()


# ---------- lazy model loading ----------

_lock = threading.Lock()
_state: dict = {'whisper': None, 'embed': None, 'embed_kind': None, 'pyannote': None}


def whisper():
    if _state['whisper'] is None:
        with _lock:
            if _state['whisper'] is None:
                from faster_whisper import WhisperModel
                log(f'[whisper] loading {WHISPER_MODEL} ({COMPUTE_TYPE})')
                _state['whisper'] = WhisperModel(
                    WHISPER_MODEL, device='cpu', compute_type=COMPUTE_TYPE,
                    cpu_threads=int(os.environ['OMP_NUM_THREADS']), local_files_only=True)
                log('[whisper] ready')
    return _state['whisper']


def embedder():
    """Returns a function: numpy audio → voice vector. ECAPA (speechbrain) or WeSpeaker (ONNX)."""
    if _state['embed'] is None:
        with _lock:
            if _state['embed'] is None:
                _state['embed'], _state['embed_kind'] = _build_embedder()
    return _state['embed']


def _build_embedder():
    import numpy as np

    ecapa_dir = f'{MODELS_DIR}/ecapa-voxceleb'
    if os.path.isdir(ecapa_dir):
        try:
            import torch
            from speechbrain.inference.speaker import EncoderClassifier
            log('[voiceid] ECAPA (speechbrain)')
            # in hyperparams.yaml pretrained_path points to the HF repository — replace it with the local path
            local_yaml = f'{ecapa_dir}/hyperparams.local.yaml'
            if not os.path.isfile(local_yaml):
                with open(f'{ecapa_dir}/hyperparams.yaml', encoding='utf-8') as f:
                    y = f.read()
                y = y.replace('pretrained_path: speechbrain/spkrec-ecapa-voxceleb',
                              f'pretrained_path: {ecapa_dir}')
                with open(local_yaml, 'w', encoding='utf-8') as f:
                    f.write(y)
            enc = EncoderClassifier.from_hparams(
                source=ecapa_dir, hparams_file='hyperparams.local.yaml',
                savedir=f'{ecapa_dir}/.sb', run_opts={'device': 'cpu'})

            def ecapa(wav):
                with torch.no_grad():
                    v = enc.encode_batch(torch.from_numpy(wav).unsqueeze(0))
                return v.squeeze().cpu().numpy().astype('float32')

            return ecapa, 'ecapa'
        except Exception:
            log('[voiceid] ECAPA failed to start:\n' + traceback.format_exc())

    onnx = f'{MODELS_DIR}/voiceid/onnx/model.onnx'
    if os.path.isfile(onnx):
        import onnxruntime as ort
        log('[voiceid] WeSpeaker ResNet34 (onnx)')
        sess = ort.InferenceSession(onnx, providers=['CPUExecutionProvider'])
        inp = sess.get_inputs()[0].name

        def wespeaker(wav):
            feats = fbank(wav)[None, :, :]
            v = sess.run(None, {inp: feats})[0]
            return np.asarray(v).reshape(-1).astype('float32')

        return wespeaker, 'wespeaker'

    raise RuntimeError('no voice model: run asr/download-models.py')


def fbank(wav, n_mels: int = 80, win: int = 400, hop: int = 160):
    """Log-mel filterbank 80×T with CMN — the input of WeSpeaker models."""
    import numpy as np
    if len(wav) < win:
        wav = np.pad(wav, (0, win - len(wav)))
    wav = wav * (1 << 15)
    frames = np.lib.stride_tricks.sliding_window_view(wav, win)[::hop]
    frames = frames - frames.mean(axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(frames * np.hamming(win), n=512)) ** 2
    mel = _mel_matrix(n_mels, 512)
    out = np.log(np.maximum(spec @ mel.T, 1e-10)).astype('float32')
    return out - out.mean(axis=0, keepdims=True)


_mel_cache: dict = {}


def _mel_matrix(n_mels: int, n_fft: int):
    import numpy as np
    key = (n_mels, n_fft)
    if key in _mel_cache:
        return _mel_cache[key]
    hz2mel = lambda f: 1127.0 * np.log(1.0 + f / 700.0)
    mel2hz = lambda m: 700.0 * (np.exp(m / 1127.0) - 1.0)
    pts = mel2hz(np.linspace(hz2mel(20), hz2mel(SR / 2), n_mels + 2))
    bins = np.floor((n_fft + 1) * pts / SR).astype(int)
    m = np.zeros((n_mels, n_fft // 2 + 1), dtype='float32')
    for i in range(n_mels):
        l, c, r = bins[i], bins[i + 1], bins[i + 2]
        for j in range(l, min(c, m.shape[1])):
            m[i, j] = (j - l) / max(c - l, 1)
        for j in range(c, min(r, m.shape[1])):
            m[i, j] = (r - j) / max(r - c, 1)
    _mel_cache[key] = m
    return m


def pyannote_pipeline():
    """pyannote/speaker-diarization-3.1, if the model is already downloaded (an HF token is needed for the download)."""
    if _state['pyannote'] == 'none':
        return None
    if _state['pyannote'] is None:
        with _lock:
            if _state['pyannote'] is None:
                cfg = f'{MODELS_DIR}/pyannote/config.yaml'
                try:
                    from pyannote.audio import Pipeline
                    if os.path.isfile(cfg):
                        log('[diar] pyannote from ' + cfg)
                        _state['pyannote'] = Pipeline.from_pretrained(cfg)
                    else:
                        _state['pyannote'] = 'none'
                except Exception:
                    log('[diar] pyannote unavailable, using VAD + embeddings')
                    _state['pyannote'] = 'none'
    return None if _state['pyannote'] == 'none' else _state['pyannote']


# ---------- transcription ----------

def _run_whisper(audio, language, prompt, offset: float = 0.0):
    """One Whisper pass. audio is a path or a numpy array; offset shifts the window timecodes."""
    segs, info = whisper().transcribe(
        audio, language=language, task='transcribe', beam_size=BEAM,
        vad_filter=True, vad_parameters={'min_silence_duration_ms': 400},
        word_timestamps=True, condition_on_previous_text=False,
        initial_prompt=prompt, temperature=[0.0, 0.2, 0.4])
    out = []
    for s in segs:
        out.append({
            't': round(s.start + offset, 3), 'end': round(s.end + offset, 3),
            'text': (s.text or '').strip(),
            'words': [{'t': round(w.start + offset, 3), 'end': round(w.end + offset, 3), 'w': w.word}
                      for w in (s.words or [])],
        })
    return out, info


def window_cuts(regions, total: float, target: float, overlap: float):
    """Window boundaries of ~target seconds; we try to cut in the pauses between speech regions.

    The same trick as online ("Slicing variants"): a long window gives the model context,
    but a phrase must not be cut in the middle — otherwise the model invents words at the seam.
    """
    lo, hi = target * 0.7, target * 1.3
    pauses = [(regions[i][1] + regions[i + 1][0]) / 2 for i in range(len(regions) - 1)]
    cuts, last = [], 0.0
    while total - last > hi:
        cands = [p for p in pauses if last + lo <= p <= last + hi]
        cut = min(cands, key=lambda p: abs(p - last - target)) if cands else last + target
        cuts.append(round(cut, 2))
        last = cut
    bounds = [0.0, *cuts, round(total, 2)]
    return [(max(0.0, bounds[i] - overlap), min(total, bounds[i + 1] + overlap))
            for i in range(len(bounds) - 1)]


def detect_language(wav):
    """Language of the whole recording — detected once, and only among the languages spoken at the clinic.

    Whisper picks from 99 languages and drifts on accented speech: on our one-minute
    Romanian clip it confidently said "Russian", and then in turn suggested
    Polish and Ukrainian — languages that were not spoken at the meeting at all. So we look not
    at its answer but at the probability table, and take the best one from `ASR_LANGS`.
    The list is set by an environment variable — if the hospital starts speaking another language,
    just add it there; no code change is needed.
    """
    _, _, probs = whisper().detect_language(
        audio=wav, vad_filter=True, language_detection_segments=4)
    best = max(((l, p) for l, p in probs if l in LANGS), key=lambda x: x[1], default=None)
    if not best:
        return LANGS[0]
    log('[asr] languages: ' + ', '.join(f'{l}={p:.2f}' for l, p in probs[:5])
        + f' → chosen {best[0]} (out of {"/".join(LANGS)})')
    return best[0]


def transcribe(path: str, language: str | None = None, prompt: str | None = None,
               window: float | None = None, overlap: float = 0.5):
    """Without window — one pass over the whole recording. With window — windows of ~window seconds.

    Offline needs the windows for exactly the same reason online needs the 15s/5s slicing: on a long
    recording Whisper loses pieces, while on a short window it, on the contrary, invents
    words. The two versions are then combined by the "Final transcript" node (V5 text, V15 kept for checking).
    """
    if not window:
        out, info = _run_whisper(path, language, prompt)
        lang, prob, dur = info.language, info.language_probability, info.duration
        wins = 1
    else:
        wav, regions = vad_regions(path)
        total = len(wav) / SR
        spans = window_cuts(regions, total, float(window), overlap) or [(0.0, total)]
        # The language is detected once for the whole recording and then forced on every window.
        # While windows chose the language themselves, on a five-second piece of Romanian Whisper
        # regularly decided it was Russian and wrote the words in Russian transliteration
        # (Romanian words spelled out in Cyrillic). One recording — one language.
        if not language:
            language = detect_language(wav)
            log(f'[asr] recording language: {language}, forcing it on all {len(spans)} windows')
        out, lang, prob, dur, wins = [], None, 0.0, round(total, 2), len(spans)
        for a, b in spans:
            chunk = wav[int(a * SR):int(b * SR)]
            if len(chunk) < SR * 0.2:
                continue
            segs, info = _run_whisper(chunk, language, prompt, offset=a)
            if segs and (lang is None or (info.language_probability or 0) > prob):
                lang, prob = info.language, info.language_probability or 0
            out += segs
        out.sort(key=lambda s: s['t'])
    return {
        'language': lang,
        'languageProbability': round(float(prob or 0), 3),
        'duration': round(float(dur or 0), 2),
        'window': window or 0,
        'windows': wins,
        'segments': out,
        'text': ' '.join(s['text'] for s in out).strip(),
        'model': os.path.basename(WHISPER_MODEL),
    }


# ---------- reference voices ----------

def voices_index():
    """C:/medminute/voices/index.json → {"Name": [{"model": "ecapa", "v": [...]}, ...]}.
       The model is stored next to the vector: ECAPA has 192 numbers, WeSpeaker 256; they must not be mixed."""
    p = f'{VOICES_DIR}/index.json'
    if not os.path.isfile(p):
        return {}
    with open(p, encoding='utf-8') as f:
        raw = json.load(f)
    out = {}
    for name, items in raw.items():
        out[name] = [it if isinstance(it, dict) else {'model': 'unknown', 'v': it}
                     for it in items]
    return out


def voices_save(idx):
    with open(f'{VOICES_DIR}/index.json', 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False)


def enroll(name: str, path: str):
    import numpy as np
    wav = load_wav(path)
    if len(wav) < SR:
        raise ValueError('the reference is shorter than one second')
    emb = embedder()
    vecs = [unit(emb(wav[i:i + SR * 6])) for i in range(0, len(wav) - SR, SR * 6)]
    if not vecs:
        vecs = [unit(emb(wav))]
    idx = voices_index()
    idx.setdefault(name, []).append(
        {'model': _state['embed_kind'], 'v': np.mean(vecs, axis=0).tolist()})
    voices_save(idx)
    return {'name': name, 'samples': len(idx[name]), 'model': _state['embed_kind'],
            'dim': len(idx[name][-1]['v'])}


def unit(v):
    import numpy as np
    v = np.asarray(v, dtype='float32')
    n = float(np.linalg.norm(v))
    return v / n if n else v


def match_names(centroids: dict, threshold: float = 0.55):
    """Matches cluster centroids with reference voices by cosine similarity.
       Only references taken with the same model that is currently loaded are used."""
    import numpy as np
    kind = _state['embed_kind']
    refs = {}
    for n, items in voices_index().items():
        vs = [unit(it['v']) for it in items if it.get('model') in (kind, 'unknown')]
        if vs:
            refs[n] = unit(np.mean(vs, axis=0))
    if not refs:
        return {}, {}
    names, scores = {}, {}
    taken = set()
    pairs = []
    for spk, c in centroids.items():
        for n, r in refs.items():
            if len(r) == len(c):
                pairs.append((float(np.dot(unit(c), r)), spk, n))
    for sim, spk, n in sorted(pairs, reverse=True):
        if spk in names or n in taken or sim < threshold:
            continue
        names[spk], scores[spk] = n, round(sim, 3)
        taken.add(n)
    return names, scores


# ---------- diarization ----------

def vad_regions(path: str):
    """Speech regions via Silero VAD (bundled with faster-whisper, ONNX, offline)."""
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    wav = decode_audio(path, sampling_rate=SR)
    ts = get_speech_timestamps(wav, VadOptions(min_silence_duration_ms=400, speech_pad_ms=120))
    return wav, [(r['start'] / SR, r['end'] / SR) for r in ts]


def split_regions(regions, max_len: float = 8.0, min_len: float = 0.6):
    out = []
    for a, b in regions:
        if b - a < min_len:
            continue
        n = max(1, math.ceil((b - a) / max_len))
        step = (b - a) / n
        for i in range(n):
            out.append((a + i * step, a + (i + 1) * step))
    return out


def diarize(path: str, num_speakers: int | None = None, max_speakers: int = 8):
    import numpy as np
    pipe = pyannote_pipeline()
    if pipe is not None:
        return _diarize_pyannote(pipe, path, num_speakers)

    wav, regions = vad_regions(path)
    chunks = split_regions(regions)
    if not chunks:
        return {'speakers': [], 'segments': [], 'method': 'vad+embed', 'names': {}}

    emb = embedder()
    vecs, keep = [], []
    for a, b in chunks:
        piece = wav[int(a * SR):int(b * SR)]
        if len(piece) < int(0.4 * SR):
            continue
        try:
            vecs.append(unit(emb(piece)))
            keep.append((a, b))
        except Exception:
            continue
    if not vecs:
        return {'speakers': [], 'segments': [], 'method': 'vad+embed', 'names': {}}

    X = np.vstack(vecs)
    labels = cluster(X, num_speakers, max_speakers)

    segments = [{'t': round(a, 2), 'end': round(b, 2), 'spk': f'Participant {int(l) + 1}'}
                for (a, b), l in zip(keep, labels)]
    segments = merge_same(segments)

    centroids = {}
    for l in sorted(set(labels)):
        centroids[f'Participant {int(l) + 1}'] = unit(X[labels == l].mean(axis=0))
    names, scores = match_names(centroids)
    for s in segments:
        s['name'] = names.get(s['spk'], s['spk'])
    # a voice print per person: the vector itself + how long they spoke — that is the voice id
    stats = {}
    for s in segments:
        st = stats.setdefault(s['spk'], {'seconds': 0.0, 'lines': 0})
        st['seconds'] += s['end'] - s['t']
        st['lines'] += 1
    for spk, st in stats.items():
        st['seconds'] = round(st['seconds'], 1)
    return {
        'speakers': sorted(centroids), 'segments': segments,
        'names': names, 'scores': scores, 'stats': stats,
        'vectors': {k: [round(float(x), 6) for x in v] for k, v in centroids.items()},
        'dim': int(len(next(iter(centroids.values())))) if centroids else 0,
        'method': f"vad+{_state['embed_kind']}", 'voiceIdModel': _state['embed_kind'],
    }


def cluster(X, num_speakers, max_speakers):
    """Picks the number of speakers by silhouette score if it is not given."""
    import numpy as np
    from sklearn.cluster import AgglomerativeClustering
    from sklearn.metrics import silhouette_score
    n = len(X)
    if num_speakers:
        k = min(num_speakers, n)
        return AgglomerativeClustering(n_clusters=k, metric='cosine', linkage='average').fit_predict(X) \
            if k > 1 else np.zeros(n, dtype=int)
    if n < 4:
        return np.zeros(n, dtype=int)
    best, best_score = np.zeros(n, dtype=int), -1.0
    for k in range(2, min(max_speakers, n - 1) + 1):
        lab = AgglomerativeClustering(n_clusters=k, metric='cosine', linkage='average').fit_predict(X)
        if len(set(lab)) < 2:
            continue
        try:
            s = silhouette_score(X, lab, metric='cosine')
        except Exception:
            continue
        if s > best_score:
            best, best_score = lab, s
    # a single voice: splitting gives nothing
    return best if best_score > 0.12 else np.zeros(n, dtype=int)


def merge_same(segments, gap: float = 0.8):
    out = []
    for s in segments:
        if out and out[-1]['spk'] == s['spk'] and s['t'] - out[-1]['end'] <= gap:
            out[-1]['end'] = s['end']
        else:
            out.append(dict(s))
    return out


def _diarize_pyannote(pipe, path, num_speakers):
    ann = pipe(path, **({'num_speakers': num_speakers} if num_speakers else {}))
    segs, order = [], {}
    for turn, _, label in ann.itertracks(yield_label=True):
        order.setdefault(label, len(order) + 1)
        segs.append({'t': round(turn.start, 2), 'end': round(turn.end, 2),
                     'spk': f'Participant {order[label]}'})
    segs = merge_same(sorted(segs, key=lambda s: s['t']))
    return {'speakers': sorted({s['spk'] for s in segs}), 'segments': segs,
            'names': {}, 'scores': {}, 'method': 'pyannote-3.1'}


# ---------- assembly: text + speakers ----------

def run(path: str, language: str | None = None, num_speakers: int | None = None,
        prompt: str | None = None):
    tr = transcribe(path, language=language, prompt=prompt)
    dia = diarize(path, num_speakers=num_speakers)
    lines, segments = [], []
    for s in tr['segments']:
        spk = who(dia['segments'], s)
        name = next((d.get('name', spk) for d in dia['segments'] if d['spk'] == spk), spk)
        segments.append({'t': s['t'], 'end': s['end'], 'spk': spk, 'name': name, 'text': s['text']})
        lines.append(f"[{mmss(s['t'])}] {name}: {s['text']}")
    return {
        'language': tr['language'], 'duration': tr['duration'], 'model': tr['model'],
        'speakers': [next((n for k, n in dia['names'].items() if k == s), s) for s in dia['speakers']],
        'rawSpeakers': dia['speakers'], 'names': dia['names'], 'scores': dia.get('scores', {}),
        'method': dia['method'], 'segments': segments, 'text': '\n'.join(lines),
        'plain': tr['text'],
    }


def who(dsegs, s):
    """The speaker with the largest overlap with the utterance."""
    best, best_ov = 'Participant 1', 0.0
    for d in dsegs:
        ov = min(s['end'], d['end']) - max(s['t'], d['t'])
        if ov > best_ov:
            best, best_ov = d['spk'], ov
    return best


def mmss(sec):
    sec = max(0, int(sec))
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f'{h:02d}:{m:02d}:{s:02d}' if h else f'{m:02d}:{s:02d}'


# ---------- HTTP ----------

def health():
    def has(p):
        return os.path.isfile(p) or os.path.isdir(p)
    return {
        'ok': True, 'port': PORT, 'modelsDir': MODELS_DIR, 'voicesDir': VOICES_DIR,
        'stt': {'path': WHISPER_MODEL, 'downloaded': has(f'{WHISPER_MODEL}/model.bin'),
                'loaded': _state['whisper'] is not None, 'compute': COMPUTE_TYPE},
        'voiceId': {'ecapa': has(f'{MODELS_DIR}/ecapa-voxceleb/hyperparams.yaml'),
                    'wespeakerOnnx': has(f'{MODELS_DIR}/voiceid/onnx/model.onnx'),
                    'loaded': _state['embed_kind']},
        'pyannote': has(f'{MODELS_DIR}/pyannote/config.yaml'),
        'voices': {k: len(v) for k, v in voices_index().items()},
        'ffmpeg': os.path.isfile(FFMPEG),
        'offline': os.environ.get('HF_HUB_OFFLINE'),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        log('[http]', self.command, self.path, fmt % args)

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        if self.path.startswith('/health'):
            return self._send(200, health())
        if self.path.startswith('/voices'):
            return self._send(200, {'voices': {
                k: {'samples': len(v), 'models': sorted({i.get('model') for i in v})}
                for k, v in voices_index().items()}})
        self._send(404, {'error': 'no such path'})

    def do_POST(self):
        try:
            b = self._body()
            path = (b.get('path') or '').replace('\\', '/')
            if self.path.startswith('/voices/enroll'):
                return self._send(200, enroll(b['name'], path))
            if not path or not os.path.isfile(path):
                return self._send(400, {'error': f'file not found: {path}'})
            if self.path.startswith('/transcribe'):
                return self._send(200, transcribe(path, b.get('language'), b.get('prompt'),
                                                  b.get('window')))
            if self.path.startswith('/diarize'):
                return self._send(200, diarize(path, b.get('numSpeakers')))
            if self.path.startswith('/run'):
                return self._send(200, run(path, b.get('language'), b.get('numSpeakers'),
                                           b.get('prompt')))
            self._send(404, {'error': 'no such path'})
        except Exception as e:
            log('[error]\n' + traceback.format_exc())
            self._send(500, {'error': f'{type(e).__name__}: {e}'})


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    log(f'MedMinute ASR → http://127.0.0.1:{PORT}  (models: {MODELS_DIR})')
    log(json.dumps(health(), ensure_ascii=False))
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
