'use strict';
(function () {
  const sid = OD.sessionId();
  const key = OD.adminKey();
  const $ = id => document.getElementById(id);
  let S = null;            // laatste beheerstatus
  let selQ = null;         // geselecteerde vraag
  let selected = new Set();// geselecteerde berichten
  let lastTableSig = '';
  let poller;

  if (!key) { $('noKey').classList.remove('hidden'); return; }
  history.replaceState(null, '', location.pathname); // sleutel uit de adresbalk halen
  $('app').classList.remove('hidden');

  const base = location.origin;
  $('pLink').value = `${base}/d/${sid}`;
  $('aLink').value = `${base}/beheer/${sid}#k=${key}`;
  $('reportLink').href = `/rapport/${sid}#k=${key}`;
  $('screenLink').href = `/scherm/${sid}#k=${key}`;

  async function act(body) {
    try {
      const r = await OD.api(`/api/s/${sid}/admin`, { admin: key, body });
      if (r.state) render(r.state);
      return r;
    } catch (e) { OD.toast(e.message); throw e; }
  }

  async function load() { render(await OD.api(`/api/s/${sid}/admin`, { admin: key })); }

  function q() { return S && S.questions.find(x => x.id === selQ); }

  function render(state) {
    S = state;
    document.title = `Beheer — ${S.title}`;
    $('title').textContent = S.title;
    $('live').textContent = `${S.online} live · ${S.participants} totaal`;
    if (!selQ || !S.questions.some(x => x.id === selQ)) selQ = S.activeQ || (S.questions[0] && S.questions[0].id) || null;
    renderQuestions();
    renderPanel();
    if (!document.activeElement || !document.activeElement.closest('details')) fillSettings();
  }

  function renderQuestions() {
    $('qcount').textContent = S.questions.length ? S.questions.length : '';
    const statusLabel = { draft: 'concept', open: 'open', closed: 'gesloten' };
    $('qlist').innerHTML = S.questions.map((x, i) => `
      <div class="qitem ${x.id === selQ ? 'sel' : ''}" data-q="${x.id}">
        <div class="row spread"><span class="chip ${x.status}">${statusLabel[x.status]}${x.type === 'segment' ? ' · keuze' : ''}</span>
          <span class="row" style="gap:2px">
            <button class="quiet small" data-move="-1" data-q="${x.id}" aria-label="Omhoog" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="quiet small" data-move="1" data-q="${x.id}" aria-label="Omlaag" ${i === S.questions.length - 1 ? 'disabled' : ''}>↓</button>
            ${x.status === 'draft' ? `<button class="quiet small" data-del="${x.id}" aria-label="Verwijderen">✕</button>` : ''}
          </span></div>
        <div class="qt" style="margin-top:6px">${OD.esc(x.text) || '<i class="muted">(geen tekst)</i>'}</div>
        <small>${x.type === 'open' ? `${OD.plural(x.messageCount, 'bericht', 'berichten')} · ${OD.plural(x.voteCount, 'stem', 'stemmen')}` : `${x.answered} antwoorden`}</small>
      </div>`).join('') || '<p class="muted">Nog geen vragen.</p>';
  }

  function renderPanel() {
    const x = q();
    $('noQ').classList.toggle('hidden', !!x);
    $('qpanel').classList.toggle('hidden', !x);
    if (!x) return;
    const statusText = { draft: 'Concept — nog niet zichtbaar', open: 'Open — deelnemers zien deze vraag', closed: 'Gesloten' };
    $('qStatus').textContent = statusText[x.status];
    $('qStatus').className = 'chip ' + x.status;
    $('qOpen').classList.toggle('hidden', x.status === 'open');
    $('qOpen').textContent = x.status === 'closed' ? 'Opnieuw openen' : 'Open voor deelnemers';
    $('qClose').classList.toggle('hidden', x.status !== 'open');
    $('qText').textContent = x.text;
    $('segPanel').classList.toggle('hidden', x.type !== 'segment');
    $('openPanel').classList.toggle('hidden', x.type !== 'open');

    if (x.type === 'segment') {
      $('qStats').innerHTML = stat(x.answered, 'antwoorden') + stat(S.participants, 'deelnemers');
      const max = Math.max(1, ...x.optionCounts);
      $('segBars').innerHTML = x.options.map((o, i) => `<div class="optbar"><span>${OD.esc(o)}</span><b class="num">${x.optionCounts[i]}</b><div class="bar" style="background:var(--surface-2)"><span style="width:${x.optionCounts[i] / max * 100}%;background:var(--accent)"></span></div></div>`).join('');
      return;
    }
    const visible = x.messages.filter(m => !m.hidden && !m.moderator);
    $('qStats').innerHTML = stat(visible.length, 'berichten') + stat(x.voteCount, 'stemmen') + stat(S.online, 'nu online') + stat(x.themes.length, "thema's");
    if (document.activeElement !== $('qPublish')) $('qPublish').value = x.publish;
    renderThemes(x);
    renderMessages(x);
  }

  function stat(n, label) { return `<div class="stat"><b>${n}</b><span>${label}</span></div>`; }

  function renderThemes(x) {
    const counts = {};
    for (const m of x.messages) if (m.themeId) counts[m.themeId] = (counts[m.themeId] || 0) + 1;
    $('themes').innerHTML = x.themes.map(t => `<span class="tag" data-theme="${t.id}" title="Klik om te hernoemen">${OD.esc(t.name)} <small>${counts[t.id] || 0}</small> <button class="quiet small" data-deltheme="${t.id}" aria-label="Thema verwijderen" style="padding:0 2px">✕</button></span>`).join('') || '<span class="muted">Nog geen thema\'s. Maak er zelf een of laat er een paar voorstellen.</span>';
    const opts = `<option value="">— geen thema —</option>` + x.themes.map(t => `<option value="${t.id}">${OD.esc(t.name)}</option>`).join('');
    if (document.activeElement !== $('bulkTheme')) { const v = $('bulkTheme').value; $('bulkTheme').innerHTML = opts; $('bulkTheme').value = v; }
  }

  function renderMessages(x) {
    const filter = $('filter').value, sort = $('sort').value;
    let list = x.messages.slice();
    if (filter === 'untheme') list = list.filter(m => !m.themeId && !m.hidden);
    if (filter === 'hidden') list = list.filter(m => m.hidden);
    const sorters = {
      agree: (a, b) => (b.agree ?? -1) - (a.agree ?? -1) || b.votes - a.votes,
      votes: (a, b) => b.votes - a.votes,
      new: (a, b) => b.createdAt - a.createdAt,
      controversial: (a, b) => Math.abs((a.agree ?? 0) - 50) - Math.abs((b.agree ?? 0) - 50) || b.votes - a.votes,
    };
    list.sort(sorters[sort]);
    const sig = JSON.stringify([filter, sort, list.map(m => [m.id, m.votes, m.agree, m.themeId, m.hidden, m.text]), x.themes]);
    const active = document.activeElement;
    if (sig === lastTableSig || (active && $('mlist').contains(active) && active.tagName === 'SELECT')) return;
    lastTableSig = sig;
    const themeOpts = t => `<option value="">—</option>` + x.themes.map(th => `<option value="${th.id}" ${th.id === t ? 'selected' : ''}>${OD.esc(th.name)}</option>`).join('');
    $('mlist').innerHTML = list.map(m => `
      <tr class="mrow ${m.hidden ? 'hid' : ''}" data-mid="${m.id}">
        <td><input type="checkbox" data-sel="${m.id}" ${selected.has(m.id) ? 'checked' : ''} aria-label="Selecteer bericht"></td>
        <td class="text">${m.moderator ? '<span class="tag mod">Stelling</span> ' : ''}${OD.esc(m.text)} <small class="muted">${OD.time(m.createdAt)}</small></td>
        <td class="num">${m.votes}${m.target ? `<small class="muted">/${m.target}</small>` : ''}</td>
        <td><div class="row" style="flex-wrap:nowrap">${OD.pct(m.agree)} ${OD.bar(m.agree)}</div></td>
        <td><select data-settheme="${m.id}" aria-label="Thema">${themeOpts(m.themeId)}</select></td>
        <td style="white-space:nowrap">
          <button class="quiet small" data-edit="${m.id}" title="Herleidbare details (namen) weghalen">Bewerk</button>
          <button class="quiet small" data-hide="${m.id}" data-h="${m.hidden ? 0 : 1}">${m.hidden ? 'Toon' : 'Verberg'}</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="6" class="empty">Nog geen berichten.</td></tr>`;
    updateSel();
  }

  function updateSel() {
    $('selCount').textContent = `${selected.size} geselecteerd`;
    $('bulkApply').disabled = $('bulkNew').disabled = selected.size === 0;
  }

  function fillSettings() {
    const st = S.settings;
    const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
    set('sTitle', S.title); set('sIntro', S.intro); set('sCode', st.accessCode || '');
    set('sSpread', st.initialSpread); set('sPromote', st.promoteAt); set('sBatch', st.batchSize);
    set('sMax', st.maxMessages); set('sLen', st.maxLength); set('sMin', st.minSegment);
  }

  // ---- Gebeurtenissen ----
  $('copyP').addEventListener('click', () => copy($('pLink').value));
  $('copyA').addEventListener('click', () => copy($('aLink').value));
  function copy(t) { navigator.clipboard.writeText(t).then(() => OD.toast('Gekopieerd.'), () => OD.toast('Kopiëren lukte niet — selecteer de tekst handmatig.')); }

  $('qlist').addEventListener('click', e => {
    const mv = e.target.closest('[data-move]');
    if (mv) { e.stopPropagation(); return act({ type: 'moveQuestion', qid: mv.dataset.q, dir: Number(mv.dataset.move) }); }
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); if (confirm('Deze vraag verwijderen?')) act({ type: 'deleteQuestion', qid: del.dataset.del }); return; }
    const it = e.target.closest('[data-q]');
    if (it) { selQ = it.dataset.q; selected.clear(); lastTableSig = ''; $('suggestions').innerHTML = ''; render(S); }
  });

  $('nqType').addEventListener('change', () => $('nqOptsF').classList.toggle('hidden', $('nqType').value !== 'segment'));
  $('nqAdd').addEventListener('click', async () => {
    const text = $('nqText').value.trim();
    if (!text) return $('nqText').focus();
    await act({ type: 'addQuestion', qtype: $('nqType').value, text, options: $('nqOpts').value });
    $('nqText').value = ''; $('nqOpts').value = '';
    const last = S.questions[S.questions.length - 1]; if (last) { selQ = last.id; render(S); }
    OD.toast('Vraag toegevoegd.');
  });

  $('qOpen').addEventListener('click', () => act({ type: 'openQuestion', qid: selQ }));
  $('qClose').addEventListener('click', () => act({ type: 'closeQuestion', qid: selQ }));
  $('qPublish').addEventListener('change', () => act({ type: 'updateQuestion', qid: selQ, publish: $('qPublish').value }));

  $('stSend').addEventListener('click', async () => {
    const text = $('stText').value.trim(); if (!text) return;
    await act({ type: 'statement', qid: selQ, text }); $('stText').value = ''; OD.toast('Stelling geplaatst — iedereen krijgt hem te zien.');
  });

  $('annSend').addEventListener('click', async () => { const text = $('annText').value.trim(); if (!text) return; await act({ type: 'announce', text }); OD.toast('Mededeling geplaatst.'); });
  $('annClear').addEventListener('click', async () => { await act({ type: 'announce', text: '' }); $('annText').value = ''; });

  $('addTheme').addEventListener('click', async () => {
    const name = $('newTheme').value.trim(); if (!name) return $('newTheme').focus();
    await act({ type: 'addTheme', qid: selQ, name }); $('newTheme').value = '';
  });
  $('newTheme').addEventListener('keydown', e => { if (e.key === 'Enter') $('addTheme').click(); });

  $('themes').addEventListener('click', e => {
    const d = e.target.closest('[data-deltheme]');
    if (d) { if (confirm('Thema verwijderen? De berichten blijven bestaan.')) act({ type: 'deleteTheme', qid: selQ, tid: d.dataset.deltheme }); return; }
    const t = e.target.closest('[data-theme]');
    if (t) { const cur = q().themes.find(x => x.id === t.dataset.theme); const name = prompt('Nieuwe naam voor dit thema:', cur ? cur.name : ''); if (name) act({ type: 'renameTheme', qid: selQ, tid: t.dataset.theme, name }); }
  });

  let suggestions = [];
  $('suggestBtn').addEventListener('click', async () => {
    const r = await act({ type: 'suggestThemes', qid: selQ });
    suggestions = r.suggestions || [];
    $('suggestions').innerHTML = suggestions.length ? `<p class="hint">Voorstellen op basis van gedeelde woorden in berichten zonder thema. Controleer ze altijd zelf.</p>` + suggestions.map((s, i) => `
      <div class="sugg"><div class="row spread"><b>${OD.esc(s.name)}</b><span class="row"><small>${s.messageIds.length} berichten</small><input type="text" data-sname="${i}" value="${OD.esc(s.name)}" style="width:180px;padding:5px 8px"><button class="small" data-sapply="${i}">Overnemen</button></span></div>
      <ul>${s.preview.map(p => `<li>${OD.esc(p)}</li>`).join('')}</ul></div>`).join('') : '<p class="muted">Geen duidelijke groepen gevonden (er zijn misschien nog te weinig berichten zonder thema).</p>';
  });
  $('suggestions').addEventListener('click', async e => {
    const b = e.target.closest('[data-sapply]'); if (!b) return;
    const i = Number(b.dataset.sapply), s = suggestions[i];
    const name = document.querySelector(`[data-sname="${i}"]`).value.trim() || s.name;
    await act({ type: 'addTheme', qid: selQ, name, messageIds: s.messageIds });
    b.closest('.sugg').remove();
  });

  $('filter').addEventListener('change', () => { lastTableSig = ''; renderPanel(); });
  $('sort').addEventListener('change', () => { lastTableSig = ''; renderPanel(); });

  $('mlist').addEventListener('change', e => {
    const s = e.target.dataset.sel;
    if (s) { e.target.checked ? selected.add(s) : selected.delete(s); updateSel(); return; }
    const t = e.target.dataset.settheme;
    if (t) act({ type: 'setTheme', mid: t, tid: e.target.value || null }).then(() => e.target.blur());
  });
  $('mlist').addEventListener('click', e => {
    const h = e.target.closest('[data-hide]');
    if (h) return act({ type: 'hideMessage', mid: h.dataset.hide, hidden: h.dataset.h === '1' });
    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const m = q().messages.find(x => x.id === ed.dataset.edit);
      const text = prompt('Pas de tekst aan, bijvoorbeeld om een naam weg te halen. Verander de strekking niet.', m.text);
      if (text && text !== m.text) act({ type: 'editMessage', mid: m.id, text });
    }
  });
  $('selAll').addEventListener('change', e => {
    document.querySelectorAll('#mlist [data-sel]').forEach(c => { c.checked = e.target.checked; e.target.checked ? selected.add(c.dataset.sel) : selected.delete(c.dataset.sel); });
    updateSel();
  });
  $('bulkApply').addEventListener('click', async () => {
    await act({ type: 'setTheme', mids: [...selected], tid: $('bulkTheme').value || null });
    selected.clear(); $('selAll').checked = false; lastTableSig = ''; renderPanel();
  });
  $('bulkNew').addEventListener('click', async () => {
    const name = prompt('Naam van het nieuwe thema:'); if (!name) return;
    await act({ type: 'addTheme', qid: selQ, name, messageIds: [...selected] });
    selected.clear(); $('selAll').checked = false; lastTableSig = ''; renderPanel();
  });

  $('saveSettings').addEventListener('click', async () => {
    await act({ type: 'updateSession', title: $('sTitle').value, intro: $('sIntro').value });
    await act({ type: 'updateSettings', settings: {
      accessCode: $('sCode').value, initialSpread: $('sSpread').value, promoteAt: $('sPromote').value,
      batchSize: $('sBatch').value, maxMessages: $('sMax').value, maxLength: $('sLen').value, minSegment: $('sMin').value,
    } });
    OD.toast('Instellingen opgeslagen.');
  });

  $('deleteSession').addEventListener('click', async () => {
    if (!confirm('Weet je het zeker? Alle berichten en stemmen worden definitief verwijderd.')) return;
    await OD.api(`/api/s/${sid}`, { method: 'DELETE', admin: key });
    try { localStorage.removeItem('od_key_' + sid); } catch (_) {}
    location.href = '/';
  });

  poller = OD.poll(load, 2500);
  void poller;
})();
