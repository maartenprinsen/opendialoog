#!/usr/bin/env node
/*
 * OpenDialoog — anonieme, live online dialogen voor groepen van 8 tot duizenden mensen.
 * Eén bestand, geen afhankelijkheden: alleen Node.js (v18+).
 *
 * Licentie: MIT (zie LICENSE).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Optioneel: wachtwoord dat nodig is om nieuwe sessies aan te maken.
const CREATE_PASSWORD = process.env.CREATE_PASSWORD || '';
// Na hoeveel dagen sessies automatisch worden verwijderd (0 = nooit).
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '0', 10);

const DEFAULT_SETTINGS = {
  initialSpread: 4,      // een nieuw bericht gaat eerst naar zoveel anderen
  spreadFactor: 2,       // bij voldoende steun wordt het bereik met deze factor vergroot
  promoteAt: 60,         // ...als minstens zoveel procent het eens is
  batchSize: 3,          // aantal berichten dat een deelnemer tegelijk beoordeelt
  maxMessages: 10,       // max. aantal berichten per deelnemer per vraag
  maxLength: 400,        // max. lengte van een bericht
  minSegment: 8,         // uitsplitsingen nooit onder dit aantal personen
  accessCode: '',        // optionele toegangscode voor deelnemers
};

const ASSIGN_TTL = 3 * 60 * 1000; // na 3 minuten zonder stem gaat een toewijzing terug in de pot
const ONLINE_WINDOW = 20 * 1000;

/* ------------------------------------------------------------------ */
/* Opslag                                                              */
/* ------------------------------------------------------------------ */

fs.mkdirSync(DATA_DIR, { recursive: true });
const sessions = new Map();   // id -> sessie (wordt opgeslagen)
const runtime = new Map();    // id -> { inflight: Map<mid, Map<code, ts>>, cache }
const dirty = new Set();

function rid(n = 10) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

function loadAll() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      s.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings);
      sessions.set(s.id, s);
    } catch (e) {
      console.error('Kon', f, 'niet laden:', e.message);
    }
  }
}

function save(s) {
  s.version = (s.version || 0) + 1;
  s.updatedAt = Date.now();
  dirty.add(s.id);
  const rt = rtFor(s.id);
  rt.cache = null;
}

