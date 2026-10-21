import { Deck, FX_LIST, SCRATCHES, headphones, master, resume, sampler, setMasterDevice } from './engine.js';
import { DECK_COLORS, computePeaks, drawDisc, drawOverview, drawStrip, overviewImage } from './waveform.js';
import { keyCompat, lib, refresh, renderTable, saveQueue, suggest } from './library.js';
import { Mixer } from './autodj.js';
import { Party } from './party.js';
import { $, $$, Knob, clamp, esc, fmtTime, frac, store, toast } from './util.js';

const decks = [new Deck(0), new Deck(1)];
const L = i => 'AB'[i];
const knobs = [{}, {}];
const LOOP_SIZES = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
const AUDIO_RE = /\.(mp3|m4a|flac|wav|ogg|opus|aac)$/i;
const fmtBeats = b => (b < 1 ? '1/' + Math.round(1 / b) : String(b));
let pitchRange = store.get('pitchRange', 8);
let stripWindow = 8;
let xfValue = 0.5;

// ================================================================ deck UI
// Layout follows YouDJ (FX pad · disc · tempo, then one control row); the
// VirtualDJ extras (pads, sync/match, mix assist) sit around it.
function deckTemplate(i) {
  return `
  <div class="deck-head">
    <div class="deck-letter">${L(i)}</div>
    <div class="deck-title">
      <div class="t-title">Load a song from the library below</div>
      <div class="t-artist"></div>
      <div class="t-time"><span class="elapsed">0:00</span> / <span class="total">0:00</span> · <span class="remain">-0:00</span> <span class="keyname"></span></div>
    </div>
    <div class="deck-bpm">
      <div class="bpm-row"><span class="bpm">---.--</span><small>BPM</small></div>
      <div class="pitch-readout">+0.0%</div>
      <div class="bpm-btns">
        <button class="sync" title="Sync tempo and beats to the other deck">SYNC</button>
        <button class="match" title="Match tempo only · ! = keys clash">MATCH<i class="key-ind"></i></button>
        <button class="assist" title="Mix Assist: auto-sync and start on the other deck's next bar">ASSIST</button>
      </div>
    </div>
  </div>
  <canvas class="overview" title="Click to jump"></canvas>
  <div class="beat-leds"><i></i><i></i><i></i><i></i></div>
  <div class="deck-body">
    <div class="fx-box">
      <div class="xy" title="FX pad: hold and drag. Left/right = timing, up/down = amount"><div class="xy-dot"></div></div>
      <span class="xy-label"></span>
    </div>
    <div class="disc-wrap"><canvas class="disc" title="Drag to scratch · scroll to nudge"></canvas></div>
    <div class="pitch">
      <small>TEMPO</small>
      <input type="range" class="pitch-slider" min="-1" max="1" step="0.0005" value="0" title="Double-click to reset">
      <div class="bend"><button class="bend-dn" title="Nudge slower">‹</button><button class="bend-up" title="Nudge faster">›</button></div>
    </div>
  </div>
  <div class="deck-ctrl">
    <select class="fx-select" title="Effect">${FX_LIST.map(f => `<option>FX · ${f}</option>`).join('')}</select>
    <button class="fx-on" title="Latch effect on">FX</button>
    <div class="loop">
      <button class="loop-minus" title="Halve loop">−</button>
      <button class="loop-toggle" title="Loop on/off">⟲ <span class="loop-size">4</span></button>
      <button class="loop-plus" title="Double loop">+</button>
    </div>
    <button class="cue">CUE</button>
    <button class="play">▶</button>
  </div>
  <div class="pads-panel">
    <div class="pad-tabs">
      <button data-page="hotcue">HOT CUE</button><button data-page="beatgrid">BEATGRID</button>
      <button data-page="rolls">ROLLS</button><button data-page="scratch">SCRATCH</button><button data-page="sampler">SAMPLER</button>
    </div>
    <div class="pads"></div>
  </div>`;
}

function padDefs(deck, page) {
  switch (page) {
    case 'hotcue':
      return deck.hotcues.map((t, k) => ({
        label: t == null ? `Cue ${k + 1}` : `${k + 1} · ${fmtTime(t)}`, cls: t == null ? '' : 'set',
        down: () => deck.hotcue(k), ctx: () => deck.clearHotcue(k),
      }));
    case 'beatgrid':
      return [
        { label: 'Set downbeat', down: () => { deck.setDownbeat(); saveGrid(deck); } },
        { label: '◀ Grid', down: () => { deck.shiftGrid(-0.01); saveGrid(deck); } },
        { label: 'Grid ▶', down: () => { deck.shiftGrid(0.01); saveGrid(deck); } },
        { label: 'Tap BPM', down: () => tapBpm(deck) },
        { label: 'BPM ×2', down: () => { deck.scaleBpm(2); saveGrid(deck); } },
        { label: 'BPM ÷2', down: () => { deck.scaleBpm(0.5); saveGrid(deck); } },
        { label: '◀◀ 4', down: () => deck.beatJump(-4) },
        { label: '4 ▶▶', down: () => deck.beatJump(4) },
      ];
    case 'rolls':
      return [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8].map(b => ({
        label: 'Roll ' + fmtBeats(b), down: () => deck.rollStart(b), up: () => deck.rollEnd(),
      }));
    case 'scratch':
      return Object.keys(SCRATCHES).map(n => ({ label: n, down: () => deck.scratchPattern(SCRATCHES[n]) }));
    case 'sampler':
      return sampler.names.map(n => ({ label: n, down: () => sampler.play(n) }));
  }
  return [];
}

