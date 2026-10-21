import { clamp, frac } from './util.js';

export const ctx = new AudioContext({ latencyHint: 'interactive' });
export const master = ctx.createGain();
export const masterAnalyser = ctx.createAnalyser();
masterAnalyser.fftSize = 2048;
masterAnalyser.smoothingTimeConstant = 0.7;
master.connect(masterAnalyser);
master.connect(ctx.destination);

export function resume() { if (ctx.state !== 'running') ctx.resume(); }

const gain = v => { const n = ctx.createGain(); n.gain.value = v; return n; };
const biquad = (type, f, q = 0.707) => {
  const n = ctx.createBiquadFilter();
  n.type = type; n.frequency.value = f; n.Q.value = q;
  return n;
};
const ramp = (param, v, t = 0.015) => param.setTargetAtTime(v, ctx.currentTime, t);

// ------------------------------------------------------------ headphone cue
export const cueBus = ctx.createGain();
const cueDest = ctx.createMediaStreamDestination();
cueBus.connect(cueDest);
const cueAudio = new Audio();
cueAudio.srcObject = cueDest.stream;
export const headphones = {
  deviceId: '',
  async setDevice(id) {
    this.deviceId = id;
    if (!id) { cueAudio.pause(); return; }
    await cueAudio.setSinkId(id);
    cueAudio.play().catch(() => {});
  },
};
export async function setMasterDevice(id) {
  if (ctx.setSinkId) await ctx.setSinkId(id || '');
}

// ------------------------------------------------------------ FX
function makeIR(seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}
const IRS = [1.2, 2.5, 5].map(makeIR);
const pick = (x, list) => list[Math.min(list.length - 1, Math.floor(x * list.length))];

const EFFECTS = {
  Echo(deck) {
    const inp = gain(1), delay = ctx.createDelay(4), fb = gain(0.5), tone = biquad('highpass', 250);
    inp.connect(delay); delay.connect(tone); tone.connect(fb); fb.connect(delay);
    return {
      in: inp, out: tone, mix: y => [1, y],
      tick(x) {
        const beats = pick(x, [0.25, 0.5, 0.75, 1]);
        ramp(delay.delayTime, clamp(beats * deck.spb / deck.effRate, 0.01, 3.9), 0.05);
      },
      label: x => pick(x, ['1/4', '1/2', '3/4', '1']) + ' beat',
    };
  },
  Reverb() {
    const inp = gain(1), conv = ctx.createConvolver(), tone = biquad('highpass', 200);
    conv.buffer = IRS[1];
    inp.connect(tone); tone.connect(conv);
    return {
      in: inp, out: conv, mix: y => [1 - y * 0.3, y * 1.4],
      tick(x) { const ir = pick(x, IRS); if (conv.buffer !== ir) conv.buffer = ir; },
      label: x => pick(x, ['Room', 'Hall', 'Cathedral']),
    };
  },
  Flanger(deck) {
    const inp = gain(1), delay = ctx.createDelay(0.05), fb = gain(0.65);
    const lfo = ctx.createOscillator(), depth = gain(0.0025);
    delay.delayTime.value = 0.004;
    inp.connect(delay); delay.connect(fb); fb.connect(delay);
    lfo.connect(depth); depth.connect(delay.delayTime); lfo.start();
    return {
      in: inp, out: delay, mix: y => [1 - y * 0.4, y],
      tick(x) { lfo.frequency.value = deck.effRate / (pick(x, [1, 2, 4, 8, 16]) * deck.spb); },
      label: x => pick(x, ['1', '2', '4', '8', '16']) + ' beats',
      stop() { lfo.stop(); },
    };
  },
  Phaser(deck) {
    const inp = gain(1), fb = gain(0.5), lfo = ctx.createOscillator(), depth = gain(700);
    const stages = [0, 1, 2, 3].map(() => biquad('allpass', 900, 0.6));
    inp.connect(stages[0]);
    stages.reduce((a, b) => (a.connect(b), b));
    stages[3].connect(fb); fb.connect(stages[0]);
    lfo.connect(depth); stages.forEach(s => depth.connect(s.frequency)); lfo.start();
    return {
      in: inp, out: stages[3], mix: y => [1 - y * 0.5, y],
      tick(x) { lfo.frequency.value = deck.effRate / (pick(x, [1, 2, 4, 8]) * deck.spb); },
      label: x => pick(x, ['1', '2', '4', '8']) + ' beats',
      stop() { lfo.stop(); },
    };
  },
  Slicer(deck) {
    const gate = gain(1);
    return {
      in: gate, out: gate, mix: () => [0, 1],
      tick(x, y, active) {
        const steps = pick(x, [1, 2, 4, 8]);
        const on = !active || Math.floor(deck.beatAt(deck.position) * steps) % 2 === 0;
        ramp(gate.gain, on ? 1 : 1 - y, 0.004);
      },
      label: x => '1/' + pick(x, [1, 2, 4, 8]) + ' beat',
    };
  },
  Brake() {
    return { mix: () => [1, 0], label: x => (1 + Math.round(x * 7)) + ' beat stop' };
  },
};
export const FX_LIST = Object.keys(EFFECTS);

