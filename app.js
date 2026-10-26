(function () {
'use strict';
const T = window.T3K, C = T.CONFIG;
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (c) => T.fmt(c);
const signed = (c) => (c > 0 ? '+' : '') + T.fmt(c);
const pts = (n) => (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('fr-BE');
const dateFr = (iso) => { try { return new Date(iso).toLocaleString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } };

/* ======================= État ======================= */
const S = {
  view: 'home',            // home | setup | game | fin
  mode: 'local',           // local | host | guest
  session: null,
  finTab: 'accounts', upto: 0, openGame: null,
  rolling: false, animN: 0, showDice: [1, 3, 5], lastEvent: null,
  sound: lsGet('le3000.sound', true),
  db: null, user: null, roomCap: null, downloads: null, myId: null, canHost: false, capsReady: false,
  room: null, myPeer: null, peers: [], hostOnline: false, livePeers: new Set(),
  guest: null, lastSeq: {}, setupSel: null, dbSessions: [], winSeen: null, payDraft: null
};

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }
const LS = 'le3000.sessions.v1';
function lsSessions() { return lsGet(LS, {}) || {}; }
function lsPut(s) { const all = lsSessions(); all[s.id] = s; lsSet(LS, all); }
function lsDelete(id) { const all = lsSessions(); delete all[id]; lsSet(LS, all); }

/* ======================= Persistance ======================= */
let pending = null, flushing = false;
function compact(s) {
  const c = JSON.parse(JSON.stringify(s));
  for (const g of c.games) if (g.status !== 'playing' && g.log.length > 12) g.log = g.log.slice(-12);
  return c;
}
function persist() {
  const s = S.session; if (!s || S.mode === 'guest') return;
  s.rev = (s.rev || 0) + 1; s.updatedAt = new Date().toISOString();
  if (S.myId && !s.ownerId) s.ownerId = S.myId;
  lsPut(s);
  if (S.db && S.canHost) { pending = s; flush(); }
  if (S.room && S.mode === 'host') S.room.presence({ t: s.id, role: 'host', rev: s.rev }).catch(() => {});
}
async function flush() {
  if (flushing) return; flushing = true;
  let retried = false;
  while (pending) {
    const s = pending; pending = null;
    try { await S.db.doc('sessions/' + s.id).set(compact(s)); retried = false; }
    catch (e) {
      if (e && e.code === 'unavailable' && !retried) { retried = true; await sleep(700 + Math.random() * 900); if (!pending) pending = s; }
      else if (e && e.code === 'quota_exceeded') toast('Stockage en ligne plein : la session reste sauvegardée sur cet appareil.');
      else if (e && e.code === 'invalid_argument') { S.canHost = false; toast('Sauvegarde en ligne refusée : sauvegarde sur cet appareil uniquement.'); }
    }
  }
  flushing = false;
}

/* ======================= Capacités claude.ai ======================= */
async function initCaps() {
  const use = (n) => (window.claude && window.claude.use ? window.claude.use(n).catch(() => null) : Promise.resolve(null));
  const [db, user, room, dl] = await Promise.all([use('db'), use('user'), use('room'), use('downloads')]);
  S.db = db; S.user = user; S.roomCap = room; S.downloads = dl;
  if (user) { try { S.myId = await user.id(); } catch (e) { /* */ } }
  if (db) {
    let can = null; try { can = user ? await user.can('data.write') : null; } catch (e) { can = null; }
    S.canHost = can !== false;
  }
  S.capsReady = true;
  await loadDbSessions();
  render();
}
async function loadDbSessions() {
  if (!S.db || !S.myId) return;
  try {
    const q = await S.db.collection('sessions').where('ownerId', '==', S.myId).limit(100).get();
    S.dbSessions = q.docs.map((d) => d.data()).filter(Boolean);
  } catch (e) { S.dbSessions = []; }
}

/* ======================= Son ======================= */
let actx = null;
function beep(kind) {
  if (!S.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const seq = { roll: [[300, .04], [380, .04]], gain: [[523, .08], [784, .12]], brelan: [[523, .08], [659, .08], [784, .08], [1047, .2]],
      loss: [[330, .12], [220, .22]], penalty: [[200, .15], [150, .15], [110, .3]], win: [[523, .1], [659, .1], [784, .1], [1047, .1], [1319, .35]], bank: [[440, .06], [660, .1]] }[kind];
    if (!seq) return;
    let t = actx.currentTime;
    for (const [f, d] of seq) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = kind === 'penalty' ? 'sawtooth' : 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.18, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + d);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d + .02); t += d * .9;
    }
  } catch (e) { /* audio indisponible */ }
}

