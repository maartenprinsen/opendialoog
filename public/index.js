'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const read = () => { try { return JSON.parse(localStorage.getItem('od_mine') || '[]'); } catch (_) { return []; } };
  const write = v => { try { localStorage.setItem('od_mine', JSON.stringify(v)); } catch (_) {} };

  OD.api('/api/config').then(c => { if (c.needsPassword) $('pwF').classList.remove('hidden'); }).catch(() => {});

  const mine = read();
  if (mine.length) {
    $('mineCard').classList.remove('hidden');
    $('mine').innerHTML = mine.slice().reverse().map(m => `<a href="/beheer/${m.id}#k=${m.key}">${OD.esc(m.title)} <small class="muted">· ${new Date(m.created).toLocaleDateString('nl-NL')}</small></a>`).join('');
  }

  $('create').addEventListener('click', async () => {
    const title = $('title').value.trim();
    if (!title) return $('title').focus();
    const questions = [];
    if ($('segQ').value.trim() && $('segO').value.trim()) questions.push({ type: 'segment', text: $('segQ').value.trim(), options: $('segO').value });
    if ($('q1').value.trim()) questions.push({ type: 'open', text: $('q1').value.trim() });
    $('create').disabled = true;
    try {
      const r = await OD.api('/api/sessions', { body: { title, intro: $('intro').value.trim(), questions, password: $('pw').value } });
      write(read().concat({ id: r.id, key: r.adminKey, title, created: Date.now() }));
      location.href = `/beheer/${r.id}#k=${r.adminKey}`;
    } catch (e) { OD.toast(e.message); $('create').disabled = false; }
  });
})();
