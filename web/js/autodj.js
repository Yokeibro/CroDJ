import { ctx } from './engine.js';
import { keyCompat, lib, suggest, saveQueue } from './library.js';
import { clamp, toast } from './util.js';

const smooth = p => p * p * (3 - 2 * p);
/** Piecewise-linear envelope: points = [[p, value], ...] sorted by p. */
function env(p, points) {
  if (p <= points[0][0]) return points[0][1];
  for (let k = 1; k < points.length; k++) {
    const [p1, v1] = points[k], [p0, v0] = points[k - 1];
    if (p <= p1) return v0 + (v1 - v0) * smooth((p - p0) / (p1 - p0 || 1));
  }
  return points[points.length - 1][1];
}

// ------------------------------------------------------------ track structure
/** Mean loudness of each 4-beat bar, from the waveform peaks. */
function barEnergy(deck) {
  if (!deck.peaks || !deck.bpm) return null;
  const { amp } = deck.peaks, bars = [];
  for (let k = 0; ; k++) {
    const t0 = deck.timeOfBeat(4 * k), t1 = deck.timeOfBeat(4 * k + 4);
    if (t1 > deck.duration) break;
    let s = 0, n = 0;
    for (let b = Math.max(0, Math.floor(t0 * 100)); b < Math.floor(t1 * 100); b++) { s += amp[b]; n++; }
    bars.push(n ? s / n : 0);
  }
  return bars;
}
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] || 0;

/** Where the incoming track should start: the drop lands as the mix finishes. */
function pickMixIn(deck, mixBeats) {
  const bars = barEnergy(deck);
  if (!bars || bars.length < 8) return 0;
  const med = median(bars);
  for (let k = 4; k < Math.min(bars.length, 48); k++) {
    const before = (bars[k - 1] + bars[k - 2] + bars[k - 3] + bars[k - 4]) / 4;
    if (bars[k] > med * 0.95 && bars[k] > before * 1.25) {
      const inBeat = 4 * k - mixBeats;
      return Math.max(0, Math.floor(inBeat / 16) * 16);
    }
  }
  return 0;
}

/** Earliest phrase boundary (16 beats) at least `minAhead` beats away. */
function nextPhrase(deck, minAhead = 4) {
  const b = deck.beatAt(deck.position) + minAhead;
  return Math.ceil(b / 16) * 16;
}

/** For Auto DJ: the phrase where the outro starts, leaving room for the mix. */
function pickMixOut(deck, mixBeats) {
  const lastBeat = Math.floor(deck.beatAt(deck.duration)) - 4;
  const latest = Math.floor((lastBeat - mixBeats) / 16) * 16;
  const bars = barEnergy(deck);
  if (!bars) return latest;
  const med = median(bars);
  // walk back from the end while the music is quiet (the outro)
  let out = latest;
  for (let b = latest; b >= latest - 64 && b > 0; b -= 16) {
    const k = b / 4, chunk = bars.slice(k, k + 4);
    if (chunk.length && Math.max(...chunk) < med * 0.8) out = b; else break;
  }
  return Math.max(16, out);
}

/**
 * Mixing brain shared by AI Mix and Auto DJ. While it works the deck
 * controls are locked; `stopAI()` (double-click the AI badge) hands control back.
 */
export class Mixer {
  constructor(decks, ui) {
    this.decks = decks; this.ui = ui;
    this.enabled = false; this.mixBeats = 32;
    this.tr = null; this.norm = null; this.tween = null;
    this.preparedFor = null; this.autoPlan = null; this.starting = false;
  }

  get locked() { return this.enabled || !!this.tr; }

  /** Deck the audience is hearing: playing and favoured by the crossfader. */
  get current() {
    const [a, b] = this.decks, xf = this.ui.getXF();
    if (a.playing && b.playing) return xf <= 0.5 ? a : b;
    return a.playing ? a : b.playing ? b : (a.track ? a : b.track ? b : null);
  }

  pickNext(exclude) {
    while (lib.queue.length) {
      const t = lib.byId.get(lib.queue.shift());
      saveQueue();
      if (t && !exclude.has(t.id)) return t;
    }
    const best = suggest(this.current?.track, { exclude, limit: 1 })[0];
    if (best) return best.track;
    const pool = lib.tracks.filter(t => !exclude.has(t.id) && !lib.history.includes(t.id));
    return pool[Math.floor(Math.random() * pool.length)] || null;
  }