/* ======================= Utilitaires UI ======================= */
let toastT = null;
function toast(msg) {
  let el = $('#toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 3200);
}
function modal(html, cls) {
  $('#layer').innerHTML = `<div class="overlay" data-act="modal-bg"><div class="modal ${cls || ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  const f = $('#layer .modal [autofocus]') || $('#layer .modal button'); if (f) f.focus();
}
function closeModal() { $('#layer').innerHTML = ''; }
let confirmCb = null;
function ask(title, body, okLabel, cb, danger) {
  confirmCb = cb;
  modal(`<h3>${esc(title)}</h3><p>${body}</p><div class="row" style="justify-content:flex-end"><button class="btn" data-act="modal-close">Annuler</button><button class="btn ${danger ? 'danger' : 'primary'}" data-act="confirm-ok" autofocus>${esc(okLabel)}</button></div>`);
}
const player = (pid) => (S.session && S.session.players.find((p) => p.id === pid)) || { name: '?', color: '#888' };
const pname = (pid) => esc(player(pid).name);
function dieHTML(v, cls) { return `<div class="die f${v || 0} ${cls || ''}" aria-label="${v ? 'Dé ' + v : 'Dé'}">${'<i></i>'.repeat(9)}</div>`; }
const scoreCls = (n) => (n < 0 ? 'neg' : '');

/* ======================= Rendu principal ======================= */
function render() {
  const app = $('#app');
  const v = S.view;
  let html = header();
  if (v === 'home') html += viewHome();
  else if (v === 'setup') html += viewSetup();
  else if (v === 'game') html += viewGame();
  else if (v === 'fin') html += viewFin();
  else if (v === 'guestwait') html += viewGuestWait();
  app.innerHTML = html;
  afterRender();
}

function header() {
  const s = S.session;
  let right = '';
  if (s && S.view !== 'home') {
    const online = s.online ? (S.mode === 'guest'
      ? `<span class="chip ${S.hostOnline ? 'live' : 'off'}">${S.hostOnline ? 'Table ' + esc(s.id) : 'Hôte déconnecté'}</span>`
      : `<span class="chip live">Table ${esc(s.id)} · ${S.peers.length} appareil${S.peers.length > 1 ? 's' : ''}</span>`) : '';
    right = `<div class="row">${online}
      ${S.view !== 'game' && T.activeGame(s) ? '<button class="btn sm" data-act="goto-game">Retour au jeu</button>' : ''}
      ${S.view !== 'fin' ? '<button class="btn sm" data-act="goto-fin">Comptes</button>' : ''}
      <button class="btn sm ghost" data-act="sound" aria-pressed="${S.sound}" title="Sons">${S.sound ? 'Son activé' : 'Son coupé'}</button></div>`;
  }
  const sub = s && S.view !== 'home' ? `<div class="meta"><b>${esc(s.name)}</b><span class="muted" style="font-size:.85rem">${S.mode === 'guest' ? 'Invité · ' + esc(S.guest.name) : s.status === 'closed' ? 'Session clôturée' : 'Session en cours'}</span></div>` : '<div class="meta"></div>';
  return `<header class="top"><button class="brand" data-act="home" aria-label="Accueil">3<span>000</span></button>${sub}${right}</header>`;
}

/* ---------- Accueil ---------- */
function allSessions() {
  const map = {};
  for (const s of S.dbSessions) map[s.id] = s;
  const ls = lsSessions();
  for (const id in ls) if (!map[id] || (ls[id].rev || 0) > (map[id].rev || 0)) map[id] = ls[id];
  return Object.values(map).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}
function viewHome() {
  const sessions = allSessions();
  const onlineOk = S.db && S.roomCap;
  const hostBtn = onlineOk && S.canHost ? '<button class="btn alt" data-act="new-online">Créer une table en ligne</button>' : '';
  const joinBtn = onlineOk ? '<button class="btn alt" data-act="join-open">Rejoindre une table</button>' : '';
  const sessRows = sessions.length ? sessions.map((s) => {
    const g = T.activeGame(s);
    return `<div class="item"><div class="grow"><b>${esc(s.name)}</b> ${s.online ? `<span class="badge">en ligne · ${esc(s.id)}</span>` : ''} ${s.status === 'closed' ? '<span class="badge">clôturée</span>' : ''}
      <div class="muted" style="font-size:.88rem">${s.players.length} joueurs · ${s.games.filter((x) => x.status === 'won').length} parties · ${dateFr(s.updatedAt || s.createdAt)}${g ? ' · partie en cours' : ''}</div></div>
      <button class="btn sm primary" data-act="open-session" data-id="${esc(s.id)}">${s.status === 'closed' ? 'Consulter' : 'Reprendre'}</button></div>`;
  }).join('') : '<div class="empty">Aucune session enregistrée. Crée la première ci-dessus.</div>';
  return `
  <section class="hero">
    <div class="stack" style="gap:16px;position:relative;z-index:1">
      <h1>3000</h1>
      <p>Trois dés, du cran, et exactement 3000 points. Les règles, les cagnottes et les comptes entre joueurs sont gérés tout seuls, partie après partie.</p>
      <div class="hero-actions"><button class="btn" data-act="new-local">Jouer sur cet appareil</button>${hostBtn}${joinBtn}</div>
      ${!onlineOk && S.capsReady ? `<p style="font-size:.88rem;opacity:.8">${esc(window.LE3000_OFFLINE_MSG || 'Le jeu en ligne entre plusieurs appareils fonctionne quand la page est ouverte dans claude.ai, connecté.')}</p>` : ''}
    </div>
    <div class="dice" aria-hidden="true">${dieHTML(6)}${dieHTML(4)}${dieHTML(2)}</div>
  </section>
  <div class="grid2">
    <section class="panel stack"><div class="row" style="justify-content:space-between"><h2>Sessions</h2><button class="btn sm" data-act="restore-open">Restaurer une sauvegarde</button></div><div class="list">${sessRows}</div></section>
    <section class="panel stack"><h2>Mémo des règles</h2>
      <div class="rules">
        <div class="rule"><b class="gain">1</b><span>100 points</span></div>
        <div class="rule"><b class="gain">5</b><span>50 points</span></div>
        <div class="rule"><b class="gain">111…666</b><span>1000 points, relance obligatoire</span></div>
        <div class="rule"><b class="gain">432</b><span>+250 et fin du tour</span></div>
        <div class="rule"><b class="gain">421</b><span>+100, relance obligatoire</span></div>
        <div class="rule"><b class="loss">642</b><span>−250 au total, +2,50 € cagnotte</span></div>
        <div class="rule"><b class="loss">122</b><span>−500 au total, +5 € cagnotte</span></div>
      </div>
      <p class="muted">Pour bloquer, le total après blocage doit atteindre au moins 300 (ou être nul ou négatif). Au-delà de 3000, le tour est annulé. Mise de 5 € par joueur et par partie, le gagnant rafle la cagnotte.</p>
    </section>
  </div>`;
}

/* ---------- Préparation de partie ---------- */
function ensureSetupSel() {
  const s = S.session;
  if (!S.setupSel) {
    const last = s.games.length ? s.games[s.games.length - 1].participants : [];
    const order = last.length ? last.concat(s.players.map((p) => p.id).filter((id) => !last.includes(id))) : s.players.map((p) => p.id);
    S.setupSel = { order, on: new Set(last.length ? last : order) };
  }
  for (const p of s.players) if (!S.setupSel.order.includes(p.id)) { S.setupSel.order.push(p.id); S.setupSel.on.add(p.id); }
  S.setupSel.order = S.setupSel.order.filter((id) => s.players.some((p) => p.id === id));
}
function viewSetup() {
  const s = S.session; ensureSetupSel();
  const sel = S.setupSel, n = sel.order.filter((id) => sel.on.has(id)).length;
  const rows = sel.order.map((id, i) => {
    const p = player(id), on = sel.on.has(id), seat = s.seats[id], live = seat && S.livePeers.has(seat);
    return `<div class="o ${on ? '' : 'off'}"><span class="dot" style="background:${esc(p.color)}"></span>
      <div class="grow"><b>${esc(p.name)}</b> ${s.online ? (live ? '<span class="badge gain">son appareil</span>' : '<span class="badge">cet écran</span>') : ''}</div>
      <button class="iconbtn" data-act="ord-up" data-id="${id}" aria-label="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="iconbtn" data-act="ord-down" data-id="${id}" aria-label="Descendre" ${i === sel.order.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="btn sm" data-act="toggle-part" data-id="${id}" aria-pressed="${on}">${on ? 'Joue' : 'Ne joue pas'}</button></div>`;
  }).join('');
  const onlineBox = s.online ? `<section class="panel stack" style="text-align:center;align-items:center">
      <span class="label">Code de la table</span><div class="code">${esc(s.id)}</div>
      <p class="muted" style="max-width:44ch">Sur chaque téléphone : ouvrir ce même lien, choisir « Rejoindre une table » et taper ce code. Les joueurs apparaissent ici automatiquement.</p>
      <div class="row" style="justify-content:center">${S.peers.map((p) => `<span class="chip live">${esc(p.presence.name || '…')}</span>`).join('') || '<span class="muted">Aucun appareil connecté pour l’instant.</span>'}</div>
    </section>` : '';
  return `${onlineBox}
  <section class="panel stack">
    <div class="row" style="justify-content:space-between"><h2>${s.games.length ? 'Nouvelle partie' : 'Les joueurs'}</h2><span class="muted">Partie n° ${(s.games.reduce((m, g) => Math.max(m, g.no), 0)) + 1}</span></div>
    <div class="field"><label class="label" for="sess-name">Nom de la session</label><input type="text" id="sess-name" value="${esc(s.name)}" maxlength="40"></div>
    <form class="row" data-form="add-player" style="flex-wrap:nowrap"><input type="text" id="new-player" placeholder="Prénom ou pseudo" maxlength="24" autocomplete="off" aria-label="Prénom du joueur"><button class="btn primary" type="submit">Ajouter</button></form>
    <div class="row" style="justify-content:space-between"><span class="label">Ordre de passage</span><button class="btn sm" data-act="shuffle">Tirer l’ordre au sort</button></div>
    <div class="order">${rows || '<div class="empty">Ajoute au moins deux joueurs.</div>'}</div>
    <p class="muted">${n} joueur${n > 1 ? 's' : ''} · cagnotte de départ <b class="money">${money(n * C.STAKE_CENTS)}</b> (${money(C.STAKE_CENTS)} chacun)</p>
    <div class="row"><button class="btn primary" data-act="start-game" ${n < 2 || s.status === 'closed' ? 'disabled' : ''} style="flex:1;min-height:56px;font-size:1.1rem">Lancer la partie</button></div>
  </section>`;
}