const tapTimes = [[], []];
function tapBpm(deck) {
  const t = tapTimes[deck.index], now = performance.now();
  if (t.length && now - t[t.length - 1] > 2000) t.length = 0;
  t.push(now);
  if (t.length >= 4) {
    const avg = (t[t.length - 1] - t[0]) / (t.length - 1);
    deck.bpm = Math.round(60000 / avg * 10) / 10;
    deck.emit('grid'); saveGrid(deck);
  }
}
function saveGrid(deck) {
  if (!deck.track) return;
  const g = store.get('grids', {});
  g[deck.track.id] = { bpm: deck.bpm, firstBeat: deck.firstBeat };
  store.set('grids', g);
}

function buildDeck(i) {
  const deck = decks[i];
  const root = $('#deck' + i);
  root.innerHTML = deckTemplate(i);
  const q = s => $(s, root);
  let page = store.get('padPage' + i, i ? 'scratch' : 'sampler');

  const renderPads = () => {
    $$('.pad-tabs button', root).forEach(b => b.classList.toggle('active', b.dataset.page === page));
    const pads = q('.pads');
    pads.innerHTML = '';
    padDefs(deck, page).forEach(d => {
      const b = document.createElement('button');
      b.className = 'pad ' + (d.cls || '') + ' p-' + page;
      b.textContent = d.label;
      b.addEventListener('pointerdown', e => { if (e.button) return; resume(); b.classList.add('down'); d.down(); });
      const up = () => { b.classList.remove('down'); d.up?.(); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', () => b.classList.contains('down') && up());
      b.addEventListener('contextmenu', e => { e.preventDefault(); d.ctx?.(); });
      pads.appendChild(b);
    });
  };
  $$('.pad-tabs button', root).forEach(b => b.onclick = () => { page = b.dataset.page; store.set('padPage' + i, page); renderPads(); });
  deck.on('cue', () => page === 'hotcue' && renderPads());
  deck.on('load', renderPads);
  renderPads();

  // FX: pick an effect, then hold the XY pad (or latch with the FX button)
  const fx = deck.fx, xy = q('.xy'), dot = q('.xy-dot'), fxOn = q('.fx-on');
  let latched = false;
  const showXY = () => {
    dot.style.left = fx.x * 100 + '%'; dot.style.top = (1 - fx.y) * 100 + '%';
    q('.xy-label').textContent = fx.label;
    xy.classList.toggle('active', fx.active);
  };
  q('.fx-select').onchange = e => { fx.setType(FX_LIST[e.target.selectedIndex]); showXY(); };
  fxOn.onclick = () => { latched = !latched; fxOn.classList.toggle('active', latched); fx.setActive(latched); showXY(); };
  xy.addEventListener('pointerdown', e => {
    resume();
    xy.setPointerCapture(e.pointerId);
    const set = ev => {
      const r = xy.getBoundingClientRect();
      fx.setXY(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp(1 - (ev.clientY - r.top) / r.height, 0, 1));
      showXY();
    };
    set(e);
    fx.setActive(true); showXY();
    xy.onpointermove = set;
    xy.onpointerup = () => { xy.onpointermove = null; if (!latched) fx.setActive(false); showXY(); };
  });
  showXY();

  // disc: drag = scratch (hand on vinyl), wheel = nudge / seek
  const disc = q('.disc');
  disc.addEventListener('pointerdown', e => {
    if (!deck.buffer) return;
    resume();
    disc.setPointerCapture(e.pointerId);
    const r = disc.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let last = Math.atan2(e.clientY - cy, e.clientX - cx);
    deck.scratchBegin();
    disc.classList.add('touch');
    disc.onpointermove = ev => {
      const a = Math.atan2(ev.clientY - cy, ev.clientX - cx);
      let d = a - last;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      last = a;
      deck.scratchMove(d / (2 * Math.PI) * 1.8); // one turn = 1.8 s (33⅓ rpm)
    };
    disc.onpointerup = () => { disc.onpointermove = null; disc.classList.remove('touch'); deck.scratchEnd(); };
  });
  let bendTimer;
  disc.addEventListener('wheel', e => {
    e.preventDefault();
    if (!deck.buffer) return;
    if (!deck.playing) { deck.seek(deck.position + Math.sign(e.deltaY) * 0.05); return; }
    deck.setBend(Math.sign(e.deltaY) * 0.06);
    clearTimeout(bendTimer);
    bendTimer = setTimeout(() => deck.setBend(0), 120);
  }, { passive: false });
  const holdBend = (btn, v) => {
    btn.onpointerdown = () => deck.setBend(v);
    btn.onpointerup = btn.onpointerleave = () => deck.setBend(0);
  };
  holdBend(q('.bend-dn'), -0.04); holdBend(q('.bend-up'), 0.04);
  const cover = new Image();

  // tempo
  const slider = q('.pitch-slider');
  slider.oninput = () => deck.setRate(1 + slider.value * pitchRange / 100);
  slider.ondblclick = () => { slider.value = 0; deck.setRate(1); };
  deck.on('rate', () => {
    const pct = (deck.rate - 1) * 100;
    if (Math.abs(pct) > pitchRange) pitchRange = Math.abs(pct) > 16 ? 50 : 16;
    slider.value = pct / pitchRange;
  });

  q('.overview').addEventListener('pointerdown', e => {
    if (!deck.buffer) return;
    const r = e.currentTarget.getBoundingClientRect();
    deck.seek((e.clientX - r.left) / r.width * deck.duration);
  });

  // transport
  const cue = q('.cue');
  cue.addEventListener('pointerdown', () => { resume(); deck.cueDown(); });
  cue.addEventListener('pointerup', () => deck.cueUp());
  cue.addEventListener('pointerleave', () => deck.cueUp());
  q('.play').onclick = () => playPause(i);
  root.addEventListener('pointerdown', e => { if (mixer.locked) { e.preventDefault(); e.stopPropagation(); nudgeLock(); } }, true);
  q('.sync').onclick = () => { if (!deck.syncTo(decks[1 - i])) toast('Both decks need a track with a BPM'); };
  q('.match').onclick = () => { if (!deck.syncTo(decks[1 - i], false)) toast('Both decks need a track with a BPM'); };
  q('.assist').onclick = () => {
    assist[i] = !assist[i];
    q('.assist').classList.toggle('active', assist[i]);
    store.set('assist' + i, assist[i]);
  };
  q('.assist').classList.toggle('active', assist[i]);
  q('.loop-toggle').onclick = () => deck.toggleLoop();
  const stepLoop = d => deck.resizeLoop(LOOP_SIZES[clamp(LOOP_SIZES.indexOf(deck.loopBeats) + d, 0, LOOP_SIZES.length - 1)]);
  q('.loop-minus').onclick = () => stepLoop(-1);
  q('.loop-plus').onclick = () => stepLoop(1);
  deck.on('loop', () => {
    q('.loop-size').textContent = fmtBeats(deck.loopBeats);
    q('.loop-toggle').classList.toggle('active', !!deck.loop);
  });
  deck.on('state', () => {
    q('.play').textContent = deck.playing ? '❚❚' : '▶';
    q('.play').classList.toggle('active', deck.playing);
    if (deck.playing && deck.track && lib.history[lib.history.length - 1] !== deck.track.id) lib.history.push(deck.track.id);
    scheduleTable();
  });
  deck.on('load', () => {
    const t = deck.track;
    q('.t-title').textContent = t.title;
    q('.t-artist').textContent = t.artist;
    q('.total').textContent = fmtTime(deck.duration);
    q('.keyname').textContent = t.camelot ? `· ${t.key} ${t.camelot}` : '';
    cover.src = `/api/cover/${t.id}`;
    root.classList.add('loaded');
  });
  deck.on('ended', () => { if (!mixer.enabled) toast(`Deck ${L(i)} finished`); });

  deck.ui = {
    bpm: q('.bpm'), pitch: q('.pitch-readout'), remain: q('.remain'), elapsed: q('.elapsed'),
    overview: q('.overview'), disc, cover, keyInd: q('.key-ind'), sync: q('.sync'), cue,
    leds: $$('.beat-leds i', root),
  };
}
const assist = [store.get('assist0', true), store.get('assist1', true)];

function playPause(i) {
  if (mixer.locked) return nudgeLock();
  resume();
  const deck = decks[i], other = decks[1 - i];
  if (!deck.playing && assist[i] && other.playing) deck.playInSync(other);
  else deck.toggle();
}

// ================================================================ mixer UI
function buildMixer() {
  const m = $('#mixer');
  const ch = i => `
    <div class="mix-ch" data-deck="${i}">
      <div class="knob-col eq"></div>
      <div class="knob-col stems"></div>
      <div class="fader-col">
        <div class="meter"><div class="meter-fill"></div></div>
        <input type="range" class="vol" min="0" max="1" step="0.01" value="1" title="Volume">
        <button class="hp" title="Headphone cue">🎧</button>
      </div>
    </div>`;
  m.innerHTML = `
    <div class="master-bpm"><span id="masterBpm">---</span><small>BPM</small></div>
    <div class="phase" title="Beat phase: when both bars line up, the decks are in sync"><div class="ph ph0"></div><div class="ph ph1"></div></div>
    <div class="mixer-cols">${ch(0)}${ch(1)}</div>
    <div class="xfader"><span>A</span><input type="range" id="xf" min="0" max="1" step="0.005" value="0.5" title="Crossfader · double-click to centre"><span>B</span></div>
    <button id="aiMix" class="btn aimix" title="Analyse both songs and blend them automatically">✦ AI MIX</button>
    <div class="next-up" id="nextUp"><small>NEXT UP</small><div class="nu-title muted">—</div><div class="nu-actions"></div></div>`;

  [0, 1].forEach(i => {
    const deck = decks[i], col = $(`.mix-ch[data-deck="${i}"]`, m);
    for (const [name, label] of [['mid', 'MID'], ['bass', 'BASS'], ['filter', 'FILTER']]) {
      const k = new Knob(label, {
        min: -1, max: 1, value: 0, cls: 'k' + i + (name === 'filter' ? ' filter' : ''),
        onChange: v => (name === 'filter' ? deck.setFilter(v) : deck.setEQ(name, v)),
      });
      knobs[i][name] = k; $('.eq', col).appendChild(k.el);
    }
    for (const [name, label] of [['vocal', 'VOCAL'], ['instru', 'INSTRU'], ['beat', 'BEAT']]) {
      const k = new Knob(label, { min: -1, max: 1, value: 0, onChange: v => deck.setStem(name, v), cls: 'k' + i + ' stem' });
      knobs[i][name] = k; $('.stems', col).appendChild(k.el);
    }
    const vol = $('.vol', col);
    vol.oninput = () => deck.setVolume(+vol.value);
    knobs[i].vol = vol;
    const hp = $('.hp', col);
    hp.onclick = () => {
      if (!headphones.deviceId) { toast('Pick a headphone output in ⚙ Settings first'); return; }
      const on = !hp.classList.contains('active');
      hp.classList.toggle('active', on);
      deck.setCue(on);
    };
    deck.ui.meter = $('.meter-fill', col);
    deck.ui.phase = $('.ph' + i, m);
  });
  const xf = $('#xf');
  xf.oninput = () => setXF(+xf.value, false);
  xf.ondblclick = () => setXF(0.5);
  $('#aiMix').onclick = () => { resume(); if (mixer.locked) nudgeLock(); else mixer.aiMix(); };
  $('#mixer').addEventListener('pointerdown', e => {
    if (mixer.locked && !e.target.closest('#aiMix')) { e.preventDefault(); e.stopPropagation(); nudgeLock(); }
  }, true);
}

function setXF(v, updateInput = true) {
  xfValue = v;
  if (updateInput) $('#xf').value = v;
  decks[0].setXfadeGain(Math.cos(v * Math.PI / 2));
  decks[1].setXfadeGain(Math.sin(v * Math.PI / 2));
}

// ================================================================ loading
async function loadTrack(i, track, force = false) {
  const deck = decks[i];
  if (!force && mixer.locked) { nudgeLock(); return false; }
  resume();
  const root = $('#deck' + i);
  root.classList.add('busy');
  $('.t-title', root).textContent = 'Loading ' + track.title + '…';
  try {
    const data = await fetch('/audio/' + track.id).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    });
    await deck.load(track, data);
    const grid = store.get('grids', {})[track.id];
    if (grid) { deck.bpm = grid.bpm; deck.firstBeat = grid.firstBeat; }
    deck.peaks = computePeaks(deck.buffer);
    deck.overview = overviewImage(deck.peaks, i);
    if (!deck.bpm) toast(`${track.title}: BPM still being analysed`);
    return true;
  } catch (e) {
    toast('Could not load track: ' + e.message);
    $('.t-title', root).textContent = 'Load failed';
    return false;
  } finally {
    root.classList.remove('busy');
    scheduleTable();
  }
}
const xfAudible = i => (i === 0 ? xfValue < 0.95 : xfValue > 0.05);