class FXUnit {
  constructor(deck) {
    this.deck = deck;
    this.input = gain(1); this.output = gain(1); this.dry = gain(1); this.wet = gain(0);
    this.input.connect(this.dry); this.dry.connect(this.output); this.wet.connect(this.output);
    this.x = 0.5; this.y = 0.6; this.active = false;
    this.setType('Echo');
  }
  setType(t) {
    if (this.fx) {
      if (this.fx.in) { this.input.disconnect(this.fx.in); this.fx.out.disconnect(); }
      this.fx.stop?.();
    }
    this.type = t;
    this.fx = EFFECTS[t](this.deck);
    if (this.fx.in) { this.input.connect(this.fx.in); this.fx.out.connect(this.wet); }
    this.apply();
  }
  apply() {
    const [d, w] = this.active ? this.fx.mix(this.y) : [1, 0];
    ramp(this.dry.gain, d); ramp(this.wet.gain, w);
  }
  setActive(a) {
    if (this.type === 'Brake') { if (a) this.deck.brake(1 + Math.round(this.x * 7)); return; }
    this.active = a; this.apply();
  }
  setXY(x, y) { this.x = x; this.y = y; this.apply(); }
  tick() { if (this.deck.buffer) this.fx.tick?.(this.x, this.y, this.active); }
  get label() { return this.fx.label(this.x); }
}

// ------------------------------------------------------------ deck
const dbMap = v => (v < 0 ? v * 26 : v * 6);