/* ---------- Jeu ---------- */
function canControl(pid) {
  const s = S.session;
  if (S.mode === 'guest') return s.seats && s.seats[pid] === S.myPeer;
  if (S.mode === 'host') { const seat = s.seats[pid]; return !(seat && S.livePeers.has(seat)) || S.override === pid; }
  return true;
}
function verdictHTML(e) {
  if (!e) return '<span class="muted" style="color:rgba(234,245,238,.7)">À toi de lancer.</span>';
  const who = pname(e.pid);
  switch (e.kind === 'bank' ? 'bank' : e.outcome === 'bust' ? 'bust' : e.outcome === 'win' ? 'win' : e.kind) {
    case 'win': return `<span class="big v-money">3000 !</span><span>${who} gagne la partie.</span>`;
    case 'bust': return `<span class="big v-loss">Dépassement</span><span>Plus de 3000 : tour annulé, ${pts(e.lostTemp)} points perdus.</span>`;
    case '642': return `<span class="big v-loss">642 · −250</span><span class="v-money">+${money(e.cents)} dans la cagnotte de ${who}</span>`;
    case '122': return `<span class="big v-loss">122 · −500</span><span class="v-money">+${money(e.cents)} dans la cagnotte de ${who}</span>`;
    case 'brelan': return `<span class="big v-gain">${esc(e.label)} · +1000</span><span>Relance de confirmation obligatoire.</span>`;
    case '432': return `<span class="big v-gain">432 · +250</span><span>Tour bloqué d’office.</span>`;
    case '421': return `<span class="big v-gain">421${e.gained ? ' · +' + pts(e.gained) : ''}</span><span>Interdit de bloquer : relance obligatoire.</span>`;
    case 'zero': return `<span class="big v-loss">Rien</span><span>${e.lostTemp ? pts(e.lostTemp) + ' points du tour perdus.' : 'Tour suivant.'}</span>`;
    case 'bank': return `<span class="big v-gain">Bloqué · +${pts(e.gained)}</span><span>${who} met ses points à l’abri.</span>`;
    default: return `<span class="big v-gain">+${pts(e.gained)}</span><span>On continue ou on bloque ?</span>`;
  }
}
function viewGame() {
  const s = S.session, g = T.activeGame(s) || lastGame(s);
  if (!g) return `<div class="empty">Aucune partie. <button class="btn sm primary" data-act="goto-setup">Préparer une partie</button></div>`;
  const playing = g.status === 'playing';
  const t = g.turn, pid = playing ? t.pid : g.winner, p = player(pid);
  const total = g.scores[pid], th = playing ? total + t.temp : total;
  const why = playing ? T.bankBlockReason(g) : null;
  const ctl = playing && canControl(pid) && !S.rolling;
  const pending = S.mode === 'guest' && S.guest.pendingRev === s.rev;
  const seat = s.seats[pid], remote = S.mode === 'host' && seat && S.livePeers.has(seat);
  let note = '';
  if (playing && !canControl(pid)) note = S.mode === 'guest' ? `En attente de ${esc(p.name)}…` : `${esc(p.name)} joue sur son téléphone. <button class="btn sm ghost" style="color:inherit;min-height:30px" data-act="override" data-id="${pid}">Jouer à sa place</button>`;
  else if (playing && why) note = esc(why);
  else if (playing && t.temp > 0) note = `Bloquer maintenant : ${pts(total)} → <b>${pts(th)}</b>`;

  const ranking = g.participants.slice().sort((a, b) => g.scores[b] - g.scores[a]);
  const board = ranking.map((id, i) => {
    const sc = g.scores[id], on = playing && id === t.pid, seatP = s.seats[id], live = seatP && S.livePeers.has(seatP);
    const sup = g.supp[id];
    return `<tr class="${on ? 'on' : ''}"><td class="rank num">${i + 1}</td>
      <td><div class="pname"><span class="dot" style="background:${esc(player(id).color)}"></span>${pname(id)}${on ? ' <span class="badge gain">joue</span>' : ''}${s.online && live ? ' <span class="badge" title="Joue sur son appareil">à distance</span>' : ''}</div>
        <div class="bar"><b style="width:${Math.max(0, Math.min(100, sc / C.TARGET * 100))}%"></b></div></td>
      <td class="r"><span class="sc num ${scoreCls(sc)}">${pts(sc)}</span></td>
      <td class="r num money">${money(g.pot[id])}${sup.n642 || sup.n122 ? `<div class="loss" style="font-size:.78rem">${sup.n642 ? sup.n642 + '×642 ' : ''}${sup.n122 ? sup.n122 + '×122' : ''}</div>` : ''}</td></tr>`;
  }).join('');
  const log = g.log.slice().reverse().slice(0, 30).map((e) => {
    let badge = '';
    if (e.kind === 'bank') badge = `<span class="badge gain">bloque +${pts(e.gained)}</span>`;
    else if (e.outcome === 'bust') badge = '<span class="badge loss">dépassement</span>';
    else if (e.kind === '642' || e.kind === '122') badge = `<span class="badge loss">${e.kind} −${e.penalty}</span> <span class="badge money">+${money(e.cents)}</span>`;
    else if (e.kind === 'zero') badge = `<span class="badge loss">rien${e.lostTemp ? ' −' + pts(e.lostTemp) : ''}</span>`;
    else badge = `<span class="badge gain">${e.kind === 'brelan' ? 'brelan ' : e.kind === '432' ? '432 ' : e.kind === '421' ? '421 ' : ''}+${pts(e.gained)}</span>${e.outcome === 'banked' ? ' <span class="badge">bloqué</span>' : ''}${e.outcome === 'win' ? ' <span class="badge money">victoire</span>' : ''}`;
    return `<div class="e"><div class="mini">${e.dice ? e.dice.map((d) => dieHTML(d)).join('') : '<span class="muted" style="font-size:.85rem">—</span>'}</div><div style="min-width:0"><b>${pname(e.pid)}</b></div><div style="text-align:right">${badge}</div></div>`;
  }).join('') || '<div class="muted">Les lancers apparaîtront ici.</div>';

  const shown = S.showDice;
  const scoringDie = (d) => { const k = S.lastEvent && S.lastEvent.kind; return k === 'points' && (d === 1 || d === 5); };
  return `<div class="game">
    <section class="table" id="table">
      <div class="who"><span class="dot" style="background:${esc(p.color)};width:16px;height:16px"></span><span class="name">${esc(p.name)}</span>
        <span class="tag">Partie ${g.no}${playing ? '' : ' · terminée'}</span>${remote ? '<span class="tag">sur son téléphone</span>' : ''}${S.mode === 'guest' && canControl(pid) ? '<span class="tag">c’est toi</span>' : ''}</div>
      <div class="tray"><div class="dice ${S.rolling ? 'rolling' : ''}" id="dice">${shown.map((d) => dieHTML(d, S.lastEvent && !S.rolling && scoringDie(d) ? 'score' : '')).join('')}</div></div>
      <div class="verdict" id="verdict">${S.rolling ? '<span class="big">…</span>' : verdictHTML(S.lastEvent)}</div>
      <div class="counters">
        <div class="counter"><div class="label">Points du tour</div><div class="v">${playing ? pts(t.temp) : '—'}</div></div>
        <div class="counter"><div class="label">Score total</div><div class="v ${total < 0 ? 'negv' : ''}">${pts(total)}</div></div>
        <div class="counter"><div class="label">Après blocage</div><div class="v ${th < 0 ? 'negv' : ''}">${pts(th)}</div></div>
      </div>
      <div class="actions">
        <button class="btn roll" data-act="roll" ${ctl && !pending && s.status !== 'closed' ? '' : 'disabled'}>${t && t.mustConfirm ? 'Relancer (obligatoire)' : 'Lancer les dés'}</button>
        <button class="btn bank" data-act="bank" ${ctl && !why && !pending && s.status !== 'closed' ? '' : 'disabled'} ${why ? `aria-describedby="why"` : ''}>Bloquer mes points</button>
      </div>
      <div class="why" id="why">${note}</div>
      <div class="pot"><div><div class="label" style="color:rgba(234,245,238,.72)">Cagnotte de la partie</div><div class="v num">${money(T.potTotal(g))}</div></div>
        <div class="muted" style="color:rgba(234,245,238,.75);font-size:.9rem">Cagnotte de ${esc(p.name)} : <b style="color:#ffd88a">${money(g.pot[pid])}</b></div></div>
    </section>
    <div class="stack" style="gap:18px;min-width:0">
      <section class="panel stack"><div class="row" style="justify-content:space-between"><h3>Classement</h3><span class="muted num">objectif ${pts(C.TARGET)}</span></div>
        <div class="scroll"><table class="board"><thead><tr><th></th><th>Joueur</th><th class="r">Score</th><th class="r">Cagnotte</th></tr></thead><tbody>${board}</tbody></table></div>
        ${s.players.filter((x) => !g.participants.includes(x.id)).length ? `<p class="muted" style="font-size:.88rem">En attente de la prochaine partie : ${s.players.filter((x) => !g.participants.includes(x.id)).map((x) => esc(x.name)).join(', ')}</p>` : ''}</section>
      <section class="panel stack"><h3>Derniers lancers</h3><div class="log">${log}</div></section>
      ${S.mode !== 'guest' ? `<div class="row"><button class="btn sm" data-act="goto-fin">Tableau de bord financier</button>${playing ? '<button class="btn sm danger" data-act="abandon">Interrompre la partie</button>' : '<button class="btn sm primary" data-act="new-game-menu">Nouvelle partie</button>'}</div>` : ''}
    </div></div>`;
}
function lastGame(s) { return s.games.length ? s.games[s.games.length - 1] : null; }

/* ---------- Invité : attente ---------- */
function viewGuestWait() {
  const g = S.guest, s = S.session;
  const msg = S.guestMissing ? 'Aucune table avec ce code pour l’instant. Vérifie le code, ou attends que l’hôte la crée.'
    : s ? 'Connecté. La partie démarre dès que l’hôte la lance.' : 'Connexion à la table…';
  return `<section class="panel stack" style="max-width:560px;margin:20px auto;text-align:center;align-items:center">
    <span class="label">Table</span><div class="code">${esc(g.code)}</div>
    <p class="muted">${msg}</p>
    ${s ? `<div class="row" style="justify-content:center">${s.players.map((p) => `<span class="chip">${esc(p.name)}</span>`).join('')}</div>` : ''}
    <span class="chip ${S.hostOnline ? 'live' : 'off'}">${S.hostOnline ? 'Hôte connecté' : 'Hôte pas encore connecté'}</span>
    <button class="btn" data-act="home">Retour</button></section>`;
}