/** YouDJ-style row button: load onto that deck and start it if nothing is on air. */
async function rowPlay(i, t) {
  const deck = decks[i];
  if (mixer.locked) return nudgeLock();
  if (deck.track?.id === t.id) return playPause(i);
  if (deck.playing && xfAudible(i)) return mixer.swapTrack(i, t); // fade away, swap, fade back
  if (await loadTrack(i, t) && !decks.some(d => d.playing)) {
    setXF(i ? 1 : 0);
    deck.play();
  }
}

// ================================================================ drag & drop from Explorer
async function collectFiles(dt) {
  const out = [];
  const walk = entry => new Promise(res => {
    if (entry.isFile) entry.file(f => { if (AUDIO_RE.test(f.name)) out.push(f); res(); }, () => res());
    else if (entry.isDirectory) {
      const reader = entry.createReader(), all = [];
      const read = () => reader.readEntries(async ents => {
        if (!ents.length) { for (const e of all) await walk(e); res(); }
        else { all.push(...ents); read(); }
      }, () => res());
      read();
    } else res();
  });
  const entries = [...dt.items].map(it => it.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const e of entries) await walk(e);
  else out.push(...[...dt.files].filter(f => AUDIO_RE.test(f.name)));
  return out;
}

async function uploadFiles(files, deckIndex = null) {
  if (!files.length) return toast('No audio files found (mp3, m4a, flac, wav, ogg, opus, aac)');
  toast(`Importing ${files.length} file${files.length > 1 ? 's' : ''}…`, 6000);
  const ids = [];
  for (let k = 0; k < files.length; k += 20) { // batches keep requests small
    const fd = new FormData();
    files.slice(k, k + 20).forEach(f => fd.append('files', f, f.name));
    const r = await fetch('/api/upload', { method: 'POST', body: fd }).then(r => r.json()).catch(() => ({ ids: [] }));
    ids.push(...r.ids);
  }
  await refresh();
  renderLibrary();
  toast(`Imported ${ids.length} track${ids.length === 1 ? '' : 's'}. Analysing BPM & key…`);
  const first = lib.byId.get(ids[0]);
  if (deckIndex != null && first) rowPlay(deckIndex, first);
}

