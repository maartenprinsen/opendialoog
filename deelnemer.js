'use strict';
(function () {
  const sid = OD.sessionId();
  const $ = id => document.getElementById(id);
  const LABELS = { '-2': 'Helemaal oneens', '-1': 'Enigszins oneens', '0': 'Neutraal', '1': 'Enigszins eens', '2': 'Helemaal eens' };
  let state = null;
  let tab = 'write';
  let batchKey = '';
  let lastQ = null;
  let poller = null;

  function show(id, on) { $(id).classList.toggle('hidden', !on); }

  async function load() {
    let data;
    try { data = await OD.api(`/api/s/${sid}/me`); }
    catch (e) {
      if (e.status === 404) { show('main', false); show('welcome', false); show('loading', true); $('loading').textContent = 'Deze dialoog bestaat niet (meer). Vraag de gespreksleider om een nieuwe link.'; }
      throw e;
    }
    render(data);
  }

  function render(data) {
    state = data;
    show('loading', false);
    document.title = data.title || 'Dialoog';
    $('topTitle').textContent = data.title || 'Dialoog';
    if (!data.joined) {
      show('welcome', true); show('main', false);
      $('wTitle').textContent = data.title;
      $('wIntro').textContent = data.intro || '';
      show('codeField', !!data.needsCode);
      return;
    }
    show('welcome', false); show('main', true);
    $('live').textContent = `${data.online} live`;
    show('live', true);

    const ann = data.announcement;
    show('announcement', !!ann);
    if (ann) $('announcement').textContent = ann.text;

    const q = data.question;
    show('waiting', !q);
    show('segmentQ', q && q.type === 'segment');
    show('openQ', q && q.type === 'open');
    if (!q) { renderClosed(data.closed); return; }
    if (q.type === 'segment') return renderSegment(q);

    if (lastQ !== q.id) { lastQ = q.id; tab = data.unlocked ? 'vote' : 'write'; batchKey = ''; $('msgText').value = ''; }
    $('qText').textContent = q.text;
    $('msgText').maxLength = data.maxLength;
    updateCounter();

    show('tabs', data.unlocked);
    $('writeLead').classList.toggle('hidden', data.unlocked);
    $('writeLabel').classList.toggle('hidden', !data.unlocked);
    show('skipBtn', !data.unlocked);
    const hasResults = !!(data.ranking || data.themes);
    show('resultsTab', hasResults);
    if (!hasResults && tab === 'results') tab = 'vote';
    if (!data.unlocked) tab = 'write';
    setTab(tab);

    if (data.unlocked) {
      renderBatch(data);
      renderMine(data);
      renderResults(data);
    }
  }

  function setTab(t) {
    tab = t;
    document.querySelectorAll('#tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    document.querySelectorAll('#openQ [data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== t));
  }

  function renderSegment(q) {
    $('segText').textContent = q.text;
    $('segOptions').innerHTML = q.options.map((o, i) => `<button data-opt="${i}" aria-pressed="${q.answer === i}">${OD.esc(o)}</button>`).join('');
  }

  function renderClosed(c) {
    if (!c) { $('closedResults').innerHTML = ''; return; }
    $('closedResults').innerHTML = `<hr style="border:0;border-top:1px solid var(--line);margin:8px 0 16px"><div class="eyebrow">Uitkomst vorige vraag</div><p class="question" style="font-size:1.15rem">${OD.esc(c.text)}</p>` + resultsHtml(c);
  }

  function renderBatch(data) {
    const items = data.batch || [];
    const key = items.map(i => i.id).join(',');
    const pending = items.filter(i => i.vote === null).length;
    $('voteBadge').textContent = pending; show('voteBadge', pending > 0);
    $('batchInfo').textContent = items.length ? `${items.length - pending} van ${items.length} beoordeeld` : '';
    $('votedTotal').textContent = data.votedTotal ? `Totaal ${data.votedTotal} beoordeeld` : '';
    if (key === batchKey) return; // niet opnieuw tekenen terwijl iemand schuift
    batchKey = key;
    if (!items.length) {
      $('batch').innerHTML = `<div class="card empty"><h2>Volgende berichten onderweg</h2><p>Zodra anderen iets schrijven, verschijnt het hier vanzelf. Je kunt intussen zelf nog iets toevoegen.</p></div>`;
      return;
    }
    $('batch').innerHTML = items.map(m => `
      <article class="msg" data-mid="${m.id}">
        ${m.moderator ? '<span class="tag mod">Stelling van de gespreksleider</span>' : ''}
        <div class="text">${OD.esc(m.text)}</div>
        <div class="scale ${m.vote === null ? 'untouched' : ''}">
          <input type="range" min="-2" max="2" step="1" value="${m.vote ?? 0}" aria-label="Hoe eens ben je het hiermee?" aria-valuetext="${m.vote === null ? 'Nog niet beoordeeld' : LABELS[m.vote]}">
          <div class="ends"><span>Oneens</span><span class="choice">${m.vote === null ? 'Schuif om te stemmen' : '<span class="done-mark">✓</span> ' + LABELS[m.vote]}</span><span>Eens</span></div>
        </div>
      </article>`).join('');
  }

  function renderMine(data) {
    const mine = data.mine || [];
    if (!mine.length) { $('mine').innerHTML = '<div class="card empty">Je hebt bij deze vraag nog niets geschreven.</div>'; return; }
    $('mine').innerHTML = `<p class="muted">Op je eigen berichten stem je niet. Hier zie je hoe anderen erop reageren.</p>` + mine.map(m => `
      <article class="msg mine">
        <div class="text">${OD.esc(m.text)}</div>
        <div class="meta">
          ${m.hidden ? '<span class="tag mod">Verborgen door gespreksleider</span>' : ''}
          <span>${OD.plural(m.votes, 'stem', 'stemmen')}</span>
          ${m.votes ? `${OD.pct(m.agree)} eens ${OD.bar(m.agree)}` : '<span>wacht op stemmen…</span>'}
          ${m.theme ? `<span class="tag">${OD.esc(m.theme)}</span>` : ''}
        </div>
      </article>`).join('');
  }

  function resultsHtml(d) {
    if (d.themes && d.themes.length) {
      return d.themes.map(t => `
        <div class="theme"><h3>${OD.esc(t.name)} <small class="muted">· ${OD.plural(t.messages.length, 'bericht', 'berichten')}</small></h3>
        ${t.messages.map(m => `<article class="msg"><div class="text">${OD.esc(m.text)}</div><div class="meta">${OD.pct(m.agree)} eens ${OD.bar(m.agree)}</div></article>`).join('')}
        </div>`).join('');
    }
    if (d.ranking && d.ranking.length) {
      return d.ranking.map(m => `
        <article class="msg">
          ${m.moderator ? '<span class="tag mod">Stelling</span>' : ''}
          <div class="text">${OD.esc(m.text)}</div>
          <div class="meta">${OD.pct(m.agree)} eens ${OD.bar(m.agree)} <span>${OD.plural(m.votes, 'stem', 'stemmen')}</span> ${m.theme ? `<span class="tag">${OD.esc(m.theme)}</span>` : ''}</div>
        </article>`).join('');
    }
    return '<div class="empty">Nog niet genoeg stemmen voor een tussenstand.</div>';
  }

  function renderResults(data) {
    if (!(data.ranking || data.themes)) return;
    const head = `<p class="muted">${data.themes ? 'Berichten over hetzelfde onderwerp, gegroepeerd door de gespreksleider.' : 'Berichten met de meeste steun bovenaan.'} Stemmen komen nog binnen.</p>`;
    $('results').innerHTML = head + resultsHtml(data);
  }

  function updateCounter() {
    const max = state ? state.maxLength : 400;
    const n = $('msgText').value.length;
    $('counter').textContent = n ? `${n}/${max}` : '';
  }

  // ---- Interactie ----
  $('joinBtn').addEventListener('click', async () => {
    try {
      $('joinBtn').disabled = true;
      render(await OD.api(`/api/s/${sid}/join`, { body: { accessCode: $('accessCode').value } }));
      startPolling();
    } catch (e) {
      OD.toast(e.message === 'toegangscode' ? 'Die toegangscode klopt niet.' : e.message);
    } finally { $('joinBtn').disabled = false; }
  });

  $('tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  $('msgText').addEventListener('input', updateCounter);
  $('msgText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('sendBtn').click(); });

  $('sendBtn').addEventListener('click', async () => {
    const text = $('msgText').value.trim();
    if (!text) return $('msgText').focus();
    $('sendBtn').disabled = true;
    try {
      const wasUnlocked = state.unlocked;
      const data = await OD.api(`/api/s/${sid}/message`, { body: { text } });
      $('msgText').value = ''; updateCounter();
      OD.toast('Verzonden — anoniem.');
      if (!wasUnlocked) tab = 'vote';
      render(data);
    } catch (e) { OD.toast(e.message); } finally { $('sendBtn').disabled = false; }
  });

  $('skipBtn').addEventListener('click', async () => {
    try { tab = 'vote'; render(await OD.api(`/api/s/${sid}/skip`, { body: {} })); } catch (e) { OD.toast(e.message); }
  });

  $('segOptions').addEventListener('click', async e => {
    const b = e.target.closest('[data-opt]'); if (!b) return;
    try { render(await OD.api(`/api/s/${sid}/segment`, { body: { option: Number(b.dataset.opt) } })); OD.toast('Opgeslagen.'); } catch (err) { OD.toast(err.message); }
  });

  // Stemmen met de schuif
  const timers = new Map();
  function sendVote(art, input) {
    const mid = art.dataset.mid, value = Number(input.value);
    const scale = art.querySelector('.scale');
    scale.classList.remove('untouched');
    art.querySelector('.choice').innerHTML = '<span class="done-mark">✓</span> ' + LABELS[value];
    input.setAttribute('aria-valuetext', LABELS[value]);
    clearTimeout(timers.get(mid));
    timers.set(mid, setTimeout(async () => {
      try {
        const data = await OD.api(`/api/s/${sid}/vote`, { body: { mid, value } });
        const allDone = (data.batch || []).every(m => m.vote !== null) || batchKey !== (data.batch || []).map(i => i.id).join(',');
        if (allDone) setTimeout(() => render(data), 500); else render(data);
      } catch (e) { OD.toast(e.message); }
    }, 350));
  }
  $('batch').addEventListener('input', e => {
    if (e.target.type !== 'range') return;
    const art = e.target.closest('[data-mid]');
    art.querySelector('.choice').textContent = LABELS[e.target.value];
  });
  $('batch').addEventListener('change', e => { if (e.target.type === 'range') sendVote(e.target.closest('[data-mid]'), e.target); });
  // Ook een klik op het midden (neutraal) telt als stem.
  $('batch').addEventListener('pointerup', e => {
    if (e.target.type !== 'range') return;
    const art = e.target.closest('[data-mid]');
    if (art.querySelector('.scale').classList.contains('untouched')) sendVote(art, e.target);
  });

  function startPolling() { if (!poller) poller = OD.poll(load, 3000); }

  load().then(() => { if (state && state.joined) startPolling(); }).catch(e => {
    $('loading').textContent = e.status === 404 ? 'Deze dialoog bestaat niet (meer).' : 'Kan geen verbinding maken. Probeer het later opnieuw.';
  });
  // Ook vóór deelname af en toe kijken (bijv. als de titel verandert) is niet nodig; na deelname start polling.
})();