/* ---------- Tableau de bord financier ---------- */
function balancesOf(acc) { const b = {}; for (const id in acc) b[id] = acc[id].balance; return b; }
function viewFin() {
  const s = S.session, ro = S.mode === 'guest';
  const tabs = [['accounts', 'Voir les comptes'], ['plan', 'Qui doit quoi à qui ?'], ['pay', 'Enregistrer un remboursement'], ['history', 'Historique financier'], ['export', 'Exporter le bilan'], ['close', 'Clôturer la session']]
    .filter(([k]) => !(ro && (k === 'pay' || k === 'close')));
  const bar = `<div class="row" style="justify-content:space-between"><h2>Comptes de la session</h2>
    ${ro ? '' : `<button class="btn primary" data-act="new-game-menu" ${s.status === 'closed' ? 'disabled' : ''}>Nouvelle partie</button>`}</div>
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${S.finTab === k}" data-act="fintab" data-id="${k}">${l}</button>`).join('')}</div>`;
  let body = '';
  if (S.finTab === 'accounts') body = finAccounts();
  else if (S.finTab === 'plan') body = finPlan(ro);
  else if (S.finTab === 'pay') body = finPay();
  else if (S.finTab === 'history') body = finHistory(ro);
  else if (S.finTab === 'export') body = finExport();
  else if (S.finTab === 'close') body = finClose();
  return `<section class="stack">${bar}${body}</section>`;
}
function settledGames(s) { return s.games.filter((g) => g.settled && g.status !== 'cancelled').sort((a, b) => a.no - b.no); }
function finAccounts() {
  const s = S.session, done = settledGames(s);
  const acc = T.accounts(s, { uptoGames: S.upto || 0 });
  const opts = [0].concat([2, 5, 10, 20].filter((n) => n < done.length)).map((n) => `<option value="${n}" ${S.upto === n ? 'selected' : ''}>${n ? 'Après ' + n + ' parties' : 'Toutes les parties (' + done.length + ')'}</option>`).join('');
  const cards = s.players.map((p) => {
    const a = acc[p.id], b = a.balance;
    return `<article class="panel acct"><div class="pname"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</div>
      <div class="bal num ${b > 0 ? 'gain' : b < 0 ? 'loss' : 'muted'}">${signed(b)}</div>
      <div class="muted" style="font-size:.9rem">${b > 0 ? 'doit recevoir ' + money(b) : b < 0 ? 'doit payer ' + money(-b) : 'aucune dette ni créance'}</div>
      <div class="kv"><span>Parties jouées</span><span>${a.games}</span>
        <span>Mises initiales</span><span>${money(a.stakes)}</span>
        <span>Suppléments 642 ${a.n642 ? '(' + a.n642 + ')' : ''}</span><span class="loss">${money(a.s642)}</span>
        <span>Suppléments 122 ${a.n122 ? '(' + a.n122 + ')' : ''}</span><span class="loss">${money(a.s122)}</span>
        <span><b>Total versé</b></span><span><b>${money(a.contrib)}</b></span>
        <span>Gains remportés</span><span class="gain">${money(a.wins)}</span>
        <span>Résultat de jeu</span><span>${signed(a.gameNet)}</span>
        <span>Remboursements payés</span><span>${money(a.paid)}</span>
        <span>Remboursements reçus</span><span>${money(a.received)}</span></div></article>`;
  }).join('');
  const sum = Object.values(acc).reduce((t, a) => t + a.balance, 0);
  return `<div class="row"><div class="field" style="max-width:320px"><label class="label" for="upto">Période</label><select id="upto" data-change="upto">${opts}</select></div>
    <span class="muted" style="font-size:.88rem">Contrôle : somme des soldes = ${money(sum)}</span></div>
    ${s.players.length ? `<div class="cards">${cards}</div>` : '<div class="empty">Pas encore de joueurs.</div>'}`;
}
function finPlan(ro) {
  const s = S.session, acc = T.accounts(s), plan = T.settlementPlan(balancesOf(acc));
  if (!plan.length) return `<div class="panel"><div class="empty">${settledGames(s).length ? 'Tous les comptes sont soldés.' : 'Aucune partie terminée : rien à rembourser pour l’instant.'}</div></div>`;
  const totRecv = Object.values(acc).filter((a) => a.balance > 0).reduce((t, a) => t + a.balance, 0);
  const rows = plan.map((x, i) => {
    const d = S.payDraft && S.payDraft.i === i;
    return `<div class="xfer"><div class="pname"><span class="dot" style="background:${esc(player(x.from).color)}"></span>${pname(x.from)}</div>
      <div style="text-align:center"><div class="amt num">${money(x.cents)}</div><div class="arrow" aria-hidden="true">→</div></div>
      <div class="pname"><span class="dot" style="background:${esc(player(x.to).color)}"></span>${pname(x.to)}</div>
      <div class="act">${ro ? '' : d ? `<form class="row" data-form="pay-plan" data-i="${i}" style="flex-wrap:nowrap"><input type="number" id="pay-amt-${i}" step="0.01" min="0.01" max="${(x.cents / 100).toFixed(2)}" value="${(x.cents / 100).toFixed(2)}" aria-label="Montant versé" style="width:110px"><button class="btn sm primary" type="submit">Confirmer</button><button class="btn sm" type="button" data-act="pay-cancel">×</button></form>`
        : `<button class="btn sm" data-act="pay-draft" data-id="${i}">Marquer comme payé</button>`}</div></div>`;
  }).join('');
  return `<section class="panel stack"><p class="muted">${plan.length} virement${plan.length > 1 ? 's' : ''} suffisent pour tout solder · ${money(totRecv)} à faire circuler. Tu peux indiquer un montant partiel avant de confirmer.</p><div>${rows}</div></section>`;
}
function finPay() {
  const s = S.session, opts = s.players.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  return `<section class="panel stack" style="max-width:620px"><h3>Remboursement libre</h3>
    <p class="muted">Pour noter un paiement réellement effectué, total ou partiel. Il règle une dette existante et ne compte jamais comme un gain de jeu.</p>
    <form class="stack" data-form="pay-free">
      <div class="grid2" style="gap:12px"><div class="field"><label class="label" for="pf-from">Qui paie</label><select id="pf-from">${opts}</select></div>
      <div class="field"><label class="label" for="pf-to">Qui reçoit</label><select id="pf-to">${s.players.map((p, i) => `<option value="${p.id}" ${i === 1 ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div></div>
      <div class="field"><label class="label" for="pf-amt">Montant (€)</label><input type="number" id="pf-amt" step="0.01" min="0.01" placeholder="5,00"></div>
      <button class="btn primary" type="submit">Enregistrer le paiement</button></form></section>`;
}
function finHistory(ro) {
  const s = S.session;
  const games = s.games.slice().sort((a, b) => b.no - a.no);
  const done = settledGames(s);
  const gameRows = games.map((g) => {
    const res = T.gameResult(s, g), idx = done.indexOf(g);
    const cum = idx >= 0 ? T.accounts(s, { uptoGames: idx + 1, excludePayments: true }) : null;
    const st = { won: '<span class="badge gain">terminée</span>', playing: '<span class="badge">en cours</span>', abandoned: '<span class="badge">interrompue</span>', cancelled: '<span class="badge loss">annulée</span>' }[g.status];
    const det = g.participants.map((pid) => `<tr><td><div class="pname"><span class="dot" style="background:${esc(player(pid).color)}"></span>${pname(pid)}</div></td>
      <td class="r">${money(C.STAKE_CENTS)}</td><td class="r loss">${res[pid].n642 ? money(res[pid].n642 * C.P642.cents) : '—'}</td><td class="r loss">${res[pid].n122 ? money(res[pid].n122 * C.P122.cents) : '—'}</td>
      <td class="r gain">${res[pid].gain ? money(res[pid].gain) : '—'}</td><td class="r"><b>${g.settled && g.status !== 'cancelled' ? signed(res[pid].net) : '—'}</b></td>
      <td class="r muted">${cum ? signed(cum[pid].balance) : '—'}</td></tr>`).join('');
    return `<details class="gm" ${S.openGame === g.id ? 'open' : ''} data-gid="${g.id}"><summary><span class="no num">${g.no}</span><span class="grow" style="flex:1;min-width:0"><b>${g.winner ? 'Gagnée par ' + pname(g.winner) : g.participants.map(pname).join(', ')}</b><br><span class="muted" style="font-size:.85rem">${dateFr(g.date)} · ${g.participants.length} joueurs</span></span>
      <span class="money num"><b>${money(T.potTotal(g))}</b></span>${st}</summary>
      <div class="scroll" style="margin-top:10px"><table class="ledger"><thead><tr><th>Joueur</th><th class="r">Mise</th><th class="r">Supp. 642</th><th class="r">Supp. 122</th><th class="r">Gain</th><th class="r">Résultat</th><th class="r">Solde cumulé</th></tr></thead><tbody>${det}</tbody></table></div>
      ${g.status === 'cancelled' ? `<p class="loss" style="margin-top:8px">Annulée le ${dateFr(g.cancelledAt)}${g.cancelReason ? ' : ' + esc(g.cancelReason) : ''}. Les écritures d’origine et leurs contre-écritures restent visibles ci-dessous.</p>` : ''}
      ${!ro && g.settled && g.status === 'won' ? `<div class="row" style="margin-top:10px"><button class="btn sm danger" data-act="cancel-game" data-id="${g.id}">Annuler cette partie</button></div>` : ''}
      ${!ro && g.status === 'abandoned' ? `<div class="row" style="margin-top:10px"><button class="btn sm" data-act="resume-game" data-id="${g.id}">Reprendre cette partie</button></div>` : ''}
    </details>`;
  }).join('') || '<div class="empty">Aucune partie pour l’instant.</div>';
  const byId = {}; s.ledger.forEach((o) => (byId[o.id] = o));
  const typeL = { stake: 'Mise initiale', supp642: 'Supplément 642', supp122: 'Supplément 122', win: 'Gain de la cagnotte', payment: 'Remboursement', reversal: 'Contre-écriture' };
  const gNo = (id) => { const g = s.games.find((x) => x.id === id); return g ? g.no : ''; };
  const ops = s.ledger.slice().reverse().map((o) => {
    const eff = T.opEffect(o, byId);
    const who = o.type === 'payment' ? `${pname(o.from)} → ${pname(o.to)}` : pname(o.pid);
    const amt = o.type === 'payment' ? money(o.cents) : signed(Object.values(eff)[0] || 0);
    return `<tr><td class="muted">${dateFr(o.date)}</td><td>${typeL[o.type] || o.type}${o.gameId ? ' · partie ' + gNo(o.gameId) : ''}${o.note ? ' <span class="muted">(' + esc(o.note) + ')</span>' : ''}</td><td>${who}</td><td class="r">${amt}</td></tr>`;
  }).join('');
  const plan = T.settlementPlan(balancesOf(T.accounts(s)));
  return `<section class="panel stack"><h3>Parties</h3><div>${gameRows}</div></section>
    <section class="panel stack"><h3>Dettes restantes</h3>${plan.length ? plan.map((x) => `<div>${pname(x.from)} doit <b class="money">${money(x.cents)}</b> à ${pname(x.to)}</div>`).join('') : '<p class="muted">Aucune.</p>'}</section>
    <section class="panel stack"><h3>Toutes les opérations</h3>${ops ? `<div class="scroll"><table class="ledger"><thead><tr><th>Date</th><th>Opération</th><th>Joueur</th><th class="r">Montant</th></tr></thead><tbody>${ops}</tbody></table></div>` : '<p class="muted">Aucune opération enregistrée.</p>'}</section>`;
}
function finExport() {
  return `<section class="panel stack" style="max-width:640px"><h3>Partager le bilan</h3>
    <p class="muted">Le CSV s’ouvre dans Excel ou Google Sheets. Le PDF reprend soldes, remboursements et parties. La sauvegarde permet de restaurer la session sur un autre appareil.</p>
    <div class="row"><button class="btn primary" data-act="exp-csv">Bilan CSV</button><button class="btn primary" data-act="exp-pdf">Bilan PDF</button><button class="btn" data-act="exp-json">Sauvegarde de la session</button></div>
    <div id="exp-out"></div></section>`;
}
function finClose() {
  const s = S.session, acc = T.accounts(s), plan = T.settlementPlan(balancesOf(acc));
  const vals = Object.values(acc);
  const contrib = vals.reduce((t, a) => t + a.contrib, 0), wins = vals.reduce((t, a) => t + a.wins, 0);
  const payments = s.ledger.filter((o) => o.type === 'payment');
  const remain = plan.reduce((t, x) => t + x.cents, 0);
  return `<section class="panel stack"><h3>Récapitulatif</h3>
    <div class="kv" style="max-width:480px"><span>Parties comptabilisées</span><span>${settledGames(s).length}</span><span>Total des contributions</span><span>${money(contrib)}</span><span>Total des gains</span><span>${money(wins)}</span><span>Remboursements déjà réalisés</span><span>${payments.length} · ${money(payments.reduce((t, o) => t + o.cents, 0))}</span><span><b>Reste à régler</b></span><span><b class="money">${money(remain)}</b></span></div>
    <div class="kv" style="max-width:480px">${s.players.map((p) => `<span>${esc(p.name)}</span><span class="${acc[p.id].balance > 0 ? 'gain' : acc[p.id].balance < 0 ? 'loss' : ''}">${signed(acc[p.id].balance)}</span>`).join('')}</div>
    ${plan.length ? `<div><span class="label">Remboursements à effectuer</span>${plan.map((x) => `<div>${pname(x.from)} verse <b class="money">${money(x.cents)}</b> à ${pname(x.to)}</div>`).join('')}</div>` : '<p class="gain"><b>Tout est soldé.</b></p>'}
    <div class="row">${s.status === 'closed' ? '<span class="badge">Session clôturée le ' + dateFr(s.closedAt) + '</span><button class="btn" data-act="reopen">Rouvrir la session</button>' : '<button class="btn primary" data-act="close-session">Clôturer la session</button>'}</div>
    <p class="muted" style="font-size:.9rem">La clôture garde tout l’historique ; elle empêche seulement de lancer de nouvelles parties. Les remboursements restent enregistrables.</p></section>`;
}

/* ======================= Après rendu ======================= */
function afterRender() {
  if (S.view === 'game' && S.flash) {
    const el = $('#table'); if (el) { el.classList.add(S.flash); setTimeout(() => el.classList.remove(S.flash), 900); }
    S.flash = null;
  }
  // Victoire
  const s = S.session; const g = s && lastGame(s);
  if (S.view === 'game' && g && g.status === 'won' && S.winSeen !== g.id) {
    S.winSeen = g.id; showWin(g);
  }
}
function showWin(g) {
  const guest = S.mode === 'guest';
  modal(`<span class="label" style="color:rgba(234,245,238,.75)">Partie ${g.no} · score exact</span>
    <div class="big">${pname(g.winner)}</div>
    <div style="font-family:var(--display);font-size:2.4rem;font-weight:900">3000 points</div>
    <p>Remporte la cagnotte de <b style="color:#ffd88a;font-size:1.3rem">${money(T.potTotal(g))}</b></p>
    ${guest ? '<button class="btn primary" data-act="modal-close">Fermer</button>' : `
    <button class="btn primary" data-act="replay-same" autofocus>Nouvelle partie avec les mêmes joueurs</button>
    <button class="btn" data-act="replay-diff">Nouvelle partie avec des joueurs différents</button>
    <button class="btn" data-act="win-accounts">Voir les comptes</button>
    <button class="btn" data-act="win-close">Terminer la session et calculer les remboursements</button>`}`, 'win');
}

/* ======================= Actions de jeu ======================= */
async function animateTo(dice, ev) {
  S.rolling = true; S.lastEvent = null; beep('roll'); render();
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) {
    for (let i = 0; i < 6; i++) {
      await sleep(70);
      const el = $('#dice'); if (el) el.querySelectorAll('.die').forEach((d) => (d.className = 'die f' + (1 + Math.floor(Math.random() * 6))));
    }
  }
  await sleep(reduce ? 50 : 160);
  S.showDice = dice; S.rolling = false; S.lastEvent = ev;
  if (ev) {
    if (ev.outcome === 'win') { beep('win'); S.flash = 'flash'; }
    else if (ev.kind === '642' || ev.kind === '122') { beep('penalty'); S.flash = 'shake'; }
    else if (ev.outcome === 'bust' || ev.kind === 'zero') { beep('loss'); S.flash = 'shake'; }
    else if (ev.kind === 'brelan') { beep('brelan'); S.flash = 'flash'; }
    else if (ev.kind === '421') { beep('bank'); }
    else beep('gain');
  }
}
let acting = false;
async function doRoll(fromRemote) {
  const s = S.session, g = T.activeGame(s);
  if (!g || acting || s.status === 'closed') return;
  if (!fromRemote && !canControl(g.turn.pid)) return;
  acting = true;
  try {
    const dice = T.rollDice();
    const ev = T.applyRoll(s, g, dice);
    S.override = null;
    persist();
    S.animN = g.rollCount;
    await animateTo(dice, ev);
  } finally { acting = false; render(); }
}
function doBank(fromRemote) {
  const s = S.session, g = T.activeGame(s);
  if (!g || acting) return;
  if (!fromRemote && !canControl(g.turn.pid)) return;
  if (T.bankBlockReason(g)) return;
  acting = true;
  try { const ev = T.bank(s, g); S.lastEvent = ev; S.animN = g.rollCount; S.override = null; beep(ev.outcome === 'win' ? 'win' : 'bank'); if (ev.outcome === 'win') S.flash = 'flash'; persist(); }
  finally { acting = false; render(); }
}
function startGame(pids) {
  const s = S.session;
  if (pids.length < 2) return toast('Il faut au moins deux joueurs.');
  const cur = T.activeGame(s);
  if (cur) return askInterrupted(cur, () => startGame(pids));
  T.newGame(s, pids);
  S.lastEvent = null; S.showDice = [1, 3, 5]; S.setupSel = null; S.winSeen = null;
  persist(); S.view = 'game'; render(); wakeLock();
}
function askInterrupted(g, then) {
  confirmCb = null;
  modal(`<h3>La partie ${g.no} n’est pas terminée</h3><p>Aucun gagnant n’a été désigné, donc aucun gain n’est enregistré. Que veux-tu faire ?</p>
    <div class="stack"><button class="btn primary" data-act="int-resume" autofocus>Reprendre la partie ${g.no}</button>
    <button class="btn danger" data-act="int-abandon">Interrompre la partie ${g.no} sans gain, puis continuer</button>
    <button class="btn" data-act="modal-close">Annuler</button></div>`);
  S.afterAbandon = then;
}
let wl = null;
async function wakeLock() { try { if (navigator.wakeLock && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => (wl = null)); } } catch (e) { wl = null; } }