function flush() {
  for (const id of dirty) {
    const s = sessions.get(id);
    if (!s) continue;
    const file = path.join(DATA_DIR, id + '.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  }
  dirty.clear();
}
setInterval(flush, 2000).unref();

function purgeOld() {
  if (!RETENTION_DAYS) return;
  const limit = Date.now() - RETENTION_DAYS * 864e5;
  for (const [id, s] of sessions) {
    if ((s.updatedAt || s.createdAt) < limit) {
      sessions.delete(id);
      runtime.delete(id);
      try { fs.unlinkSync(path.join(DATA_DIR, id + '.json')); } catch (_) {}
    }
  }
}
setInterval(purgeOld, 3600 * 1000).unref();

function rtFor(id) {
  let rt = runtime.get(id);
  if (!rt) { rt = { inflight: new Map(), cache: null, lastSeen: new Map() }; runtime.set(id, rt); }
  return rt;
}

/* ------------------------------------------------------------------ */
/* Domeinlogica                                                        */
/* ------------------------------------------------------------------ */

function createSession({ title, intro }) {
  const s = {
    id: rid(8),
    adminKey: rid(24),
    title: String(title || 'Nieuwe dialoog').slice(0, 200),
    intro: String(intro || '').slice(0, 2000),
    createdAt: Date.now(),
    settings: Object.assign({}, DEFAULT_SETTINGS),
    questions: [],
    activeQ: null,
    participants: {},
    messages: {},
    announcement: null,
    version: 0,
  };
  sessions.set(s.id, s);
  save(s);
  return s;
}

function newQuestion(data) {
  const type = data.type === 'segment' ? 'segment' : 'open';
  return {
    id: rid(6),
    type,
    text: String(data.text || '').slice(0, 600),
    options: type === 'segment' ? cleanOptions(data.options) : [],
    status: 'draft',            // draft | open | closed
    publish: 'ranking',         // none | ranking | themes
    themes: [],
    openedAt: null,
    closedAt: null,
  };
}

function cleanOptions(opts) {
  if (!Array.isArray(opts)) opts = String(opts || '').split('\n');
  return opts.map(o => String(o).trim().slice(0, 80)).filter(Boolean).slice(0, 30);
}

function stats(msg) {
  const vals = Object.values(msg.votes);
  let pos = 0, neg = 0, neu = 0, sum = 0;
  for (const v of vals) { if (v > 0) pos++; else if (v < 0) neg++; else neu++; sum += v; }
  const decided = pos + neg;
  return {
    votes: vals.length,
    pos, neg, neu,
    agree: decided ? Math.round((pos / decided) * 100) : null,
    avg: vals.length ? Math.round((sum / vals.length) * 100) / 100 : null,
  };
}

function participantCount(s) { return Object.keys(s.participants).length; }

function onlineCount(s) {
  const rt = rtFor(s.id);
  const now = Date.now();
  let n = 0;
  for (const t of rt.lastSeen.values()) if (now - t < ONLINE_WINDOW) n++;
  return n;
}

function questionById(s, qid) { return s.questions.find(q => q.id === qid); }

function inflightCount(rt, mid, now) {
  const m = rt.inflight.get(mid);
  if (!m) return 0;
  let n = 0;
  for (const [code, t] of m) { if (now - t < ASSIGN_TTL) n++; else m.delete(code); }
  return n;
}

/*
 * Verspreiding: een bericht gaat eerst naar `initialSpread` anderen.
 * Zodra dat aantal stemmen binnen is en minstens `promoteAt` procent het eens is,
 * wordt het bereik vergroot met `spreadFactor`, enzovoort tot iedereen het heeft gezien.
 * Stellingen van de moderator gaan altijd naar iedereen.
 */
function maybePromote(s, msg) {
  if (msg.moderator) return;
  const st = stats(msg);
  if (st.votes < msg.target) return;
  const cap = Math.max(1, participantCount(s) - 1);
  if (msg.target >= cap) return;
  if (st.agree !== null && st.agree >= s.settings.promoteAt) {
    msg.target = Math.min(cap, Math.ceil(msg.target * s.settings.spreadFactor));
  }
}

function nextBatch(s, p, q) {
  const rt = rtFor(s.id);
  const now = Date.now();
  const cap = participantCount(s) - 1;
  const cands = [];
  for (const m of Object.values(s.messages)) {
    if (m.qid !== q.id || m.hidden || m.author === p.code) continue;
    if (m.votes[p.code] !== undefined) continue;
    const have = Object.keys(m.votes).length + inflightCount(rt, m.id, now);
    const target = m.moderator ? Infinity : Math.min(m.target, Math.max(cap, 1));
    if (have >= target) continue;
    cands.push({ m, ratio: m.moderator ? -1 : have / target });
  }
  cands.sort((a, b) => a.ratio - b.ratio || a.m.createdAt - b.m.createdAt);
  const picked = cands.slice(0, s.settings.batchSize).map(c => c.m.id);
  for (const mid of picked) {
    if (!rt.inflight.has(mid)) rt.inflight.set(mid, new Map());
    rt.inflight.get(mid).set(p.code, now);
  }
  return picked;
}

function rankingFor(s, q, limit) {
  const rt = rtFor(s.id);
  const key = q.id + ':' + limit;
  if (rt.cache && rt.cache.v === s.version && rt.cache.key === key && Date.now() - rt.cache.t < 1500) return rt.cache.data;
  const minVotes = Math.min(3, Math.max(1, participantCount(s) - 1));
  const list = Object.values(s.messages)
    .filter(m => m.qid === q.id && !m.hidden)
    .map(m => ({ m, st: stats(m) }))
    .filter(x => x.st.votes >= minVotes)
    .sort((a, b) => (b.st.agree - a.st.agree) || (b.st.votes - a.st.votes))
    .slice(0, limit)
    .map(({ m, st }) => ({ id: m.id, text: m.text, agree: st.agree, votes: st.votes, theme: themeName(q, m.themeId), moderator: !!m.moderator }));
  rt.cache = { v: s.version, key, t: Date.now(), data: list };
  return list;
}

function themeName(q, tid) {
  if (!tid) return null;
  const t = q.themes.find(t => t.id === tid);
  return t ? t.name : null;
}

function themesView(s, q) {
  const groups = q.themes.map(t => ({ id: t.id, name: t.name, messages: [] }));
  const byId = Object.fromEntries(groups.map(g => [g.id, g]));
  for (const m of Object.values(s.messages)) {
    if (m.qid !== q.id || m.hidden || !m.themeId || !byId[m.themeId]) continue;
    const st = stats(m);
    byId[m.themeId].messages.push({ id: m.id, text: m.text, agree: st.agree, votes: st.votes });
  }
  for (const g of groups) g.messages.sort((a, b) => (b.agree ?? -1) - (a.agree ?? -1));
  return groups.filter(g => g.messages.length);
}

/* ---------- Thema-suggesties (eenvoudige trefwoord-clustering) ---------- */

const STOP = new Set(('de het een en van in op te dat die is voor met aan er niet zijn om ook als bij of wordt worden door naar maar dan nog wel meer we wij ze zij je jij ik mij me mijn ons onze hun hen hij haar zich dit deze wat wie waar hoe kan kunnen moet moeten zou zouden heb hebt heeft hebben had was waren werd geen veel heel echt alleen al toch dus omdat want zo nu hier daar dat over uit tot tegen zonder onder tussen binnen elke elk iedere ieder alle alles iets niets niemand iemand mensen gewoon soms vaak altijd nooit even beter goed slecht minder meest gaan gaat doen doet laten word zijn the and for that with this are you not but have was they from were will would there their what about which when your can more had has into than then them only some could other also just like over such been its our out who very yet een paar zoals graag eigenlijk vind vinden denk denken').split(' '));

function tokens(text) {
  const out = new Set();
  for (let w of String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)) {
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
    w = w.replace(/(heden|heid|ingen|ing|en|es|s|e)$/, '');
    if (w.length < 4) continue;
    out.add(w.slice(0, 7));
  }
  return out;
}

function suggestThemes(s, q) {
  const msgs = Object.values(s.messages)
    .filter(m => m.qid === q.id && !m.hidden && !m.themeId && !m.moderator)
    .map(m => ({ m, t: tokens(m.text), st: stats(m) }))
    .filter(x => x.t.size)
    .sort((a, b) => (b.st.agree ?? 0) * b.st.votes - (a.st.agree ?? 0) * a.st.votes);
  const df = new Map();
  for (const x of msgs) for (const t of x.t) df.set(t, (df.get(t) || 0) + 1);
  const N = msgs.length || 1;
  const w = t => Math.log(1 + N / (df.get(t) || 1));
  const clusters = [];
  for (const x of msgs) {
    let best = null, bestSim = 0;
    for (const c of clusters) {
      let inter = 0, a = 0;
      for (const t of x.t) { a += w(t); if (c.freq.has(t)) inter += w(t) * Math.min(1, c.freq.get(t) / c.items.length + 0.34); }
      const sim = a ? inter / a : 0;
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best && bestSim >= 0.24) {
      best.items.push(x);
      for (const t of x.t) best.freq.set(t, (best.freq.get(t) || 0) + 1);
    } else {
      clusters.push({ items: [x], freq: new Map([...x.t].map(t => [t, 1])) });
    }
  }
  // Voorbeeldwoord per stam (zodat het label leesbaar blijft)
  const sample = new Map();
  for (const x of msgs) {
    for (const raw of x.m.text.split(/[^\p{L}0-9]+/u)) {
      const tk = [...tokens(raw)][0];
      if (tk && !sample.has(tk)) sample.set(tk, raw.toLowerCase());
    }
  }
  return clusters
    .filter(c => c.items.length >= 2)
    .map(c => {
      const score = ([t, n]) => n * w(t) * Math.min(1, (sample.get(t) || t).length / 9);
      const top = [...c.freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => score(b) - score(a)).slice(0, 2).map(([t]) => sample.get(t) || t);
      return { name: top.length ? top.join(' / ') : 'Thema', messageIds: c.items.map(x => x.m.id), preview: c.items.slice(0, 3).map(x => x.m.text) };
    })
    .sort((a, b) => b.messageIds.length - a.messageIds.length)
    .slice(0, 12);
}

/* ---------- Rapportage ---------- */

function report(s) {
  const min = s.settings.minSegment;
  const segQs = s.questions.filter(q => q.type === 'segment');
  const segments = segQs.map(q => {
    const counts = q.options.map(() => 0);
    for (const p of Object.values(s.participants)) {
      const a = p.segments && p.segments[q.id];
      if (a !== undefined && counts[a] !== undefined) counts[a]++;
    }
    return { id: q.id, text: q.text, options: q.options.map((o, i) => ({ label: o, count: counts[i] >= min ? counts[i] : null, reportable: counts[i] >= min })) };
  });

  const questions = s.questions.filter(q => q.type === 'open' && q.status !== 'draft').map(q => {
    const all = Object.values(s.messages).filter(m => m.qid === q.id && !m.hidden);
    const rows = all.map(m => {
      const st = stats(m);
      const bySegment = {};
      for (const sq of segQs) {
        bySegment[sq.id] = sq.options.map((_, i) => {
          let pos = 0, neg = 0, n = 0;
          for (const [code, v] of Object.entries(m.votes)) {
            const p = s.participants[code];
            if (!p || !p.segments || p.segments[sq.id] !== i) continue;
            n++; if (v > 0) pos++; else if (v < 0) neg++;
          }
          if (n < min) return null; // nooit rapporteren onder de drempel
          return pos + neg ? Math.round(pos / (pos + neg) * 100) : null;
        });
      }
      return { id: m.id, text: m.text, theme: themeName(q, m.themeId), themeId: m.themeId || null, moderator: !!m.moderator, ...st, bySegment };
    }).sort((a, b) => (b.agree ?? -1) - (a.agree ?? -1) || b.votes - a.votes);
    const themes = q.themes.map(t => {
      const items = rows.filter(r => r.themeId === t.id);
      const voted = items.filter(r => r.agree !== null);
      return { id: t.id, name: t.name, count: items.length, avgAgree: voted.length ? Math.round(voted.reduce((a, r) => a + r.agree, 0) / voted.length) : null, votes: items.reduce((a, r) => a + r.votes, 0) };
    }).filter(t => t.count).sort((a, b) => b.count - a.count);
    const writers = new Set(all.filter(m => !m.moderator).map(m => m.author)).size;
    return { id: q.id, text: q.text, status: q.status, messages: rows, themes, writers, totalVotes: rows.reduce((a, r) => a + r.votes, 0) };
  });

  return {
    title: s.title, intro: s.intro, createdAt: s.createdAt,
    participants: participantCount(s), minSegment: min,
    segments, questions, generatedAt: Date.now(),
  };
}

function csv(s) {
  const r = report(s);
  const segQs = r.segments;
  const esc = v => { v = v === null || v === undefined ? '' : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = ['vraag', 'bericht', 'thema', 'moderator', 'stemmen', 'eens', 'oneens', 'neutraal', 'percentage_eens', 'gemiddelde'];
  for (const sq of segQs) for (const o of sq.options) head.push(`${sq.text} = ${o.label} (% eens)`);
  const lines = [head.map(esc).join(';')];
  for (const q of r.questions) {
    for (const m of q.messages) {
      const row = [q.text, m.text, m.theme, m.moderator ? 'ja' : '', m.votes, m.pos, m.neg, m.neu, m.agree, m.avg];
      for (const sq of segQs) for (let i = 0; i < sq.options.length; i++) row.push(m.bySegment[sq.id] ? m.bySegment[sq.id][i] : '');
      lines.push(row.map(esc).join(';'));
    }
  }
  return '﻿' + lines.join('\r\n');
}

/* ---------- Deelnemersweergave ---------- */

function participantState(s, p) {
  const q = s.activeQ ? questionById(s, s.activeQ) : null;
  const out = {
    title: s.title,
    intro: s.intro,
    announcement: s.announcement,
    online: onlineCount(s),
    participants: participantCount(s),
    maxLength: s.settings.maxLength,
    maxMessages: s.settings.maxMessages,
    question: null,
    version: s.version,
  };
  if (!q) {
    const last = [...s.questions].reverse().find(x => x.type === 'open' && x.status === 'closed' && x.publish !== 'none');
    if (last) out.closed = closedView(s, last);
    return out;
  }
  out.question = { id: q.id, type: q.type, text: q.text, status: q.status };
  if (q.type === 'segment') {
    out.question.options = q.options;
    out.question.answer = p.segments ? p.segments[q.id] ?? null : null;
    return out;
  }
  const mine = Object.values(s.messages)
    .filter(m => m.qid === q.id && m.author === p.code)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(m => { const st = stats(m); return { id: m.id, text: m.text, votes: st.votes, agree: st.agree, theme: themeName(q, m.themeId), hidden: !!m.hidden }; });
  out.mine = mine;
  const unlocked = mine.length > 0 || (p.skipped && p.skipped[q.id]);
  out.unlocked = !!unlocked;

  if (unlocked) {
    p.batch = p.batch && p.batch.qid === q.id ? p.batch : { qid: q.id, ids: [] };
    const rt = rtFor(s.id);
    const now = Date.now();
    // Houd de lopende reeks vast; vraag pas nieuwe berichten op als alles beoordeeld is.
    const open = p.batch.ids.filter(id => s.messages[id] && !s.messages[id].hidden && s.messages[id].votes[p.code] === undefined);
    if (open.length === 0) {
      p.batch.ids = nextBatch(s, p, q);
    } else {
      for (const id of open) { if (!rt.inflight.has(id)) rt.inflight.set(id, new Map()); rt.inflight.get(id).set(p.code, now); }
    }
    out.batch = p.batch.ids
      .filter(id => s.messages[id] && !s.messages[id].hidden)
      .map(id => { const m = s.messages[id]; return { id, text: m.text, moderator: !!m.moderator, vote: m.votes[p.code] ?? null }; });
    out.votedTotal = Object.values(s.messages).filter(m => m.qid === q.id && m.votes[p.code] !== undefined).length;
  }
  if (q.publish === 'ranking') out.ranking = rankingFor(s, q, 15);
  if (q.publish === 'themes') out.themes = themesView(s, q);
  return out;
}

function closedView(s, q) {
  return { text: q.text, ranking: q.publish === 'ranking' ? rankingFor(s, q, 15) : null, themes: q.publish === 'themes' ? themesView(s, q) : null };
}

/* ---------- Beheerweergave ---------- */

function adminState(s) {
  const qs = s.questions.map(q => {
    const msgs = Object.values(s.messages).filter(m => m.qid === q.id);
    let answered = 0;
    const optionCounts = q.options.map(() => 0);
    if (q.type === 'segment') for (const p of Object.values(s.participants)) {
      const a = p.segments && p.segments[q.id];
      if (a !== undefined && optionCounts[a] !== undefined) { answered++; optionCounts[a]++; }
    }
    return {
      ...q,
      optionCounts,
      messageCount: msgs.length,
      voteCount: msgs.reduce((a, m) => a + Object.keys(m.votes).length, 0),
      answered,
      messages: q.type === 'open' ? msgs.sort((a, b) => b.createdAt - a.createdAt).map(m => ({
        id: m.id, text: m.text, createdAt: m.createdAt, hidden: !!m.hidden, themeId: m.themeId || null,
        moderator: !!m.moderator, target: m.moderator ? null : m.target, ...stats(m),
      })) : [],
    };
  });
  return {
    id: s.id, title: s.title, intro: s.intro, settings: s.settings,
    activeQ: s.activeQ, announcement: s.announcement,
    participants: participantCount(s), online: onlineCount(s),
    questions: qs, version: s.version,
  };
}

function adminAction(s, a) {
  const q = a.qid ? questionById(s, a.qid) : null;
  switch (a.type) {
    case 'updateSession':
      if (a.title !== undefined) s.title = String(a.title).slice(0, 200);
      if (a.intro !== undefined) s.intro = String(a.intro).slice(0, 2000);
      break;
    case 'updateSettings': {
      const st = a.settings || {};
      const num = (k, lo, hi) => { if (st[k] !== undefined) { const v = Number(st[k]); if (Number.isFinite(v)) s.settings[k] = Math.max(lo, Math.min(hi, v)); } };
      num('initialSpread', 2, 50); num('spreadFactor', 1.2, 5); num('promoteAt', 0, 100);
      num('batchSize', 1, 10); num('maxMessages', 1, 100); num('maxLength', 50, 2000); num('minSegment', 3, 100);
      if (st.accessCode !== undefined) s.settings.accessCode = String(st.accessCode).trim().slice(0, 40);
      break;
    }
    case 'addQuestion':
      s.questions.push(newQuestion({ text: a.text, options: a.options, type: a.qtype }));
      break;
    case 'updateQuestion':
      if (!q) throw err(404, 'Vraag niet gevonden');
      if (a.text !== undefined) q.text = String(a.text).slice(0, 600);
      if (a.options !== undefined && q.type === 'segment') {
        if (q.status !== 'draft') throw err(400, 'Opties kunnen niet meer worden gewijzigd nadat de vraag is geopend');
        q.options = cleanOptions(a.options);
      }
      if (a.publish !== undefined && ['none', 'ranking', 'themes'].includes(a.publish)) q.publish = a.publish;
      break;
    case 'deleteQuestion':
      if (!q) throw err(404, 'Vraag niet gevonden');
      if (q.status !== 'draft') throw err(400, 'Alleen vragen die nog niet geopend zijn kunnen worden verwijderd');
      s.questions = s.questions.filter(x => x !== q);
      break;
    case 'moveQuestion': {
      if (!q) throw err(404, 'Vraag niet gevonden');
      const i = s.questions.indexOf(q), j = i + (a.dir < 0 ? -1 : 1);
      if (j >= 0 && j < s.questions.length) [s.questions[i], s.questions[j]] = [s.questions[j], s.questions[i]];
      break;
    }
    case 'openQuestion':
      if (!q) throw err(404, 'Vraag niet gevonden');
      if (s.activeQ && s.activeQ !== q.id) { const prev = questionById(s, s.activeQ); if (prev) { prev.status = 'closed'; prev.closedAt = Date.now(); } }
      q.status = 'open'; q.openedAt = q.openedAt || Date.now(); q.closedAt = null;
      s.activeQ = q.id;
      break;
    case 'closeQuestion':
      if (!q) throw err(404, 'Vraag niet gevonden');
      q.status = 'closed'; q.closedAt = Date.now();
      if (s.activeQ === q.id) s.activeQ = null;
      break;
    case 'hideMessage': {
      const m = s.messages[a.mid]; if (!m) throw err(404, 'Bericht niet gevonden');
      m.hidden = !!a.hidden;
      break;
    }
    case 'editMessage': {
      // Alleen voor het verwijderen van herleidbare details (namen e.d.).
      const m = s.messages[a.mid]; if (!m) throw err(404, 'Bericht niet gevonden');
      const t = String(a.text || '').trim().slice(0, s.settings.maxLength);
      if (t) { m.text = t; m.edited = true; }
      break;
    }
    case 'addTheme': {
      if (!q) throw err(404, 'Vraag niet gevonden');
      const name = String(a.name || '').trim().slice(0, 80);
      if (!name) throw err(400, 'Geef het thema een naam');
      const t = { id: rid(6), name };
      q.themes.push(t);
      if (Array.isArray(a.messageIds)) for (const mid of a.messageIds) if (s.messages[mid] && s.messages[mid].qid === q.id) s.messages[mid].themeId = t.id;
      break;
    }
    case 'renameTheme': {
      if (!q) throw err(404, 'Vraag niet gevonden');
      const t = q.themes.find(t => t.id === a.tid); if (!t) throw err(404, 'Thema niet gevonden');
      t.name = String(a.name || '').trim().slice(0, 80) || t.name;
      break;
    }
    case 'deleteTheme': {
      if (!q) throw err(404, 'Vraag niet gevonden');
      q.themes = q.themes.filter(t => t.id !== a.tid);
      for (const m of Object.values(s.messages)) if (m.themeId === a.tid) m.themeId = null;
      break;
    }
    case 'setTheme': {
      const ids = Array.isArray(a.mids) ? a.mids : [a.mid];
      for (const mid of ids) { const m = s.messages[mid]; if (m) m.themeId = a.tid || null; }
      break;
    }
    case 'suggestThemes':
      if (!q) throw err(404, 'Vraag niet gevonden');
      return { suggestions: suggestThemes(s, q) };
    case 'announce':
      s.announcement = a.text ? { text: String(a.text).slice(0, 500), at: Date.now() } : null;
      break;
    case 'statement': {
      if (!q || q.type !== 'open') throw err(400, 'Kies een open vraag');
      const text = String(a.text || '').trim().slice(0, s.settings.maxLength);
      if (!text) throw err(400, 'Lege stelling');
      const m = { id: rid(8), qid: q.id, author: '__moderator__', text, createdAt: Date.now(), votes: {}, target: Infinity, moderator: true, hidden: false, themeId: null };
      s.messages[m.id] = m;
      break;
    }
    default:
      throw err(400, 'Onbekende actie');
  }
  save(s);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function err(status, message) { const e = new Error(message); e.status = status; return e; }

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'interest-cohort=()',
};

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, Object.assign({ 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SECURITY_HEADERS, headers));
  res.end(isStr ? body : JSON.stringify(body));
}

function serveFile(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 404, 'Niet gevonden');
  fs.readFile(full, (e, data) => {
    if (e) return send(res, 404, 'Niet gevonden');
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, SECURITY_HEADERS));
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(err(413, 'Te groot')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (_) { reject(err(400, 'Ongeldige JSON')); } });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) { return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted; }

