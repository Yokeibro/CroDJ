const RES = 100; // peak buckets per second

export function computePeaks(buffer) {
  const sr = buffer.sampleRate, step = Math.floor(sr / RES), n = Math.ceil(buffer.length / step);
  const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
  const amp = new Float32Array(n), low = new Float32Array(n);
  const a = 1 - Math.exp(-2 * Math.PI * 150 / sr);
  let lp = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    let mx = 0, le = 0, fe = 0;
    const end = Math.min(buffer.length, (i + 1) * step);
    for (let j = i * step; j < end; j++) {
      const s = (L[j] + R[j]) * 0.5;
      lp += a * (s - lp);
      const as = s < 0 ? -s : s;
      if (as > mx) mx = as;
      le += lp < 0 ? -lp : lp;
      fe += as;
    }
    amp[i] = mx; low[i] = fe > 0 ? Math.min(1, le / fe) : 0;
    if (mx > peak) peak = mx;
  }
  if (peak > 0) for (let i = 0; i < n; i++) amp[i] /= peak;
  return { amp, low };
}

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
function palette(hi, lo, steps = 16) {
  const a = hex(hi), b = hex(lo);
  return Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',')})`;
  });
}
export const DECK_COLORS = [
  { main: '#3ea6ff', pal: palette('#d6ecff', '#1667c9') },
  { main: '#ff7a3d', pal: palette('#ffe2cc', '#d8341a') },
];

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return dpr;
}

/** VirtualDJ-style scrolling strip: one lane per deck, playhead in the centre. */
export function drawStrip(canvas, decks, windowSec) {
  const dpr = fit(canvas);
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, laneH = H / decks.length;
  g.clearRect(0, 0, W, H);
  decks.forEach((d, i) => {
    const y0 = i * laneH, mid = y0 + laneH / 2;
    g.fillStyle = i % 2 ? '#0b0b0b' : '#0e0e0e';
    g.fillRect(0, y0, W, laneH);
    if (!d.peaks) return;
    const span = windowSec * d.effRate, pos = d.position, t0 = pos - span / 2, tpp = span / W;
    const { amp, low } = d.peaks, pal = DECK_COLORS[i].pal, step = Math.max(1, Math.round(dpr));
    for (let x = 0; x < W; x += step) {
      const b0 = Math.floor((t0 + x * tpp) * RES), b1 = Math.max(b0 + 1, Math.floor((t0 + (x + step) * tpp) * RES));
      if (b1 <= 0 || b0 >= amp.length) continue;
      let a = 0, l = 0;
      for (let b = Math.max(0, b0); b < Math.min(amp.length, b1); b++) { if (amp[b] > a) { a = amp[b]; l = low[b]; } }
      const h = a * laneH * 0.44;
      g.fillStyle = pal[Math.min(15, Math.floor(l * 2.2 * 15))];
      g.fillRect(x, mid - h, step, h * 2);
    }
    const xOf = t => (t - t0) / tpp;
    if (d.loop) {
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(xOf(d.loop.start), y0, xOf(d.loop.end) - xOf(d.loop.start), laneH);
    }
    if (d.bpm) {
      const bStart = Math.ceil(d.beatAt(t0)), bEnd = d.beatAt(t0 + span);
      for (let b = bStart; b <= bEnd; b++) {
        const x = xOf(d.timeOfBeat(b)), down = b % 4 === 0;
        g.fillStyle = down ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)';
        const th = Math.round(laneH * (down ? 0.22 : 0.1));
        g.fillRect(x, i ? y0 : y0 + laneH - th, Math.max(1, dpr), th);
      }
    }
    const marker = (t, color) => {
      const x = xOf(t);
      if (x < 0 || x > W) return;
      g.fillStyle = color;
      g.fillRect(x, y0, 2 * dpr, laneH);
    };
    marker(d.cuePoint, '#ffd23f');
    d.hotcues.forEach(t => t != null && marker(t, '#b98cff'));
  });
  g.fillStyle = '#fff';
  g.fillRect(W / 2 - dpr, 0, 2 * dpr, H);
}

export function overviewImage(peaks, deckIndex) {
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 80;
  const g = c.getContext('2d'), { amp, low } = peaks, pal = DECK_COLORS[deckIndex].pal;
  const per = amp.length / c.width;
  for (let x = 0; x < c.width; x++) {
    let a = 0, l = 0;
    for (let b = Math.floor(x * per); b < Math.floor((x + 1) * per); b++) if (amp[b] > a) { a = amp[b]; l = low[b]; }
    g.fillStyle = pal[Math.min(15, Math.floor(l * 2.2 * 15))];
    g.fillRect(x, 40 - a * 38, 1, a * 76);
  }
  return c;
}

export function drawOverview(canvas, deck) {
  fit(canvas);
  const g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  if (!deck.overview) return;
  g.drawImage(deck.overview, 0, 0, W, H);
  const f = deck.position / deck.duration;
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(0, 0, W * f, H);
  const mark = (t, c) => { g.fillStyle = c; g.fillRect(t / deck.duration * W, 0, 2, H); };
  mark(deck.cuePoint, '#ffd23f');
  deck.hotcues.forEach(t => t != null && mark(t, '#b98cff'));
  g.fillStyle = '#fff';
  g.fillRect(W * f - 1, 0, 2, H);
}

/** YouDJ-style record: black vinyl, grooves, album-art label, tonearm. */
export function drawDisc(canvas, deck, color, cover) {
  const dpr = fit(canvas);
  const g = canvas.getContext('2d'), N = canvas.width, c = N / 2, R = c * 0.86;
  g.clearRect(0, 0, N, N);
  g.fillStyle = '#000';
  g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.fill();
  for (let r = R - 3 * dpr; r > R * 0.4; r -= 2.5 * dpr) {
    g.strokeStyle = (r / dpr | 0) % 5 ? '#141414' : '#1d1d1d';
    g.lineWidth = dpr; g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke();
  }
  const angle = (deck.position * 0.5556 * Math.PI * 2) % (Math.PI * 2), lr = R * 0.36;
  g.save();
  g.translate(c, c); g.rotate(angle);
  g.beginPath(); g.arc(0, 0, lr, 0, Math.PI * 2); g.clip();
  if (cover && cover.complete && cover.naturalWidth) g.drawImage(cover, -lr, -lr, lr * 2, lr * 2);
  else { g.fillStyle = color; g.fillRect(-lr, -lr, lr * 2, lr * 2); g.fillStyle = '#000'; g.fillRect(-lr, -dpr * 2, lr * 2, dpr * 4); }
  g.restore();
  g.save(); g.translate(c, c); g.rotate(angle);
  g.fillStyle = 'rgba(255,255,255,.75)'; g.fillRect(-dpr, -R + 4 * dpr, 2 * dpr, R * 0.18);
  g.restore();
  g.fillStyle = '#ddd'; g.beginPath(); g.arc(c, c, 3 * dpr, 0, Math.PI * 2); g.fill();
  g.strokeStyle = deck.scratch ? '#fff' : color; g.lineWidth = 2 * dpr;
  g.beginPath(); g.arc(c, c, R + 3 * dpr, 0, Math.PI * 2); g.stroke();
  // tonearm (static, mirrored for deck B)
  const s = deck.index ? -1 : 1, px = c + s * R * 0.98, py = c - R * 0.92;
  g.strokeStyle = '#bdbdbd'; g.lineWidth = 3 * dpr; g.lineCap = 'butt';
  g.beginPath(); g.moveTo(px, py); g.lineTo(px - s * R * 0.08, c + R * 0.35); g.lineTo(px - s * R * 0.28, c + R * 0.58); g.stroke();
  g.fillStyle = '#e6e6e6'; g.fillRect(px - 5 * dpr, py - 5 * dpr, 10 * dpr, 10 * dpr);
  g.fillStyle = '#9a9a9a'; g.fillRect(px - s * R * 0.28 - 4 * dpr, c + R * 0.58 - 4 * dpr, 8 * dpr, 8 * dpr);
}
