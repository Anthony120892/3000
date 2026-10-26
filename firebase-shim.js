/* ==========================================================================
   LE 3000 — pont Firebase pour l'hébergement hors claude.ai (Vercel…)
   Expose window.claude.use("db" | "room" | "user") avec la même forme que
   claude.ai, en s'appuyant sur Firestore + connexion anonyme.
   ========================================================================== */
(function () {
  'use strict';
  const cfg = window.FIREBASE_CONFIG;
  const configured = !!(cfg && cfg.apiKey && cfg.projectId && !/A_REMPLACER/.test(cfg.apiKey) && window.firebase);
  if (!configured) {
    window.LE3000_OFFLINE_MSG = 'Le jeu sur plusieurs téléphones s’active dès que la base en ligne (Firebase) est configurée. Le jeu sur un seul appareil fonctionne déjà.';
    window.claude = { use: async () => null };
    return;
  }
  firebase.initializeApp(cfg);
  const fs = firebase.firestore();
  const FV = firebase.firestore.FieldValue;
  const authP = firebase.auth().signInAnonymously().then((c) => c.user.uid).catch((e) => {
    console.warn('Auth anonyme', e);
    const code = (e && e.code) || 'inconnu';
    const hint = {
      'auth/admin-restricted-operation': 'la connexion « Anonyme » n’est pas activée dans Firebase Authentication',
      'auth/operation-not-allowed': 'la connexion « Anonyme » n’est pas activée dans Firebase Authentication',
      'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'la clé apiKey de firebase-config.js est incorrecte',
      'auth/invalid-api-key': 'la clé apiKey de firebase-config.js est incorrecte',
      'auth/unauthorized-domain': 'ce domaine n’est pas dans les domaines autorisés de Firebase Authentication',
      'auth/network-request-failed': 'le réseau bloque l’accès à Firebase'
    }[code];
    window.LE3000_OFFLINE_MSG = 'Jeu en ligne indisponible : ' + (hint || 'connexion à Firebase refusée') + ' (code ' + code + '). Le jeu sur un seul appareil fonctionne.';
    return null;
  });
  const mapErr = (e) => ({ code: ({ 'permission-denied': 'invalid_argument', 'resource-exhausted': 'quota_exceeded', unavailable: 'unavailable', unauthenticated: 'invalid_argument' })[e && e.code] || 'unavailable', message: (e && e.message) || '' });

  /* ---------- db : sessions/<code> -> tables/<code> {hostUid, ownerId, rev, json} ---------- */
  function sessRef(path) {
    const m = /^sessions\/([A-Za-z0-9]{1,40})$/.exec(path);
    if (!m) throw new TypeError('Chemin non pris en charge : ' + path);
    return fs.collection('tables').doc(m[1]);
  }
  const unpack = (snap) => ({
    id: snap.id, exists: snap.exists, metadata: { fromCache: false, hasPendingWrites: false },
    data: () => { if (!snap.exists) return undefined; try { return JSON.parse(snap.data().json); } catch (e) { return undefined; } }
  });
  const db = Object.freeze({
    doc(path) {
      const ref = sessRef(path);
      return {
        id: ref.id, path,
        get: async () => { try { return unpack(await ref.get()); } catch (e) { throw mapErr(e); } },
        set: async (data) => {
          const uid = await authP; if (!uid) throw { code: 'invalid_argument', message: 'Non connecté' };
          try { await ref.set({ hostUid: uid, ownerId: data.ownerId || uid, rev: data.rev || 0, updatedAt: FV.serverTimestamp(), json: JSON.stringify(data) }); }
          catch (e) { throw mapErr(e); }
        },
        onSnapshot(next, err) {
          let unsub = () => {}, dead = false;
          authP.then(() => { if (dead) return; unsub = ref.onSnapshot((s) => next(unpack(s)), (e) => err && err({ code: 'revoked', message: e.message })); });
          return () => { dead = true; unsub(); };
        }
      };
    },
    collection() {
      let q = fs.collection('tables');
      const api = {
        where(f, op, v) { q = q.where(f, op, v); return api; },
        limit(n) { q = q.limit(n); return api; },
        async get() { await authP; try { const r = await q.get(); return { docs: r.docs.map(unpack) }; } catch (e) { throw mapErr(e); } }
      };
      return api;
    }
  });

  /* ---------- room : présence par table, tables/<code>/presence/<uid> ---------- */
  const STALE_MS = 50000, BEAT_MS = 15000;
  function makeRoom(code) {
    const col = fs.collection('tables').doc(code).collection('presence');
    let uid = null, mine = {}, docs = {}, unsub = null, timer = null, isConnected = false;
    const subs = new Set(), connSubs = new Set();
    const write = async () => {
      uid = uid || await authP; if (!uid) throw { code: 'not_granted', message: 'Non connecté' };
      await col.doc(uid).set({ json: JSON.stringify(mine), atc: Date.now(), at: FV.serverTimestamp() });
    };
    const list = () => {
      const now = Date.now();
      return Object.keys(docs).filter((id) => id === uid || now - docs[id].atc < STALE_MS).map((id) => Object.freeze({
        peer: id, by: id, isMe: id === uid, sameTab: id === uid, kind: 'viewer', guest: false,
        presence: Object.freeze(id === uid ? Object.assign({}, docs[id].p, mine) : docs[id].p), updatedAt: docs[id].atc
      }));
    };
    const notify = () => { const peers = list(); subs.forEach((f) => { try { f({ peers, joined: [], left: [], updated: [] }); } catch (e) { console.error(e); } }); };
    const setConn = (v) => { if (v !== isConnected) { isConnected = v; connSubs.forEach((f) => f(v)); } };
    const start = authP.then((u) => {
      uid = u; if (!uid) return;
      unsub = col.onSnapshot((s) => {
        const next = {};
        s.forEach((d) => { const v = d.data(); let p = {}; try { p = JSON.parse(v.json || '{}'); } catch (e) { /* */ } next[d.id] = { p, atc: v.atc || 0 }; });
        docs = next; setConn(true); notify();
      }, () => setConn(false));
      timer = setInterval(() => { write().catch(() => {}); notify(); }, BEAT_MS);
      window.addEventListener('pagehide', () => { col.doc(uid).delete().catch(() => {}); });
    });
    return Object.freeze({
      name: 't-' + code.toLowerCase(),
      async presence(patch) {
        await start;
        for (const k in patch) { if (patch[k] === null) delete mine[k]; else mine[k] = patch[k]; }
        try { await write(); } catch (e) { throw mapErr(e); }
        notify();
      },
      onPeers(f) { subs.add(f); setTimeout(() => f({ peers: list(), joined: [], left: [], updated: [] }), 0); return () => subs.delete(f); },
      peers: list,
      connected: () => isConnected,
      onConnection(f) { connSubs.add(f); setTimeout(() => f(isConnected), 0); return () => connSubs.delete(f); },
      emit: async () => {}, on: () => () => {},
      async leave() { clearInterval(timer); if (unsub) unsub(); subs.clear(); if (uid) await col.doc(uid).delete().catch(() => {}); }
    });
  }
  const rooms = {};
  const room = Object.freeze({
    async join(name) {
      const code = String(name).replace(/^t-/, '').toUpperCase();
      if (!/^[A-Z0-9]{1,40}$/.test(code)) throw { code: 'invalid_argument', message: 'Nom de table invalide' };
      return (rooms[code] = rooms[code] || makeRoom(code));
    },
    presence: async () => {}, onPeers: () => () => {}, peers: () => [], connected: () => false, emit: async () => {}, on: () => () => {}
  });

  const user = Object.freeze({
    id: () => authP,
    can: async () => ((await authP) ? true : false),
    isOwner: async () => true, canEdit: async () => true
  });

  const caps = { db, room, user };
  window.claude = { use: async (n) => { if (!caps[n]) return null; const ok = await authP; return ok ? caps[n] : null; } };
})();