function getParticipant(req, res, s, create, accessCode) {
  const name = 'od_' + s.id;
  const code = cookies(req)[name];
  if (code && s.participants[code]) {
    rtFor(s.id).lastSeen.set(code, Date.now());
    return s.participants[code];
  }
  if (!create) return null;
  if (s.settings.accessCode && String(accessCode || '').trim().toLowerCase() !== s.settings.accessCode.toLowerCase()) throw err(403, 'toegangscode');
  // Willekeurige code: geen naam, geen e-mail, geen IP-adres.
  const p = { code: rid(12), joinedAt: Date.now(), segments: {}, skipped: {} };
  s.participants[p.code] = p;
  rtFor(s.id).lastSeen.set(p.code, Date.now());
  save(s);
  res.setHeader('Set-Cookie', `${name}=${p.code}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${isSecure(req) ? '; Secure' : ''}`);
  return p;
}

function requireAdmin(req, s, url) {
  const key = req.headers['x-admin-key'] || url.searchParams.get('key');
  if (!key || !s || !crypto.timingSafeEqual(Buffer.from(String(key).padEnd(64)), Buffer.from(s.adminKey.padEnd(64)))) throw err(403, 'Geen toegang');
}

// Eenvoudige rem tegen misbruik, per deelnemercode (geen IP-adressen).
const buckets = new Map();
function limit(key, perMinute) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > 60000) { b = { t: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  if (b.n > perMinute) throw err(429, 'Even rustig aan — probeer het zo opnieuw.');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 60000) buckets.delete(k); }, 60000).unref();

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  // Pagina's
  if (method === 'GET' && parts[0] !== 'api') {
    if (parts.length === 0) return serveFile(res, 'index.html');
    if (parts[0] === 'd' && parts[1]) return serveFile(res, 'deelnemer.html');
    if (parts[0] === 'beheer' && parts[1]) return serveFile(res, 'beheer.html');
    if (parts[0] === 'rapport' && parts[1]) return serveFile(res, 'rapport.html');
    if (parts[0] === 'scherm' && parts[1]) return serveFile(res, 'scherm.html');
    if (parts.length === 1 && /^[\w.-]+\.(css|js|svg|png|ico|webmanifest)$/.test(parts[0])) return serveFile(res, parts[0]);
    return send(res, 404, 'Niet gevonden');
  }

  if (parts[0] !== 'api') return send(res, 404, 'Niet gevonden');

  if (method === 'GET' && parts[1] === 'health') return send(res, 200, { ok: true, sessions: sessions.size });

  if (method === 'GET' && parts[1] === 'config') return send(res, 200, { needsPassword: !!CREATE_PASSWORD });

  if (method === 'POST' && parts[1] === 'sessions' && parts.length === 2) {
    const body = await readBody(req);
    if (CREATE_PASSWORD && body.password !== CREATE_PASSWORD) throw err(403, 'Onjuist wachtwoord');
    const s = createSession(body);
    if (Array.isArray(body.questions)) for (const q of body.questions.slice(0, 50)) s.questions.push(newQuestion(q));
    save(s);
    return send(res, 201, { id: s.id, adminKey: s.adminKey });
  }

  if (parts[1] !== 's' || !parts[2]) return send(res, 404, { error: 'Niet gevonden' });
  const s = sessions.get(parts[2]);
  if (!s) return send(res, 404, { error: 'Deze dialoog bestaat niet (meer).' });
  const action = parts[3];

  // ---- Deelnemer ----
  if (method === 'GET' && action === 'me') {
    const p = getParticipant(req, res, s, false);
    if (!p) return send(res, 200, { joined: false, title: s.title, intro: s.intro, needsCode: !!s.settings.accessCode });
    return send(res, 200, Object.assign({ joined: true }, participantState(s, p)));
  }
  if (method === 'POST' && action === 'join') {
    const body = await readBody(req);
    const p = getParticipant(req, res, s, true, body.accessCode);
    return send(res, 200, Object.assign({ joined: true }, participantState(s, p)));
  }
  if (method === 'POST' && ['message', 'vote', 'skip', 'segment'].includes(action)) {
    const p = getParticipant(req, res, s, false);
    if (!p) throw err(401, 'Open de link opnieuw om mee te doen.');
    const body = await readBody(req);
    limit(s.id + p.code + action, action === 'vote' ? 240 : 30);
    const q = s.activeQ ? questionById(s, s.activeQ) : null;
    if (!q || q.status !== 'open') throw err(409, 'Deze vraag is gesloten.');
    if (action === 'message') {
      if (q.type !== 'open') throw err(400, 'Bij deze vraag kun je niet schrijven.');
      const text = String(body.text || '').replace(/\s+/g, ' ').trim();
      if (text.length < 2) throw err(400, 'Je bericht is leeg.');
      if (text.length > s.settings.maxLength) throw err(400, `Maximaal ${s.settings.maxLength} tekens.`);
      const mineN = Object.values(s.messages).filter(m => m.qid === q.id && m.author === p.code).length;
      if (mineN >= s.settings.maxMessages) throw err(400, `Je kunt maximaal ${s.settings.maxMessages} berichten per vraag sturen.`);
      const m = { id: rid(8), qid: q.id, author: p.code, text, createdAt: Date.now(), votes: {}, target: s.settings.initialSpread, hidden: false, themeId: null };
      s.messages[m.id] = m;
    } else if (action === 'vote') {
      const m = s.messages[body.mid];
      if (!m || m.qid !== q.id || m.hidden) throw err(404, 'Bericht niet gevonden.');
      if (m.author === p.code) throw err(400, 'Op je eigen bericht stem je niet.');
      const assigned = p.batch && p.batch.qid === q.id && p.batch.ids.includes(m.id);
      if (!assigned && m.votes[p.code] === undefined) throw err(403, 'Dit bericht is niet aan jou voorgelegd.');
      const v = Math.round(Number(body.value));
      if (!(v >= -2 && v <= 2)) throw err(400, 'Ongeldige stem.');
      m.votes[p.code] = v;
      const inf = rtFor(s.id).inflight.get(m.id); if (inf) inf.delete(p.code);
      maybePromote(s, m);
    } else if (action === 'skip') {
      p.skipped = p.skipped || {}; p.skipped[q.id] = true;
    } else if (action === 'segment') {
      if (q.type !== 'segment') throw err(400, 'Dit is geen keuzevraag.');
      const i = Number(body.option);
      if (!Number.isInteger(i) || i < 0 || i >= q.options.length) throw err(400, 'Ongeldige keuze.');
      p.segments = p.segments || {}; p.segments[q.id] = i;
    }
    save(s);
    return send(res, 200, Object.assign({ joined: true }, participantState(s, p)));
  }

  // ---- Beheer ----
  if (method === 'GET' && action === 'admin') { requireAdmin(req, s, url); return send(res, 200, adminState(s)); }
  if (method === 'POST' && action === 'admin') {
    requireAdmin(req, s, url);
    const body = await readBody(req);
    const result = adminAction(s, body);
    return send(res, 200, Object.assign(result, { state: adminState(s) }));
  }
  if (method === 'GET' && action === 'report') { requireAdmin(req, s, url); return send(res, 200, report(s)); }
  if (method === 'GET' && action === 'export.csv') {
    requireAdmin(req, s, url);
    return send(res, 200, csv(s), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="opendialoog-${s.id}.csv"` });
  }
  if (method === 'GET' && action === 'screen') {
    // Presentatiescherm voor de zaal: alleen geaggregeerde, gepubliceerde informatie.
    requireAdmin(req, s, url);
    const q = s.activeQ ? questionById(s, s.activeQ) : null;
    return send(res, 200, {
      title: s.title, online: onlineCount(s), participants: participantCount(s),
      question: q ? { text: q.text, type: q.type, messageCount: Object.values(s.messages).filter(m => m.qid === q.id && !m.hidden).length } : null,
      ranking: q && q.type === 'open' ? rankingFor(s, q, 8) : [],
      themes: q && q.type === 'open' ? themesView(s, q) : [],
    });
  }
  if (method === 'DELETE' && !action) {
    requireAdmin(req, s, url);
    sessions.delete(s.id); runtime.delete(s.id); dirty.delete(s.id);
    try { fs.unlinkSync(path.join(DATA_DIR, s.id + '.json')); } catch (_) {}
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Niet gevonden' });
}

loadAll();
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Er ging iets mis.' });
  });
});
server.keepAliveTimeout = 65000;

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`OpenDialoog draait op http://localhost:${PORT}`));
  const stop = () => { flush(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

module.exports = { server, sessions, flush, _internals: { stats, suggestThemes, tokens, report } };