export class Deck {
  constructor(index) {
    this.index = index;
    this.buffer = null; this.reversed = null; this.track = null;
    this.playing = false; this.pos = 0; this.anchor = 0; this.rate = 1; this.bend = 0;
    this.cuePoint = 0; this.hotcues = new Array(8).fill(null);
    this.loop = null; this.loopBeats = 4; this.slip = null; this.busyUntil = 0;
    this.bpm = 0; this.firstBeat = 0;
    this.handlers = {};

    this.input = gain(1);
    // "Stems": mid/side + band split. Vocals ≈ centre mids, instruments ≈ side
    // channel, beat ≈ centre lows and highs.
    const split = ctx.createChannelSplitter(2);
    this.input.connect(split);
    const mid = gain(1), side = gain(1);
    const lm = gain(0.5), rm = gain(0.5), ls = gain(0.5), rs = gain(-0.5);
    split.connect(lm, 0); split.connect(rm, 1); split.connect(ls, 0); split.connect(rs, 1);
    lm.connect(mid); rm.connect(mid); ls.connect(side); rs.connect(side);
    const lp = biquad('lowpass', 180), hp = biquad('highpass', 6000);
    mid.connect(lp); mid.connect(hp);
    this.vocalGain = gain(1); this.edgeGain = gain(0); this.instruGain = gain(1);
    mid.connect(this.vocalGain); lp.connect(this.edgeGain); hp.connect(this.edgeGain);
    side.connect(this.instruGain);
    const L = gain(1), R = gain(1), neg = gain(-1);
    for (const n of [this.vocalGain, this.edgeGain]) { n.connect(L); n.connect(R); }
    this.instruGain.connect(L); this.instruGain.connect(neg); neg.connect(R);
    const merge = ctx.createChannelMerger(2);
    L.connect(merge, 0, 0); R.connect(merge, 0, 1);
    this.stems = { vocal: 0, instru: 0, beat: 0 };

    this.eqBass = biquad('lowshelf', 220);
    this.eqMid = biquad('peaking', 1100, 0.8);
    this.fLP = biquad('lowpass', 22000, 1); this.fHP = biquad('highpass', 10, 1);
    this.fx = new FXUnit(this);
    this.volume = gain(1); this.xfade = gain(1); this.cueSend = gain(0);
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 1024;
    merge.connect(this.eqBass); this.eqBass.connect(this.eqMid); this.eqMid.connect(this.fLP);
    this.fLP.connect(this.fHP); this.fHP.connect(this.fx.input);
    this.fx.output.connect(this.volume); this.fx.output.connect(this.cueSend);
    this.cueSend.connect(cueBus);
    this.volume.connect(this.xfade); this.volume.connect(this.analyser);
    this.xfade.connect(master);
  }

  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }
  emit(ev) { (this.handlers[ev] || []).forEach(fn => fn(this)); }

  // ---- mixer
  /**
   * VirtualDJ-style stem knob, v in [-1, 1]: centre = normal, left = remove
   * this part, right = isolate it (the other parts are turned down).
   */
  setStem(name, v) {
    this.stems[name] = v;
    const g = { vocal: 1, instru: 1, beat: 1 };
    for (const [k, val] of Object.entries(this.stems)) {
      if (val < 0) g[k] *= 1 + val;
      else if (val > 0) for (const other in g) if (other !== k) g[other] *= 1 - val;
    }
    ramp(this.vocalGain.gain, g.vocal);
    ramp(this.edgeGain.gain, g.beat - g.vocal);
    ramp(this.instruGain.gain, g.instru);
  }
  setEQ(band, v) { ramp((band === 'bass' ? this.eqBass : this.eqMid).gain, dbMap(v)); }
  setFilter(v) {
    const lp = v < -0.02 ? 22000 * Math.pow(60 / 22000, -v) : 22000;
    const hp = v > 0.02 ? 10 * Math.pow(9000 / 10, v) : 10;
    ramp(this.fLP.frequency, lp, 0.02); ramp(this.fHP.frequency, hp, 0.02);
  }
  setVolume(v) { ramp(this.volume.gain, v * v); }
  setXfadeGain(v) { ramp(this.xfade.gain, v, 0.01); }
  setCue(on) { ramp(this.cueSend.gain, on ? 1 : 0); }
  get level() {
    const d = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(d);
    let s = 0; for (const x of d) s += x * x;
    return Math.sqrt(s / d.length);
  }

  // ---- loading
  async load(track, arrayBuffer) {
    this._stop();
    this.playing = false;
    let buf = await ctx.decodeAudioData(arrayBuffer);
    if (buf.numberOfChannels === 1) {
      const st = ctx.createBuffer(2, buf.length, buf.sampleRate);
      st.copyToChannel(buf.getChannelData(0), 0); st.copyToChannel(buf.getChannelData(0), 1);
      buf = st;
    }
    this.buffer = buf; this.reversed = null; this.track = track;
    this.bpm = track.bpm || 0; this.firstBeat = track.firstBeat || 0;
    this.pos = 0; this.cuePoint = 0; this.loop = null; this.slip = null;
    this.hotcues = new Array(8).fill(null);
    this.emit('load');
  }

  // ---- transport
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get effRate() { return this.rate * (1 + this.bend); }
  get spb() { return this.bpm ? 60 / this.bpm : 0.5; }
  get liveBpm() { return this.bpm * this.effRate; }
  get remaining() { return (this.duration - this.position) / this.effRate; }
  get position() {
    if (!this.playing) return this.pos;
    const now = ctx.currentTime;
    if (now < this.anchor) return this.pos;
    let p = this.pos + (now - this.anchor) * this.effRate;
    if (this.loop && p >= this.loop.end) {
      const len = this.loop.end - this.loop.start;
      p = this.loop.start + ((p - this.loop.start) % len);
    }
    return Math.min(p, this.duration);
  }
  beatAt(t) { return (t - this.firstBeat) / this.spb; }
  timeOfBeat(b) { return this.firstBeat + b * this.spb; }

  reanchor() {
    if (this.playing && ctx.currentTime >= this.anchor) {
      this.pos = this.position;
      this.anchor = ctx.currentTime;
    }
  }
  _start(when = 0) {
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.effRate;
    if (this.loop) { src.loop = true; src.loopStart = this.loop.start; src.loopEnd = this.loop.end; }
    src.connect(this.input);
    const t = Math.max(when, ctx.currentTime);
    src.start(t, clamp(this.pos, 0, this.duration - 0.001));
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null; this.playing = false; this.pos = this.duration;
      this.emit('state'); this.emit('ended');
    };
    this.src = src; this.anchor = t; this.playing = true;
  }
  _stop() {
    if (!this.src) return;
    this.src.onended = null;
    try { this.src.stop(); } catch { /* not started */ }
    this.src.disconnect();
    this.src = null;
  }
  play(when) {
    if (!this.buffer || this.playing) return;
    resume();
    if (this.pos >= this.duration - 0.05) this.pos = 0;
    this._start(when);
    this.emit('state');
  }
  pause() {
    if (!this.playing) return;
    this.pos = this.position;
    this._stop();
    this.playing = false;
    this.emit('state');
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) {
    t = clamp(t, 0, Math.max(0, this.duration - 0.01));
    if (this.loop && (t < this.loop.start || t > this.loop.end)) this.loop = null;
    if (this.playing) { this._stop(); this.pos = t; this._start(); } else this.pos = t;
    this.emit('seek');
  }
  setRate(r) {
    this.reanchor();
    this.rate = r;
    if (this.src) this.src.playbackRate.setValueAtTime(this.effRate, ctx.currentTime);
    this.emit('rate');
  }
  setBend(b) {
    this.reanchor();
    this.bend = b;
    if (this.src) this.src.playbackRate.setValueAtTime(this.effRate, ctx.currentTime);
  }

  // VirtualDJ-style CUE: paused → set cue (or hold to preview); playing → back to cue.
  cueDown() {
    if (!this.buffer) return;
    if (this.playing) { this.pause(); this.seek(this.cuePoint); return; }
    if (Math.abs(this.pos - this.cuePoint) < 0.02) { this.cuePreview = true; this.play(); }
    else this.cuePoint = this.pos;
    this.emit('cue');
  }
  cueUp() {
    if (!this.cuePreview) return;
    this.cuePreview = false;
    this.pause(); this.seek(this.cuePoint);
  }
  hotcue(i) {
    if (!this.buffer) return;
    if (this.hotcues[i] == null) this.hotcues[i] = this.position;
    else this.seek(this.hotcues[i]);
    this.emit('cue');
  }
  clearHotcue(i) { this.hotcues[i] = null; this.emit('cue'); }

  // ---- loops & rolls
  setLoop(start, end) {
    this.reanchor();
    this.loop = { start, end };
    if (this.src) { this.src.loop = true; this.src.loopStart = start; this.src.loopEnd = end; }
    if (!this.playing && (this.pos < start || this.pos > end)) this.pos = start;
    this.emit('loop');
  }
  clearLoop() {
    if (!this.loop) return;
    this.reanchor();
    this.loop = null;
    if (this.src) this.src.loop = false;
    this.emit('loop');
  }
  toggleLoop() {
    if (!this.buffer) return;
    if (this.loop) return this.clearLoop();
    const p = this.position;
    const start = this.bpm ? Math.max(0, this.timeOfBeat(Math.floor(this.beatAt(p) + 0.02))) : p;
    this.setLoop(start, start + this.loopBeats * this.spb);
  }
  resizeLoop(beats) {
    this.loopBeats = beats;
    if (!this.loop) return this.emit('loop');
    const p = this.position, { start } = this.loop, end = start + beats * this.spb;
    this.setLoop(start, end);
    if (p >= end) this.seek(start + ((p - start) % (end - start)));
  }
  rollStart(beats) {
    if (!this.playing || !this.bpm) return;
    const p = this.position;
    this.slip = { pos: p, time: ctx.currentTime, rate: this.effRate };
    const step = Math.min(beats, 1);
    const start = Math.max(0, this.timeOfBeat(Math.floor(this.beatAt(p) / step) * step));
    this.setLoop(start, start + beats * this.spb);
  }
  rollEnd() {
    if (!this.slip) return;
    const target = this.slip.pos + (ctx.currentTime - this.slip.time) * this.slip.rate;
    this.slip = null; this.loop = null;
    this.seek(target);
    this.emit('loop');
  }
  beatJump(beats) { if (this.buffer) this.seek(this.position + beats * this.spb); }

  // ---- scratching (grain playback, reversed buffer for backspins)
  _ensureReversed() {
    if (this.reversed) return;
    const b = this.buffer;
    const r = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    for (let ch = 0; ch < b.numberOfChannels; ch++) {
      const s = b.getChannelData(ch), d = r.getChannelData(ch), n = s.length;
      for (let i = 0; i < n; i++) d[i] = s[n - 1 - i];
    }
    this.reversed = r;
  }
  /** A playback head running one way through the track (reversed buffer for backwards). */
  _head(dir, pos, when, rate) {
    const src = ctx.createBufferSource();
    src.buffer = dir > 0 ? this.buffer : this.reversed;
    src.playbackRate.setValueAtTime(rate, when);
    const g = ctx.createGain();
    src.connect(g); g.connect(this.input);
    src.start(when, clamp(dir > 0 ? pos : this.duration - pos, 0, this.duration - 0.01));
    return { src, g, dir };
  }
  _killHead(h, when = ctx.currentTime) {
    if (!h) return;
    h.g.gain.setTargetAtTime(0, when, 0.003);
    h.src.stop(when + 0.03);
  }

  // Hand-on-vinyl model: the pointer sets a target speed, the platter follows
  // with a little inertia, and audio speed tracks the platter continuously.
  scratchBegin() {
    if (!this.buffer) return;
    this._ensureReversed();
    const wasPlaying = this.playing;
    if (this.playing) { this.pos = this.position; this._stop(); this.playing = false; }
    this.scratch = { wasPlaying, vel: wasPlaying ? this.effRate : 0, target: 0, lastMove: 0, head: null };
    this.scratch.timer = setInterval(() => this._scratchStep(), 8);
    this._lastStep = performance.now();
  }
  scratchMove(dSec) {
    const s = this.scratch;
    if (!s) return;
    const now = performance.now();
    const dt = Math.max(0.008, (now - (s.lastMove || now - 16)) / 1000);
    s.lastMove = now;
    s.target = clamp(dSec / dt, -6, 6);
  }
  _scratchStep() {
    const s = this.scratch;
    if (!s) return;
    const now = performance.now(), dt = (now - this._lastStep) / 1000;
    this._lastStep = now;
    if (now - s.lastMove > 40) s.target = s.releasing ? this.effRate : 0; // hand held still
    s.vel += (s.target - s.vel) * Math.min(1, dt * (s.releasing ? 14 : 35));
    this.pos = clamp(this.pos + s.vel * dt, 0, this.duration);
    const dir = s.vel >= 0 ? 1 : -1, speed = Math.abs(s.vel);
    if (speed < 0.02) {
      if (s.head) { this._killHead(s.head); s.head = null; }
    } else if (!s.head || s.head.dir !== dir) {
      this._killHead(s.head);
      s.head = this._head(dir, this.pos, ctx.currentTime, speed);
    } else {
      s.head.src.playbackRate.setTargetAtTime(speed, ctx.currentTime, 0.006);
    }
    if (s.releasing && Math.abs(s.vel - this.effRate) < 0.03) this._scratchFinish();
  }
  scratchEnd() {
    const s = this.scratch;
    if (!s) return;
    if (s.wasPlaying) { s.releasing = true; s.lastMove = 0; return; } // motor spins back up
    this._scratchFinish();
  }
  _scratchFinish() {
    const s = this.scratch;
    clearInterval(s.timer);
    this.scratch = null;
    this._killHead(s.head);
    if (s.wasPlaying) this._start();
    this.emit('state');
  }

  /** Pre-programmed scratch: each step moves the record like a hand would (speed ramps up and down). */
  scratchPattern(steps) {
    if (!this.buffer || this.scratch || ctx.currentTime < this.busyUntil) return;
    this._ensureReversed();
    const wasPlaying = this.playing, start = this.position, r = this.effRate;
    const beat = this.spb / r;
    if (this.playing) { this._stop(); this.playing = false; }
    let t = ctx.currentTime + 0.01, p = start;
    for (const [beats, vel, on] of steps) {
      const dur = beats * beat, v = Math.abs(vel * r);
      if (on) {
        const h = this._head(Math.sign(vel), p, t, 0.01);
        const pr = h.src.playbackRate;
        pr.linearRampToValueAtTime(v, t + dur * 0.3);
        pr.setValueAtTime(v, t + dur * 0.7);
        pr.linearRampToValueAtTime(0.01, t + dur);
        h.g.gain.setValueAtTime(0, t);
        h.g.gain.linearRampToValueAtTime(1, t + 0.004);
        h.g.gain.setValueAtTime(1, t + dur - 0.004);
        h.g.gain.linearRampToValueAtTime(0, t + dur);
        h.src.stop(t + dur + 0.01);
      }
      p = clamp(p + vel * r * dur * 0.7, 0, this.duration);
      t += dur;
    }
    this.busyUntil = t;
    // slip mode: the track keeps "running" underneath the scratch
    this.pos = wasPlaying ? start + (t - ctx.currentTime) * r : start;
    if (wasPlaying) this._start(t);
  }
  brake(beats = 2) {
    if (!this.playing || !this.src) return;
    this.reanchor();
    const dur = beats * this.spb / this.effRate, now = ctx.currentTime;
    const p = this.pos, r = this.effRate, src = this.src;
    src.playbackRate.setValueAtTime(r, now);
    src.playbackRate.linearRampToValueAtTime(0.001, now + dur);
    setTimeout(() => {
      if (this.src !== src) return;
      this._stop(); this.playing = false;
      this.pos = p + r * dur / 2;
      this.emit('state');
    }, dur * 1000);
  }

  // ---- sync / beatgrid
  syncTo(other, phase = true) {
    if (!this.bpm || !other.bpm || !other.buffer) return false;
    let ratio = other.liveBpm / this.bpm;
    while (ratio > 1.45) ratio /= 2;
    while (ratio < 0.72) ratio *= 2;
    this.bend = 0;
    this.setRate(ratio);
    if (phase && this.playing && other.playing) {
      let d = frac(this.beatAt(this.position)) - frac(other.beatAt(other.position));
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      this.seek(this.position - d * this.spb);
    }
    return true;
  }
  /** Start playing so this deck's bars land on the other deck's next bar. */
  playInSync(other, unit = 4) {
    if (!other.playing || !this.bpm || !other.bpm) { this.play(); return ctx.currentTime; }
    this.syncTo(other, false);
    const lead = 0.08, now = ctx.currentTime + lead;
    const ob = other.beatAt(other.position + lead * other.effRate);
    const nextB = Math.ceil(ob / unit - 1e-6) * unit;
    const wait = (nextB - ob) * other.spb / other.effRate;
    let sb = Math.round(this.beatAt(this.pos) / unit) * unit;
    if (this.timeOfBeat(sb) < 0) sb += unit;
    this.pos = this.timeOfBeat(sb);
    this.play(now + wait);
    return now + wait;
  }
  /** Start this deck at `myBeat` exactly when `other` reaches `otherBeat`. Returns the start time. */
  playAligned(other, otherBeat, myBeat) {
    this.syncTo(other, false);
    const lead = 0.06;
    const ob = other.beatAt(other.position + lead * other.effRate);
    while (otherBeat < ob) otherBeat += 4;
    const when = ctx.currentTime + lead + (otherBeat - ob) * other.spb / other.effRate;
    this.pos = Math.max(0, this.timeOfBeat(myBeat));
    this.play(when);
    return when;
  }
  setDownbeat() {
    if (!this.bpm) return;
    const p = this.position, bar = 4 * this.spb;
    this.firstBeat = p - Math.floor(p / bar) * bar;
    this.emit('grid');
  }
  shiftGrid(sec) { this.firstBeat += sec; this.emit('grid'); }
  scaleBpm(f) { if (this.bpm) { this.bpm *= f; this.emit('grid'); } }
}

