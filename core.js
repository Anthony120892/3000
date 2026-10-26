/* ==========================================================================
   LE 3000 — moteur de jeu + comptabilité (pur, sans DOM, testable)
   ========================================================================== */
(function (root) {
  'use strict';

  /* ---------- Configuration : points à confirmer isolés ici ---------- */
  const CONFIG = {
    TARGET: 3000,
    BANK_THRESHOLD: 300,          // blocage interdit si 0 < théorique < 300 (300 pile autorisé, règle de table)
    STAKE_CENTS: 500,             // mise initiale par partie
    P642: { penalty: 250, cents: 250 },
    P122: { penalty: 500, cents: 500 },
    BRELAN_POINTS: 1000,
    P432_POINTS: 250,
    // 421 : relance obligatoire (pas de blocage). ⚠ À confirmer : il garde les points
    // ordinaires de son 1 (100). Mettre 0 si le 421 ne rapporte rien.
    P421_POINTS: 100,
    // ⚠ À confirmer : le 432 impose de bloquer. Si le total théorique tombe
    // entre 1 et 300, on bloque quand même (la règle spéciale prime, §6 ex. 5).
    // false = les points du 432 sont alors perdus.
    P432_BYPASSES_THRESHOLD: true,
    // ⚠ À confirmer : un lancer qui amène le total théorique à 3000 pile fait
    // gagner immédiatement (§7), même juste après un brelan.
    WIN_ON_EXACT_AFTER_ROLL: true,
    // ⚠ À confirmer : le dépassement de 3000 est vérifié dès le lancer (§11 étape 8).
    BUST_CHECK_ON_ROLL: true,
    // Il faut avoir marqué au moins une fois dans le tour pour bloquer.
    REQUIRE_SCORING_ROLL_TO_BANK: true,
    LOG_KEEP: 60
  };

  const uid = (p) => (p || '') + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

  /* ---------- Évaluation d'un lancer ---------- */
  function evaluate(dice) {
    const s = dice.slice().sort((a, b) => a - b).join('');
    if (s === '246') return { kind: '642', points: 0, label: '642' };
    if (s === '122') return { kind: '122', points: 0, label: '122' };
    if (s === '234') return { kind: '432', points: CONFIG.P432_POINTS, label: '432' };
    if (s === '124') return { kind: '421', points: CONFIG.P421_POINTS, label: '421' };
    if (dice[0] === dice[1] && dice[1] === dice[2])
      return { kind: 'brelan', points: CONFIG.BRELAN_POINTS, label: 'Brelan de ' + dice[0] };
    let pts = 0;
    for (const d of dice) { if (d === 1) pts += 100; else if (d === 5) pts += 50; }
    return pts > 0 ? { kind: 'points', points: pts, label: '+' + pts } : { kind: 'zero', points: 0, label: 'Rien' };
  }

  function rollDice(rng) {
    const r = rng || (() => {
      if (root.crypto && root.crypto.getRandomValues) {
        const a = new Uint32Array(1); root.crypto.getRandomValues(a); return a[0] / 4294967296;
      }
      return Math.random();
    });
    return [0, 0, 0].map(() => 1 + Math.floor(r() * 6));
  }

  /* ---------- Partie ---------- */
  function newGame(session, participantIds) {
    const no = (session.games.reduce((m, g) => Math.max(m, g.no), 0)) + 1;
    const g = {
      id: uid('g'), no, date: new Date().toISOString(), status: 'playing',
      participants: participantIds.slice(),
      scores: {}, pot: {}, supp: {}, winner: null, settled: false,
      cur: 0, turn: null, log: [], rollCount: 0, last: null
    };
    for (const pid of participantIds) {
      g.scores[pid] = 0; g.pot[pid] = CONFIG.STAKE_CENTS; g.supp[pid] = { n642: 0, n122: 0 };
    }
    startTurn(g);
    session.games.push(g);
    return g;
  }

  function startTurn(g) {
    g.turn = { pid: g.participants[g.cur], temp: 0, mustConfirm: false, scored: false, rolls: 0 };
  }

  function activeGame(session) {
    for (let i = session.games.length - 1; i >= 0; i--) if (session.games[i].status === 'playing') return session.games[i];
    return null;
  }

  function theoretical(g) { return g.scores[g.turn.pid] + g.turn.temp; }

  /** Pourquoi le blocage est-il refusé ? null = autorisé. */
  function bankBlockReason(g) {
    if (!g || g.status !== 'playing') return 'Partie terminée.';
    const t = g.turn;
    if (t.rolls === 0) return 'Lance d’abord les dés.';
    if (t.mustConfirm) return (t.confirmWhy === '421' ? '421' : 'Brelan') + ' : une relance est obligatoire.';
    if (CONFIG.REQUIRE_SCORING_ROLL_TO_BANK && !t.scored) return 'Aucun point à bloquer.';
    const th = theoretical(g);
    if (th > 0 && th < CONFIG.BANK_THRESHOLD)
      return `Total théorique ${th} : il faut au moins ${CONFIG.BANK_THRESHOLD} points pour bloquer.`;
    return null;
  }

  function pushLog(g, e) {
    g.log.push(e);
    if (g.log.length > CONFIG.LOG_KEEP) g.log.splice(0, g.log.length - CONFIG.LOG_KEEP);
  }

  function endTurn(g) {
    if (g.status !== 'playing') return;
    g.cur = (g.cur + 1) % g.participants.length;
    startTurn(g);
  }

  function win(session, g, pid) {
    g.status = 'won'; g.winner = pid; g.endedAt = new Date().toISOString();
    settleGame(session, g);
  }

  /**
   * Applique un lancer. Retourne l'événement (pour l'affichage).
   * outcome : 'continue' | 'penalty' | 'lost' | 'bust' | 'banked' | 'win'
   */
  function applyRoll(session, g, dice) {
    if (!g || g.status !== 'playing') throw new Error('Aucune partie en cours');
    const t = g.turn, pid = t.pid;
    const ev = evaluate(dice);
    const before = g.scores[pid];
    const tempBefore = t.temp;
    t.rolls++; g.rollCount++;
    const e = { n: g.rollCount, pid, dice: dice.slice(), kind: ev.kind, label: ev.label, gained: 0,
      penalty: 0, cents: 0, lostTemp: 0, outcome: 'continue', at: Date.now() };

    const finishExactOrBust = () => {
      const th = theoretical(g);
      if (CONFIG.BUST_CHECK_ON_ROLL && th > CONFIG.TARGET) {
        e.lostTemp = t.temp; e.outcome = 'bust'; t.temp = 0; endTurn(g); return true;
      }
      if (CONFIG.WIN_ON_EXACT_AFTER_ROLL && th === CONFIG.TARGET) {
        g.scores[pid] = th; t.temp = 0; e.outcome = 'win'; win(session, g, pid); return true;
      }
      return false;
    };

    if (ev.kind === '642' || ev.kind === '122') {
      const P = ev.kind === '642' ? CONFIG.P642 : CONFIG.P122;
      g.scores[pid] = before - P.penalty;
      g.pot[pid] += P.cents;
      g.supp[pid][ev.kind === '642' ? 'n642' : 'n122']++;
      e.penalty = P.penalty; e.cents = P.cents; e.lostTemp = tempBefore; e.outcome = 'penalty';
      t.temp = 0;
      pushLog(g, e); endTurn(g); return e;
    }
    if (ev.kind === 'zero') {
      e.lostTemp = tempBefore; e.outcome = 'lost'; t.temp = 0;
      pushLog(g, e); endTurn(g); return e;
    }
    // points, brelan, 432 : on ajoute au compteur temporaire
    t.temp += ev.points; t.scored = true; e.gained = ev.points;
    t.mustConfirm = ev.kind === 'brelan' || ev.kind === '421';
    t.confirmWhy = t.mustConfirm ? ev.kind : null;
    if (finishExactOrBust()) { pushLog(g, e); return e; }

    if (ev.kind === '432') {
      const th = theoretical(g);
      if (th > CONFIG.TARGET) { e.lostTemp = t.temp; e.outcome = 'bust'; t.temp = 0; }
      else if (th > 0 && th < CONFIG.BANK_THRESHOLD && !CONFIG.P432_BYPASSES_THRESHOLD) {
        e.lostTemp = t.temp; e.outcome = 'lost'; t.temp = 0;
      } else {
        g.scores[pid] = th; e.outcome = 'banked'; t.temp = 0;
        if (th === CONFIG.TARGET) { e.outcome = 'win'; pushLog(g, e); win(session, g, pid); return e; }
      }
      pushLog(g, e); endTurn(g); return e;
    }
    pushLog(g, e);
    return e;
  }

  function bank(session, g) {
    const why = bankBlockReason(g);
    if (why) throw new Error(why);
    const t = g.turn, pid = t.pid, th = theoretical(g);
    const e = { n: ++g.rollCount, pid, dice: null, kind: 'bank', label: 'Bloque', gained: t.temp,
      penalty: 0, cents: 0, lostTemp: 0, outcome: 'banked', at: Date.now() };
    if (th > CONFIG.TARGET) { e.outcome = 'bust'; e.lostTemp = t.temp; e.gained = 0; t.temp = 0; pushLog(g, e); endTurn(g); return e; }
    g.scores[pid] = th; t.temp = 0;
    if (th === CONFIG.TARGET) { e.outcome = 'win'; pushLog(g, e); win(session, g, pid); return e; }
    pushLog(g, e); endTurn(g); return e;
  }

  /* ======================= Comptabilité ======================= */
  function potTotal(g) { return Object.values(g.pot).reduce((a, b) => a + b, 0); }

  function hasOp(session, id) { return session.ledger.some((o) => o.id === id); }
  function addOp(session, op) {
    if (hasOp(session, op.id)) return false;      // jamais deux fois
    session.ledger.push(op); return true;
  }

  /** Enregistre mises, suppléments et gain d'une partie gagnée. Idempotent. */
  function settleGame(session, g) {
    if (g.settled || g.status !== 'won' || !g.winner) return false;
    const date = g.endedAt || new Date().toISOString();
    for (const pid of g.participants) {
      addOp(session, { id: `${g.id}:stake:${pid}`, type: 'stake', gameId: g.id, pid, cents: CONFIG.STAKE_CENTS, date });
      const s = g.supp[pid];
      if (s.n642) addOp(session, { id: `${g.id}:s642:${pid}`, type: 'supp642', gameId: g.id, pid, cents: s.n642 * CONFIG.P642.cents, count: s.n642, date });
      if (s.n122) addOp(session, { id: `${g.id}:s122:${pid}`, type: 'supp122', gameId: g.id, pid, cents: s.n122 * CONFIG.P122.cents, count: s.n122, date });
    }
    addOp(session, { id: `${g.id}:win`, type: 'win', gameId: g.id, pid: g.winner, cents: potTotal(g), date });
    g.settled = true;
    return true;
  }

  /** Annule une partie déjà comptabilisée : contre-écritures, trace conservée. */
  function cancelGame(session, gameId, reason) {
    const g = session.games.find((x) => x.id === gameId);
    if (!g) return false;
    if (g.status === 'cancelled') return false;
    const date = new Date().toISOString();
    for (const op of session.ledger.filter((o) => o.gameId === gameId && o.type !== 'reversal')) {
      addOp(session, { id: `${op.id}:rev`, type: 'reversal', of: op.id, gameId, pid: op.pid, cents: op.cents, date, note: reason || 'Partie annulée' });
    }
    g.prevStatus = g.status; g.status = 'cancelled'; g.cancelReason = reason || ''; g.cancelledAt = date;
    return true;
  }

  function recordPayment(session, from, to, cents, note) {
    cents = Math.round(cents);
    if (!(cents > 0)) throw new Error('Montant invalide');
    if (from === to) throw new Error('Payeur et bénéficiaire identiques');
    const op = { id: uid('pay'), type: 'payment', from, to, cents, date: new Date().toISOString(), sessionId: session.id, note: note || '' };
    addOp(session, op); return op;
  }

  /** Effet net d'une opération sur le solde de chaque joueur (centimes). */
  function opEffect(op, byId) {
    switch (op.type) {
      case 'stake': case 'supp642': case 'supp122': return { [op.pid]: -op.cents };
      case 'win': return { [op.pid]: op.cents };
      case 'payment': return { [op.from]: op.cents, [op.to]: -op.cents };
      case 'reversal': {
        const o = byId[op.of]; if (!o) return {};
        const eff = opEffect(o, byId), r = {};
        for (const k in eff) r[k] = -eff[k];
        return r;
      }
    }
    return {};
  }

  /** Compte détaillé par joueur, éventuellement limité aux N premières parties. */
  function accounts(session, opts) {
    opts = opts || {};
    const byId = {}; session.ledger.forEach((o) => (byId[o.id] = o));
    const reversed = new Set(session.ledger.filter((o) => o.type === 'reversal').map((o) => o.of));
    let allowedGames = null;
    if (opts.uptoGames) {
      const done = session.games.filter((g) => g.settled && g.status !== 'cancelled').sort((a, b) => a.no - b.no);
      allowedGames = new Set(done.slice(0, opts.uptoGames).map((g) => g.id));
    }
    const acc = {};
    for (const p of session.players) acc[p.id] = { pid: p.id, games: 0, stakes: 0, s642: 0, s122: 0, n642: 0, n122: 0, contrib: 0, wins: 0, gameNet: 0, paid: 0, received: 0, balance: 0 };
    const gamesBy = {};
    for (const op of session.ledger) {
      if (op.type === 'reversal' || reversed.has(op.id)) continue;   // annulées = neutres, mais tracées
      if (op.gameId && allowedGames && !allowedGames.has(op.gameId)) continue;
      if (op.type === 'payment' && opts.excludePayments) continue;
      const a = acc[op.pid] || acc[op.from];
      switch (op.type) {
        case 'stake': a.stakes += op.cents; a.contrib += op.cents; (gamesBy[op.pid] = gamesBy[op.pid] || new Set()).add(op.gameId); break;
        case 'supp642': a.s642 += op.cents; a.n642 += op.count || 0; a.contrib += op.cents; break;
        case 'supp122': a.s122 += op.cents; a.n122 += op.count || 0; a.contrib += op.cents; break;
        case 'win': a.wins += op.cents; break;
        case 'payment': if (acc[op.from]) acc[op.from].paid += op.cents; if (acc[op.to]) acc[op.to].received += op.cents; break;
      }
    }
    for (const id in acc) {
      const a = acc[id];
      a.games = gamesBy[id] ? gamesBy[id].size : 0;
      a.gameNet = a.wins - a.contrib;
      a.balance = a.gameNet + a.paid - a.received;
    }
    return acc;
  }

  /** Remboursements minimisant le nombre de transactions (exacts d'abord, puis glouton). */
  function settlementPlan(balances) {
    const cred = [], debt = [];
    for (const pid in balances) {
      const b = balances[pid];
      if (b > 0) cred.push({ pid, amt: b });
      else if (b < 0) debt.push({ pid, amt: -b });
    }
    const out = [];
    // 1) paires exactes
    for (const d of debt) {
      const c = cred.find((c) => c.amt === d.amt && c.amt > 0);
      if (c && d.amt > 0) { out.push({ from: d.pid, to: c.pid, cents: d.amt }); c.amt = 0; d.amt = 0; }
    }
    // 2) glouton : plus gros débiteur -> plus gros créancier
    for (;;) {
      const D = debt.filter((x) => x.amt > 0).sort((a, b) => b.amt - a.amt)[0];
      const C = cred.filter((x) => x.amt > 0).sort((a, b) => b.amt - a.amt)[0];
      if (!D || !C) break;
      const m = Math.min(D.amt, C.amt);
      out.push({ from: D.pid, to: C.pid, cents: m });
      D.amt -= m; C.amt -= m;
    }
    return out;
  }

  /** Résultat financier détaillé d'une partie. */
  function gameResult(session, g) {
    const res = {};
    for (const pid of g.participants) {
      const s = g.supp[pid];
      const contrib = CONFIG.STAKE_CENTS + s.n642 * CONFIG.P642.cents + s.n122 * CONFIG.P122.cents;
      const gain = g.winner === pid ? potTotal(g) : 0;
      res[pid] = { contrib, gain, net: gain - contrib, n642: s.n642, n122: s.n122 };
    }
    return res;
  }

  function newSession(name) {
    return { v: 1, id: code6(), name: name || 'Soirée 3000', createdAt: new Date().toISOString(),
      status: 'open', players: [], games: [], ledger: [], seats: {}, online: false, rev: 0, log: [] };
  }
  function code6() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
    for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  function addPlayer(session, name) {
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) throw new Error('Prénom manquant');
    const ex = session.players.find((p) => p.name.toLowerCase() === clean.toLowerCase());
    if (ex) return ex;
    const PAL = ['#e4572e', '#2e86ab', '#f2a541', '#7b4fb0', '#3bb273', '#d1495b', '#00798c', '#c8963e', '#5c6bc0', '#8d6e63'];
    const p = { id: uid('p'), name: clean, color: PAL[session.players.length % PAL.length] };
    session.players.push(p); return p;
  }

  const fmt = (c) => (c < 0 ? '−' : '') + (Math.abs(c) / 100).toFixed(2).replace('.', ',') + ' €';

  root.T3K = { CONFIG, evaluate, rollDice, newGame, activeGame, theoretical, bankBlockReason, applyRoll, bank,
    endTurn, settleGame, cancelGame, recordPayment, accounts, settlementPlan, gameResult, potTotal,
    newSession, addPlayer, uid, fmt, code6, opEffect };
})(typeof globalThis !== 'undefined' ? globalThis : this);