  // ---------------------------------------------------------- AI Mix
  /** Analyse both decks and blend from the playing one into the other. */
  aiMix() {
    if (this.tr) return;
    const [a, b] = this.decks;
    if (!a.track || !b.track) return toast('AI Mix needs a song on both decks');
    if (!a.bpm || !b.bpm) return toast('Still analysing BPM, try again in a moment');
    let from = this.current;
    if (!from.playing) {
      from.pos = Math.max(0, from.timeOfBeat(0));
      this.ui.setXF(from.index ? 1 : 0);
      from.play();
    }
    const to = this.decks[1 - from.index];
    if (to.playing) { // both already running: blend right away
      to.syncTo(from);
      return this.transition(from, to, { beats: 16, start: ctx.currentTime });
    }
    this.transition(from, to, { outBeat: nextPhrase(from, 4) });
  }

  /**
   * Beat-matched, phrase-aligned transition. `plan.outBeat` = beat on the
   * outgoing deck where the incoming deck starts.
   */
  transition(from, to, plan = {}) {
    const harmonic = keyCompat(from.track?.camelot, to.track?.camelot) >= 0.45;
    const beats = plan.beats || (harmonic ? this.mixBeats : Math.min(16, this.mixBeats));
    let start = plan.start;
    if (start == null) {
      const inBeat = to.position > 1 && !to.playing && Math.abs(to.position - to.cuePoint) < 0.05
        ? Math.round(to.beatAt(to.position)) // the DJ cued a spot: respect it
        : pickMixIn(to, beats);
      start = to.playAligned(from, plan.outBeat ?? nextPhrase(from, 4), inBeat);
    }
    const dur = beats * from.spb / from.effRate;
    this.ui.setVolume(to.index, 1);
    this.tr = { from, to, start, dur, xf0: this.ui.getXF(), harmonic };
    this.applyAutomation(0);
    this.ui.onAI?.(true, `AI MIXING → ${to.track.title}`);
  }

  /** All the moves a DJ would make, as a function of mix progress p (0..1). */
  applyAutomation(p) {
    const { from, to, xf0 } = this.tr;
    const side = to.index ? 1 : 0;
    const k = (deck, name, v) => this.ui.setKnob(deck.index, name, v);
    this.ui.setXF(env(p, [[0, xf0], [0.35, 0.5], [0.65, 0.5], [1, side]]));
    k(to, 'bass', p < 0.5 ? -1 : 0);
    k(from, 'bass', p < 0.5 ? 0 : -1);
    k(to, 'vocal', env(p, [[0, -1], [0.55, -1], [0.85, 0]])); // no vocal clash
    k(from, 'vocal', env(p, [[0, 0], [0.45, -1]]));
    k(to, 'filter', env(p, [[0, 0.45], [0.4, 0]]));
    k(from, 'filter', env(p, [[0, 0], [0.6, 0], [1, 0.65]]));
  }

  resetKnobs(deck) {
    for (const n of ['bass', 'mid', 'vocal', 'instru', 'beat', 'filter']) this.ui.setKnob(deck.index, n, 0);
  }

  finishTransition() {
    const { from, to } = this.tr;
    from.pause();
    this.resetKnobs(from); this.resetKnobs(to);
    this.ui.setXF(to.index ? 1 : 0);
    this.tr = null;
    this.ui.onAI?.(this.enabled, this.enabled ? 'AUTO DJ' : '');
    // drift the new track back to its original tempo over 16 bars
    if (Math.abs(to.rate - 1) > 0.002) this.norm = { deck: to, r0: to.rate, start: ctx.currentTime, dur: 64 * to.spb };
  }

  /** Double-click on the AI badge: hand control back to the DJ immediately. */
  stopAI() {
    const tr = this.tr;
    this.enabled = false; this.autoPlan = null; this.preparedFor = null;
    if (tr) {
      if (ctx.currentTime < tr.start) tr.to.pause(); // incoming hadn't started yet
      this.resetKnobs(tr.from); this.resetKnobs(tr.to);
      this.tr = null;
    }
    this.ui.onAutoDJ?.(false);
    this.ui.onAI?.(false, '');
    toast('You have control. AI stopped.');
  }