// ------------------------------------------------------------ sampler
async function render(dur, build) {
  const oc = new OfflineAudioContext(2, Math.ceil(dur * 44100), 44100);
  const noise = oc.createBuffer(1, oc.length, 44100);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  build(oc, noise);
  return oc.startRendering();
}
function env(oc, node, points) {
  const g = oc.createGain();
  g.gain.setValueAtTime(points[0][1], 0);
  for (const [t, v] of points.slice(1)) g.gain.linearRampToValueAtTime(v, t);
  node.connect(g);
  return g;
}

const SAMPLES = {
  'Air Horn': () => render(1.6, oc => {
    const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.7;
    for (const f of [466, 470, 587, 591]) {
      const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(bp); o.start();
    }
    env(oc, bp, [[0, 0], [0.02, 0.5], [0.15, 0.5], [0.17, 0], [0.25, 0], [0.27, 0.5], [0.4, 0.5], [0.42, 0],
      [0.5, 0], [0.52, 0.5], [1.4, 0.5], [1.6, 0]]).connect(oc.destination);
  }),
  'Siren': () => render(2.2, oc => {
    const o = oc.createOscillator(); o.type = 'square';
    const lfo = oc.createOscillator(); lfo.frequency.value = 2.5;
    const depth = oc.createGain(); depth.gain.value = 350;
    o.frequency.value = 900; lfo.connect(depth); depth.connect(o.frequency);
    const lp = oc.createBiquadFilter(); lp.frequency.value = 2500; o.connect(lp);
    o.start(); lfo.start();
    env(oc, lp, [[0, 0], [0.05, 0.25], [2, 0.25], [2.2, 0]]).connect(oc.destination);
  }),
  'Kick': () => render(0.6, oc => {
    const o = oc.createOscillator();
    o.frequency.setValueAtTime(160, 0); o.frequency.exponentialRampToValueAtTime(40, 0.35); o.start();
    env(oc, o, [[0, 1], [0.5, 0]]).connect(oc.destination);
  }),
  'Snare': () => render(0.4, (oc, noise) => {
    const n = oc.createBufferSource(); n.buffer = noise; n.start();
    const bp = oc.createBiquadFilter(); bp.type = 'highpass'; bp.frequency.value = 1500; n.connect(bp);
    env(oc, bp, [[0, 0.8], [0.25, 0]]).connect(oc.destination);
    const o = oc.createOscillator(); o.frequency.value = 190; o.start();
    env(oc, o, [[0, 0.6], [0.12, 0]]).connect(oc.destination);
  }),
  'Clap': () => render(0.5, (oc, noise) => {
    const n = oc.createBufferSource(); n.buffer = noise; n.start();
    const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 1.5; n.connect(bp);
    env(oc, bp, [[0, 0], [0.002, 1], [0.012, 0.1], [0.02, 1], [0.03, 0.1], [0.04, 1], [0.4, 0]]).connect(oc.destination);
  }),
  'Laser': () => render(0.5, oc => {
    const o = oc.createOscillator(); o.type = 'square';
    o.frequency.setValueAtTime(2400, 0); o.frequency.exponentialRampToValueAtTime(90, 0.4); o.start();
    env(oc, o, [[0, 0.3], [0.45, 0]]).connect(oc.destination);
  }),
  'Riser': () => render(4, (oc, noise) => {
    const n = oc.createBufferSource(); n.buffer = noise; n.start();
    const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(300, 0); bp.frequency.exponentialRampToValueAtTime(9000, 4); n.connect(bp);
    env(oc, bp, [[0, 0], [3.9, 1], [4, 0]]).connect(oc.destination);
  }),
  'Boom': () => render(2, oc => {
    const o = oc.createOscillator();
    o.frequency.setValueAtTime(90, 0); o.frequency.exponentialRampToValueAtTime(28, 1.8); o.start();
    const sh = oc.createWaveShaper();
    sh.curve = Float32Array.from({ length: 256 }, (_, i) => Math.tanh(3 * (i / 128 - 1)));
    o.connect(sh);
    env(oc, sh, [[0, 0.9], [1.9, 0]]).connect(oc.destination);
  }),
};