function wireDragDrop() {
  const overlay = $('#dropOverlay');
  let depth = 0;
  const isFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (!isFiles(e)) return; depth++; overlay.hidden = false; });
  window.addEventListener('dragleave', e => { if (!isFiles(e)) return; if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  window.addEventListener('dragover', e => {
    if (!isFiles(e)) return;
    e.preventDefault();
    $$('.drop-zone', overlay).forEach(z => z.classList.toggle('hot', z.contains(e.target)));
  });
  window.addEventListener('drop', async e => {
    if (!isFiles(e)) return;
    e.preventDefault();
    depth = 0; overlay.hidden = true;
    const zone = e.target.closest?.('.drop-zone')?.dataset.drop;
    const files = await collectFiles(e.dataTransfer);
    uploadFiles(files, zone === '0' || zone === '1' ? +zone : null);
  });
  $('#btnAddFiles').onclick = () => $('#filePick').click();
  $('#filePick').onchange = e => { uploadFiles([...e.target.files]); e.target.value = ''; };
}

// ================================================================ library UI
const loadedIds = () => new Set(decks.map(d => d.track?.id).filter(Boolean));
const tableContext = () => ({
  current: mixer.current?.track, loaded: loadedIds(),
  decks: decks.map(d => ({ id: d.track?.id, playing: d.playing })),
});
let tableQueued = false;
function scheduleTable() {
  if (tableQueued) return;
  tableQueued = true;
  requestAnimationFrame(() => { tableQueued = false; renderLibrary(); });
}

function renderLibrary() {
  renderTable(tableContext());
  $('#cntAll').textContent = lib.tracks.length;
  $('#cntSpotify').textContent = lib.tracks.filter(t => t.source === 'spotify').length || '';
  $('#cntQueue').textContent = lib.queue.length || '';
  $('#libStatus').textContent = lib.pending ? `Analysing BPM & key… ${lib.pending} left` : '';
  $('#sortSel').value = lib.sort.key;
  $('#sortDir').textContent = lib.sort.dir > 0 ? '▲' : '▼';
  const genres = [...new Set(lib.tracks.map(t => t.genre).filter(Boolean))].sort();
  $('#genreList').innerHTML = genres.map(g =>
    `<div class="side-item sub ${lib.genre === g ? 'active' : ''}" data-genre="${esc(g)}">${esc(g)}</div>`).join('') ||
    '<div class="muted sub">—</div>';
  $('#folderList').innerHTML = lib.folders.map(f =>
    `<div class="side-item sub ${lib.folder === f ? 'active' : ''}" data-folder="${esc(f)}" title="${esc(f)}">${esc(f.split(/[\\/]/).pop())}</div>`).join('');
  renderNextUp();
}

let nextUpTrack = null;
function renderNextUp() {
  const cur = mixer.current;
  const box = $('#nextUp');
  const next = lib.queue.length ? { track: lib.byId.get(lib.queue[0]), score: null }
    : suggest(cur?.track, { exclude: loadedIds(), limit: 1 })[0];
  nextUpTrack = next?.track || null;
  if (!next?.track) {
    $('.nu-title', box).innerHTML = '<span class="muted">Play something to get suggestions</span>';
    $('.nu-actions', box).innerHTML = '';
    return;
  }
  const t = next.track, other = cur ? 1 - cur.index : 0;
  $('.nu-title', box).innerHTML = `<b>${esc(t.title)}</b> <span class="muted">${esc(t.artist)}</span><br>
    <span class="lime">${t.bpm ? t.bpm.toFixed(0) : '?'} BPM · ${t.camelot || '?'}${next.score != null ? ` · ${Math.round(next.score * 100)}% match` : ' · queued'}</span>`;
  $('.nu-actions', box).innerHTML = `<button class="btn small" data-nu>Load → ${L(other)}</button>`;
  $('[data-nu]', box).onclick = () => loadTrack(other, t);
}

function renderInfo(t) {
  if (!t) return;
  $('#info').innerHTML = `
    <img class="info-cover" src="/api/cover/${t.id}" alt="" onerror="this.classList.add('none')">
    <div class="info-title">${esc(t.title)}</div>
    <div class="info-artist">${esc(t.artist)}</div>
    <dl>
      <dt>BPM</dt><dd>${t.bpm ? t.bpm.toFixed(2) : t.analyzed ? 'unknown' : 'analysing…'}</dd>
      <dt>Key</dt><dd>${t.key ? `${t.key} (${t.camelot})` : '—'}</dd>
      <dt>Energy</dt><dd>${t.energy ?? '—'} / 10</dd>
      <dt>Length</dt><dd>${fmtTime(t.duration)}</dd>
      <dt>Album</dt><dd>${esc(t.album) || '—'}</dd>
      <dt>Year</dt><dd>${esc(t.year) || '—'}</dd>
      <dt>Genre</dt><dd>${esc(t.genre) || '—'}</dd>
      <dt>Source</dt><dd>${t.source === 'spotify' ? 'Spotify (spotDL)' : 'Local file'}</dd>
    </dl>
    <div class="info-path" title="${esc(t.path)}">${esc(t.path)}</div>
    <div class="info-actions">
      <button class="btn small" data-act="reveal">📂 Show in folder</button>
      <button class="btn small" data-act="q">+ Queue</button>
    </div>`;
  $('#info').onclick = e => {
    const act = e.target.dataset.act;
    if (act === 'reveal') fetch('/api/reveal/' + t.id, { method: 'POST' });
    if (act === 'q') addToQueue(t);
  };
}

function addToQueue(t) {
  lib.queue.push(t.id); saveQueue(); scheduleTable();
  toast(`Queued: ${t.title}`);
}

function wireLibrary() {
  $$('.lib-side [data-view]').forEach(el => el.onclick = () => {
    lib.view = el.dataset.view; lib.genre = null; lib.folder = null;
    $$('.lib-side .side-item').forEach(x => x.classList.toggle('active', x === el));
    renderLibrary();
  });
  $('.lib-side').addEventListener('click', e => {
    const el = e.target.closest('[data-genre],[data-folder]');
    if (!el) return;
    lib.view = 'all';
    lib.genre = el.dataset.genre ?? null;
    lib.folder = el.dataset.folder ?? null;
    $$('.lib-side [data-view]').forEach(x => x.classList.remove('active'));
    renderLibrary();
  });
  $('#search').oninput = e => { lib.search = e.target.value; renderLibrary(); };
  const setSort = (key, dir) => { lib.sort = { key, dir }; store.set('sort', lib.sort); renderLibrary(); };
  $('#sortSel').onchange = e => setSort(e.target.value, e.target.value === 'added' ? -1 : 1);
  $('#sortDir').onclick = () => setSort(lib.sort.key, -lib.sort.dir);
  $('#libHead').onclick = e => {
    const k = e.target.closest('th')?.dataset.sort;
    if (k) setSort(k, lib.sort.key === k ? -lib.sort.dir : 1);
  };
  const body = $('#libBody');
  body.onclick = e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const t = lib.byId.get(tr.dataset.id);
    const btn = e.target.closest('button');
    if (btn?.dataset.load != null) return rowPlay(+btn.dataset.load, t);
    if (btn?.hasAttribute('data-queue')) return addToQueue(t);
    lib.selected = t.id;
    $$('tr.sel', body).forEach(r => r.classList.remove('sel'));
    tr.classList.add('sel');
    renderInfo(t);
  };
  body.ondblclick = e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr || e.target.closest('button')) return;
    const free = decks.find(d => !d.playing) || decks[0];
    rowPlay(free.index, lib.byId.get(tr.dataset.id));
  };
  body.ondragstart = e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) e.dataTransfer.setData('text/x-crodj', tr.dataset.id);
  };
  // library rows dragged onto a deck
  [0, 1].forEach(i => {
    const root = $('#deck' + i);
    root.addEventListener('dragover', e => {
      if (![...e.dataTransfer.types].includes('text/x-crodj')) return;
      e.preventDefault(); root.classList.add('drop');
    });
    root.addEventListener('dragleave', () => root.classList.remove('drop'));
    root.addEventListener('drop', e => {
      const id = e.dataTransfer.getData('text/x-crodj');
      root.classList.remove('drop');
      if (!id) return;
      e.preventDefault();
      loadTrack(i, lib.byId.get(id));
    });
  });
}