/* ======================= Sessions ======================= */
function openSession(s, mode) {
  S.session = s; S.mode = mode; S.setupSel = null; S.lastEvent = null; S.winSeen = null;
  const g = T.activeGame(s), last = lastGame(s);
  if (last && last.status === 'won') S.winSeen = last.id;
  if (last && last.log.length) { const e = last.log[last.log.length - 1]; if (e.dice) S.showDice = e.dice; S.animN = last.rollCount; }
  S.view = g ? 'game' : s.games.length ? 'fin' : 'setup';
  if (s.online && mode === 'host') connectRoom(s.id, 'host');
  render();
}
function newSession(online) {
  const s = T.newSession('Soirée du ' + new Date().toLocaleDateString('fr-BE', { day: 'numeric', month: 'long' }));
  s.online = !!online; if (S.myId) s.ownerId = S.myId;
  S.session = s; persist();
  openSession(s, online ? 'host' : 'local');
}

/* ======================= Réseau : hôte / invités ======================= */
async function connectRoom(code, role) {
  if (!S.roomCap) return;
  if (S.room && S.roomCode === code) return;
  if (S.room && S.room.leave && S.room !== S.roomCap) { try { await S.room.leave(); } catch (e) { /* */ } }
  let r = S.roomCap;
  try { r = await S.roomCap.join('t-' + code.toLowerCase()); } catch (e) { r = S.roomCap; }
  S.room = r; S.roomCode = code;
  r.onPeers((ch) => onPeers(ch.peers), () => { S.hostOnline = false; render(); });
  const pres = role === 'host' ? { t: code, role: 'host', rev: (S.session && S.session.rev) || 0 } : { t: code, role: 'guest', name: S.guest.name };
  r.presence(pres).catch(() => toast('Connexion à la table impossible pour le moment.'));
}
function onPeers(peers) {
  const code = S.roomCode;
  const me = peers.find((p) => p.isMe && p.sameTab); if (me) S.myPeer = me.peer;
  const at = peers.filter((p) => p.presence && p.presence.t === code && !(p.isMe && p.sameTab));
  S.livePeers = new Set(at.map((p) => p.peer));
  if (S.mode === 'host') {
    S.peers = at.filter((p) => p.presence.role === 'guest');
    let changed = false;
    for (const p of S.peers) if (handleGuest(p)) changed = true;
    if (changed) persist();
    if (S.view !== 'game' || !acting) render();
  } else if (S.mode === 'guest') {
    const h = at.find((p) => p.presence.role === 'host');
    const was = S.hostOnline; S.hostOnline = !!h;
    if (h && S.session && (h.presence.rev || 0) > (S.session.rev || 0)) refetchSoon();
    if (was !== S.hostOnline) render();
  }
}
function handleGuest(p) {
  const s = S.session; if (!s) return false;
  const name = String(p.presence.name || '').trim().slice(0, 24); if (!name) return false;
  let changed = false;
  let pl = s.players.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!pl) { pl = T.addPlayer(s, name); changed = true; toast(name + ' a rejoint la table'); }
  const cur = s.seats[pl.id];
  if (cur !== p.peer && !(cur && S.livePeers.has(cur))) { s.seats[pl.id] = p.peer; changed = true; }
  // Intention de jeu envoyée par le téléphone
  const a = p.presence.act;
  if (a && typeof a.seq === 'number' && a.seq > (S.lastSeq[p.peer] || 0)) {
    S.lastSeq[p.peer] = a.seq;
    const g = T.activeGame(s);
    const valid = g && a.rev === s.rev && a.pid === pl.id && s.seats[pl.id] === p.peer && g.turn.pid === pl.id;
    if (valid) {
      if (a.type === 'roll') setTimeout(() => doRoll(true), 0);
      else if (a.type === 'bank') setTimeout(() => doBank(true), 0);
    }
  }
  return changed;
}
let refetchT = null;
function refetchSoon() {
  clearTimeout(refetchT);
  refetchT = setTimeout(async () => {
    try { const d = await S.db.doc('sessions/' + S.guest.code).get(); if (d.exists) onGuestDoc(d.data()); } catch (e) { /* */ }
  }, 1500);
}
let guestUnsub = null;
async function joinTable(code, name) {
  code = code.trim().toUpperCase(); name = name.trim().slice(0, 24);
  if (!/^[A-Z0-9]{6}$/.test(code)) return toast('Le code fait 6 caractères.');
  if (!name) return toast('Indique ton prénom.');
  lsSet('le3000.guest', { code, name });
  S.mode = 'guest'; S.guest = { code, name, seq: 0, pendingRev: null }; S.session = null; S.guestMissing = false;
  S.view = 'guestwait'; closeModal(); render();
  if (guestUnsub) guestUnsub();
  guestUnsub = S.db.doc('sessions/' + code).onSnapshot((snap) => {
    if (!snap.exists) { S.guestMissing = true; if (S.view === 'guestwait') render(); return; }
    onGuestDoc(snap.data());
  }, () => { toast('La table n’est plus accessible.'); });
  connectRoom(code, 'guest');
}
function onGuestDoc(data) {
  const prev = S.session;
  if (prev && (data.rev || 0) <= (prev.rev || 0)) return;
  const s = JSON.parse(JSON.stringify(data));
  if (!prev) { const lg = lastGame(s); if (lg && lg.status === 'won') S.winSeen = lg.id; if (lg) S.animN = Math.max(0, lg.rollCount - 1); }
  S.session = s; S.guestMissing = false;
  if (S.guest.pendingRev != null && s.rev !== S.guest.pendingRev) S.guest.pendingRev = null;
  if (S.view === 'guestwait') S.view = T.activeGame(s) || s.games.length ? 'game' : 'guestwait';
  const g = lastGame(s);
  if (g && g.rollCount > S.animN && g.log.length && S.view === 'game') {
    const e = g.log[g.log.length - 1]; S.animN = g.rollCount;
    if (e.dice) { animateTo(e.dice, e).then(render); return; }
    S.lastEvent = e;
  }
  if (S.view === 'guestwait' && !s.games.length) S.view = 'guestwait';
  render();
}
function guestAct(type) {
  const s = S.session, g = T.activeGame(s);
  if (!g || !S.room) return;
  S.guest.seq = Math.max(Date.now(), S.guest.seq + 1);
  S.guest.pendingRev = s.rev;
  S.room.presence({ act: { seq: S.guest.seq, type, pid: g.turn.pid, rev: s.rev } }).catch(() => { S.guest.pendingRev = null; toast('Message non envoyé, réessaie.'); render(); });
  render();
  setTimeout(() => { if (S.guest.pendingRev === s.rev && S.session.rev === s.rev) { S.guest.pendingRev = null; render(); } }, 6000);
}

