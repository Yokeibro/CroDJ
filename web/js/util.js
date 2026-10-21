export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const frac = v => v - Math.floor(v);

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const store = {
  get(k, def) { try { const v = localStorage.getItem('crodj.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('crodj.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

let toastTimer;
export function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** Rotary knob: drag vertically, wheel, double-click to reset. */
export class Knob {
  constructor(label, { min = -1, max = 1, value = 0, def = value, onChange = () => {}, cls = '' } = {}) {
    Object.assign(this, { min, max, def, onChange });
    this.el = document.createElement('div');
    this.el.className = 'knob ' + cls;
    this.el.innerHTML = `<div class="knob-dial" title="Drag up/right or down/left · double-click to reset to centre"><div class="knob-ind"></div></div><label>${label}</label>`;
    this.dial = this.el.firstElementChild;
    this.set(value, true);
    this.dial.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.dial.setPointerCapture(e.pointerId);
      let x = e.clientX, y = e.clientY;
      // drag up or right = turn clockwise; drag down or left = anticlockwise
      const move = ev => {
        const fine = ev.shiftKey ? 0.2 : 1;
        const d = (ev.clientX - x) + (y - ev.clientY);
        this.set(clamp(this.value + d / 140 * (this.max - this.min) * fine, this.min, this.max));
        x = ev.clientX; y = ev.clientY;
      };
      const up = () => {
        this.dial.removeEventListener('pointermove', move);
        this.dial.removeEventListener('pointerup', up);
      };
      this.dial.addEventListener('pointermove', move);
      this.dial.addEventListener('pointerup', up);
    });
    this.dial.addEventListener('dblclick', () => this.set(this.def));
    this.dial.addEventListener('wheel', e => {
      e.preventDefault();
      this.set(clamp(this.value - Math.sign(e.deltaY) * (this.max - this.min) / 40, this.min, this.max));
    }, { passive: false });
  }

  set(v, silent = false) {
    this.value = v;
    const span = this.max - this.min;
    const f = (v - this.min) / span, d = (this.def - this.min) / span;
    this.dial.style.setProperty('--a', (-135 + 270 * f) + 'deg');
    this.el.style.setProperty('--lo', Math.min(f, d) * 270 + 'deg');
    this.el.style.setProperty('--hi', Math.max(f, d) * 270 + 'deg');
    if (!silent) this.onChange(v);
  }
}
