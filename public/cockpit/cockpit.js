/* ─── Centre de Commandement CrewiGo — logique front (autonome, sans dépendance) ─── */
(function () {
  'use strict';

  const KEY = 'cockpit_token';
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('fr-FR'));
  let timer = null;

  // ── Auth ──────────────────────────────────────────────────────────────────
  function token() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch {} }

  function showLogin(msg) {
    clearInterval(timer);
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
  $('btn-refresh').addEventListener('click', () => load());

  // ── Chargement des données ──────────────────────────────────────────────────
  async function load() {
    const t = token();
    if (!t) return showLogin('');
    try {
      const r = await fetch('/api/cockpit/stats', { headers: { Authorization: 'Bearer ' + t } });
      if (r.status === 401 || r.status === 403) { setToken(''); return showLogin('Session expirée, reconnecte-toi'); }
      if (!r.ok) throw new Error('http ' + r.status);
      render(await r.json());
    } catch (e) {
      $('content').innerHTML = '<div class="loading">Erreur de chargement. Réessaie.</div>';
    }
  }

  function start() {
    load();
    clearInterval(timer);
    timer = setInterval(load, 60000); // rafraîchissement auto chaque minute
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────
  function card(label, value, sub, deltaHtml) {
    return `<div class="card">
      <div class="label">${label}</div>
      <div class="value">${value}${deltaHtml || ''}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
    </div>`;
  }

  function barRow(name, sub, pctVal) {
    const p = Math.max(0, Math.min(100, pctVal || 0));
    return `<div class="bar-row">
      <div class="bl">
        <div class="bn">${name}</div>
        <div class="bs">${sub}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${p}%"></div></div>
      </div>
      <div class="bar-pct">${p}%</div>
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

  function deltaBadge(now, label) {
    // simple indicateur de volume cette semaine (pas de comparaison historique en v1)
    if (!now) return `<span class="delta flat">·</span>`;
    return '';
  }

  function render(d) {
    const dotColor = d.mode === 'postgres' ? 'var(--green)' : 'var(--orange)';
    $('updated').innerHTML =
      `<span class="dot" style="background:${dotColor}"></span>` +
      `Données réelles · ${d.mode === 'postgres' ? 'base de production' : 'mode local (dev)'} · ` +
      `maj ${new Date(d.generatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;

    const t = d.totals, w = d.week, e = d.engagement, a = d.adoption, g = d.growth, s = d.series;
    const eur = (n) => fmt(n) + ' €';

    const html = `
      <!-- Cette semaine -->
      <div class="section-title">Cette semaine (7 derniers jours)</div>
      <div class="grid g4">
        ${card('🧳 Voyages créés', fmt(w.voyages))}
        ${card('👥 Participants rejoints', fmt(w.participants))}
        ${card('💬 Messages envoyés', fmt(w.messages))}
        ${card('🧭 Voyages actifs', fmt(e.voyagesActifs7j), 'avec activité sur 7j')}
      </div>

      <!-- Vue d'ensemble -->
      <div class="section-title">Vue d'ensemble</div>
      <div class="grid g4">
        ${card('🧳 Voyages', fmt(t.voyages), `${fmt(t.voyagesActif)} actifs · ${fmt(t.voyagesCompleted)} terminés · ${fmt(t.voyagesArchived)} archivés`)}
        ${card('👥 Participants', fmt(t.participants), `${e.avgParticipants} en moyenne / voyage`)}
        ${card('🧑‍✈️ Organisateurs', fmt(t.organisateurs))}
        ${card('💬 Messages', fmt(t.messages), `médiane ${e.msgMedianeParVoyage} / voyage`)}
        ${card('📄 Documents', fmt(t.documents))}
        ${card('🔒 Attributions privées', fmt(t.attributions))}
        ${card('💶 Dépenses', fmt(t.depensesCount), `total suivi ${eur(t.depensesSum)}`)}
        ${card('🔔 Abonnements push', fmt(t.pushSubs))}
      </div>

      <!-- Graphiques -->
      <div class="section-title">Activité · 30 derniers jours</div>
      <div class="grid g2">
        <div class="card chart-card"><div class="label">🧳 Voyages créés / jour</div>${chart(s.voyages30)}</div>
        <div class="card chart-card"><div class="label">💬 Messages / jour</div>${chart(s.messages30)}</div>
      </div>

      <!-- Adoption -->
      <div class="section-title">Adoption des fonctionnalités</div>
      <div class="card">
        ${barRow('Attributions privées', `${fmt(a.voyagesWithAttr)} voyages sur ${fmt(t.voyages)}`, a.attributionsPct)}
        ${barRow('Documents partagés', `${fmt(a.voyagesWithDoc)} voyages sur ${fmt(t.voyages)}`, a.documentsPct)}
        ${barRow('Suivi des dépenses', `${fmt(a.voyagesWithDep)} voyages sur ${fmt(t.voyages)}`, a.depensesPct)}
        ${barRow('Organisateurs fidèles (≥ 2 voyages)', `${fmt(g.organisateursMulti)} sur ${fmt(g.organisateursActifs)} organisateurs`, g.multiPct)}
      </div>

      <!-- Santé technique -->
      <div class="section-title">Santé technique</div>
      <div class="health">
        <div class="pill">Base : <b>${d.mode === 'postgres' ? 'PostgreSQL (prod)' : 'JSON local'}</b></div>
        <div class="pill">Serveur en ligne depuis : <b>${uptime(d.server.uptimeSec)}</b></div>
        <div class="pill">Mémoire : <b>${fmt(d.server.memMB)} Mo</b></div>
      </div>
      <div class="note">⏱️ Latence API (P95) et taux d'erreurs serveur : à venir en Priorité 2
        (nécessite l'activation du logging structuré + Sentry).</div>
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