// ================================================================ modals
function openModal(id) { $(id).hidden = false; }
$$('.modal').forEach(m => m.addEventListener('click', e => {
  if (e.target === m || e.target.hasAttribute('data-close')) m.hidden = true;
}));

let jobsTimer;
const seenJobs = new Set();
async function pollJobs() {
  const jobs = await fetch('/api/spotdl').then(r => r.json());
  $('#jobs').innerHTML = jobs.map(j => `
    <div class="job ${j.status}">
      <div class="job-head"><b>${j.status === 'running' ? 'Downloading…' : j.status === 'done' ? '✔ Done' : '⚠ Failed'}</b>
        <span class="muted">${esc(j.url)}</span></div>
      <pre>${esc(j.log.slice(-6).join('\n'))}</pre>
    </div>`).join('');
  const running = jobs.some(j => j.status === 'running');
  for (const j of jobs) {
    if (j.status !== 'running' && !seenJobs.has(j.id)) {
      seenJobs.add(j.id);
      if (j.status === 'done') {
        await refresh();
        lib.view = 'spotify'; lib.genre = null; lib.folder = null;
        $$('.lib-side .side-item').forEach(x => x.classList.toggle('active', x.dataset.view === 'spotify'));
        renderLibrary();
        toast('Spotify import finished. Showing Spotify imports.');
      }
    }
  }
  clearTimeout(jobsTimer);
  if (running || !$('#importModal').hidden) jobsTimer = setTimeout(pollJobs, 1500);
}

