/* ─── Centre de Commandement CrewiGo — logique front (autonome, sans dépendance) ─── */
(function () {
  'use strict';

  const KEY = 'cockpit_token';
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('fr-FR'));
  let timer = null, freshTimer = null;
  let lastData = null, lastOk = 0, lastError = false;

  // ── Auth ──────────────────────────────────────────────────────────────────
  function token() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch {} }

  function showLogin(msg) {
    clearInterval(timer);
    clearInterval(freshTimer);
    lastData = null; lastOk = 0; lastError = false;
    const v = $('verdict'); if (v) v.style.display = 'none';
    $('dash').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('login-err').textContent = msg || '';
    setTimeout(() => $('pwd')?.focus(), 50);
  }
  function showDash() {
    $('login').classList.add('hidden');
    $('dash').classList.remove('hidden');
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-btn'), err = $('login-err');
    const password = $('pwd').value;
    btn.disabled = true; btn.textContent = '…'; err.textContent = '';
    try {
      const r = await fetch('/api/cockpit/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = d.error || 'Erreur'; return; }
      setToken(d.token);
      $('pwd').value = '';
      showDash(); start();
    } catch { err.textContent = 'Connexion impossible'; }
    finally { btn.disabled = false; btn.textContent = 'Accéder'; }
  });

  $('btn-logout').addEventListener('click', () => { setToken(''); showLogin(''); });
  $('btn-refresh').addEventListener('click', () => load(true));

  // ── Chargement des données ──────────────────────────────────────────────────
  async function load(force) {
    const t = token();
    if (!t) return showLogin('');
    try {
      // force=true (bouton Actualiser) court-circuite le cache serveur via ?fresh=1
      const url = '/api/cockpit/stats' + (force ? '?fresh=1' : '');
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
      if (r.status === 401 || r.status === 403) { setToken(''); return showLogin('Session expirée, reconnecte-toi'); }
      if (!r.ok) throw new Error('http ' + r.status);
      lastData = await r.json();
      lastOk = Date.now();
      lastError = false;
      render(lastData);
      tickFresh();
    } catch (e) {
      lastError = true;
      tickFresh();
      if (!lastData) $('content').innerHTML = '<div class="loading">Erreur de chargement. Réessaie.</div>';
    }
  }

  function start() {
    load();
    clearInterval(timer);
    timer = setInterval(load, 60000); // rafraîchissement auto chaque minute
    clearInterval(freshTimer);
    freshTimer = setInterval(tickFresh, 10000); // fraîcheur + verdict toutes les 10 s
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────
  function card(label, value, sub, deltaHtml, isEmpty) {
    const vcls = isEmpty ? 'value empty' : 'value';
    return `<div class="card">
      <div class="label">${label}</div>
      <div class="${vcls}">${value}${deltaHtml || ''}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
    </div>`;
  }

  // carte "cette semaine" : 0 → état vide doux + badge de tendance vs semaine précédente
  function weekCard(label, now, prev, emptyLabel) {
    const empty = (+now || 0) === 0;
    const value = empty ? (emptyLabel || 'Aucun') : fmt(now);
    return card(label, value, null, deltaBadge(now, prev), empty);
  }

  function barRow(name, sub, pctVal) {
    const p = Math.max(0, Math.min(100, pctVal || 0));
    const cls = p >= 60 ? 'good' : p >= 30 ? 'mid' : 'low';
    return `<div class="bar-row">
      <div class="bl">
        <div class="bn">${name}</div>
        <div class="bs">${sub}</div>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${p}%"></div></div>
      </div>
      <div class="bar-pct ${cls}">${p}%</div>
    </div>`;
  }

  // mini bar-chart SVG sur 30 jours (continu, jours manquants = 0)
  function chart(series) {
    const days = 30, today = new Date();
    const map = {}; (series || []).forEach(x => { map[x.d] = x.n; });
    const data = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
      data.push({ d, n: map[d] || 0 });
    }
    const total = data.reduce((s, x) => s + x.n, 0);
    if (total === 0) return '<div class="chart-empty">Pas encore de données sur 30 jours</div>';
    const max = Math.max(1, ...data.map(x => x.n));
    const W = 300, H = 80, gap = 1.4, bw = (W / days) - gap;
    let bars = '';
    data.forEach((x, i) => {
      const h = x.n ? Math.max(2, (x.n / max) * (H - 4)) : 0;
      const px = i * (W / days);
      bars += `<rect class="chart-bar" x="${px.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1"><title>${x.d} : ${x.n}</title></rect>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
  }

  // tendance vs semaine précédente
  function deltaBadge(now, prev) {
    now = +now || 0; prev = +prev || 0;
    if (prev === 0 && now === 0) return `<span class="delta flat" title="aucune activité">·</span>`;
    if (prev === 0 && now > 0)  return `<span class="delta new" title="rien la semaine précédente">nouveau</span>`;
    const p = Math.round(((now - prev) / prev) * 100);
    if (p === 0) return `<span class="delta flat">= stable</span>`;
    const cls = p > 0 ? 'up' : 'down', arr = p > 0 ? '▲' : '▼';
    return `<span class="delta ${cls}" title="vs 7 jours précédents">${arr} ${Math.abs(p)} %</span>`;
  }

  // temps écoulé lisible
  function ageLabel(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `il y a ${sec} s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `il y a ${m} min`;
    const h = Math.floor(m / 60);
    return `il y a ${h} h`;
  }

  // ── Verdict global + fraîcheur (rejoué toutes les 10 s) ──────────────────────
  function tickFresh() {
    if (!lastData) return;
    const ageSec = (Date.now() - lastOk) / 1000;
    const stale = lastError || ageSec > 90;
    const veryStale = lastError && ageSec > 300;
    const d = lastData;

    // Ligne de fraîcheur
    const mode = d.mode === 'postgres'
      ? '<span class="badge-mode prod">prod</span>'
      : '<span class="badge-mode dev">dev</span>';
    $('updated').innerHTML =
      `<span class="live-dot ${stale ? 'stale' : 'on'}"></span>` +
      `<span>Données réelles · ${ageLabel(ageSec)}</span>` + mode +
      (stale ? `<span style="color:var(--orange)">· rafraîchissement…</span>` : '');

    // Verdict synthétique
    let cls = 'ok', txt = 'Tout est nominal', sub = 'Système et activité OK';
    if (veryStale) {
      cls = 'crit'; txt = 'Connexion perdue'; sub = 'Données non rafraîchies — vérifie ta connexion';
    } else if (stale) {
      cls = 'warn'; txt = 'Données en cours de rafraîchissement'; sub = ageLabel(ageSec);
    } else if ((d.server?.uptimeSec || 0) < 300) {
      cls = 'warn'; txt = 'Serveur redémarré récemment'; sub = 'Démarré ' + uptime(d.server.uptimeSec);
    } else {
      const w = d.week || {}, e = d.engagement || {}, g = d.growth || {};
      // Verdict d'adoption prioritaire : le but de l'outil est de mesurer la traction externe.
      if (g.founderConfigured) {
        const ext = +g.externes || 0;
        if (ext === 0) {
          cls = 'warn'; txt = 'Aucun utilisateur externe';
          sub = `${fmt(g.voyagesReels)} voyage(s) réel(s) · seuls les comptes fondateurs créent des voyages`;
        } else {
          cls = 'ok'; txt = `Traction externe · ${fmt(ext)} externe${ext > 1 ? 's' : ''}`;
          sub = `${fmt(g.voyagesReels)} voyage(s) réel(s) (${g.reelsPct || 0}% du total)`;
        }
      } else {
        const calme = !(w.voyages || w.messages || w.participants || e.voyagesActifs7j);
        if (calme) { cls = 'warn'; txt = 'Activité calme cette semaine'; sub = 'Aucune action sur 7 jours — normal hors période de voyage'; }
        else { sub = `${fmt(e.voyagesActifs7j)} voyage(s) actif(s) · ${fmt(w.messages)} message(s)/7j`; }
      }
    }
    const v = $('verdict');
    v.style.display = '';
    v.className = 'verdict ' + cls;
    $('verdict-txt').textContent = txt;
    $('verdict-sub').textContent = sub;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtEur = (n) => fmt(Math.round(+n || 0)) + ' €';
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const dd = new Date(String(iso).replace(' ', 'T'));
    return isNaN(dd) ? '—' : dd.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  function render(d) {
    const t = d.totals || {}, w = d.week || {}, wp = d.weekPrev || {}, e = d.engagement || {};
    const a = d.adoption || {}, g = d.growth || {}, s = d.series || {};

    // ── Dérivés : participants sans e-mail + taux d'arrivée par lien ──
    // « Sans e-mail » = ajoutés manuellement par l'organisateur ou consultant sans s'identifier.
    const partTotal   = +t.participants    || 0;
    const partLien    = +t.invitesParLien  || 0;
    const partSansMail = Math.max(0, partTotal - partLien);
    const tauxLien    = partTotal > 0 ? Math.round((partLien / partTotal) * 100) : 0;

    // ── Panneau organisateurs (qui utilise l'app) ──
    const orgs = d.organisateurs || [];
    // Si FOUNDER_EMAILS est configuré côté serveur → distinction fiable fondateur/externe.
    // Sinon, repli sur l'heuristique « le compte avec le plus de voyages = toi ».
    const founderMode = !!g.founderConfigured;
    const externes = founderMode ? (+g.externes || 0) : (orgs.length > 0 ? orgs.length - 1 : 0);
    let orgHtml;
    if (!orgs.length) {
      orgHtml = '<div class="chart-empty">Aucun organisateur pour l\'instant</div>';
    } else {
      orgHtml = orgs.map((o, i) => {
        const isFounder = founderMode ? !!o.isFounder : (i === 0);
        const tag = isFounder
          ? `<span class="org-tag me">${founderMode ? 'fondateur' : 'vous ?'}</span>`
          : '<span class="org-tag ext">externe</span>';
        return `<div class="org-row">
          <div class="org-id">
            <div class="org-email">${esc(o.email)}${tag}</div>
            <div class="org-meta">dernier voyage : ${fmtDate(o.lastVoyage)}</div>
          </div>
          <div class="org-count">${fmt(o.voyages)}<small>voyage${o.voyages > 1 ? 's' : ''}</small></div>
        </div>`;
      }).join('');
    }

    const html = `
      <!-- Qui utilise CrewiGo (signal d'adoption — placé en tête) -->
      <div class="section-title">Qui utilise CrewiGo ? (organisateurs)</div>
      <div class="grid ${founderMode ? 'g4' : 'g3'}">
        ${card('🧑‍✈️ Organisateurs', fmt(orgs.length), 'comptes ayant créé ≥ 1 voyage', null, orgs.length === 0)}
        ${card(founderMode ? '🌍 Externes' : '🌍 Externes (hors toi)', externes === 0 ? 'Aucun' : fmt(externes), externes === 0 ? (founderMode ? 'aucun utilisateur hors équipe' : 'tu es seul à créer des voyages') : 'd\'autres créent des voyages 🎉', null, externes === 0)}
        ${founderMode ? card('🎯 Voyages réels', fmt(g.voyagesReels), `${g.reelsPct || 0}% du total · ${fmt(g.voyagesTest)} en test`, null, !g.voyagesReels) : ''}
        ${card('🔁 Fidèles (≥ 2 voyages)', fmt(g.organisateursMulti), `${g.multiPct || 0}% des organisateurs`, null, !g.organisateursMulti)}
      </div>
      <div class="card">${orgHtml}</div>
      <div class="hint">${founderMode
        ? 'ℹ️ « fondateur » = compte interne (équipe CrewiGo) défini via <code>FOUNDER_EMAILS</code> ; ses voyages comptent comme « test ». « externe » = vrai utilisateur — ses voyages comptent comme « réels ».'
        : 'ℹ️ « vous ? » = le compte qui a créé le plus de voyages (probablement toi, tes tests inclus). Vérifie l\'e-mail pour confirmer. Les autres sont des utilisateurs externes.'}</div>

      <!-- Cette semaine -->
      <div class="section-title">Cette semaine · vs 7 jours précédents</div>
      <div class="grid g4">
        ${weekCard('🧳 Voyages créés', w.voyages, wp.voyages)}
        ${weekCard('👥 Participants rejoints', w.participants, wp.participants)}
        ${weekCard('🔗 Invités par lien', w.invitesParLien, wp.invitesParLien)}
        ${weekCard('💬 Messages envoyés', w.messages, wp.messages)}
      </div>

      <!-- Participants & liens (tout ce qui concerne les participants, regroupé) -->
      <div class="section-title">Participants & liens (cumul)</div>
      <div class="grid g4">
        ${card('👥 Participants', fmt(t.participants), 'tous voyages confondus', null, !t.participants)}
        ${card('🔗 Invités par lien', fmt(t.invitesParLien), 'rejoints via leur lien d\'invitation', null, !t.invitesParLien)}
        ${card('👤 Participants sans e-mail', fmt(partSansMail), 'ajoutés manuellement / sans s\'identifier', null, !partSansMail)}
        ${card('🔗 Taux d\'arrivée par lien', partTotal ? tauxLien + '%' : '—', partTotal ? `${fmt(partLien)} sur ${fmt(partTotal)} ont rejoint via leur lien` : 'aucun participant', null, !partTotal)}
      </div>

      <!-- Engagement -->
      <div class="section-title">Engagement & dynamique de groupe</div>
      <div class="grid g4">
        ${card('🧭 Voyages actifs', (+e.voyagesActifs7j ? fmt(e.voyagesActifs7j) : 'Aucun'), 'au moins 1 action sur 7 jours', null, !e.voyagesActifs7j)}
        ${card('👥 Participants / voyage', (e.medianeParticipants ?? '—'), 'médiane — taille de groupe typique')}
        ${card('💬 Messages / voyage', (e.msgMedianeParVoyage ?? '—'), 'médiane CrewiChat')}
        ${card('💶 Dépenses suivies', fmtEur(t.depensesSum), `sur ${fmt(t.depensesCount)} dépense(s)`, null, !t.depensesCount)}
      </div>

      <!-- Graphiques -->
      <div class="section-title">Activité · 30 derniers jours</div>
      <div class="grid g2">
        <div class="card chart-card"><div class="label">🧳 Voyages créés / jour</div>${chart(s.voyages30)}</div>
        <div class="card chart-card"><div class="label">💬 Messages / jour</div>${chart(s.messages30)}</div>
      </div>

      <!-- Vue d'ensemble -->
      <div class="section-title">Vue d'ensemble (cumul depuis le début)</div>
      <div class="grid g4">
        ${card('🧳 Voyages', fmt(t.voyages), `${fmt(t.voyagesActif)} actifs · ${fmt(t.voyagesCompleted)} terminés · ${fmt(t.voyagesArchived)} archivés`)}
        ${card('💬 Messages', fmt(t.messages), 'tous voyages confondus', null, !t.messages)}
        ${card('📄 Documents', fmt(t.documents), null, null, !t.documents)}
        ${card('🔒 Attributions privées', fmt(t.attributions), null, null, !t.attributions)}
      </div>

      <!-- Adoption -->
      <div class="section-title">Adoption des fonctionnalités (% de voyages)</div>
      <div class="card">
        ${barRow('Attributions privées', `${fmt(a.voyagesWithAttr)} voyage(s) sur ${fmt(t.voyages)}`, a.attributionsPct)}
        ${barRow('Documents partagés', `${fmt(a.voyagesWithDoc)} voyage(s) sur ${fmt(t.voyages)}`, a.documentsPct)}
        ${barRow('Suivi des dépenses', `${fmt(a.voyagesWithDep)} voyage(s) sur ${fmt(t.voyages)}`, a.depensesPct)}
      </div>

      <!-- Santé technique -->
      <div class="section-title">Santé technique</div>
      <div class="health">
        <div class="pill">Base : <b>${d.mode === 'postgres' ? 'PostgreSQL (prod)' : 'JSON local'}</b></div>
        <div class="pill">En ligne depuis : <b>${uptime(d.server?.uptimeSec)}</b></div>
        <div class="pill">Mémoire : <b>${fmt(d.server?.memMB)} Mo</b></div>
        <div class="pill">🔔 Abonnements push : <b>${fmt(t.pushSubs)}</b></div>
      </div>
    `;
    $('content').innerHTML = html;
  }

  function uptime(sec) {
    sec = sec || 0;
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return `${d} j ${h} h`;
    if (h) return `${h} h ${m} min`;
    return `${m} min`;
  }

  // ── Démarrage ───────────────────────────────────────────────────────────────
  if (token()) { showDash(); start(); } else { showLogin(''); }
})();
