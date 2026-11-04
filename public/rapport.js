'use strict';
(function () {
  const sid = OD.sessionId();
  const key = OD.adminKey();
  const $ = id => document.getElementById(id);
  if (!key) { $('out').innerHTML = '<div class="notice">Open het rapport via de beheerpagina.</div>'; return; }
  history.replaceState(null, '', location.pathname);
  $('csv').href = `/api/s/${sid}/export.csv?key=${encodeURIComponent(key)}`;
  $('print').addEventListener('click', () => window.print());

  OD.api(`/api/s/${sid}/report`, { admin: key }).then(render).catch(e => { $('out').innerHTML = `<div class="notice">${OD.esc(e.message)}</div>`; });

  function render(r) {
    document.title = `Rapport — ${r.title}`;
    const segs = r.segments.filter(s => s.options.some(o => o.reportable));
    let h = `<section class="card">
      <div class="eyebrow">Rapport · ${new Date(r.generatedAt).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' })}</div>
      <h1>${OD.esc(r.title)}</h1>
      ${r.intro ? `<p class="muted" style="white-space:pre-line">${OD.esc(r.intro)}</p>` : ''}
      <div class="stats">
        <div class="stat"><b>${r.participants}</b><span>deelnemers</span></div>
        <div class="stat"><b>${r.questions.reduce((a, q) => a + q.messages.filter(m => !m.moderator).length, 0)}</b><span>berichten</span></div>
        <div class="stat"><b>${r.questions.reduce((a, q) => a + q.totalVotes, 0)}</b><span>beoordelingen</span></div>
        <div class="stat"><b>${r.questions.length}</b><span>vragen</span></div>
      </div>
      <p class="hint" style="margin-top:12px">Percentage eens = aandeel “eens” onder iedereen die niet neutraal stemde. Uitsplitsingen worden alleen getoond bij groepen van minstens ${r.minSegment} personen; kleinere groepen staan als “–”.</p>
    </section>`;

    if (r.segments.length) {
      h += `<section class="card"><h2>Samenstelling</h2>` + r.segments.map(s => `
        <h3 style="margin-top:10px">${OD.esc(s.text)}</h3>
        <table><tbody>${s.options.map(o => `<tr><td>${OD.esc(o.label)}</td><td class="num">${o.reportable ? o.count : `<span class="muted">minder dan ${r.minSegment}</span>`}</td></tr>`).join('')}</tbody></table>`).join('') + `</section>`;
    }

    for (const q of r.questions) {
      h += `<section class="qhead"><div class="eyebrow">Vraag</div><h2 class="question" style="font-size:1.4rem">${OD.esc(q.text)}</h2>
        <p class="muted">${OD.plural(q.messages.filter(m => !m.moderator).length, 'bericht', 'berichten')} van ${OD.plural(q.writers, 'schrijver', 'schrijvers')} · ${OD.plural(q.totalVotes, 'beoordeling', 'beoordelingen')}</p></section>`;

      if (q.themes.length) {
        h += `<section class="card"><h3>Thema's</h3>
          <div class="theme-row muted" style="font-size:.78rem;text-transform:uppercase;letter-spacing:.05em"><span>Thema</span><span>Berichten</span><span class="hide-sm">Gemiddelde steun</span><span></span></div>
          ${q.themes.map(t => `<div class="theme-row"><span class="name">${OD.esc(t.name)}</span><span class="num">${t.count}</span>${OD.bar(t.avgAgree)}<span class="pctc">${OD.pct(t.avgAgree)}</span></div>`).join('')}
        </section>`;
      }

      const groups = [];
      for (const t of q.themes) groups.push({ name: t.name, items: q.messages.filter(m => m.themeId === t.id) });
      const rest = q.messages.filter(m => !m.themeId);
      if (rest.length) groups.push({ name: q.themes.length ? 'Overige berichten' : 'Alle berichten', items: rest });

      const segCols = segs.flatMap(s => s.options.map((o, i) => ({ sid: s.id, i, label: o.label, ok: o.reportable }))).filter(c => c.ok);
      for (const g of groups) {
        if (!g.items.length) continue;
        h += `<section class="card"><h3>${OD.esc(g.name)} <small class="muted">· ${g.items.length}</small></h3><div class="table-scroll"><table>
          <thead><tr><th>Bericht</th><th class="num">Stemmen</th><th class="num">Eens</th><th style="min-width:110px"></th>${segCols.map(c => `<th class="num seg">${OD.esc(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${g.items.map(m => `<tr>
            <td class="text">${m.moderator ? '<span class="tag mod">Stelling</span> ' : ''}${OD.esc(m.text)}</td>
            <td class="num">${m.votes}</td><td class="num">${OD.pct(m.agree)}</td><td>${OD.bar(m.agree)}</td>
            ${segCols.map(c => { const v = m.bySegment[c.sid] && m.bySegment[c.sid][c.i]; return `<td class="num seg">${v === null || v === undefined ? '–' : v + '%'}</td>`; }).join('')}
          </tr>`).join('')}</tbody></table></div></section>`;
      }
    }
    if (!r.questions.length) h += '<div class="card empty">Er zijn nog geen open vragen gesteld.</div>';
    $('out').innerHTML = h;
  }
})();