function wireModals() {
  $('#btnImport').onclick = () => { openModal('#importModal'); $('#spotUrl').focus(); pollJobs(); };
  $('#spotGo').onclick = async () => {
    const url = $('#spotUrl').value.trim();
    if (!url) return;
    const r = await fetch('/api/spotdl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const j = await r.json();
    if (!r.ok) return toast(j.error);
    $('#spotUrl').value = '';
    toast('Import started. Songs appear under Spotify imports when done.');
    pollJobs();
  };
  $('#spotUrl').onkeydown = e => e.key === 'Enter' && $('#spotGo').click();
  $('#spotPaste').onclick = async () => {
    try { $('#spotUrl').value = (await navigator.clipboard.readText()).trim(); $('#spotUrl').focus(); }
    catch { toast('Clipboard blocked by the browser. Click the box and press Ctrl+V.'); }
  };
  // Ctrl+V anywhere in the import window drops the link into the box
  document.addEventListener('paste', e => {
    if ($('#importModal').hidden || e.target === $('#spotUrl')) return;
    const text = e.clipboardData?.getData('text')?.trim();
    if (text) { $('#spotUrl').value = text; e.preventDefault(); }
  });

  $('#btnSettings').onclick = async () => {
    openModal('#settingsModal');
    await renderFolderSettings();
    await fillDevices();
  };
  $('#addFolderBtn').onclick = async () => {
    const folder = $('#newFolder').value.trim();
    if (!folder) return;
    const r = await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
    const j = await r.json();
    if (!r.ok) return toast(j.error);
    $('#newFolder').value = '';
    await renderFolderSettings(j);
    await refresh(); renderLibrary();
  };
  $('#pitchRange').value = pitchRange;
  $('#pitchRange').onchange = e => {
    pitchRange = +e.target.value; store.set('pitchRange', pitchRange);
    decks.forEach(d => d.emit('rate'));
  };
}

async function renderFolderSettings(cfg) {
  cfg ||= await fetch('/api/config').then(r => r.json());
  lib.folders = cfg.folders;
  $('#folderSettings').innerHTML = cfg.folders.map(f =>
    `<div class="row folder"><span>${esc(f)}</span><button class="btn small" data-rm="${esc(f)}">Remove</button></div>`).join('');
  $('#dlFolder').textContent = 'Spotify imports are saved to: ' + cfg.downloadFolder;
  $$('[data-rm]', $('#folderSettings')).forEach(b => b.onclick = async () => {
    const c = await fetch('/api/folders', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: b.dataset.rm }) }).then(r => r.json());
    await renderFolderSettings(c); await refresh(); renderLibrary();
  });
}

