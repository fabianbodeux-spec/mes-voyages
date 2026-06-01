// ═══════════════════════════════════════════════════════════════════════════
//  CENTRE DE COMMANDEMENT (cockpit) — module autonome
// ───────────────────────────────────────────────────────────────────────────
//  Tableau de bord interne INDÉPENDANT de l'application CrewiGo.
//  Tout le code du cockpit vit ici (page HTML, auth dédiée, API stats) afin de
//  ne JAMAIS mélanger sa logique avec celle de l'app dans server.js.
//
//  Front associé : public/cockpit/index.html + public/cockpit/cockpit.js
//
//  Sécurité :
//   - Accès protégé par un mot de passe DÉDIÉ (≠ comptes utilisateurs), via la
//     variable d'environnement COCKPIT_PASSWORD. En prod, tant qu'elle n'est pas
//     définie, le cockpit reste fermé (login → 503). En local, mot de passe de
//     dev par défaut ('cockpit-dev') pour la prévisualisation.
//   - JWT à scope 'cockpit', signé avec le JWT_SECRET de l'app, expiration 7 j.
//   - Comparaison du mot de passe à temps constant (crypto.timingSafeEqual).
//   - API en LECTURE SEULE : aucune route ne modifie les données CrewiGo.
//
//  Montage depuis server.js :
//   require('./cockpit')(app, { db, IS_CLOUD, JWT_SECRET, checkAuthRate, publicDir });
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const path   = require('path');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

/**
 * Enregistre toutes les routes du Centre de Commandement sur l'app Express.
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {object}  deps.db            - couche d'accès données (database.js)
 * @param {boolean} deps.IS_CLOUD      - true en prod (PostgreSQL), false en local (JSON)
 * @param {string}  deps.JWT_SECRET    - secret de signature JWT (partagé avec l'app)
 * @param {Function} deps.checkAuthRate - rate-limiter par IP (retourne false si dépassé)
 * @param {string}  deps.publicDir     - chemin absolu du dossier /public
 */
