'use strict';
(function () {
  const sid = OD.sessionId();
  const key = OD.adminKey();
  const $ = id => document.getElementById(id);
  let mode = 'ranking';
  if (!key) { $('q').textContent = 'Open het presentatiescherm via de beheerpagina.'; return; }
  history.replaceState(null, '', location.pathname);
  $('link').textContent = `${location.host}/d/${sid}`;
  $('mode').addEventListener('click', () => { mode = mode === 'ranking' ? 'themes' : 'ranking'; $('mode').textContent = mode === 'ranking' ? "Toon thema's" : 'Toon ranglijst'; poll.now(); });

  const poll = OD.poll(async () => {
    const d = await OD.api(`/api/s/${sid}/screen`, { admin: key });
    $('live').textContent = `${d.online} live`;
    $('q').textContent = d.question ? d.question.text : 'Even wachten op de volgende vraag…';
    if (!d.question || d.question.type !== 'open') { $('body').innerHTML = ''; return; }
    if (mode === 'themes' && d.themes.length) {
      $('body').innerHTML = `<div class="cols">${d.themes.map(t => `<div class="card"><h2>${OD.esc(t.name)} <small class="muted">· ${t.messages.length}</small></h2>${t.messages.slice(0, 4).map(m => `<div class="rank" style="grid-template-columns:3.5em 1fr"><span class="p" style="font-size:1.3em">${m.agree ?? '–'}%</span><span>${OD.esc(m.text)}</span></div>`).join('')}</div>`).join('')}</div>`;
    } else {
      $('body').innerHTML = d.ranking.length
        ? d.ranking.map(m => `<div class="rank"><span class="p">${m.agree ?? '–'}%</span><div><div class="t">${OD.esc(m.text)}</div><small class="muted">${OD.plural(m.votes, 'stem', 'stemmen')}${m.theme ? ' · ' + OD.esc(m.theme) : ''}</small></div></div>`).join('')
        : `<p class="muted">${OD.plural(d.question.messageCount, 'bericht', 'berichten')} binnen — de ranglijst verschijnt zodra er gestemd is.</p>`;
    }
  }, 3000);
})();