async function fillDevices() {
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput'); } catch { /* unsupported */ }
  const opts = (sel, none) => [`<option value="">${none}</option>`, ...devs.filter(d => d.deviceId !== 'default')
    .map((d, k) => `<option value="${d.deviceId}" ${d.deviceId === sel ? 'selected' : ''}>${esc(d.label || 'Output ' + (k + 1))}</option>`)].join('');
  $('#masterOut').innerHTML = opts(store.get('masterOut', ''), 'System default');
  $('#cueOut').innerHTML = opts(headphones.deviceId, 'Off');
  $('#masterOut').onchange = async e => { await setMasterDevice(e.target.value).catch(err => toast(err.message)); store.set('masterOut', e.target.value); };
  $('#cueOut').onchange = async e => { await headphones.setDevice(e.target.value).catch(err => toast(err.message)); };
}

// ================================================================ top bar
const mixer = new Mixer(decks, {
  getXF: () => xfValue,
  setXF: v => setXF(v),
  setKnob: (i, name, v) => knobs[i][name].set(v),
  setVolume: (i, v) => { knobs[i].vol.value = v; decks[i].setVolume(v); },
  getVolume: i => +knobs[i].vol.value,
  loadTrack,
  onAutoDJ: on => $('#btnAutoDJ').classList.toggle('active', on),
  onAI: (on, text) => {
    $('#aiLock').hidden = !on;
    $('#aiMix').classList.toggle('active', on);
    if (text) $('#aiText').textContent = text;
    disarm();
  },
});

// AI lock: the badge must be clicked twice (within 2 s) to hand control back.
let armTimer;
function disarm() {
  clearTimeout(armTimer);
  $('#aiBadge').classList.remove('armed');
  $('#aiHint').textContent = 'click twice to take control';
}
function nudgeLock() {
  toast('AI is mixing. Click the AI badge twice to take control.');
  const b = $('#aiBadge');
  b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
}
function wireLock() {
  $('#aiLock').addEventListener('click', e => { if (!e.target.closest('#aiBadge')) nudgeLock(); });
  $('#aiBadge').onclick = () => {
    const b = $('#aiBadge');
    if (b.classList.contains('armed')) { disarm(); mixer.stopAI(); return; }
    b.classList.add('armed');
    $('#aiHint').textContent = 'click again to stop the AI';
    armTimer = setTimeout(disarm, 2000);
  };
}

