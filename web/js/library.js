import { $, esc, fmtTime, store } from './util.js';

export const lib = {
  tracks: [], byId: new Map(), pending: 0,
  queue: store.get('queue', []), history: [],
  view: 'all', genre: null, folder: null, search: '',
  sort: store.get('sort', { key: 'title', dir: 1 }),
  selected: null, folders: [],
};

export async function refresh() {
  const r = await fetch('/api/tracks').then(r => r.json());
  lib.tracks = r.tracks;
  lib.pending = r.pending;
  lib.byId = new Map(r.tracks.map(t => [t.id, t]));
  lib.queue = lib.queue.filter(id => lib.byId.has(id));
  return lib;
}

export function saveQueue() { store.set('queue', lib.queue); }

// ------------------------------------------------------------ suggestions
function parseCamelot(c) {
  const m = /^(\d+)([AB])$/.exec(c || '');
  return m ? { n: +m[1], l: m[2] } : null;
}
export function keyCompat(a, b) {
  const x = parseCamelot(a), y = parseCamelot(b);
  if (!x || !y) return 0.5;
  const dn = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (dn === 0 && x.l === y.l) return 1;
  if (dn === 0 || (dn === 1 && x.l === y.l)) return 0.85;
  if (dn === 2 && x.l === y.l) return 0.45;
  return 0.1;
}
function bpmDistance(a, b) {
  if (!a || !b) return 1;
  return Math.min(...[1, 2, 0.5].map(k => Math.abs(b * k - a) / a));
}

/** Rank tracks that would mix well after `base` (BPM, Camelot key, energy, genre). */
export function suggest(base, { exclude = new Set(), limit = 40 } = {}) {
  if (!base) return [];
  const out = [];
  for (const t of lib.tracks) {
    if (t.id === base.id || exclude.has(t.id) || !t.analyzed || t.error) continue;
    const dist = bpmDistance(base.bpm, t.bpm);
    const bpmScore = Math.exp(-((dist / 0.05) ** 2));
    const keyScore = keyCompat(base.camelot, t.camelot);
    const e = (t.energy || 5) - (base.energy || 5);
    const energyScore = 1 - Math.min(1, Math.abs(e - 0.5) / 5);
    let score = 0.5 * bpmScore + 0.3 * keyScore + 0.2 * energyScore;
    if (base.genre && t.genre && base.genre.toLowerCase() === t.genre.toLowerCase()) score += 0.05;
    if (lib.history.includes(t.id)) score *= 0.25;
    const reasons = [
      `BPM ${t.bpm ? t.bpm.toFixed(1) : '?'} (${(dist * 100).toFixed(1)}% off)`,
      `Key ${t.camelot || '?'}${keyScore >= 0.85 ? ' ✓ harmonic' : ''}`,
      `Energy ${t.energy ?? '?'}`,
    ];
    out.push({ track: t, score: Math.min(1, score), reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ------------------------------------------------------------ table
const COLS = [
  ['title', 'Title'], ['artist', 'Artist'], ['bpm', 'BPM'], ['camelot', 'Key'],
  ['duration', 'Time'], ['energy', 'Energy'], ['genre', 'Genre'], ['added', 'Added'],
];

export function visibleRows(context) {
  let rows;
  if (lib.view === 'suggest') return suggest(context.current, { exclude: context.loaded });
  if (lib.view === 'queue') rows = lib.queue.map(id => lib.byId.get(id)).filter(Boolean);
  else if (lib.view === 'history') rows = [...lib.history].reverse().map(id => lib.byId.get(id)).filter(Boolean);
  else rows = lib.tracks.filter(t =>
    (lib.view !== 'spotify' || t.source === 'spotify') &&
    (!lib.genre || t.genre === lib.genre) &&
    (!lib.folder || t.path.toLowerCase().startsWith(lib.folder.toLowerCase())));
  const q = lib.search.trim().toLowerCase();
  if (q) rows = rows.filter(t => [t.title, t.artist, t.album, t.genre].join(' ').toLowerCase().includes(q));
  if (lib.view !== 'queue' && lib.view !== 'history') {
    const { key, dir } = lib.sort;
    rows = [...rows].sort((a, b) => {
      const x = a[key] ?? '', y = b[key] ?? '';
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir;
    });
  }
  return rows.map(track => ({ track }));
}

export function renderTable(context) {
  const rows = visibleRows(context);
  const isSuggest = lib.view === 'suggest';
  $('#libHead').innerHTML = '<tr><th class="c-play" title="Play on deck A / B">A&nbsp;&nbsp;B</th>' + COLS.map(([k, label]) => {
    const arrow = lib.sort.key === k ? (lib.sort.dir > 0 ? ' ▲' : ' ▼') : '';
    return `<th data-sort="${k}" class="c-${k}">${label}${arrow}</th>`;
  }).join('') + `<th class="c-act">${isSuggest ? 'Match' : ''}</th></tr>`;
  if (!rows.length) {
    const msg = isSuggest ? 'Load and play a track to get suggestions.'
      : lib.tracks.length ? 'No tracks match.'
        : 'No music yet. Add a folder in ⚙ Settings or import from Spotify.';
    $('#libBody').innerHTML = `<tr><td colspan="10" class="empty">${msg}</td></tr>`;
    return;
  }
  $('#libBody').innerHTML = rows.map(({ track: t, score, reasons }) => `
    <tr data-id="${t.id}" draggable="true" class="${lib.selected === t.id ? 'sel' : ''} ${context.loaded.has(t.id) ? 'loaded' : ''}">
      <td class="c-play">${[0, 1].map(i => {
        const on = context.decks[i].id === t.id;
        return `<button class="pb d${i} ${on ? 'on' : ''} ${on && context.decks[i].playing ? 'live' : ''}" data-load="${i}" title="Play on deck ${'AB'[i]}">${on && context.decks[i].playing ? '❚❚' : '▶'}</button>`;
      }).join('')}</td>
      <td class="c-title">${t.source === 'spotify' ? '<i class="sp" title="Imported from Spotify">●</i>' : ''}${esc(t.title)}</td>
      <td class="c-artist">${esc(t.artist)}</td>
      <td class="c-bpm">${t.analyzed ? (t.bpm ? t.bpm.toFixed(1) : '—') : '<span class="muted">…</span>'}</td>
      <td class="c-camelot">${t.camelot ? `<span class="keychip k${parseInt(t.camelot)}">${t.camelot}</span>` : ''}</td>
      <td class="c-duration">${fmtTime(t.duration)}</td>
      <td class="c-energy">${t.energy ? `<span class="energy" style="--e:${t.energy}"></span>` : ''}</td>
      <td class="c-genre">${esc(t.genre)}</td>
      <td class="c-added">${new Date(t.added * 1000).toLocaleDateString()}</td>
      <td class="c-act">${isSuggest ? `<span class="match" title="${esc(reasons.join(' · '))}">${Math.round(score * 100)}%</span>` : ''}
        <button data-queue title="Add to Auto DJ queue">+Q</button></td>
    </tr>`).join('');
}
