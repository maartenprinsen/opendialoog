/* OpenDialoog — gedeelde hulpfuncties voor alle pagina's. */
'use strict';

const OD = {
  sessionId() { return location.pathname.split('/').filter(Boolean)[1]; },
  adminKey() {
    const m = location.hash.match(/k=([\w-]+)/);
    if (m) { try { localStorage.setItem('od_key_' + OD.sessionId(), m[1]); } catch (_) {} return m[1]; }
    try { return localStorage.getItem('od_key_' + OD.sessionId()); } catch (_) { return null; }
  },
  async api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.admin) headers['X-Admin-Key'] = opts.admin;
    const res = await fetch(path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) { const e = new Error((data && data.error) || 'Er ging iets mis'); e.status = res.status; throw e; }
    return data;
  },
  esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  toast(text, ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  },
  pct(agree) {
    if (agree === null || agree === undefined) return '<span class="pct">–</span>';
    const cls = agree >= 60 ? 'hi' : agree < 40 ? 'lo' : '';
    return `<span class="pct ${cls}">${agree}%</span>`;
  },
  bar(agree) {
    if (agree === null || agree === undefined) return '<div class="bar" aria-hidden="true"></div>';
    return `<div class="bar" role="img" aria-label="${agree}% eens"><span style="width:${agree}%"></span></div>`;
  },
  plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); },
  time(ts) { return new Date(ts).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }); },
  // Herhaal een functie, maar pauzeer als het tabblad niet zichtbaar is.
  poll(fn, ms) {
    let timer = null, busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try { await fn(); } catch (e) { console.warn(e); } finally { busy = false; }
      timer = setTimeout(tick, document.hidden ? ms * 4 : ms);
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(timer); tick(); } });
    tick();
    return { now() { clearTimeout(timer); tick(); } };
  },
  logo: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v4a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3.2A2.5 2.5 0 0 1 4 10.5v-4Z" fill="currentColor" opacity=".9"/><path d="M18 9h.5A1.5 1.5 0 0 1 20 10.5v4a1.5 1.5 0 0 1-1.5 1.5H18v2.5L15 16h-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity=".6"/></svg>',
};

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-logo]').forEach(el => { el.innerHTML = OD.logo + el.innerHTML; });
});
