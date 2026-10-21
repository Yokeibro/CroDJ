import { masterAnalyser } from './engine.js';
import { $, esc } from './util.js';

/** Full-screen party mode: beat-reactive visualiser, big now-playing, Auto DJ on. */
export class Party {
  constructor(getInfo) {
    this.getInfo = getInfo;
    this.el = $('#party');
    this.canvas = $('#partyViz');
    this.freq = new Uint8Array(masterAnalyser.frequencyBinCount);
    this.hue = 200; this.bassAvg = 0; this.flash = 0; this.active = false;
    $('#partyExit').onclick = () => this.toggle(false);
  }

  toggle(on = !this.active) {
    this.active = on;
    this.el.hidden = !on;
    if (on) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen();
    this.onToggle?.(on);
  }

  draw() {
    if (!this.active) return;
    const c = this.canvas, px = 1 / 2;
    const W = c.width = Math.round(c.clientWidth * px), H = c.height = Math.round(c.clientHeight * px);
    const g = c.getContext('2d');
    masterAnalyser.getByteFrequencyData(this.freq);
    let bass = 0;
    for (let i = 1; i < 12; i++) bass += this.freq[i];
    bass /= 11 * 255;
    if (bass > this.bassAvg * 1.18 && bass > 0.45) this.flash = 1;
    this.bassAvg = this.bassAvg * 0.93 + bass * 0.07;
    this.flash *= 0.88;
    this.hue = (this.hue + 0.3 + bass) % 360;

    g.fillStyle = `hsl(${this.hue}, 40%, ${3 + this.flash * 10}%)`;
    g.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, r0 = Math.min(W, H) * (0.18 + bass * 0.05);
    const bars = 128;
    for (let i = 0; i < bars; i++) {
      const v = this.freq[Math.floor(i * 1.6) + 2] / 255;
      const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const len = v * Math.min(W, H) * 0.3;
      g.strokeStyle = `hsla(${(this.hue + i * 2.5) % 360}, 95%, 60%, ${0.4 + v * 0.6})`;
      g.lineWidth = Math.max(1, (Math.PI * 2 * r0) / bars * 0.6);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
      g.stroke();
    }
    // light beams
    for (let k = 0; k < 6; k++) {
      const a = performance.now() / 2000 * (k % 2 ? 1 : -1) + k;
      g.fillStyle = `hsla(${(this.hue + k * 60) % 360}, 100%, 60%, ${0.05 + this.flash * 0.12})`;
      g.beginPath(); g.moveTo(cx, H);
      g.lineTo(cx + Math.cos(a) * W, H - Math.abs(Math.sin(a)) * H * 1.2);
      g.lineTo(cx + Math.cos(a + 0.12) * W, H - Math.abs(Math.sin(a + 0.12)) * H * 1.2);
      g.fill();
    }

    const info = this.getInfo();
    const key = info.now?.id + '|' + info.next?.id;
    if (key !== this.lastKey) {
      this.lastKey = key;
      $('#partyTitle').textContent = info.now?.title || 'Starting…';
      $('#partyArtist').textContent = info.now?.artist || '';
      $('#partyNext').innerHTML = info.next ? `Up next: <b>${esc(info.next.title)}</b> — ${esc(info.next.artist)}` : '';
      const img = $('#partyCover');
      img.hidden = !info.now;
      if (info.now) img.src = `/api/cover/${info.now.id}`;
    }
    $('#partyBpm').textContent = info.bpm ? info.bpm.toFixed(0) + ' BPM' : '';
    $('#partyCover').style.transform = `scale(${1 + this.flash * 0.06})`;
  }
}
