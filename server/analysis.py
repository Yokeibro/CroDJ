"""Audio analysis: BPM, beat-grid offset, musical key and energy.

Decodes with ffmpeg (must be on PATH) and analyses with numpy only.
"""
import subprocess

import numpy as np

SR = 11025
HOP = 128
FPS = SR / HOP

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# Krumhansl-Schmuckler key profiles
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
# Camelot wheel numbers indexed by pitch class
CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]


def decode(path, max_seconds=240):
    cmd = ["ffmpeg", "-v", "quiet", "-i", path, "-t", str(max_seconds),
           "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    return np.frombuffer(raw, dtype=np.float32)


def _stft_mag(y, n_fft, hop):
    n = 1 + (len(y) - n_fft) // hop
    if n <= 0:
        return np.zeros((1, n_fft // 2 + 1))
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n)[:, None]
    frames = y[idx] * np.hanning(n_fft)[None, :]
    return np.abs(np.fft.rfft(frames, axis=1))


def onset_envelope(y):
    mag = np.log1p(10 * _stft_mag(y, 512, HOP))
    flux = np.maximum(0, np.diff(mag, axis=0)).sum(axis=1)
    flux -= np.convolve(flux, np.ones(16) / 16, mode="same")  # remove slow trend
    return np.maximum(flux, 0)


def _comb_score(env, period, bins=48):
    """How concentrated onset energy is when folded at `period` frames."""
    phase = (np.arange(len(env)) % period) / period
    hist = np.bincount((phase * bins).astype(int), weights=env, minlength=bins)[:bins]
    hist = np.convolve(np.r_[hist[-1], hist, hist[0]], [0.25, 0.5, 0.25], "valid")
    best = int(np.argmax(hist))
    return hist[best] - hist.mean(), (best + 0.5) / bins * period


def detect_bpm(env):
    env = env - env.mean()
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    lags = np.arange(len(ac))
    with np.errstate(divide="ignore"):
        bpms = 60 * FPS / lags
    mask = (bpms >= 60) & (bpms <= 200)
    # bias toward the usual dance-music range
    weight = np.exp(-0.5 * (np.log2(bpms[mask] / 122) / 0.9) ** 2)
    coarse = bpms[mask][np.argmax(ac[mask] * weight)]
    while coarse < 78:
        coarse *= 2
    while coarse > 180:
        coarse /= 2

    env = np.maximum(env, 0)
    best = (-1, coarse, 0.0)
    for bpm in np.arange(coarse - 3, coarse + 3, 0.02):
        score, offset = _comb_score(env, 60 * FPS / bpm)
        if score > best[0]:
            best = (score, bpm, offset)
    _, bpm, offset_frames = best
    # flux frames lead the true onset by roughly the analysis window latency
    first_beat = (offset_frames / FPS + 0.042) % (60 / bpm)
    return round(float(bpm), 2), float(first_beat)


def detect_key(y):
    mag = _stft_mag(y, 4096, 2048)
    freqs = np.fft.rfftfreq(4096, 1 / SR)
    valid = (freqs > 55) & (freqs < 2000)
    pcs = np.round(12 * np.log2(freqs[valid] / 440) + 9).astype(int) % 12
    chroma = np.bincount(pcs, weights=mag[:, valid].sum(axis=0), minlength=12)
    chroma = (chroma - chroma.mean()) / (chroma.std() + 1e-9)
    best = (-2, 0, "major")
    for root in range(12):
        for mode, prof in (("major", MAJOR), ("minor", MINOR)):
            p = np.roll(prof, root)
            r = np.corrcoef(chroma, p)[0, 1]
            if r > best[0]:
                best = (r, root, mode)
    _, root, mode = best
    name = KEY_NAMES[root] + ("m" if mode == "minor" else "")
    camelot = f"{CAMELOT_MINOR[root]}A" if mode == "minor" else f"{CAMELOT_MAJOR[root]}B"
    return name, camelot


def analyze(path):
    y = decode(path)
    if len(y) < SR * 5:
        raise ValueError("track too short or undecodable")
    bpm, first_beat = detect_bpm(onset_envelope(y))
    key, camelot = detect_key(y)
    rms = float(np.sqrt(np.mean(y ** 2)))
    energy = int(np.clip(round(rms * 40), 1, 10))
    return {"bpm": bpm, "firstBeat": round(first_beat, 3), "key": key,
            "camelot": camelot, "energy": energy}