  // ---------------------------------------------------------- crossfader tween
  tweenXF(target, sec) {
    return new Promise(res => {
      this.tween = { x0: this.ui.getXF(), target, t0: ctx.currentTime, sec, res };
    });
  }

  /** Change the song on an on-air deck: slide to the other deck, swap, slide back. */
  async swapTrack(i, track) {
    const deck = this.decks[i], other = this.decks[1 - i];
    const home = i ? 1 : 0;
    if (other.playing) await this.tweenXF(1 - home, 0.5);
    else { deck.setVolume(0); await new Promise(r => setTimeout(r, 250)); }
    if (!await this.ui.loadTrack(i, track, true)) return;
    deck.pos = Math.max(0, deck.timeOfBeat(0));
    if (other.playing && deck.bpm && other.bpm) {
      const nextBar = Math.ceil((other.beatAt(other.position) + 1) / 4) * 4;
      const start = deck.playAligned(other, nextBar, 0);
      await new Promise(r => setTimeout(r, Math.max(0, (start - ctx.currentTime) * 1000)));
      await this.tweenXF(home, 1.5);
    } else {
      deck.play();
      this.ui.setVolume(i, this.ui.getVolume(i));
    }
  }

  // ---------------------------------------------------------- per-tick
  tick() {
    const now = ctx.currentTime;
    if (this.tween) {
      const { x0, target, t0, sec, res } = this.tween;
      const p = clamp((now - t0) / sec, 0, 1);
      this.ui.setXF(x0 + (target - x0) * smooth(p));
      if (p >= 1) { this.tween = null; res(); }
    }
    const tr = this.tr;
    if (tr) {
      if (now < tr.start) return;
      const p = clamp((now - tr.start) / tr.dur, 0, 1);
      this.applyAutomation(p);
      if (p >= 1 || !tr.to.playing) this.finishTransition();
      return;
    }
    if (this.norm) {
      const { deck, r0, start, dur } = this.norm;
      const p = clamp((now - start) / dur, 0, 1);
      deck.setRate(r0 + (1 - r0) * p);
      if (p >= 1 || !deck.playing) this.norm = null;
    }
    if (this.enabled) this.autoTick();
  }

  async autoTick() {
    if (this.starting) return;
    const playing = this.decks.filter(d => d.playing);
    const loaded = new Set(this.decks.map(d => d.track?.id).filter(Boolean));
    if (!playing.length) {
      this.starting = true;
      try {
        const deck = this.decks[0];
        const t = deck.track && deck.position < deck.duration - 30 ? deck.track : this.pickNext(loaded);
        if (!t) { this.setEnabled(false); toast('Auto DJ: library is empty'); return; }
        if (deck.track?.id !== t.id) await this.ui.loadTrack(0, t, true);
        this.ui.setXF(0); this.ui.setVolume(0, 1);
        deck.play();
      } finally { this.starting = false; }
      return;
    }
    const cur = this.current;
    const other = this.decks[1 - cur.index];
    if (this.preparedFor !== cur.track.id && !other.playing && cur.remaining < 90) {
      this.preparedFor = cur.track.id;
      this.autoPlan = null;
      // respect a track the DJ already cued up on the other deck
      const userPick = other.track && !lib.history.includes(other.track.id);
      const next = userPick ? null : this.pickNext(loaded);
      if (next) {
        this.starting = true;
        try { await this.ui.loadTrack(other.index, next, true); } finally { this.starting = false; }
      }
    }
    if (this.preparedFor === cur.track.id && other.track && !other.playing && other.bpm && cur.bpm) {
      this.autoPlan ??= pickMixOut(cur, this.mixBeats);
      if (cur.beatAt(cur.position) >= this.autoPlan - 8) {
        this.transition(cur, other, { outBeat: this.autoPlan });
      }
    }
  }

  setEnabled(on) {
    this.enabled = on;
    this.preparedFor = null; this.autoPlan = null;
    this.ui.onAutoDJ?.(on);
    this.ui.onAI?.(on || !!this.tr, on ? 'AUTO DJ' : '');
  }
}