const party = new Party(() => {
  const cur = mixer.current;
  const other = cur && decks[1 - cur.index];
  const next = other?.track && !other.playing ? other.track : nextUpTrack;
  return { now: cur?.track, next, bpm: cur?.liveBpm };
});
let autoBeforeParty = false;
party.onToggle = on => {
  $('#btnParty').classList.toggle('active', on);
  if (on) { autoBeforeParty = mixer.enabled; mixer.setEnabled(true); }
  else if (!autoBeforeParty) mixer.setEnabled(false);
};

function wireTopbar() {
  $('#btnAutoDJ').onclick = () => {
    resume();
    if (mixer.enabled) return nudgeLock();
    mixer.setEnabled(true);
    toast('Auto DJ on. Click the AI badge twice to take control back.');
  };
  $('#btnParty').onclick = () => { resume(); party.toggle(); };
  mixer.mixBeats = store.get('mixBeats', 32);
  $('#mixBeats').value = mixer.mixBeats;
  $('#mixBeats').onchange = e => { mixer.mixBeats = +e.target.value; store.set('mixBeats', mixer.mixBeats); };
  $('#btnHelp').onclick = () => openModal('#helpModal');
  $('#masterVol').oninput = e => { master.gain.value = +e.target.value; };
  $('#strip').addEventListener('wheel', e => {
    e.preventDefault();
    stripWindow = clamp(stripWindow * (e.deltaY > 0 ? 1.15 : 0.87), 2, 40);
  }, { passive: false });
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'z') playPause(0);
    if (k === 'm') playPause(1);
    if (k === 'escape' && party.active) party.toggle(false);
  });
}

// ================================================================ render loop
// Audio-side automation runs on a timer so it keeps going when the window is
// hidden (tabs playing audio are not timer-throttled); visuals use rAF.
setInterval(() => {
  mixer.tick();
  decks.forEach(d => d.fx.tick());
}, 25);

function frame() {
  drawStrip($('#strip'), decks, stripWindow);
  const cur = mixer.current;
  $('#masterBpm').textContent = cur?.bpm ? cur.liveBpm.toFixed(1) : '—';
  decks.forEach((d, i) => {
    const u = d.ui, other = decks[1 - i];
    drawOverview(u.overview, d);
    drawDisc(u.disc, d, DECK_COLORS[i].main, u.cover);
    u.bpm.textContent = d.bpm ? d.liveBpm.toFixed(2) : '—';
    u.pitch.textContent = (d.effRate >= 1 ? '+' : '') + ((d.effRate - 1) * 100).toFixed(1) + '%';
    u.elapsed.textContent = fmtTime(d.position);
    u.remain.textContent = '-' + fmtTime(d.remaining);
    u.remain.classList.toggle('warn', d.playing && d.remaining < 30);
    u.meter.style.height = Math.min(100, d.level * 280) + '%';
    const beat = d.bpm && d.buffer ? d.beatAt(d.position) : -1;
    u.leds.forEach((led, k) => led.classList.toggle('on', beat >= 0 && Math.floor(beat) % 4 === k));
    u.phase.style.left = beat >= 0 ? frac(beat) * 100 + '%' : '-10%';
    const synced = d.bpm && other.bpm && Math.abs(d.liveBpm - other.liveBpm) < 0.05;
    u.sync.classList.toggle('active', !!(synced && d.track && other.track));
    const kc = d.track && other.track ? keyCompat(d.track.camelot, other.track.camelot) : 1;
    u.keyInd.textContent = kc < 0.45 ? '!' : '';
    u.cue.classList.toggle('active', !!d.buffer && !d.playing && Math.abs(d.pos - d.cuePoint) < 0.02);
  });
  party.draw();
  requestAnimationFrame(frame);
}

// ================================================================ boot
async function poll() {
  const before = lib.pending + ':' + lib.tracks.length;
  await refresh().catch(() => {});
  // pick up BPM on loaded decks once analysis lands
  decks.forEach(d => {
    const t = d.track && lib.byId.get(d.track.id);
    if (t && t.analyzed && !d.bpm && t.bpm) {
      d.track = t; d.bpm = t.bpm; d.firstBeat = t.firstBeat;
      $('#deck' + d.index + ' .keyname').textContent = t.camelot ? `· ${t.key} ${t.camelot}` : '';
    }
  });
  if (before !== lib.pending + ':' + lib.tracks.length) renderLibrary();
  setTimeout(poll, lib.pending ? 2500 : 8000);
}

async function boot() {
  buildDeck(0); buildDeck(1); buildMixer(); setXF(0.5);
  wireLibrary(); wireModals(); wireTopbar(); wireDragDrop(); wireLock();
  await sampler.init();
  await renderFolderSettings();
  await refresh();
  renderLibrary();
  const out = store.get('masterOut', '');
  if (out) setMasterDevice(out).catch(() => {});
  requestAnimationFrame(frame);
  setTimeout(poll, 2500);
  document.addEventListener('pointerdown', resume, { once: true });
  window.crodj = { decks, mixer, lib }; // handy for debugging in DevTools
}
boot();