module.exports = function mountCockpit(app, deps) {
  const { db, IS_CLOUD, JWT_SECRET, checkAuthRate, publicDir } = deps;

  const COCKPIT_PASSWORD = process.env.COCKPIT_PASSWORD || (IS_CLOUD ? null : 'cockpit-dev');

  // Cache court des stats : ~30 requêtes SQL par appel × auto-refresh 60s × onglets ouverts.
  // Un cache module-level de 30 s absorbe l'essentiel de la charge (lecture seule, données agrégées).
  const STATS_CACHE_MS = 30000;
  let _statsCache = null, _statsCacheAt = 0;

  // ── Middleware : JWT à scope 'cockpit' (indépendant des comptes utilisateurs) ──
  function cockpitAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Non authentifié' });
    try {
      const payload = jwt.verify(header.split(' ')[1], JWT_SECRET);
      if (payload.scope !== 'cockpit') return res.status(403).json({ error: 'Accès refusé' });
      req.cockpit = true;
      next();
    } catch { return res.status(401).json({ error: 'Session expirée' }); }
  }

  // ── Page : coquille HTML (les données restent protégées par mot de passe côté API) ──
  app.get('/cockpit', (req, res) => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Content-Type':  'text/html; charset=utf-8'
    });
    res.sendFile(path.join(publicDir, 'cockpit', 'index.html'), { etag: false, lastModified: false });
  });

  // ── Login : compare au mot de passe dédié (comparaison à temps constant) ──
  app.post('/api/cockpit/login', (req, res) => {
    if (!checkAuthRate(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 15 min' });
    if (!COCKPIT_PASSWORD) return res.status(503).json({ error: 'Cockpit non configuré (variable COCKPIT_PASSWORD manquante).' });
    const pwd = String(req.body?.password || '');
    const a = Buffer.from(pwd), b = Buffer.from(COCKPIT_PASSWORD);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect' });
    const token = jwt.sign({ scope: 'cockpit' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  });

  // ── Stats globales agrégées (tous voyages confondus) — LECTURE SEULE ──
  app.get('/api/cockpit/stats', cockpitAuth, async (req, res) => {
    try {
      // Sert le cache s'il est encore frais (sauf ?fresh=1 pour forcer le recalcul)
      if (_statsCache && req.query.fresh !== '1' && (Date.now() - _statsCacheAt) < STATS_CACHE_MS) {
        return res.json(_statsCache);
      }
      // Mémorise le payload puis l'envoie (un seul point de sortie pour les deux chemins PG/JSON)
      const serve = (payload) => { _statsCache = payload; _statsCacheAt = Date.now(); return res.json(payload); };

      const dayStr = (off = 0) => new Date(Date.now() - off * 86400000).toISOString().slice(0, 10);
      const c7 = dayStr(7), c14 = dayStr(14), c30 = dayStr(30);
      const pct = (a, b) => b > 0 ? Math.round((a / b) * 100) : 0;

      if (IS_CLOUD && db._pool) {
        // .catch logge l'erreur (au lieu de l'avaler en silence) puis renvoie [] :
        // une requête cassée affiche 0 mais laisse une trace serveur pour debug.
        const q = (sql, params = []) => db._pool.query(sql, params).then(r => r.rows)
          .catch(e => { console.warn('[COCKPIT sql]', e.message); return []; });
        const n = (rows, key = 'count', i = 0) => rows[i] ? (parseFloat(rows[i][key]) || 0) : 0;
        const [
          vStatut, partTot, orgTot, msgTot, docTot, attrTot, depAgg, pushTot,
          vWeek, pWeek, mWeek, oWeek,
          vPrev, pPrev, mPrev,
          actifs7, attrVoy, docVoy, depVoy, vTot,
          orgMulti, avgPart, msgMed, partMed,
          vSeries, mSeries, pSeries, orgList,
          inviteTot, inviteWeek, invitePrev
        ] = await Promise.all([
          q(`SELECT COALESCE(NULLIF(statut,''),'actif') s, COUNT(*) count FROM voyages GROUP BY 1`),
          q(`SELECT COUNT(*) count FROM participants`),
          q(`SELECT COUNT(*) count FROM users`),
          q(`SELECT COUNT(*) count FROM commentaires`),
          q(`SELECT COUNT(*) count FROM documents`),
          q(`SELECT COUNT(*) count FROM attributions`),
          q(`SELECT COUNT(*) count, COALESCE(SUM(montant),0) sum FROM depenses`),
          q(`SELECT COUNT(*) count FROM push_subscriptions`),
          q(`SELECT COUNT(*) count FROM voyages WHERE created_at >= $1`, [c7]),
          q(`SELECT COUNT(*) count FROM participants WHERE created_at >= $1`, [c7]),
          q(`SELECT COUNT(*) count FROM commentaires WHERE created_at >= $1`, [c7]),
          q(`SELECT COUNT(*) count FROM users WHERE created_at >= $1`, [c7]),
          q(`SELECT COUNT(*) count FROM voyages      WHERE created_at >= $1 AND created_at < $2`, [c14, c7]),
          q(`SELECT COUNT(*) count FROM participants WHERE created_at >= $1 AND created_at < $2`, [c14, c7]),
          q(`SELECT COUNT(*) count FROM commentaires WHERE created_at >= $1 AND created_at < $2`, [c14, c7]),
          q(`SELECT COUNT(DISTINCT voyage_id) count FROM (
               SELECT voyage_id FROM commentaires WHERE created_at >= $1
               UNION SELECT voyage_id FROM participants WHERE created_at >= $1
               UNION SELECT voyage_id FROM documents   WHERE created_at >= $1) u`, [c7]),
          q(`SELECT COUNT(DISTINCT voyage_id) count FROM attributions`),
          q(`SELECT COUNT(DISTINCT voyage_id) count FROM documents`),
          q(`SELECT COUNT(DISTINCT voyage_id) count FROM depenses`),
          q(`SELECT COUNT(*) count FROM voyages`),
          q(`SELECT COUNT(*) FILTER (WHERE c>=2) multi, COUNT(*) total
               FROM (SELECT owner_id, COUNT(*) c FROM voyages WHERE owner_id IS NOT NULL GROUP BY owner_id) t`),
          q(`SELECT COALESCE(AVG(c),0) avg FROM (SELECT voyage_id, COUNT(*) c FROM participants GROUP BY voyage_id) t`),
          q(`SELECT COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY c),0) med
               FROM (SELECT voyage_id, COUNT(*) c FROM commentaires GROUP BY voyage_id) t`),
          q(`SELECT COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY c),0) med
               FROM (SELECT voyage_id, COUNT(*) c FROM participants GROUP BY voyage_id) t`),
          q(`SELECT substring(created_at,1,10) d, COUNT(*) n FROM voyages      WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, [c30]),
          q(`SELECT substring(created_at,1,10) d, COUNT(*) n FROM commentaires WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, [c30]),
          q(`SELECT substring(created_at,1,10) d, COUNT(*) n FROM participants WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, [c30]),
          q(`SELECT u.email, COUNT(v.id) voyages, MAX(v.created_at) last_voyage
               FROM users u JOIN voyages v ON v.owner_id = u.id
               GROUP BY u.id, u.email
               ORDER BY COUNT(v.id) DESC, MAX(v.created_at) DESC
               LIMIT 50`),
          // Personnes invitées par lien : emails enregistrés via la page de partage
          // (1 ligne = 1 personne distincte ayant rejoint un voyage via son lien d'invitation)
          q(`SELECT COUNT(*) count FROM participant_emails`),
          q(`SELECT COUNT(*) count FROM participant_emails WHERE saved_at >= $1::timestamptz`, [c7]),
          q(`SELECT COUNT(*) count FROM participant_emails WHERE saved_at >= $1::timestamptz AND saved_at < $2::timestamptz`, [c14, c7]),
        ]);
        const sm = {}; vStatut.forEach(r => { sm[r.s] = parseInt(r.count) || 0; });
        const voyagesTot = n(vTot);
        const totals = {
          voyages: voyagesTot,
          voyagesActif: sm['actif'] || 0,
          voyagesCompleted: (sm['completed'] || 0) + (sm['terminé'] || 0),
          voyagesArchived: sm['archived'] || 0,
          participants: n(partTot),
          organisateurs: n(orgTot),
          messages: n(msgTot),
          documents: n(docTot),
          attributions: n(attrTot),
          depensesCount: n(depAgg),
          depensesSum: Math.round(n(depAgg, 'sum')),
          pushSubs: n(pushTot),
          invitesParLien: n(inviteTot),
        };
        return serve({
          generatedAt: new Date().toISOString(),
          mode: 'postgres',
          server: { uptimeSec: Math.round(process.uptime()), memMB: Math.round(process.memoryUsage().rss / 1048576) },
          totals,
          week: { voyages: n(vWeek), participants: n(pWeek), messages: n(mWeek), organisateurs: n(oWeek), invitesParLien: n(inviteWeek) },
          weekPrev: { voyages: n(vPrev), participants: n(pPrev), messages: n(mPrev), invitesParLien: n(invitePrev) },
          engagement: {
            voyagesActifs7j: n(actifs7),
            msgMedianeParVoyage: Math.round(n(msgMed, 'med') * 10) / 10,
            medianeParticipants: Math.round(n(partMed, 'med') * 10) / 10,
            avgParticipants: Math.round(n(avgPart, 'avg') * 10) / 10,
          },
          adoption: {
            voyagesWithAttr: n(attrVoy), attributionsPct: pct(n(attrVoy), voyagesTot),
            voyagesWithDoc: n(docVoy),  documentsPct:    pct(n(docVoy),  voyagesTot),
            voyagesWithDep: n(depVoy),  depensesPct:     pct(n(depVoy),  voyagesTot),
          },
          growth: {
            organisateursMulti:   n(orgMulti, 'multi'),
            organisateursActifs:  n(orgMulti, 'total'),
            multiPct:             pct(n(orgMulti, 'multi'), n(orgMulti, 'total')),
          },
          series: {
            voyages30:      vSeries.map(r => ({ d: r.d, n: parseInt(r.n) })),
            messages30:     mSeries.map(r => ({ d: r.d, n: parseInt(r.n) })),
            participants30: pSeries.map(r => ({ d: r.d, n: parseInt(r.n) })),
          },
          organisateurs: orgList.map(r => ({
            email: r.email || '—',
            voyages: parseInt(r.voyages) || 0,
            lastVoyage: r.last_voyage || null,
          })),
        });
      }

      // ── Fallback local (JSON) — pour la prévisualisation en dev ──
      const safe = (fn) => { try { const r = fn(); return Array.isArray(r) ? r : []; } catch { return []; } };
      const recent = (ts, cut) => String(ts || '').slice(0, 10) >= cut;
      const between = (ts, lo, hi) => { const d = String(ts || '').slice(0, 10); return d >= lo && d < hi; };
      const voyages = safe(() => db.voyages.getAll ? db.voyages.getAll() : []);
      const users = safe(() => db.users.getAll ? db.users.getAll() : []);
      let participants = 0, messages = 0, documents = 0, attributions = 0, depCount = 0, depSum = 0;
      let pWeek = 0, mWeek = 0, pPrev = 0, mPrev = 0;
      let invitesTot = 0, invitesWeek = 0, invitesPrev = 0;
      const vAttr = new Set(), vDoc = new Set(), vDep = new Set(), actifs = new Set();
      const partCounts = [], msgCounts = [];
      const vBucket = {}, mBucket = {}, pBucket = {};
      voyages.forEach(v => {
        const P = safe(() => db.participants.getByVoyage(v.id));
        const C = safe(() => db.commentaires.getByVoyage(v.id));
        const D = safe(() => db.documents.getByVoyage(v.id));
        const A = safe(() => db.attributions.getByVoyage(v.id));
        const E = safe(() => db.depenses.getByVoyage(v.id));
        const EM = safe(() => db.participant_emails?.getByVoyage ? db.participant_emails.getByVoyage(v.id) : []);
        participants += P.length; messages += C.length; documents += D.length; attributions += A.length;
        depCount += E.length; depSum += E.reduce((s, x) => s + (parseFloat(x.montant) || 0), 0);
        invitesTot += EM.length;
        EM.forEach(x => { if (recent(x.saved_at, c7)) invitesWeek++; if (between(x.saved_at, c14, c7)) invitesPrev++; });
        partCounts.push(P.length); if (C.length) msgCounts.push(C.length);
        if (A.length) vAttr.add(v.id);
        if (D.length) vDoc.add(v.id);
        if (E.length) vDep.add(v.id);
        if (recent(v.created_at, c30)) vBucket[String(v.created_at).slice(0,10)] = (vBucket[String(v.created_at).slice(0,10)] || 0) + 1;
        P.forEach(x => { if (recent(x.created_at, c7)) { pWeek++; actifs.add(v.id); } if (between(x.created_at, c14, c7)) pPrev++; if (recent(x.created_at, c30)) { const d = String(x.created_at).slice(0,10); pBucket[d] = (pBucket[d]||0)+1; } });
        C.forEach(x => { if (recent(x.created_at, c7)) { mWeek++; actifs.add(v.id); } if (between(x.created_at, c14, c7)) mPrev++; if (recent(x.created_at, c30)) { const d = String(x.created_at).slice(0,10); mBucket[d] = (mBucket[d]||0)+1; } });
        D.forEach(x => { if (recent(x.created_at, c7)) actifs.add(v.id); });
      });
      const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };
      const ownerCounts = {}, ownerLast = {};
      voyages.forEach(v => {
        if (v.owner_id == null) return;
        ownerCounts[v.owner_id] = (ownerCounts[v.owner_id] || 0) + 1;
        const ts = String(v.created_at || '');
        if (!ownerLast[v.owner_id] || ts > ownerLast[v.owner_id]) ownerLast[v.owner_id] = ts;
      });
      const ownerVals = Object.values(ownerCounts);
      const orgList = users
        .filter(u => ownerCounts[u.id])
        .map(u => ({ email: u.email || '—', voyages: ownerCounts[u.id], lastVoyage: ownerLast[u.id] || null }))
        .sort((a, b) => b.voyages - a.voyages || String(b.lastVoyage).localeCompare(String(a.lastVoyage)))
        .slice(0, 50);
      const voyagesTot = voyages.length;
      const toSeries = (bucket) => Object.keys(bucket).sort().map(d => ({ d, n: bucket[d] }));
      return serve({
        generatedAt: new Date().toISOString(),
        mode: 'local',
        server: { uptimeSec: Math.round(process.uptime()), memMB: Math.round(process.memoryUsage().rss / 1048576) },
        totals: {
          voyages: voyagesTot,
          voyagesActif: voyages.filter(v => !v.statut || v.statut === 'actif').length,
          voyagesCompleted: voyages.filter(v => ['completed','terminé'].includes(v.statut)).length,
          voyagesArchived: voyages.filter(v => v.statut === 'archived').length,
          participants, organisateurs: users.length, messages, documents, attributions,
          depensesCount: depCount, depensesSum: Math.round(depSum), pushSubs: 0,
          invitesParLien: invitesTot,
        },
        week: { voyages: voyages.filter(v => recent(v.created_at, c7)).length, participants: pWeek, messages: mWeek, organisateurs: users.filter(u => recent(u.created_at, c7)).length, invitesParLien: invitesWeek },
        weekPrev: { voyages: voyages.filter(v => between(v.created_at, c14, c7)).length, participants: pPrev, messages: mPrev, invitesParLien: invitesPrev },
        engagement: { voyagesActifs7j: actifs.size, msgMedianeParVoyage: median(msgCounts), medianeParticipants: median(partCounts), avgParticipants: partCounts.length ? Math.round(participants / partCounts.length * 10) / 10 : 0 },
        adoption: {
          voyagesWithAttr: vAttr.size, attributionsPct: pct(vAttr.size, voyagesTot),
          voyagesWithDoc: vDoc.size,  documentsPct:    pct(vDoc.size,  voyagesTot),
          voyagesWithDep: vDep.size,  depensesPct:     pct(vDep.size,  voyagesTot),
        },
        growth: { organisateursMulti: ownerVals.filter(c => c >= 2).length, organisateursActifs: ownerVals.length, multiPct: pct(ownerVals.filter(c => c >= 2).length, ownerVals.length) },
        series: { voyages30: toSeries(vBucket), messages30: toSeries(mBucket), participants30: toSeries(pBucket) },
        organisateurs: orgList
      });
    } catch (e) { console.error('[COCKPIT]', e); res.status(500).json({ error: 'Erreur interne' }); }
  });
};