/* ======================= Exports ======================= */
async function saveFile(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  if (S.downloads) {
    try { await S.downloads.save({ filename, data: blob }); toast('Fichier proposé au téléchargement.'); return; }
    catch (e) { if (e && (e.code === 'declined' || e.code === 'cancelled')) return; }
  }
  try {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { toast('Téléchargement impossible ici.'); }
}
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'session';
const eur = (c) => (c / 100).toFixed(2).replace('.', ',');
function csv() {
  const s = S.session, acc = T.accounts(s), q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const L = [];
  L.push(['Session', s.name].map(q).join(';'));
  L.push(['Généré le', dateFr(new Date().toISOString())].map(q).join(';'));
  L.push('');
  L.push(['Joueur', 'Parties', 'Mises', 'Supp. 642', 'Supp. 122', 'Contributions', 'Gains', 'Résultat de jeu', 'Remb. payés', 'Remb. reçus', 'Solde net'].map(q).join(';'));
  for (const p of s.players) { const a = acc[p.id]; L.push([p.name, a.games, eur(a.stakes), eur(a.s642), eur(a.s122), eur(a.contrib), eur(a.wins), eur(a.gameNet), eur(a.paid), eur(a.received), eur(a.balance)].map(q).join(';')); }
  L.push('');
  L.push(['Remboursements à effectuer'].map(q).join(';'));
  L.push(['De', 'À', 'Montant (€)'].map(q).join(';'));
  for (const x of T.settlementPlan(balancesOf(acc))) L.push([player(x.from).name, player(x.to).name, eur(x.cents)].map(q).join(';'));
  L.push('');
  L.push(['Parties'].map(q).join(';'));
  L.push(['N°', 'Date', 'Statut', 'Joueurs', 'Gagnant', 'Cagnotte (€)'].map(q).join(';'));
  for (const g of s.games) L.push([g.no, dateFr(g.date), g.status, g.participants.map((id) => player(id).name).join(', '), g.winner ? player(g.winner).name : '', eur(T.potTotal(g))].map(q).join(';'));
  L.push('');
  L.push(['Opérations'].map(q).join(';'));
  L.push(['Identifiant', 'Date', 'Type', 'Partie', 'Joueur / De', 'À', 'Montant (€)', 'Note'].map(q).join(';'));
  for (const o of s.ledger) L.push([o.id, dateFr(o.date), o.type, o.gameId ? (s.games.find((g) => g.id === o.gameId) || {}).no || '' : '', player(o.pid || o.from).name, o.to ? player(o.to).name : '', eur(o.cents), o.note || ''].map(q).join(';'));
  return '﻿' + L.join('\r\n');
}
function pdf() {
  if (!window.jspdf) { toast('Le module PDF n’a pas pu se charger.'); return null; }
  const s = S.session, acc = T.accounts(s), doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const e = (c) => (c < 0 ? '-' : '') + (Math.abs(c) / 100).toFixed(2).replace('.', ',') + ' €';
  let y = 18; const W = 210, M = 16;
  const line = () => { doc.setDrawColor(200); doc.line(M, y, W - M, y); y += 5; };
  const page = (h) => { if (y + (h || 8) > 282) { doc.addPage(); y = 18; } };
  doc.setFont('helvetica', 'bold'); doc.setFontSize(26); doc.setTextColor(28, 90, 69); doc.text('3000', M, y);
  doc.setFontSize(13); doc.setTextColor(20); doc.text('Bilan financier · ' + s.name, M + 30, y - 1); y += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100);
  doc.text(`Généré le ${dateFr(new Date().toISOString())} · ${settledGames(s).length} parties comptabilisées · session ${s.status === 'closed' ? 'clôturée' : 'en cours'}`, M, y); y += 8;
  doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Soldes', M, y); y += 6;
  const cols = [M, M + 46, M + 66, M + 92, M + 118, M + 144];
  doc.setFontSize(8.5); doc.setTextColor(110);
  ['Joueur', 'Parties', 'Versé', 'Gagné', 'Remb. net', 'Solde'].forEach((h, i) => doc.text(h, cols[i], y)); y += 2; line();
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  for (const p of s.players) {
    const a = acc[p.id]; page();
    doc.setTextColor(20); doc.text(p.name, cols[0], y); doc.text(String(a.games), cols[1], y); doc.text(e(a.contrib), cols[2], y); doc.text(e(a.wins), cols[3], y); doc.text(e(a.paid - a.received), cols[4], y);
    doc.setFont('helvetica', 'bold'); a.balance < 0 ? doc.setTextColor(192, 58, 38) : a.balance > 0 ? doc.setTextColor(29, 128, 72) : doc.setTextColor(90);
    doc.text(e(a.balance), cols[5], y); doc.setFont('helvetica', 'normal'); y += 6;
  }
  y += 4; page(20); doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Qui doit quoi à qui ?', M, y); y += 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
  const plan = T.settlementPlan(balancesOf(acc));
  if (!plan.length) { doc.text('Tous les comptes sont soldés.', M, y); y += 6; }
  for (const x of plan) { page(); doc.text(`${player(x.from).name}  verse  ${e(x.cents)}  à  ${player(x.to).name}`, M, y); y += 6; }
  const pays = s.ledger.filter((o) => o.type === 'payment');
  if (pays.length) {
    y += 4; page(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Remboursements déjà effectués', M, y); y += 7; doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    for (const o of pays) { page(); doc.text(`${dateFr(o.date)}   ${player(o.from).name} -> ${player(o.to).name}   ${e(o.cents)}`, M, y); y += 5.5; }
  }
  y += 4; page(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Parties', M, y); y += 7; doc.setFontSize(10);
  for (const g of s.games.slice().sort((a, b) => a.no - b.no)) {
    page(14); const res = T.gameResult(s, g);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(20);
    const st = { won: 'gagnée par ' + (g.winner ? player(g.winner).name : ''), playing: 'en cours', abandoned: 'interrompue', cancelled: 'annulée' }[g.status];
    doc.text(`Partie ${g.no} · ${dateFr(g.date)} · ${st} · cagnotte ${e(T.potTotal(g))}`, M, y); y += 5.5;
    doc.setFont('helvetica', 'normal'); doc.setTextColor(80); doc.setFontSize(9);
    const parts = g.participants.map((pid) => `${player(pid).name} ${g.settled && g.status !== 'cancelled' ? (res[pid].net > 0 ? '+' : '') + e(res[pid].net) : ''}${res[pid].n642 ? ' (' + res[pid].n642 + 'x642)' : ''}${res[pid].n122 ? ' (' + res[pid].n122 + 'x122)' : ''}`).join('   ');
    const wrapped = doc.splitTextToSize(parts, W - 2 * M);
    for (const w of wrapped) { page(); doc.text(w, M, y); y += 4.6; }
    y += 2; doc.setFontSize(10);
  }
  return doc.output('blob');
}

/* ======================= Événements ======================= */
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id, s = S.session;
  if (act === 'modal-bg') { if (ev.target === b && !b.querySelector('.win')) closeModal(); return; }
  if (b.disabled) return;
  switch (act) {
    case 'home': S.view = 'home'; if (S.mode === 'guest' && guestUnsub) { guestUnsub(); guestUnsub = null; } loadDbSessions().then(render); render(); break;
    case 'sound': S.sound = !S.sound; lsSet('le3000.sound', S.sound); if (S.sound) beep('bank'); render(); break;
    case 'new-local': newSession(false); break;
    case 'new-online': newSession(true); break;
    case 'join-open': {
      const last = lsGet('le3000.guest', {}) || {};
      modal(`<h3>Rejoindre une table</h3><form class="stack" data-form="join"><div class="field"><label class="label" for="j-code">Code de la table</label><input type="text" id="j-code" maxlength="6" autocomplete="off" style="text-transform:uppercase;font-family:var(--display);font-size:1.8rem;letter-spacing:.15em" value="${esc(last.code || '')}" autofocus></div>
        <div class="field"><label class="label" for="j-name">Ton prénom</label><input type="text" id="j-name" maxlength="24" value="${esc(last.name || '')}"></div>
        <p class="muted" style="font-size:.88rem">Utilise le même prénom qu’à la table : si l’hôte t’a déjà inscrit, ton téléphone prend ta place automatiquement.</p>
        <div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-act="modal-close">Annuler</button><button class="btn primary" type="submit">Rejoindre</button></div></form>`);
      break;
    }
    case 'open-session': { const ss = allSessions().find((x) => x.id === id); if (ss) openSession(JSON.parse(JSON.stringify(ss)), ss.online && S.canHost ? 'host' : 'local'); break; }
    case 'restore-open':
      modal(`<h3>Restaurer une sauvegarde</h3><p class="muted">Choisis un fichier de sauvegarde « .json » exporté depuis Le 3000.</p><input type="file" id="restore-file" accept="application/json,.json"><div class="row" style="justify-content:flex-end"><button class="btn" data-act="modal-close">Fermer</button></div>`);
      break;
    case 'modal-close': closeModal(); break;
    case 'confirm-ok': { const cb = confirmCb; confirmCb = null; closeModal(); if (cb) cb(); break; }
    case 'goto-game': S.view = 'game'; render(); break;
    case 'goto-fin': S.view = 'fin'; render(); break;
    case 'goto-setup': S.view = 'setup'; render(); break;
    case 'fintab': S.finTab = id; S.payDraft = null; render(); break;
    case 'ord-up': case 'ord-down': {
      const o = S.setupSel.order, i = o.indexOf(id), j = act === 'ord-up' ? i - 1 : i + 1;
      if (j >= 0 && j < o.length) { [o[i], o[j]] = [o[j], o[i]]; render(); } break;
    }
    case 'toggle-part': S.setupSel.on.has(id) ? S.setupSel.on.delete(id) : S.setupSel.on.add(id); render(); break;
    case 'shuffle': { const o = S.setupSel.order; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } render(); break; }
    case 'start-game': { const nm = $('#sess-name'); if (nm && nm.value.trim()) s.name = nm.value.trim().slice(0, 40); startGame(S.setupSel.order.filter((x) => S.setupSel.on.has(x))); break; }
    case 'roll': S.mode === 'guest' ? guestAct('roll') : doRoll(false); break;
    case 'bank': S.mode === 'guest' ? guestAct('bank') : doBank(false); break;
    case 'override': S.override = id; render(); break;
    case 'abandon': { const g = T.activeGame(s); askInterrupted(g, null); break; }
    case 'int-resume': closeModal(); S.view = 'game'; render(); break;
    case 'int-abandon': { const g = T.activeGame(s); if (g) { g.status = 'abandoned'; g.endedAt = new Date().toISOString(); persist(); } closeModal(); const then = S.afterAbandon; S.afterAbandon = null; if (then) then(); else { S.view = 'fin'; S.finTab = 'history'; render(); } break; }
    case 'resume-game': { if (T.activeGame(s)) return toast('Une autre partie est déjà en cours.'); const g = s.games.find((x) => x.id === id); if (g) { g.status = 'playing'; persist(); S.view = 'game'; render(); } break; }
    case 'new-game-menu': { if (T.activeGame(s)) { askInterrupted(T.activeGame(s), () => { S.view = 'setup'; render(); }); } else { S.view = 'setup'; S.setupSel = null; render(); } break; }
    case 'replay-same': { closeModal(); const g = lastGame(s); startGame(g.participants.slice()); break; }
    case 'replay-diff': closeModal(); S.setupSel = null; S.view = 'setup'; render(); break;
    case 'win-accounts': closeModal(); S.view = 'fin'; S.finTab = 'accounts'; render(); break;
    case 'win-close': closeModal(); S.view = 'fin'; S.finTab = 'close'; render(); break;
    case 'pay-draft': S.payDraft = { i: +id }; render(); { const inp = $('#pay-amt-' + id); if (inp) inp.focus(); } break;
    case 'pay-cancel': S.payDraft = null; render(); break;
    case 'cancel-game': {
      const g = s.games.find((x) => x.id === id);
      ask(`Annuler la partie ${g.no} ?`, `Ses mises, suppléments et son gain seront neutralisés par des contre-écritures. Rien n’est effacé : la trace reste dans l’historique et tous les soldes sont recalculés.`, 'Annuler la partie', () => { T.cancelGame(s, id, 'Annulée manuellement'); persist(); render(); toast(`Partie ${g.no} annulée, soldes recalculés.`); }, true);
      break;
    }
    case 'close-session': ask('Clôturer la session ?', 'L’historique financier est conservé. Plus aucune partie ne pourra être lancée, mais les remboursements restent enregistrables.', 'Clôturer', () => { s.status = 'closed'; s.closedAt = new Date().toISOString(); persist(); render(); toast('Session clôturée.'); }); break;
    case 'reopen': s.status = 'open'; persist(); render(); break;
    case 'exp-csv': saveFile(`3000-${slug(s.name)}.csv`, csv(), 'text/csv;charset=utf-8'); break;
    case 'exp-pdf': { const blob = pdf(); if (blob) saveFile(`3000-${slug(s.name)}.pdf`, blob, 'application/pdf'); break; }
    case 'exp-json': saveFile(`3000-sauvegarde-${slug(s.name)}.json`, JSON.stringify(s, null, 1), 'application/json'); break;
  }
});
document.addEventListener('submit', (ev) => {
  const f = ev.target.closest('[data-form]'); if (!f) return; ev.preventDefault();
  const s = S.session;
  switch (f.dataset.form) {
    case 'add-player': {
      const inp = $('#new-player'); const v = inp.value.trim(); if (!v) return;
      const before = s.players.length; const p = T.addPlayer(s, v);
      if (s.players.length === before) toast(p.name + ' est déjà dans la liste.');
      S.setupSel && S.setupSel.on.add(p.id); persist(); render(); { const n = $('#new-player'); if (n) n.focus(); }
      break;
    }
    case 'join': joinTable($('#j-code').value, $('#j-name').value); break;
    case 'pay-plan': {
      const i = +f.dataset.i, plan = T.settlementPlan(balancesOf(T.accounts(s))), x = plan[i];
      const cents = Math.round(parseFloat(String($('#pay-amt-' + i).value).replace(',', '.')) * 100);
      if (!x || !(cents > 0)) return toast('Montant invalide.');
      if (cents > x.cents) return toast('Le montant dépasse la dette : ' + money(x.cents) + '.');
      ask('Confirmer le remboursement', `${pname(x.from)} a bien versé <b>${money(cents)}</b> à ${pname(x.to)} ?`, 'Oui, c’est payé', () => { T.recordPayment(s, x.from, x.to, cents, cents < x.cents ? 'partiel' : ''); S.payDraft = null; persist(); render(); toast('Remboursement enregistré.'); });
      break;
    }
    case 'pay-free': {
      const from = $('#pf-from').value, to = $('#pf-to').value;
      const cents = Math.round(parseFloat(String($('#pf-amt').value).replace(',', '.')) * 100);
      if (from === to) return toast('Choisis deux joueurs différents.');
      if (!(cents > 0)) return toast('Indique un montant positif.');
      ask('Confirmer le remboursement', `${pname(from)} a bien versé <b>${money(cents)}</b> à ${pname(to)} ?`, 'Oui, c’est payé', () => { T.recordPayment(s, from, to, cents, 'saisie libre'); persist(); S.finTab = 'accounts'; render(); toast('Remboursement enregistré.'); });
      break;
    }
  }
});
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.id === 'upto') { S.upto = +t.value; render(); }
  if (t.id === 'sess-name' && S.session && t.value.trim()) { S.session.name = t.value.trim().slice(0, 40); persist(); }
  if (t.id === 'restore-file' && t.files && t.files[0]) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d || !Array.isArray(d.players) || !Array.isArray(d.games) || !Array.isArray(d.ledger)) throw new Error('format');
        d.seats = d.seats || {}; d.rev = (d.rev || 0);
        closeModal(); S.session = d; persist(); openSession(d, d.online && S.canHost ? 'host' : 'local'); toast('Session restaurée.');
      } catch (e) { toast('Ce fichier n’est pas une sauvegarde valide du 3000.'); }
    };
    r.readAsText(t.files[0]);
  }
});
document.addEventListener('toggle', (ev) => { const d = ev.target; if (d.matches && d.matches('details.gm')) S.openGame = d.open ? d.dataset.gid : (S.openGame === d.dataset.gid ? null : S.openGame); }, true);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && $('#layer .overlay') && !$('#layer .win')) closeModal();
  if (S.view !== 'game' || $('#layer .overlay') || /input|select|textarea/i.test(ev.target.tagName)) return;
  if (ev.key === ' ' || ev.key === 'Enter') { const b = $('[data-act="roll"]'); if (b && !b.disabled && ev.target === document.body) { ev.preventDefault(); b.click(); } }
  if (ev.key === 'b' || ev.key === 'B') { const b = $('[data-act="bank"]'); if (b && !b.disabled) b.click(); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.view === 'game') wakeLock(); });

/* ======================= Démarrage ======================= */
render();
initCaps();
window.__le3000 = { S, T };
})();
