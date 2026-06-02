// ═══════════════════════════════════════════════════════════════════════════
//  LANDING PAGE (public/marketing) — module autonome
// ───────────────────────────────────────────────────────────────────────────
//  Regroupe tout le « public » servi à un visiteur non connecté, afin de ne
//  pas disperser cette logique dans server.js :
//   - GET /                  → page d'accueil (landing.html) + injection du nonce CSP
//   - GET /api/stats/public  → compteurs publics (voyages/participants/photos)
//   - GET /api/qr-landing    → QR code SVG vers crewigo.app
//   - GET /og-image.svg      → image Open Graph (partage sur réseaux sociaux)
//
//  Front associé : public/landing.html + public/og-image.svg
//
//  Notes :
//   - Aucune authentification (pages/API publiques par nature).
//   - /api/stats/public a un cache serveur de 5 min (module-level) pour limiter
//     la charge DB face au trafic anonyme.
//   - La page RGPD /confidentialite reste volontairement dans server.js.
//
//  Montage depuis server.js :
//   require('./landing')(app, { db, IS_CLOUD, publicDir });
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Enregistre les routes publiques (landing + stats publiques + QR + OG) sur l'app.
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {object}  deps.db        - couche d'accès données (database.js)
 * @param {boolean} deps.IS_CLOUD  - true en prod (PostgreSQL), false en local (JSON)
 * @param {string}  deps.publicDir - chemin absolu du dossier /public
 */
module.exports = function mountLanding(app, deps) {
  const { db, IS_CLOUD, publicDir } = deps;

  // ── Page d'accueil ──────────────────────────────────────────────────────
  // no-store : le navigateur ne cache jamais ce HTML.
  // Servie dynamiquement pour injecter le nonce CSP dans les <script> inline.
  app.get('/', (req, res) => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Content-Type':  'text/html; charset=utf-8'
    });
    let html = fs.readFileSync(path.join(publicDir, 'landing.html'), 'utf8');
    const nonce = res.locals.cspNonce || '';
    if (nonce) html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
    res.end(html);
  });

  // ── Stats publiques : /api/stats/public ───────────────────────────────────
  // Compteurs pour la landing — pas d'authentification requise.
  // Cache serveur 5 minutes pour limiter les requêtes DB.
  let _statsCache = null, _statsCacheAt = 0;
  app.get('/api/stats/public', async (req, res) => {
    try {
      const now = Date.now();
      if (_statsCache && now - _statsCacheAt < 300000) {
        return res.setHeader('Cache-Control', 'public, max-age=300').json(_statsCache);
      }
      let stats = { voyages: 0, participants: 0, photos: 0 };
      if (IS_CLOUD && db._pool) {
        const [v, p, ph] = await Promise.all([
          db._pool.query('SELECT COUNT(*) FROM voyages').then(r => parseInt(r.rows[0].count)),
          db._pool.query('SELECT COUNT(*) FROM participants').then(r => parseInt(r.rows[0].count)),
          db._pool.query("SELECT COUNT(*) FROM photos WHERE url IS NOT NULL").then(r => parseInt(r.rows[0].count)).catch(() => 0)
        ]);
        stats = { voyages: v, participants: p, photos: ph };
      } else {
        try {
          const voyages = db.voyages.getAll ? db.voyages.getAll() : [];
          // local mode : compter tous les participants via les voyages
          const partCount = voyages.reduce((sum, v) => {
            const parts = db.participants?.getByVoyage ? db.participants.getByVoyage(v.id) : [];
            return sum + (parts?.length || 0);
          }, 0);
          stats = { voyages: voyages.length, participants: partCount, photos: 0 };
        } catch { stats = { voyages: 0, participants: 0, photos: 0 }; }
      }
      // Arrondir à la dizaine pour éviter un aspect "trop précis" = moins crédible
      stats.voyagesDisplay = Math.max(stats.voyages, 12); // minimum affiché
      _statsCache = stats;
      _statsCacheAt = now;
      res.setHeader('Cache-Control', 'public, max-age=300').json(stats);
    } catch (e) {
      console.warn('[Stats] Erreur:', e.message);
      res.json({ voyages: 0, participants: 0, photos: 0, voyagesDisplay: 0 });
    }
  });

  // ── L7 — QR code local (remplace api.qrserver.com) ────────────────────────
  // Généré en SVG côté serveur via le package qrcode — aucun appel externe.
  app.get('/api/qr-landing', async (req, res) => {
    try {
      const QRCode = require('qrcode');
      const svg = await QRCode.toString('https://crewigo.app', {
        type:   'svg',
        color:  { dark: '#F97316ff', light: '#0D0D0Dff' },
        margin: 2,
        scale:  4
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h
      res.send(svg);
    } catch (e) {
      console.warn('[QR] Génération échouée:', e.message);
      res.status(503).end();
    }
  });

  // ── OG image SVG (1200×630) ────────────────────────────────────────────────
  app.get('/og-image.svg', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(publicDir, 'og-image.svg'));
  });
};