export const sampler = {
  bus: gain(0.7),
  buffers: {},
  names: Object.keys(SAMPLES),
  async init() {
    this.bus.connect(master);
    await Promise.all(this.names.map(async n => { this.buffers[n] = await SAMPLES[n](); }));
  },
  play(name) {
    const b = this.buffers[name];
    if (!b) return;
    resume();
    const s = ctx.createBufferSource();
    s.buffer = b; s.connect(this.bus); s.start();
  },
};

// Scratch patterns as [beats, velocity, sound-on] steps.
const rep = (n, steps) => Array.from({ length: n }, () => steps).flat();
export const SCRATCHES = {
  'Baby': rep(2, [[0.25, 2, 1], [0.25, -2, 1]]),
  'Chirp': rep(2, [[0.125, 2, 1], [0.125, 2, 0], [0.125, -2, 1], [0.125, -2, 0]]),
  'Transformer': rep(4, [[0.125, 1, 1], [0.125, 1, 0]]),
  'Forward': rep(2, [[0.25, 2, 1], [0.25, -2, 0]]),
  'Stab': rep(2, [[0.125, 3, 1], [0.375, -1, 0]]),
  'Tear': rep(2, [[0.25, 2, 1], [0.083, -2, 1], [0.083, -2, 0], [0.084, -2, 1]]),
  'Scribble': rep(8, [[0.0625, 3, 1], [0.0625, -3, 1]]),
  'Spinback': [[0.25, -4, 1], [0.25, -3, 1], [0.25, -2, 1], [0.25, -1, 1]],
};
