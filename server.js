const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const db = require('./database');
const { createSession } = require('./sessions');
const verifyParticipantSession = require('./services/verifyParticipantSession');

const IS_CLOUD = db.usePostgres;

// Version de l'app — doit correspondre à CACHE_VERSION dans sw.js
// Changer ici ET dans sw.js à chaque déploiement pour forcer le rechargement
const APP_VERSION = 'v52';
const fs = require('fs');
if (!process.env.JWT_SECRET && IS_CLOUD) {
  console.error('FATAL: JWT_SECRET non défini. Arrêt du serveur.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'crewigo-dev-secret-local';

// En prod, les clés VAPID DOIVENT être définies en variables d'environnement
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:admin@mes-voyages.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('⚠️  VAPID keys manquantes — push notifications désactivées');
}

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Faire confiance au proxy reverse (Railway / Nginx) pour req.protocol
app.set('trust proxy', 1);

// CORS : restreint à l'origine configurée en prod, ouvert en dev local
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null;
app.use(cors({
  origin: allowedOrigins || true,
  methods: ['GET','POST','PUT','PATCH','DELETE']
}));
// S3 — Nonce CSP : généré par la directive scriptSrc et stocké dans res.locals
// pour être injecté dans les balises <script> inline lors du rendu HTML.
// Plus d'unsafe-inline pour script-src : chaque bloc inline porte son nonce.
// scriptSrcAttr reste unsafe-inline car l'app utilise encore des attributs
// onclick=/oninput= dans le HTML (refacto à prévoir en court terme).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     [
        "'self'",
        "cdn.jsdelivr.net",
        // Nonce généré par requête — remplace unsafe-inline pour les blocs <script>
        (req, res) => {
          if (!res.locals.cspNonce) {
            res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
          }
          return `'nonce-${res.locals.cspNonce}'`;
        },
      ],
      // Le HTML statique est propre (0 onclick= dans index.html), mais app.js
      // génère encore des onclick= dans des innerHTML (cards, buttons dynamiques).
      // 'unsafe-inline' requis pour ces attributs inline générés par JS.
      // TODO : migrer les 53 onclick= restants en app.js vers event delegation.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      // Police Satoshi auto-hébergée dans /fonts/ — plus de fontshare.com en fontSrc
      fontSrc:       ["'self'"],
      imgSrc:        ["'self'", "data:", "blob:", "upload.wikimedia.org", "commons.wikimedia.org", "*.tile.openstreetmap.org", "*.wikimedia.org"],
      // api.qrserver.com supprimé : QR code généré en local via /api/qr-landing (L7)
      connectSrc:    ["'self'", "fr.wikipedia.org", "commons.wikimedia.org", "geocoding-api.open-meteo.com", "api.open-meteo.com", "nominatim.openstreetmap.org", "api.anthropic.com"],
      workerSrc:     ["'self'", "blob:", "cdn.jsdelivr.net"],
      frameSrc:      ["'self'", "https://maps.google.com", "https://www.google.com", "https://www.openstreetmap.org"],
      objectSrc:     ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(express.json({ limit: '20mb' }));

// ─── FILET DE SÉCURITÉ : rate limit global sur /api/* (120 req/min/IP) ───────
// Appliqué après la déclaration des helpers rate-limit (plus bas dans le fichier),
// mais le middleware est enregistré ici pour couvrir toutes les routes API.
app.use('/api/', (req, res, next) => {
  if (!checkApiRate(req.ip)) {
    return res.status(429).json({ error: 'Trop de requêtes, réessaie dans une minute' });
  }
  next();
});

// ─── ROUTES PRINCIPALES (avant express.static pour éviter que index.html soit servi sur /) ──
// no-store : le navigateur ne cache jamais ces pages HTML
// Les URLs versionnées app.js?v=XX et style.css?v=XX garantissent le rechargement du JS/CSS
// La route GET '/' (landing) vit désormais dans le module ./landing (monté plus bas).
app.get('/app', (req, res) => {
  // no-store + pas d'ETag : res.end() contourne la génération automatique d'ETag
  // d'Express (res.send() en génère un → Safari peut retourner 304 et servir un
  // HTML périmé malgré Cache-Control: no-store)
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma':        'no-cache',
    'Expires':       '0',
    'Content-Type':  'text/html; charset=utf-8'
  });
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const nonce = res.locals.cspNonce || '';
  html = html
    .replace('href="style.css"', `href="style.css?${APP_VERSION}"`)
    .replace('src="i18n.js"',    `src="i18n.js?${APP_VERSION}"`)
    .replace('src="app.js"',     `src="app.js?${APP_VERSION}"`);
  if (nonce) html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
  res.end(html);
});

// ─── ROUTE DÉDIÉE sw.js (AVANT express.static) ──────────────────────────────
// Le Service Worker DOIT être récupéré frais à chaque requête — jamais via cache HTTP.
// express.static génère ETag + Last-Modified automatiquement (via serve-static) et
// res.removeHeader() dans setHeaders est trop tardif (les headers sont posés après).
// → Route explicite avec sendFile({ etag:false, lastModified:false }) pour garantir
//   qu'aucun header de revalidation ne filtre vers Safari.
app.get('/sw.js', (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma':        'no-cache',
    'Expires':       '0',
    'Content-Type':  'application/javascript; charset=utf-8',
  });
  res.sendFile(path.join(__dirname, 'public', 'sw.js'), { etag: false, lastModified: false });
});

app.get('/confidentialite', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, 'public', 'confidentialite.html'), { etag: false, lastModified: false });
});

// ─── Centre de Commandement (cockpit) ───────────────────────────────────────
// Module AUTONOME (page HTML + auth dédiée + API stats) : tout vit dans cockpit.js
// pour ne jamais mélanger sa logique avec celle de l'app. Monté tôt afin que sa
// route /cockpit prime sur les middlewares statiques / catch-all.
require('./cockpit')(app, { db, IS_CLOUD, JWT_SECRET, checkAuthRate, publicDir: path.join(__dirname, 'public') });

// ─── Landing page (public/marketing) ────────────────────────────────────────
// Module AUTONOME : page d'accueil GET '/', stats publiques, QR landing, OG image.
// Monté AVANT express.static pour que GET '/' prime sur le service statique.
require('./landing')(app, { db, IS_CLOUD, publicDir: path.join(__dirname, 'public') });

// ─── QR code générique : /api/qr?url=<encodedUrl> ───────────────────────────
// Utilisé par le modal de partage pour afficher le QR du lien de partage.
// Authentification requise pour limiter l'abus.
app.get('/api/qr', authMiddleware, async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!raw) return res.status(400).json({ error: 'Paramètre url manquant' });
    // Accepte uniquement les URLs relatives /partage/... ou absolues du même domaine
    const allowed = /^(https?:\/\/[^/]+)?\/partage\/[a-zA-Z0-9_-]{6,}$/.test(raw) ||
                    /^(https?:\/\/[^/]+)?\/share\/[a-zA-Z0-9_-]{6,}$/.test(raw);
    if (!allowed) return res.status(400).json({ error: 'URL non autorisée' });
    const QRCode = require('qrcode');
    // Résoudre les chemins relatifs en URL absolue pour le QR code
    let fullUrl = raw;
    if (raw.startsWith('/')) {
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
      const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
      fullUrl = `${proto}://${host}${raw}`;
    }
    const svg = await QRCode.toString(fullUrl, {
      type:   'svg',
      color:  { dark: '#F97316ff', light: '#00000000' }, // fond transparent
      margin: 1,
      scale:  5
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(svg);
  } catch (e) {
    console.warn('[QR] Génération échouée:', e.message);
    res.status(503).end();
  }
});

// La route GET '/og-image.svg' vit désormais dans le module ./landing (monté plus haut).

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(js|css|html)$/.test(filePath)) {
      // Forcer la revalidation des fichiers JS/CSS/HTML à chaque requête
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ─── HELPERS SÉCURITÉ ──────────────────────────────────────────────────────

// Sanitise un nom de fichier pour Content-Disposition
function safeFilename(name) {
  return (name || 'fichier').replace(/[^\w.\- ]/g, '_').substring(0, 200);
}

// Types MIME autorisés pour les uploads
const ALLOWED_MIMES = new Set([
  'image/jpeg','image/png','image/webp','image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain','text/csv'
]);

// ─── AUTH JWT ──────────────────────────────────────────────────────────────

// Rate-limiter pour les tentatives de connexion (15 essais / 15 min / IP)
const _authAttempts = new Map();
function checkAuthRate(ip) {
  const now = Date.now();
  let rec = _authAttempts.get(ip);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 15 * 60_000 };
  rec.count++;
  _authAttempts.set(ip, rec);
  return rec.count <= 15;
}

// Rate-limiter pour les demandes de magic link (5 / heure / IP)
const _magicLinkAttempts = new Map();
function checkMagicLinkRate(ip) {
  const now = Date.now();
  let rec = _magicLinkAttempts.get(ip);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 60 * 60_000 };
  rec.count++;
  _magicLinkAttempts.set(ip, rec);
  return rec.count <= 5;
}

// Rate-limiter pour les commentaires publics (CrewiChat participants) : 20 / 5 min / IP+token
const _chatAttempts = new Map();
function checkChatRate(ip, token) {
  const key = `${ip}:${token}`;
  const now = Date.now();
  let rec = _chatAttempts.get(key);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 5 * 60_000 };
  rec.count++;
  _chatAttempts.set(key, rec);
  return rec.count <= 20;
}

// Rate-limiter général API : 120 req / min / IP (filet de sécurité global)
const _apiRate = new Map();
function checkApiRate(ip) {
  const now = Date.now();
  let rec = _apiRate.get(ip);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 60_000 };
  rec.count++;
  _apiRate.set(ip, rec);
  return rec.count <= 120;
}

// S4 — Nettoyage périodique des Maps de rate-limiting (évite les fuites mémoire)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _authAttempts)      { if (now > v.resetAt) _authAttempts.delete(k); }
  for (const [k, v] of _magicLinkAttempts) { if (now > v.resetAt) _magicLinkAttempts.delete(k); }
  for (const [k, v] of _chatAttempts)      { if (now > v.resetAt) _chatAttempts.delete(k); }
  for (const [k, v] of _apiRate)           { if (now > v.resetAt) _apiRate.delete(k); }
}, 3_600_000); // toutes les heures

// Middleware JWT — skip en mode local (JSON files)
// En local, on résout l'id du premier utilisateur existant (évite les décalages d'id après tests)
function authMiddleware(req, res, next) {
  if (!IS_CLOUD) {
    const users = db.users.getAll ? db.users.getAll() : [];
    const first = (Array.isArray(users) ? users : [])[0];
    req.user = { id: first?.id ?? 1, email: first?.email ?? 'local' };
    return next();
  }
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée, reconnecte-toi' });
  }
}

// ─── ROUTES AUTH ────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  if (!checkAuthRate(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 15 min' });
  const { email, password, nom } = req.body;
  if (!email || !password || password.length < 8)
    return res.status(400).json({ error: 'Email et mot de passe requis (8 caractères minimum)' });
  try {
    const existing = await db.users.getByEmail(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    const hash = await bcrypt.hash(password, 12);
    const user = await db.users.create(
      email.toLowerCase().trim(),
      hash,
      (nom || email.split('@')[0]).trim()
    );
    // Premier inscrit → hérite de tous les voyages sans propriétaire
    const total = await db.users.count();
    if (total <= 1) await db.users.claimOrphanVoyages(user.id);
    const token = jwt.sign({ id: user.id, email: user.email, nom: user.nom }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, nom: user.nom } });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/auth/login', async (req, res) => {
  if (!checkAuthRate(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 15 min' });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  try {
    const user = await db.users.getByEmail(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    const token = jwt.sign({ id: user.id, email: user.email, nom: user.nom }, JWT_SECRET, { expiresIn: '30d' });

    // P3 — Réconciliation automatique : trouver les participations liées à cet email
    let newParticipations = 0;
    try {
      const emailLinks    = await run(() => db.participant_emails.getAllByEmail(email.toLowerCase().trim()));
      const existingLinks = await run(() => db.user_participant_links.getByUser(user.id));
      const existingKeys  = new Set(existingLinks.map(l => l.voyage_id));

      for (const ep of emailLinks) {
        if (existingKeys.has(ep.voyage_id)) continue; // déjà lié
        const participants = await run(() => db.participants.getByVoyage(ep.voyage_id));
        const participant  = participants.find(p => p.nom === ep.participant_nom);
        if (participant) {
          await run(() => db.user_participant_links.upsert(
            user.id, participant.id, ep.voyage_id, ep.participant_nom
          )).catch(() => {});
          newParticipations++;
        }
      }
    } catch(e) {
      console.warn('[P3 réconciliation]', e.message);
    }
    res.json({ token, user: { id: user.id, email: user.email, nom: user.nom }, newParticipations });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await db.users.getById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json(user);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// Sliding window : renouvelle le token pour 30j supplémentaires
app.get('/api/auth/refresh', authMiddleware, async (req, res) => {
  const token = jwt.sign(
    { id: req.user.id, email: req.user.email, nom: req.user.nom },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({ token });
});

// ── RGPD art. 20 — export des données personnelles ───────────────────────────
app.get('/api/auth/export', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const user    = await run(() => db.users.getById(userId));
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const voyages = await run(() => db.voyages.getAll(userId));
    const data = {
      exported_at: new Date().toISOString(),
      compte: { id: user.id, email: user.email, nom: user.nom, created_at: user.created_at },
      voyages: []
    };
    for (const v of voyages) {
      const [participants, reservations, agenda, depenses, bagages] = await Promise.all([
        run(() => db.participants.getByVoyage(v.id)),
        run(() => db.reservations.getByVoyage(v.id)),
        run(() => db.agenda.getByVoyage(v.id)),
        run(() => db.depenses.getByVoyage(v.id)),
        run(() => db.bagages.getByVoyage(v.id)),
      ]);
      // Exclure le contenu binaire des documents/photos (trop lourd, non lisible)
      data.voyages.push({ ...v, participants, reservations, agenda, depenses, bagages });
    }
    res.setHeader('Content-Disposition', `attachment; filename="crewigo-export-${Date.now()}.json"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json(data);
  } catch(e) { console.error('[EXPORT]', e); res.status(500).json({ error: 'Erreur lors de l\'export' }); }
});

// ── RGPD art. 17 — suppression du compte ─────────────────────────────────────
app.delete('/api/auth/account', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    // Supprimer tous les voyages (cascade participants, docs, photos…)
    const voyages = await run(() => db.voyages.getAll(userId));
    for (const v of voyages) {
      await run(() => db.voyages.delete(v.id));
    }
    // Supprimer le compte, les magic_links et participant_emails liés à l'email
    await run(() => db.users.delete(userId));
    res.json({ ok: true });
  } catch(e) { console.error('[ACCOUNT DELETE]', e); res.status(500).json({ error: 'Erreur lors de la suppression' }); }
});

// ── Voyages participants liés à ce compte admin (via user_participant_links) ──
app.get('/api/auth/my-participations', authMiddleware, async (req, res) => {
  try {
    const links = await run(() => db.user_participant_links.getByUser(req.user.id));
    if (!links.length) return res.json([]);
    // Récupérer les voyages uniques
    const voyageIds = [...new Set(links.map(l => l.voyage_id))];
    const voyages   = await Promise.all(
      voyageIds.map(vid => run(() => db.voyages.getById(vid)).catch(() => null))
    );
    const result = voyages.filter(Boolean).map(v => {
      const link = links.find(l => l.voyage_id === v.id);
      return { ...v, participant_nom: link.participant_nom, role_in_voyage: 'participant' };
    });
    res.json(result);
  } catch(e) {
    console.error('[my-participations]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Rate-limiter en mémoire pour les tentatives PIN
const _pinAttempts = new Map();
function checkPinRate(key) {
  const now = Date.now();
  let rec = _pinAttempts.get(key);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 60_000 };
  rec.count++;
  _pinAttempts.set(key, rec);
  return rec.count <= 5;
}

// Helper pour supporter db sync (local JSON) et async (PostgreSQL)
const run = async (fn) => {
  const result = fn();
  return result instanceof Promise ? result : result;
};

// Helper de vérification d'ownership — no-op en mode local
async function checkVoyageOwnership(voyageId, userId) {
  if (!IS_CLOUD) return true;
  const voyage = await run(() => db.voyages.getById(voyageId));
  return voyage && voyage.owner_id === userId;
}

// Middleware d'ownership pour les routes scopées par voyage (/api/voyages/:id/...).
// À placer APRÈS authMiddleware (a besoin de req.user). No-op en mode local.
// `param` = nom du paramètre d'URL portant l'id du voyage ('id' par défaut, sinon 'vid'/'voyageId').
function requireVoyageOwner(param = 'id') {
  return async (req, res, next) => {
    if (!IS_CLOUD) return next();
    try {
      const voyageId = req.params[param];
      const voyage = await run(() => db.voyages.getById(voyageId));
      if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
      if (voyage.owner_id !== req.user.id)
        return res.status(403).json({ error: 'Accès refusé' });
      next();
    } catch(e) {
      console.error('[OWNERSHIP]', e);
      res.status(500).json({ error: 'Erreur interne' });
    }
  };
}

// ─── VOYAGES ───────────────────────────────────────────────────────────────

app.get('/api/voyages', authMiddleware, async (req, res) => {
  try { res.json(await run(() => db.voyages.getAll(req.user.id))); } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// GET home summary enrichi (participant_count, top_photo_id, avg_capsule_note) — DOIT être avant /:id
app.get('/api/voyages/home-summary', authMiddleware, async (req, res) => {
  try {
    const rows = await run(() => db.voyages.getAllWithSummary(req.user.id));
    res.json(rows);
  } catch(e) {
    console.error('[HOME SUMMARY]', e.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// GET voyages archivés — DOIT être avant /:id pour ne pas être intercepté
app.get('/api/voyages/archives', authMiddleware, async (req, res) => {
  try {
    const all = IS_CLOUD
      ? (await db._pool.query("SELECT * FROM voyages WHERE statut='archived' AND owner_id=$1 ORDER BY archived_at DESC", [req.user.id])).rows
      : db.voyages.getAll().filter(v => v.statut === 'archived').sort((a, b) => (b.archived_at || '').localeCompare(a.archived_at || ''));
    res.json(all);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.get('/api/voyages/:id', authMiddleware, async (req, res) => {
  try {
    const v = await run(() => db.voyages.getById(req.params.id));
    if (!v) return res.status(404).json({ error: 'Voyage non trouvé' });
    if (IS_CLOUD && v.owner_id !== req.user.id)
      return res.status(403).json({ error: 'Accès refusé' });
    res.json(v);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages', authMiddleware, async (req, res) => {
  if (!req.body.nom || !String(req.body.nom).trim()) {
    return res.status(400).json({ error: 'Le champ nom est obligatoire' });
  }
  try { const item = await run(() => db.voyages.create({ ...req.body, owner_id: req.user.id })); res.json({ id: item.id }); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.put('/api/voyages/:id', authMiddleware, async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    if (IS_CLOUD && voyage.owner_id !== req.user.id)
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.voyages.update(req.params.id, req.body));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/voyages/:id', authMiddleware, async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    if (IS_CLOUD && voyage.owner_id !== req.user.id)
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.voyages.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.patch('/api/voyages/:id/statut', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const { statut } = req.body;
    const VALID = ['actif', 'terminé', 'draft', 'planned', 'active', 'completed', 'archived'];
    if (!VALID.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    const extra = {};
    if (statut === 'completed' && !voyage.completed_at) extra.completed_at = new Date().toISOString();
    if (statut === 'archived' && !voyage.archived_at)   extra.archived_at  = new Date().toISOString();
    await run(() => db.voyages.setStatutFull(req.params.id, statut, extra));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── RÉSERVATIONS ──────────────────────────────────────────────────────────

app.get('/api/voyages/:id/reservations', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { res.json(await run(() => db.reservations.getByVoyage(req.params.id))); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/reservations', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { const item = await run(() => db.reservations.create(req.params.id, req.body)); res.json({ id: item.id }); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.put('/api/reservations/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.reservations.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.reservations.update(req.params.id, req.body));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/reservations/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.reservations.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.reservations.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── AGENDA ────────────────────────────────────────────────────────────────

app.get('/api/voyages/:id/agenda', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { res.json(await run(() => db.agenda.getByVoyage(req.params.id))); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/agenda', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const { date, titre } = req.body || {};
    if (!date || !titre) return res.status(400).json({ error: 'Date et titre requis' });
    const item = await run(() => db.agenda.create(req.params.id, req.body));
    res.json({ id: item.id });
  } catch(e) {
    const detail = e?.message || String(e) || 'Erreur interne';
    console.error('[AGENDA CREATE ERROR]', detail, e?.stack);
    res.status(500).json({ error: detail });
  }
});

app.get('/api/agenda/:id/documents', authMiddleware, async (req, res) => {
  try {
    const event = await run(() => db.agenda.getById(req.params.id));
    if (!event) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(event.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    const docs = await run(() => db.documents.getByEvent ? db.documents.getByEvent(req.params.id) : []);
    res.json(docs);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.put('/api/agenda/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.agenda.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.agenda.update(req.params.id, req.body));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/agenda/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.agenda.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.agenda.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── DOCUMENTS ─────────────────────────────────────────────────────────────

app.get('/api/voyages/:id/documents', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { res.json(await run(() => db.documents.getByVoyage(req.params.id))); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/documents', authMiddleware, requireVoyageOwner(), upload.single('fichier'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
  if (!ALLOWED_MIMES.has(req.file.mimetype)) return res.status(400).json({ error: 'Type de fichier non autorisé' });
  try {
    const item = await run(() => db.documents.create(req.params.id, {
      nom: safeFilename(req.file.originalname),
      type_fichier: req.file.mimetype,
      taille: req.file.size,
      categorie: req.body.categorie || 'autre',
      event_id: req.body.event_id ? parseInt(req.body.event_id) : null,
      reservation_id: req.body.reservation_id ? parseInt(req.body.reservation_id) : null,
      contenu: req.file.buffer.toString('base64')
    }));
    res.json({ id: item.id });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/documents/:id/download', authMiddleware, async (req, res) => {
  try {
    const doc = await run(() => db.documents.getById(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Document non trouvé' });
    if (!(await checkVoyageOwnership(doc.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    const mime = ALLOWED_MIMES.has(doc.type_fichier) ? doc.type_fichier : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename(doc.nom)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(doc.contenu, 'base64'));
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.put('/api/documents/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.documents.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.documents.update(req.params.id, req.body));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/documents/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.documents.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.documents.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── HELPERS PIN & NOM ────────────────────────────────────────────────────

// P4 — Normalisation des prénoms : trim + casse titre (Unicode-aware, accents inclus)
// "jean-claude" → "Jean-Claude", "  MARIE  " → "Marie"
function _toTitleCase(str) {
  return String(str).trim()
    .toLowerCase()
    .replace(/(^|[\s\-'])(.)/gu, (_, sep, c) => sep + c.toUpperCase());
}

async function hashPin(pin) {
  if (pin == null) return null;
  return bcrypt.hash(String(pin).slice(0, 20), 10);
}

/** Vérifie un PIN entré par l'utilisateur contre le hash stocké.
 *  Fallback transparent pour les anciens PINs en clair (avant migration bcrypt). */
async function verifyPin(inputPin, storedPin) {
  if (!storedPin || inputPin == null) return false;
  // Nouveau format bcrypt
  if (storedPin.startsWith('$2b$') || storedPin.startsWith('$2a$')) {
    return bcrypt.compare(String(inputPin), storedPin);
  }
  // Ancien format en clair — comparaison à temps constant
  const a = Buffer.from(String(storedPin));
  const b = Buffer.from(String(inputPin));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── PARTICIPANTS ──────────────────────────────────────────────────────────

app.get('/api/voyages/:id/participants', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { res.json(await run(() => db.participants.getByVoyage(req.params.id))); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/participants', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const { nom, couleur, pin } = req.body;
    if (!nom?.trim()) return res.status(400).json({ error: 'Nom requis' });
    const nomNorm = _toTitleCase(nom.trim()).slice(0, 50);

    // Déduplication : avertir si un participant du même prénom (casse normalisée) existe déjà
    const existing = await run(() => db.participants.getByVoyage(req.params.id));
    const duplicate = existing.find(p =>
      p.nom.toLowerCase().trim() === nomNorm.toLowerCase()
    );
    if (duplicate) {
      return res.status(409).json({
        error: `Un participant nommé "${duplicate.nom}" existe déjà dans ce voyage`,
        duplicateId: duplicate.id
      });
    }

    const payload = {
      nom: nomNorm,
      couleur: couleur || '#6366F1',
      pin: await hashPin(pin),
      // 'role' volontairement exclu — toujours 'participant' par défaut
    };
    const item = await run(() => db.participants.create(req.params.id, payload));
    res.status(201).json({ id: item.id });
  } catch(e) {
    const msg = e?.message || String(e);
    console.error('[PARTICIPANT CREATE]', msg, e?.detail || '');
    res.status(500).json({ error: msg.split('\n')[0].slice(0, 120) || 'Erreur interne' });
  }
});

app.put('/api/participants/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.participants.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    const { nom, couleur, pin } = req.body;
    const payload = {};
    if (nom !== undefined) payload.nom = _toTitleCase(nom).slice(0, 50); // P4
    if (couleur !== undefined) payload.couleur = couleur;
    if (pin !== undefined) payload.pin = await hashPin(pin);
    // 'role' et 'voyage_id' volontairement exclus
    await run(() => db.participants.update(req.params.id, payload));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/participants/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.participants.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.participants.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/join-as-participant', authMiddleware, async (req, res) => {
  try {
    const voyageId = parseInt(req.params.id);

    // 1. Récupérer le voyage et vérifier l'ownership
    const voyage = await run(() => db.voyages.getById(voyageId));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    if (!(await checkVoyageOwnership(voyageId, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });

    // 2. Trouver ou créer le participant "owner"
    const parts = await run(() => db.participants.getByVoyage(voyageId));

    // Cherche un participant existant avec role='owner' (défensif : le champ peut être absent)
    let ownerPart = parts.find(p => p.role === 'owner');

    if (!ownerPart) {
      const nom = (req.body.nom || 'Organisateur').trim().slice(0, 50);
      const couleur = req.body.couleur || '#FF6B35';

      ownerPart = await run(() => db.participants.create(voyageId, {
        nom,
        couleur,
        pin: null,
        role: 'owner',
      }));
    }

    // 3. Générer un session token
    const sessionToken = createSession({
      participantId: ownerPart.id,
      voyageId,
      nom:     ownerPart.nom,
      couleur: ownerPart.couleur,
      role:    'owner',
    });

    // P3 — Créer le lien user ↔ participant pour ce voyage (organisateur qui rejoint en tant que participant)
    await run(() => db.user_participant_links.upsert(
      req.user.id, ownerPart.id, voyageId, ownerPart.nom
    )).catch(e => console.warn('[JOIN-AS-PARTICIPANT] link upsert:', e.message));

    // 4. Construire l'URL de partage (utilise le share_token du voyage)
    const shareToken = voyage.share_token || null;
    const partageUrl = shareToken ? `/partage/${shareToken}` : null;

    res.json({
      success: true,
      participant: {
        nom:            ownerPart.nom,
        participant_id: ownerPart.id,
        couleur:        ownerPart.couleur,
        role:           'owner',
      },
      sessionToken,
      partageUrl,
    });
  } catch(e) {
    console.error('[JOIN-AS-PARTICIPANT]', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/partage/:token/verify-pin', async (req, res) => {
  try {
    const rateKey = `${req.params.token}:${req.body.participant_id}`;
    if (!checkPinRate(rateKey)) {
      return res.status(429).json({ ok: false, error: 'Trop de tentatives, réessaie dans 1 minute' });
    }
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Token invalide' });
    const { participant_id, pin } = req.body;
    const parts = await run(() => db.participants.getByVoyage(voyage.id));
    const p = parts.find(x => x.id === +participant_id);
    if (!p || !p.pin) return res.json({ ok: false });
    const same = await verifyPin(pin, p.pin);
    if (!same) return res.json({ ok: false });

    // Générer la session
    const sessionToken = createSession({
      participantId: p.id,
      voyageId:      voyage.id,
      nom:           p.nom,
      couleur:       p.couleur,
      role:          p.role || 'participant',
    });

    res.json({ ok: true, sessionToken });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── DÉPENSES ──────────────────────────────────────────────────────────────

app.get('/api/voyages/:id/depenses', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { res.json(await run(() => db.depenses.getByVoyage(req.params.id))); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/depenses', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const item = await run(() => db.depenses.create(req.params.id, req.body));
    res.json({ id: item.id });
  } catch(e) {
    console.error('[DEPENSE POST]', e.message);
    const msg = e.message || '';
    if (msg.includes('column') || msg.includes('does not exist'))
      return res.status(500).json({ error: 'Colonne manquante — rechargez la page' });
    if (msg.includes('not-null') || msg.includes('null value'))
      return res.status(400).json({ error: 'Champ obligatoire manquant' });
    if (msg.includes('syntax') || msg.includes('invalid input'))
      return res.status(400).json({ error: 'Données invalides (' + msg.split('\n')[0].slice(0,60) + ')' });
    res.status(500).json({ error: msg.split('\n')[0].slice(0, 100) || 'Erreur interne' });
  }
});

app.put('/api/depenses/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.depenses.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.depenses.update(req.params.id, req.body));
    res.json({ ok: true });
  } catch(e) {
    console.error('[DEPENSE PUT]', e.message);
    const msg = e.message || '';
    res.status(500).json({ error: msg.split('\n')[0].slice(0, 100) || 'Erreur interne' });
  }
});

app.delete('/api/depenses/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.depenses.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.depenses.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── BAGAGES ───────────────────────────────────────────────────────────────

app.get('/api/voyages/:id/bagages', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { res.json(await run(() => db.bagages.getByVoyage(req.params.id))); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/bagages', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { const item = await run(() => db.bagages.create(req.params.id, req.body)); res.json({ id: item.id }); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:vid/bagages/bulk', authMiddleware, requireVoyageOwner('vid'), async (req, res) => {
  try {
    const { participant_id, items } = req.body;
    await run(() => db.bagages.deleteByVoyageParticipant(req.params.vid, participant_id));
    for (const item of items) {
      await run(() => db.bagages.create(req.params.vid, { ...item, participant_id }));
    }
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.put('/api/bagages/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.bagages.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.bagages.update(req.params.id, req.body));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/bagages/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.bagages.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.bagages.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── PARTAGE ────────────────────────────────────────────────────────────────

function genererToken() {
  return crypto.randomBytes(9).toString('base64url'); // 72 bits, URL-safe
}

app.post('/api/voyages/:id/partager', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (!voyage) return res.status(404).json({ error: 'Voyage non trouvé' });
    let token = voyage.share_token;
    if (!token) {
      token = genererToken();
      await run(() => db.voyages.setToken(req.params.id, token));
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ token, url: `${baseUrl}/share/${token}` });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── S6 — Rotation du lien de partage ───────────────────────────────────────
// Génère un nouveau token et invalide l'ancien. Les participants ayant
// l'ancien lien devront obtenir le nouveau auprès de l'organisateur.
app.post('/api/voyages/:id/rotate-token', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const newToken = genererToken();
    await run(() => db.voyages.setToken(req.params.id, newToken));
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    console.log(`[S6] Token rotaté — voyage ${req.params.id}`);
    res.json({ token: newToken, url: `${baseUrl}/share/${newToken}` });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ── Notification admin : un participant vient de rejoindre ────────────────────
app.post('/api/partage/:token/first-access', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Token invalide' });
    const { nom } = req.body;
    if (!nom) return res.status(400).json({ error: 'nom requis' });

    // Push uniquement aux abonnements admin (participant_id IS NULL)
    const allSubs = await run(() => db.push_subscriptions.getByVoyage(voyage.id));
    const adminSubs = allSubs.filter(s => !s.participant_id);
    if (!adminSubs.length) return res.json({ ok: true, sent: 0 });

    const payload = JSON.stringify({
      title: `🧭 ${nom} vient de rejoindre !`,
      body:  `${nom} a rejoint le voyage "${voyage.nom}"`,
      tag:   `join-${voyage.id}-${nom.replace(/\s+/g,'_')}`,
      url:   '/'
    });

    let sent = 0;
    for (const sub of adminSubs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        sent++;
      } catch(e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          run(() => db.push_subscriptions.deleteByEndpoint?.(sub.endpoint)).catch(() => {});
        }
      }
    }
    console.log(`[Join] ${nom} → voyage ${voyage.id} — ${sent} push admin envoyés`);
    res.json({ ok: true, sent });
  } catch(e) {
    console.error('[first-access]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Sauvegarde email + envoi magic link ───────────────────────────────────────
app.post('/api/partage/:token/save-email', async (req, res) => {
  // S4 — rate limit : 5 demandes de magic link / heure / IP
  if (!checkMagicLinkRate(req.ip)) return res.status(429).json({ error: 'Trop de demandes, réessaie dans une heure' });
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { email, participant_nom } = req.body;
    if (!email || !participant_nom) return res.status(400).json({ error: 'email et participant_nom requis' });
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email)) return res.status(400).json({ error: 'Email invalide' });

    // Sauvegarde dans participant_emails (idempotent)
    await run(() => db.participant_emails.save(voyage.id, participant_nom, email));

    // Vérifier si cet email correspond à un compte admin existant
    const existingUser = await run(() => db.users.getByEmail(email));
    const has_account  = !!existingUser;

    // AP-9 : si le compte existe, créer immédiatement le lien user ↔ participant
    // sans attendre le login ou le clic sur le magic link.
    if (existingUser) {
      try {
        const allParts = await run(() => db.participants.getByVoyage(voyage.id));
        const part     = allParts.find(p => p.nom === participant_nom);
        if (part) {
          await run(() => db.user_participant_links.upsert(
            existingUser.id, part.id, voyage.id, participant_nom
          ));
          console.log(`[AP-9] Lien user_participant créé : user ${existingUser.id} ↔ "${participant_nom}" voyage ${voyage.id}`);
        }
      } catch (e) {
        console.warn('[AP-9] user_participant_links upsert:', e.message);
      }
    }

    // Envoi du magic link (silencieux si pas de config email)
    try {
      const { generateAndSend } = require('./services/magicLink');
      const result = await generateAndSend({
        email,
        voyageId:       voyage.id,
        participantNom: participant_nom,
        shareToken:     req.params.token,
        voyageNom:      voyage.nom
      });
      const sent = result?.emailSent !== false || !result?.magicUrl; // true si email réellement envoyé
      console.log(`[MagicLink] ${sent ? 'Envoyé' : 'Dev — lien console'} → ${email} pour voyage ${voyage.id}${has_account ? ' (compte existant détecté)' : ''}`);
      res.json({
        ok:          true,
        magic_sent:  sent,
        has_account,
        // En mode dev (pas de config email), on renvoie l'URL directement côté client
        magic_url:   result?.magicUrl || null,
      });
    } catch (emailErr) {
      console.error('[MagicLink] Envoi échoué (email sauvegardé quand même):', emailErr.message);
      res.json({ ok: true, magic_sent: false, has_account, magic_url: null });
    }
  } catch (e) {
    console.error('[save-email]', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Store éphémère pour les jetons _mid (single-use, 60s TTL) ─────────────────
// Évite de mettre l'identité (email, nom) en clair dans l'URL / les logs serveur.
const _pendingMidTokens = new Map(); // token → { identity, expires }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _pendingMidTokens) {
    if (v.expires < now) _pendingMidTokens.delete(k);
  }
}, 60_000); // nettoyage toutes les 60s

// Échange du jeton opaque contre l'identité (single-use)
app.get('/api/magic/decode/:token', (req, res) => {
  const entry = _pendingMidTokens.get(req.params.token);
  if (!entry || entry.expires < Date.now()) {
    _pendingMidTokens.delete(req.params.token);
    return res.status(404).json({ error: 'Token expiré ou invalide' });
  }
  _pendingMidTokens.delete(req.params.token); // consommé une seule fois
  res.json(entry.identity);
});

// ── Validation du magic link et redirection ───────────────────────────────────
app.get('/auth/magic/:magicToken', async (req, res) => {
  try {
    const record = await run(() => db.magic_links.getByToken(req.params.magicToken));

    // Token inconnu
    if (!record) return res.send(_magicErrorPage('Lien invalide ou déjà utilisé.'));

    // Déjà utilisé
    if (record.used_at) return res.send(_magicErrorPage('Ce lien a déjà été utilisé. Demande un nouveau lien depuis la page du voyage.'));

    // Expiré
    if (new Date(record.expires_at) < new Date()) return res.send(_magicErrorPage('Ce lien a expiré. Demande un nouveau lien depuis la page du voyage.', record.voyage_id));

    // Marquer comme utilisé
    await run(() => db.magic_links.markUsed(req.params.magicToken));

    // Récupérer le voyage + le participant pour avoir la couleur
    const voyage = await run(() => db.voyages.getById(record.voyage_id));
    if (!voyage) return res.send(_magicErrorPage('Voyage introuvable.'));

    const shareToken = req.query.v || voyage.share_token;
    if (!shareToken) return res.send(_magicErrorPage('Token de partage manquant.'));

    const [participants, existingUser] = await Promise.all([
      run(() => db.participants.getByVoyage(record.voyage_id)),
      run(() => db.users.getByEmail(record.email))
    ]);
    const participant   = participants.find(p => p.nom === record.participant_nom);
    const couleur       = participant?.couleur || '#F97316';
    const participantId = participant?.id || null;

    // Créer le lien user ↔ participant si compte existant
    if (existingUser) {
      await run(() => db.user_participant_links.upsert(
        existingUser.id, participantId, record.voyage_id, record.participant_nom
      )).catch(e => console.warn('[MagicLink] user_participant_links upsert:', e.message));
      console.log(`[MagicLink] Compte lié : user ${existingUser.id} ↔ participant "${record.participant_nom}" voyage ${record.voyage_id}`);
    }

    // Construire l'identité et la stocker sous un jeton opaque (60s, single-use)
    // → ni l'email ni les données personnelles ne transitent dans l'URL / les logs
    const identity = {
      nom:            record.participant_nom,
      couleur,
      email:          record.email,
      participant_id: participantId,
      from_magic:     true,
      has_account:    !!existingUser
    };
    const midToken = crypto.randomBytes(16).toString('base64url');
    _pendingMidTokens.set(midToken, { identity, expires: Date.now() + 60_000 });

    res.redirect(302, `/share/${shareToken}?_mid=${midToken}`);
  } catch (e) {
    console.error('[magic-link]', e.message);
    res.send(_magicErrorPage('Une erreur est survenue. Réessaie depuis la page du voyage.'));
  }
});

function _magicErrorPage(msg, voyageId) {
  // Bouton "Renvoyer" visible uniquement si on connaît le voyage
  const renvoyerBtn = voyageId
    ? `<button onclick="resendLink()" style="display:inline-block;background:#f97316;color:#fff;border-radius:10px;padding:12px 24px;font-size:15px;font-weight:700;border:none;cursor:pointer;margin-bottom:12px">
         Renvoyer un lien magique →
       </button>`
    : '';

  const renvoyerScript = voyageId
    ? `<script>
async function resendLink() {
  const email = prompt('Ton adresse email pour recevoir le lien :');
  if (!email || !email.includes('@')) return;
  const btn = document.querySelector('button');
  btn.textContent = 'Envoi…';
  btn.disabled = true;
  try {
    const r = await fetch('/api/partage/${voyageId}/magic-link', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, participantNom: '' })
    });
    const d = await r.json();
    if (d.ok) {
      btn.textContent = '✅ Lien envoyé ! Vérifie tes emails.';
    } else {
      btn.textContent = 'Erreur — réessaie';
      btn.disabled = false;
    }
  } catch(e) {
    btn.textContent = 'Erreur réseau — réessaie';
    btn.disabled = false;
  }
}
<\/script>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CrewiGO — Lien expiré</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;text-align:center;padding:24px}
.card{background:#1e293b;border-radius:20px;padding:40px 32px;max-width:400px}
h2{margin:0 0 12px;font-size:1.4rem}p{color:#94a3b8;margin:0 0 24px;line-height:1.6}
a{display:inline-block;background:#475569;color:#fff;border-radius:10px;padding:12px 24px;text-decoration:none;font-weight:700;margin-top:8px;font-size:14px}
.btn-group{display:flex;flex-direction:column;gap:8px;align-items:center}</style>
${renvoyerScript}
</head><body><div class="card"><div style="font-size:2.5rem;margin-bottom:16px">🔮</div>
<h2>Lien magique</h2><p>${msg}</p>
<div class="btn-group">
${renvoyerBtn}
<a href="/">Retour à CrewiGO</a>
</div></div></body></html>`;
}

app.get('/api/partage/:token', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const [reservations, agenda, participants, depenses, bagages, docsRaw] = await Promise.all([
      run(() => db.reservations.getByVoyage(voyage.id)),
      run(() => db.agenda.getByVoyage(voyage.id)),
      run(() => db.participants.getByVoyage(voyage.id)),
      run(() => db.depenses.getByVoyage(voyage.id)),
      run(() => db.bagages.getByVoyage(voyage.id)),
      run(() => db.documents.getByVoyage(voyage.id))
    ]);
    const documents = docsRaw.map(({ contenu, ...meta }) => meta);
    // Ne jamais exposer le PIN — transmettre uniquement has_pin
    const participantsSafe = participants.map(({ pin, ...p }) => ({ ...p, has_pin: !!pin }));
    res.json({ voyage, reservations, agenda, participants: participantsSafe, depenses, bagages, documents });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── PUSH NOTIFICATIONS & DEMANDES ──────────────────────────────────────────

async function pushToAll(voyageId, payload) {
  const subs = await run(() => db.push_subscriptions.getByVoyage(voyageId));
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await run(() => db.push_subscriptions.deleteByEndpoint && db.push_subscriptions.deleteByEndpoint(sub.endpoint)).catch(() => {});
      }
    }
  }
}

// ─── Rappel de départ : notification J-1 ────────────────────────────────────
// Tourne toutes les heures. Envoie un push aux abonnés des voyages qui
// commencent demain, sauf si le rappel a déjà été envoyé ce jour-là.
// On stocke l'état dans un Set en mémoire (redémarrage = reset, acceptable).
const _departureReminderSent = new Set(); // "voyageId_YYYY-MM-DD"

async function _checkDepartureReminders() {
  if (!process.env.VAPID_PUBLIC_KEY) return; // push désactivé
  try {
    const voyages = await run(() => db.voyages.getAllForReminders()).catch(() => []);
    if (!voyages || !voyages.length) return;

    const now      = new Date();
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const todayStr    = now.toISOString().split('T')[0];

    for (const v of voyages) {
      if (!v.date_debut || v.statut === 'terminé') continue;
      const debutStr = String(v.date_debut).split('T')[0];
      if (debutStr !== tomorrowStr) continue;

      const key = `${v.id}_${todayStr}`;
      if (_departureReminderSent.has(key)) continue;
      _departureReminderSent.add(key);

      const dest = v.destination ? ` · ${v.destination}` : '';
      await pushToAll(v.id, {
        title: `✈️ Départ demain ! — ${v.nom}`,
        body: `Votre voyage commence demain${dest}. Bon voyage ! 🌍`,
        tag: `departure-${v.id}-${todayStr}`,
        url: '/'
      });
      console.log(`[Push] Rappel départ envoyé — voyage ${v.id} (${v.nom})`);
    }
  } catch(e) {
    console.warn('[Push] Erreur rappel départ:', e.message);
  }
}

// Lancer le check au démarrage (après 30s) puis toutes les heures
setTimeout(() => _checkDepartureReminders(), 30000);
setInterval(() => _checkDepartureReminders(), 3600000);

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || 'BCV64icXiouIl1g8KVeaEyGMLbhD0M5RFx_qDc5LGiAbIS49-QGP1XOeQWnLEGUnOfmMBH6dQbn20J1sekxQWF0' });
});

app.post('/api/push/subscribe/:voyageId', authMiddleware, requireVoyageOwner('voyageId'), async (req, res) => {
  try {
    await run(() => db.push_subscriptions.upsert(req.params.voyageId, req.body));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/push/subscribe-partage/:token', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    await run(() => db.push_subscriptions.upsert(voyage.id, req.body));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/demandes/:token', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Voyage non trouvé' });

    const demande = await run(() => db.demandes.create(voyage.id, req.body));

    const subs = await run(() => db.push_subscriptions.getByVoyage(voyage.id));
    const payload = JSON.stringify({
      title: `📩 Demande de ${req.body.auteur || 'un invité'}`,
      body: req.body.message || `Modification : ${req.body.element_nom}`,
      tag: 'demande-' + demande.id,
      url: '/'
    });

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch(e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await run(() => db.push_subscriptions.deleteByEndpoint && db.push_subscriptions.deleteByEndpoint(sub.endpoint)).catch(() => {});
        }
      }
    }

    res.json({ ok: true, id: demande.id });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.get('/api/voyages/:id/demandes', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { res.json(await run(() => db.demandes.getByVoyage(req.params.id))); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.put('/api/demandes/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.demandes.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.demandes.update(req.params.id, req.body));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/demandes/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.demandes.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.demandes.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── ATTRIBUTIONS PRIVÉES ────────────────────────────────────────────────────

app.get('/api/voyages/:id/attributions', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const attrs = await run(() => db.attributions.getByVoyage(req.params.id));
    // Inclure les liens pour chaque attribution
    const enriched = await Promise.all(attrs.map(async (a) => ({
      ...a,
      links: await run(() => db.attribution_links.getByAttribution(a.id))
    })));
    res.json(enriched);
  }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/attributions', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { const item = await run(() => db.attributions.create(req.params.id, req.body)); res.json({ id: item.id }); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/attributions/:id', authMiddleware, async (req, res) => {
  try {
    const item = await run(() => db.attributions.getById(req.params.id));
    if (!item) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(item.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    // Supprimer aussi tous les liens associés
    await run(() => db.attribution_links.deleteByAttribution(req.params.id));
    await run(() => db.attributions.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── LIENS D'ATTRIBUTION ──────────────────────────────────────────────────────
// Validation URL basique (https/http uniquement — pas de javascript:, data:, etc.)
function _validateLinkUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url.trim());
    return ['https:', 'http:'].includes(u.protocol);
  } catch { return false; }
}

// Helper : vérifier que l'attribution appartient à l'organisateur connecté
async function _checkLinkOwner(linkId, userId) {
  const link = await run(() => db.attribution_links.getById(linkId));
  if (!link) return null;
  const attr = await run(() => db.attributions.getById(link.attribution_id));
  if (!attr) return null;
  const ok = await checkVoyageOwnership(attr.voyage_id, userId);
  return ok ? link : null;
}

app.get('/api/attributions/:id/links', authMiddleware, async (req, res) => {
  try {
    const attr = await run(() => db.attributions.getById(req.params.id));
    if (!attr) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(attr.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    res.json(await run(() => db.attribution_links.getByAttribution(req.params.id)));
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/attributions/:id/links', authMiddleware, async (req, res) => {
  try {
    const attr = await run(() => db.attributions.getById(req.params.id));
    if (!attr) return res.status(404).json({ error: 'Introuvable' });
    if (!(await checkVoyageOwnership(attr.voyage_id, req.user.id)))
      return res.status(403).json({ error: 'Accès refusé' });
    const { titre, url, description, type } = req.body;
    if (!titre?.trim()) return res.status(400).json({ error: 'Titre requis' });
    if (!_validateLinkUrl(url)) return res.status(400).json({ error: 'URL invalide (https:// ou http:// requis)' });
    const VALID_TYPES = ['billet', 'qrcode', 'document', 'voucher', 'information', 'autre'];
    const linkType = VALID_TYPES.includes(type) ? type : 'autre';
    const link = await run(() => db.attribution_links.create(req.params.id, {
      titre: titre.trim(), url: url.trim(),
      description: description?.trim() || null,
      type: linkType
    }));
    res.json(link);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.put('/api/attribution-links/:id', authMiddleware, async (req, res) => {
  try {
    const link = await _checkLinkOwner(req.params.id, req.user.id);
    if (!link) return res.status(404).json({ error: 'Introuvable ou accès refusé' });
    const { titre, url, description, type, position } = req.body;
    if (!titre?.trim()) return res.status(400).json({ error: 'Titre requis' });
    if (!_validateLinkUrl(url)) return res.status(400).json({ error: 'URL invalide' });
    const VALID_TYPES = ['billet', 'qrcode', 'document', 'voucher', 'information', 'autre'];
    const updated = await run(() => db.attribution_links.update(req.params.id, {
      titre: titre.trim(), url: url.trim(),
      description: description?.trim() || null,
      type: VALID_TYPES.includes(type) ? type : 'autre',
      position: +position || link.position
    }));
    res.json(updated);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/attribution-links/:id', authMiddleware, async (req, res) => {
  try {
    const link = await _checkLinkOwner(req.params.id, req.user.id);
    if (!link) return res.status(404).json({ error: 'Introuvable ou accès refusé' });
    await run(() => db.attribution_links.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.get('/api/partage/:token/mes-infos/:participantId', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const items = await run(() => db.attributions.getByParticipant(voyage.id, req.params.participantId));
    // Enrichir : document + liens pour chaque attribution
    const enriched = await Promise.all(items.map(async (a) => {
      const [doc, links] = await Promise.all([
        a.document_id ? run(() => db.documents.getById(a.document_id)) : Promise.resolve(null),
        run(() => db.attribution_links.getByAttribution(a.id))
      ]);
      return {
        ...a,
        document: doc ? { id: doc.id, nom: doc.nom, type_fichier: doc.type_fichier } : null,
        links: links || []
      };
    }));
    res.json(enriched);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── MESSAGES PRIVÉS ───────────────────────────────────────────────────────

app.get('/api/voyages/:id/messages-prives', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { res.json(await run(() => db.messages_prives.getByVoyage(req.params.id))); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/messages-prives', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const { participant_id, message } = req.body;
    if (!participant_id || !message?.trim()) return res.status(400).json({ error: 'Données manquantes' });
    const item = await run(() => db.messages_prives.create(req.params.id, {
      participant_id: +participant_id, auteur: 'Organisateur', message: message.trim()
    }));
    res.json(item);
    // Push ciblé vers le participant
    const subs = await run(() => db.push_subscriptions.getByParticipant(req.params.id, participant_id));
    if (subs.length) {
      const voyage = await run(() => db.voyages.getById(req.params.id));
      const apercu = message.trim().length > 60 ? message.trim().slice(0, 60) + '…' : message.trim();
      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({
              title: `📬 Message privé — ${voyage?.nom || 'Voyage'}`,
              body: apercu,
              tag: 'mp-' + item.id,
              url: voyage?.share_token ? `/share/${voyage.share_token}?tab=preparation` : '/'
            })
          );
        } catch(e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await run(() => db.push_subscriptions.deleteByEndpoint && db.push_subscriptions.deleteByEndpoint(sub.endpoint)).catch(() => {});
          }
        }
      }
    }
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/voyages/:id/messages-prives/:msgId', authMiddleware, async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    if (IS_CLOUD && voyage.owner_id !== req.user.id)
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.messages_prives.delete(req.params.msgId));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.get('/api/partage/:token/messages-prives/:participantId', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const msgs = await run(() => db.messages_prives.getByParticipant(voyage.id, req.params.participantId));
    // Marquer comme lus
    msgs.filter(m => !m.lu).forEach(m => run(() => db.messages_prives.marquerLu(m.id)).catch(() => {}));
    res.json(msgs);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── COMMENTAIRES ──────────────────────────────────────────────────────────

app.get('/api/partage/:token/commentaires', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    res.json(await run(() => db.commentaires.getByVoyage(voyage.id)));
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/commentaires', async (req, res) => {
  // S4-ext — Rate limit : 20 messages / 5 min / IP+token (anti-spam public)
  if (!checkChatRate(req.ip, req.params.token)) {
    return res.status(429).json({ error: 'Trop de messages, attends quelques minutes' });
  }
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { auteur, message, reply_to_id, reply_to_auteur, reply_to_preview } = req.body;
    if (!auteur || !message?.trim()) return res.status(400).json({ error: 'Données manquantes' });
    const safeAuteur = String(auteur).trim().slice(0, 50);
    const safeMessage = message.trim().slice(0, 2000);
    const data = {
      auteur: safeAuteur, message: safeMessage,
      reply_to_id: reply_to_id ? +reply_to_id : null,
      reply_to_auteur: reply_to_auteur ? String(reply_to_auteur).slice(0, 50) : null,
      reply_to_preview: reply_to_preview ? String(reply_to_preview).slice(0, 100) : null
    };
    const item = await run(() => db.commentaires.create(voyage.id, data));
    res.json(item);
    const apercu = safeMessage.length > 60 ? safeMessage.slice(0, 60) + '…' : safeMessage;
    pushToAll(voyage.id, {
      title: `💬 ${voyage.nom}`,
      body: `${safeAuteur} : ${apercu}`,
      tag: 'commentaire-' + voyage.id,
      url: `/share/${req.params.token}?tab=discussion`
    }).catch(() => {});
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/commentaires/:id/react', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { auteur, emoji } = req.body;
    if (!auteur || !emoji) return res.status(400).json({ error: 'Données manquantes' });
    const ALLOWED_EMOJIS = ['👍','❤️','👌','🎉','🔥'];
    if (!ALLOWED_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Emoji non autorisé' });
    const safeAuteur = String(auteur).trim().slice(0, 50);
    const item = await run(() => db.commentaires.react(+req.params.id, emoji, safeAuteur));
    if (!item) return res.status(404).json({ error: 'Message introuvable' });
    res.json(item);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/partage/:token/commentaires/:id', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    // Vérifier que le commentaire appartient bien à ce voyage (anti-IDOR)
    const all = await run(() => db.commentaires.getByVoyage(voyage.id));
    const commentaire = all.find(c => c.id === +req.params.id);
    if (!commentaire) return res.status(403).json({ error: 'Interdit' });
    // L'auteur est obligatoire pour prouver l'identité
    if (!req.body.auteur) return res.status(400).json({ error: 'Auteur requis' });
    if (req.body.auteur !== commentaire.auteur)
      return res.status(403).json({ error: 'Tu ne peux supprimer que tes propres commentaires' });
    await run(() => db.commentaires.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/voyages/:id/commentaires', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { res.json(await run(() => db.commentaires.getByVoyage(req.params.id))); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/commentaires', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const { auteur, message, reply_to_id, reply_to_auteur, reply_to_preview } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message vide' });
    const nom = auteur || 'Organisateur';
    const data = {
      auteur: nom, message: message.trim(),
      reply_to_id: reply_to_id ? +reply_to_id : null,
      reply_to_auteur: reply_to_auteur ? String(reply_to_auteur).slice(0, 50) : null,
      reply_to_preview: reply_to_preview ? String(reply_to_preview).slice(0, 100) : null
    };
    const item = await run(() => db.commentaires.create(req.params.id, data));
    res.json(item);
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (voyage?.share_token) {
      const apercu = message.trim().length > 60 ? message.trim().slice(0, 60) + '…' : message.trim();
      pushToAll(req.params.id, {
        title: `💬 ${voyage.nom}`,
        body: `${nom} : ${apercu}`,
        tag: 'commentaire-' + req.params.id,
        url: `/share/${voyage.share_token}?tab=discussion`
      }).catch(() => {});
    }
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/voyages/:id/commentaires/:cid/react', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const { auteur, emoji } = req.body;
    if (!auteur || !emoji) return res.status(400).json({ error: 'Données manquantes' });
    const ALLOWED_EMOJIS = ['👍','❤️','👌','🎉','🔥'];
    if (!ALLOWED_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Emoji non autorisé' });
    const item = await run(() => db.commentaires.react(+req.params.cid, emoji, String(auteur).trim().slice(0, 50)));
    if (!item) return res.status(404).json({ error: 'Message introuvable' });
    res.json(item);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/voyages/:id/commentaires/:cid', authMiddleware, async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    if (IS_CLOUD && voyage.owner_id !== req.user.id)
      return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.commentaires.delete(req.params.cid));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── DOCS PARTICIPANTS ──────────────────────────────────────────────────────

app.get('/api/partage/:token/mes-docs/:participantId', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    res.json(await run(() => db.docs_participants.getByParticipant(voyage.id, req.params.participantId)));
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/mes-docs', upload.single('fichier'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
  if (!ALLOWED_MIMES.has(req.file.mimetype)) return res.status(400).json({ error: 'Type de fichier non autorisé' });
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const doc = await run(() => db.docs_participants.create(voyage.id, {
      participant_id: +req.body.participant_id,
      nom: safeFilename(req.file.originalname),
      type_fichier: req.file.mimetype,
      taille: req.file.size,
      categorie: req.body.categorie || 'autre',
      contenu: req.file.buffer.toString('base64')
    }));
    res.json({ id: doc.id, nom: doc.nom, type_fichier: doc.type_fichier, taille: doc.taille });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/partage/:token/mes-docs/:docId/download', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const doc = await run(() => db.docs_participants.getById(req.params.docId));
    if (!doc || doc.voyage_id !== voyage.id) return res.status(404).json({ error: 'Document introuvable' });
    const mime = ALLOWED_MIMES.has(doc.type_fichier) ? doc.type_fichier : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename(doc.nom)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(doc.contenu, 'base64'));
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/partage/:token/mes-docs/:docId', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const doc = await run(() => db.docs_participants.getById(req.params.docId));
    if (!doc || doc.voyage_id !== voyage.id) return res.status(404).json({ error: 'Document introuvable' });
    await run(() => db.docs_participants.delete(req.params.docId));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.get('/api/voyages/:id/docs-participants', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try { res.json(await run(() => db.docs_participants.getByVoyage(req.params.id))); }
  catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.get('/api/voyages/:id/docs-participants/:docId/download', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const doc = await run(() => db.docs_participants.getById(req.params.docId));
    if (!doc || doc.voyage_id !== +req.params.id) return res.status(404).json({ error: 'Document introuvable' });
    const mime = ALLOWED_MIMES.has(doc.type_fichier) ? doc.type_fichier : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename(doc.nom)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(doc.contenu, 'base64'));
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── GÉOLOCALISATION (SSE) ────────────────────────────────────────────────────

// voyageId (string) → Set<res> — clients SSE actifs
const geoClients = new Map();

async function broadcastLocations(voyageId) {
  const clients = geoClients.get(String(voyageId));
  if (!clients || clients.size === 0) return;
  try {
    const locs = await run(() => db.locations.getByVoyage(voyageId));
    const data = `data: ${JSON.stringify(locs)}\n\n`;
    clients.forEach(res => { try { res.write(data); } catch(e) {} });
  } catch(e) {}
}

// Flux SSE — connexion persistante, push immédiat à chaque changement
app.get('/api/partage/:token/locations/stream', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Token invalide' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // désactive le buffer Nginx / Railway
    res.flushHeaders();

    const vid = String(voyage.id);
    if (!geoClients.has(vid)) geoClients.set(vid, new Set());
    geoClients.get(vid).add(res);

    // État initial dès la connexion
    const locs = await run(() => db.locations.getByVoyage(voyage.id));
    res.write(`data: ${JSON.stringify(locs)}\n\n`);

    // Heartbeat toutes les 25 s pour garder la connexion vivante
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch(e) {} }, 25000);

    req.on('close', () => {
      clearInterval(hb);
      const set = geoClients.get(vid);
      if (set) { set.delete(res); if (set.size === 0) geoClients.delete(vid); }
    });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// Fallback REST (utilisé si SSE indisponible)
app.get('/api/partage/:token/locations', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Token invalide' });
    res.json(await run(() => db.locations.getByVoyage(voyage.id)));
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/location', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Token invalide' });
    const { device_id, participant_id, nom, couleur, lat, lng } = req.body;
    if (!device_id || !nom || lat == null || lng == null) return res.status(400).json({ error: 'Données manquantes' });
    await run(() => db.locations.upsert(voyage.id, { device_id, participant_id: participant_id || null, nom, couleur: couleur || '#6366F1', lat, lng }));
    broadcastLocations(voyage.id); // push SSE à tous les viewers
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/partage/:token/location/:device_id', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Token invalide' });
    await run(() => db.locations.delete(voyage.id, req.params.device_id));
    broadcastLocations(voyage.id); // push SSE — retire le marker chez tout le monde
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── PARTAGE : RÉSERVATIONS + DOCUMENTS (lecture seule via token) ──────────

app.get('/api/partage/:token/reservations', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const resas = await run(() => db.reservations.getByVoyage(voyage.id));
    res.json(resas);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.get('/api/partage/:token/documents', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const [docs, attrs] = await Promise.all([
      run(() => db.documents.getByVoyage(voyage.id)),
      run(() => db.attributions.getByVoyage(voyage.id))
    ]);
    // Exclure les documents liés à une attribution (documents privés par participant)
    // Ces docs sont accessibles via /mes-infos/:participantId, jamais dans la liste commune
    const privateDocIds = new Set(attrs.filter(a => a.document_id).map(a => a.document_id));
    res.json(docs.filter(d => !privateDocIds.has(d.id)));
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ── Dépenses publiques (participants) — GET liste + POST créer ───────────────
app.get('/api/partage/:token/depenses', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const depenses = await run(() => db.depenses.getByVoyage(voyage.id));
    res.json(depenses);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/depenses', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { titre, montant, date, categorie, payeur_id, participants_ids } = req.body;
    if (!titre || !montant) return res.status(400).json({ error: 'Titre et montant requis' });
    if (parseFloat(montant) <= 0) return res.status(400).json({ error: 'Le montant doit être positif' });
    // Valider que participants_ids est un JSON valide si fourni
    let safeParts = '[]';
    if (participants_ids) {
      try { JSON.parse(participants_ids); safeParts = participants_ids; }
      catch(e) { return res.status(400).json({ error: 'participants_ids invalide' }); }
    }
    const item = await run(() => db.depenses.create(voyage.id, {
      titre: titre.trim(), montant: parseFloat(montant), date, categorie: categorie || 'autre',
      payeur_id: payeur_id || null,
      participants_ids: safeParts
    }));
    res.json(item);
  } catch(e) { console.error('[DEPENSE CREATE]', e.message, e.detail || ''); res.status(500).json({ error: 'Erreur interne' }); }
});

// ── Téléchargement public d'un document (réservation / agenda) ────────────
app.get('/api/partage/:token/documents/:docId/download', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const doc = await run(() => db.documents.getById(req.params.docId));
    if (!doc || doc.voyage_id !== voyage.id) return res.status(404).json({ error: 'Document introuvable' });
    const mime = ALLOWED_MIMES.has(doc.type_fichier) ? doc.type_fichier : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename(doc.nom)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(doc.contenu, 'base64'));
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── PRE-TRIP HUB ─────────────────────────────────────────────────────────

// ── Hype Meter ────────────────────────────────────────────────────────────
app.get('/api/partage/:token/hype', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const votes = await run(() => db.hype_votes.getByVoyage(voyage.id));
    const total = votes.length;
    const moyenne = total > 0 ? Math.round((votes.reduce((s, v) => s + v.score, 0) / total) * 10) / 10 : 0;
    res.json({ votes, moyenne, total });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/hype', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { score, emoji } = req.body;
    const auteur = req.body.auteur;
    if (!auteur || !score || score < 1 || score > 5) return res.status(400).json({ error: 'Données invalides' });
    const safeAuteur = String(auteur).trim().slice(0, 50);
    await run(() => db.hype_votes.upsert(voyage.id, { auteur: safeAuteur, score: +score, emoji: emoji ? String(emoji).slice(0, 10) : null }));
    const votes = await run(() => db.hype_votes.getByVoyage(voyage.id));
    const total = votes.length;
    const moyenne = total > 0 ? Math.round((votes.reduce((s, v) => s + v.score, 0) / total) * 10) / 10 : 0;
    res.json({ ok: true, moyenne, total });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ── Profils participants ───────────────────────────────────────────────────
app.get('/api/partage/:token/profils', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    res.json(await run(() => db.participant_profiles.getByVoyage(voyage.id)));
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/profil', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { auteur, participant_id, couleur, truc_en_voyage, chaud_pour, refuse } = req.body;
    if (!auteur) return res.status(400).json({ error: 'Auteur requis' });
    await run(() => db.participant_profiles.upsert(voyage.id, { auteur, participant_id: participant_id || null, couleur, truc_en_voyage, chaud_pour, refuse }));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ── Wishlist collaborative ─────────────────────────────────────────────────
app.get('/api/partage/:token/wishlist', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const items = await run(() => db.wishlist.getByVoyage(voyage.id));
    // Normaliser likes (peut être string JSON en PG)
    res.json(items.map(w => ({ ...w, likes: typeof w.likes === 'string' ? JSON.parse(w.likes || '[]') : (w.likes || []) })));
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/wishlist', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { auteur, titre, description, type, url } = req.body;
    if (!auteur || !titre?.trim()) return res.status(400).json({ error: 'Données manquantes' });
    const item = await run(() => db.wishlist.create(voyage.id, { auteur, titre: titre.trim(), description: description?.trim() || null, type: type || 'activite', url: url?.trim() || null }));
    res.json({ ...item, likes: [] });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/wishlist/:id/like', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { auteur } = req.body;
    if (!auteur) return res.status(400).json({ error: 'Auteur requis' });
    const safeAuteur = String(auteur).trim().slice(0, 50);
    const item = await run(() => db.wishlist.getById(req.params.id));
    if (!item || item.voyage_id !== voyage.id) return res.status(404).json({ error: 'Item introuvable' });
    const liked = await run(() => db.wishlist.toggleLike(req.params.id, safeAuteur));
    res.json({ ok: true, liked });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/partage/:token/wishlist/:id', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const item = await run(() => db.wishlist.getById(req.params.id));
    if (!item || item.voyage_id !== voyage.id) return res.status(404).json({ error: 'Item introuvable' });
    // L'auteur est obligatoire pour prouver l'identité
    if (!req.body.auteur) return res.status(400).json({ error: 'Auteur requis' });
    if (req.body.auteur !== item.auteur)
      return res.status(403).json({ error: 'Tu ne peux supprimer que tes propres items' });
    await run(() => db.wishlist.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ── Sondages ──────────────────────────────────────────────────────────────
app.get('/api/partage/:token/sondages', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const sondages = await run(() => db.sondages.getByVoyage(voyage.id));
    res.json(sondages.map(s => ({
      ...s,
      options: typeof s.options === 'string' ? JSON.parse(s.options || '[]') : (s.options || []),
      votes:   typeof s.votes   === 'string' ? JSON.parse(s.votes   || '[]') : (s.votes   || [])
    })));
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/sondages', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { titre, options, created_by } = req.body;
    if (!titre?.trim() || !Array.isArray(options) || options.length < 2) return res.status(400).json({ error: 'Titre et au moins 2 options requis' });
    const s = await run(() => db.sondages.create(voyage.id, { titre: titre.trim(), options: options.map(o => String(o).trim()), created_by: created_by || 'Anonyme' }));
    res.json({ ...s, options: typeof s.options === 'string' ? JSON.parse(s.options || '[]') : (s.options || []), votes: [] });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.post('/api/partage/:token/sondages/:id/vote', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { option_id } = req.body;
    const auteur = req.body.auteur;
    if (!option_id || !auteur) return res.status(400).json({ error: 'Données manquantes' });
    const safeAuteur = String(auteur).trim().slice(0, 50);
    const s = await run(() => db.sondages.getById(req.params.id));
    if (!s || s.voyage_id !== voyage.id) return res.status(404).json({ error: 'Sondage introuvable' });
    if (s.statut === 'fermé') return res.status(403).json({ error: 'Sondage fermé' });
    await run(() => db.sondages.vote(req.params.id, option_id, safeAuteur));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.patch('/api/partage/:token/sondages/:id/fermer', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const s = await run(() => db.sondages.getById(req.params.id));
    if (!s || s.voyage_id !== voyage.id) return res.status(404).json({ error: 'Sondage introuvable' });
    // L'auteur est obligatoire pour prouver l'identité
    if (!req.body.auteur) return res.status(400).json({ error: 'Auteur requis' });
    if (req.body.auteur !== s.created_by)
      return res.status(403).json({ error: 'Seul le créateur peut fermer ce sondage' });
    await run(() => db.sondages.fermer(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

app.delete('/api/partage/:token/sondages/:id', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const s = await run(() => db.sondages.getById(req.params.id));
    if (!s || s.voyage_id !== voyage.id) return res.status(404).json({ error: 'Sondage introuvable' });
    // L'auteur est obligatoire pour prouver l'identité
    if (!req.body.auteur) return res.status(400).json({ error: 'Auteur requis' });
    if (req.body.auteur !== s.created_by)
      return res.status(403).json({ error: 'Seul le créateur peut supprimer ce sondage' });
    await run(() => db.sondages.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// Anciens liens /partage/ → redirect vers /share/ même depuis bfcache
app.get('/partage/:token', (req, res) => {
  const t = req.params.token;
  // Valider le token avant injection dans le HTML (évite XSS via path)
  if (!/^[a-zA-Z0-9_\-]{6,30}$/.test(t)) return res.status(400).send('Token invalide');
  const safe = encodeURIComponent(t);
  res.set('Cache-Control', 'no-store');
  res.redirect(301, `/share/${safe}`);
});

// ─── MANIFEST PARTICIPANT DYNAMIQUE (QW2) ────────────────────────────────────
// Quand un participant installe la PWA depuis /share/:token, ce manifest
// encode start_url = /share/TOKEN → l'app s'ouvre directement sur son voyage.
app.get('/manifest-participant/:token', (req, res) => {
  const t = req.params.token;
  // Valider le format (anti-injection)
  if (!/^[a-zA-Z0-9_\-]{6,30}$/.test(t)) return res.status(400).json({ error: 'token invalide' });

  const manifest = {
    id: `/share/${t}`,
    name: "CrewiGO — Mon voyage",
    short_name: "CrewiGO",
    description: "Accéder à mon voyage de groupe.",
    start_url: `/share/${t}`,
    display: "standalone",
    orientation: "portrait",
    theme_color: "#F97316",
    background_color: "#0f172a",
    lang: "fr",
    scope: "/",
    icons: [
      { src: "/logo-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/logo-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
    ],
    categories: ["travel", "lifestyle", "social"]
  };

  res.set('Content-Type', 'application/manifest+json');
  res.set('Cache-Control', 'no-store'); // Le manifest change si le token change
  res.json(manifest);
});

// ─── Serveur de voyage unifié (/share/:token ET /voyage/:token) ─────────────
// Interface unique : un seul HTML, le rôle (organisateur vs participant) est
// déterminé côté client via _checkOrganizerMode() dans partage.html.
// /voyage/:token = URL canonique · /share/:token = alias rétrocompatible.
async function _serveVoyagePage(req, res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma':        'no-cache',
    'Expires':       '0',
    'Content-Type':  'text/html; charset=utf-8'
  });
  let html = fs.readFileSync(path.join(__dirname, 'public', 'partage.html'), 'utf8');
  const nonce = res.locals.cspNonce || '';
  html = html
    .replace('href="/style.css"', `href="/style.css?${APP_VERSION}"`)
    .replace('src="/app.js"',     `src="/app.js?${APP_VERSION}"`);
  if (nonce) html = html.replace(/<script>/g, `<script nonce="${nonce}">`);

  // ─── INJECTION OG DYNAMIQUE ──────────────────────────────────────────────────
  // Les bots (WhatsApp, Telegram, Slack…) ne font jamais tourner le JS —
  // ils lisent uniquement le HTML brut. On injecte les balises OG côté serveur
  // pour que chaque lien partagé affiche le bon nom de voyage + destination.
  try {
    const t = req.params.token;
    // Valider le format du token avant toute requête DB (anti path-injection)
    if (/^[a-zA-Z0-9_\-]{6,30}$/.test(t)) {
      const voyage = await run(() => db.voyages.getByToken(t));
      if (voyage) {
        const participants = await run(() => db.participants.getByVoyage(voyage.id));
        const nbMembres = participants.length;

        // Échappement HTML pour éviter tout XSS via les données du voyage
        const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const nom  = esc(voyage.nom || 'Voyage en groupe');
        const dest = esc(voyage.destination || '');

        // Formatage lisible des dates (ex : "14 juin" / "17 juin")
        const fmtDate = d => {
          if (!d) return null;
          const dt = new Date(d);
          return isNaN(dt.getTime()) ? null : dt.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
        };
        const debut = fmtDate(voyage.date_debut);
        const fin   = fmtDate(voyage.date_fin);

        // Titre OG : "Weekend à Lisbonne · CrewiGO" ou "Notre Road Trip · CrewiGO"
        const ogTitle = dest ? `${nom} · ${dest}` : nom;

        // Description OG : "6 membres · Lisbonne · du 14 juin au 17 juin"
        const descParts = [];
        if (nbMembres > 0) descParts.push(`${nbMembres} membre${nbMembres > 1 ? 's' : ''}`);
        if (dest)           descParts.push(dest);
        if (debut && fin)   descParts.push(`du ${debut} au ${fin}`);
        else if (debut)     descParts.push(`à partir du ${debut}`);
        const ogDesc = descParts.length
          ? descParts.join(' · ')
          : 'Rejoignez ce voyage en groupe sur CrewiGO.';

        // URL canonique pour og:url — /voyage/ est l'URL de référence
        const isUnified = req.path.startsWith('/voyage/');
        const ogUrl = `${req.protocol}://${req.get('host')}/${isUnified ? 'voyage' : 'share'}/${esc(t)}`;

        html = html
          .replace(/<title>[^<]*<\/title>/,                                          `<title>${nom} — CrewiGO</title>`)
          .replace(/(<meta property="og:title"\s+content=")[^"]*(")/,               `$1${ogTitle} — CrewiGO$2`)
          .replace(/(<meta property="og:description"\s+content=")[^"]*(")/,         `$1${ogDesc}$2`)
          .replace(/(<meta property="og:locale"\s+content=")[^"]*(")/,              `$1fr_FR$2`)
          .replace(/(<meta name="twitter:title"\s+content=")[^"]*(")/,              `$1${ogTitle} — CrewiGO$2`)
          .replace(/(<meta name="twitter:description"\s+content=")[^"]*(")/,        `$1${ogDesc}$2`)
          .replace(/(<meta name="apple-mobile-web-app-title"\s+content=")[^"]*(")/,`$1${nom}$2`);

        // Injecter og:url juste après og:locale (si la balise n'existe pas encore)
        if (!html.includes('og:url')) {
          html = html.replace(
            /(<meta property="og:locale"[^>]*>)/,
            `$1\n  <meta property="og:url" content="${ogUrl}">`
          );
        }
      }
    }
  } catch (e) {
    // Fallback silencieux sur les OG statiques — la page reste fonctionnelle
    console.warn('[OG INJECTION] Erreur silencieuse:', e.message);
  }

  res.end(html);
}

// /share/:token = alias rétrocompatible (tous les liens déjà envoyés continuent de fonctionner)
app.get('/share/:token',  _serveVoyagePage);
// /voyage/:token = URL canonique unifiée (organisateur + participant, même HTML)
app.get('/voyage/:token', _serveVoyagePage);

// ── API : l'utilisateur connecté est-il propriétaire de ce voyage ? ───────────
// Utilisé par partage.html pour afficher la bannière "Gérer le voyage" si l'org.
// visite son propre lien (/voyage/:token ou /share/:token).
app.get('/api/voyages/by-token/:token/is-owner', authMiddleware, async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.json({ isOwner: false });
    const isOwner = IS_CLOUD
      ? voyage.owner_id === req.user.id
      : true; // local JSON = mono-utilisateur, toujours propriétaire
    res.json({ isOwner, voyageId: voyage.id });
  } catch(e) {
    res.json({ isOwner: false });
  }
});

// ─── PHOTOS PARTAGÉES ────────────────────────────────────────────────────────

// Liste des photos d'un voyage (pas le contenu base64 — juste les métadonnées)
app.get('/api/partage/:token/photos', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    const photos = await run(() => db.photos.getByVoyage(voyage.id));
    res.json(photos);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// Upload d'une photo par un participant
app.post('/api/partage/:token/photos', upload.single('photo'), async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
    if (req.file.size > 10 * 1024 * 1024) return res.status(413).json({ error: 'Photo trop lourde (max 10 Mo)' });

    const auteur = (req.body.auteur || 'Anonyme').trim().slice(0, 50);
    const couleur = req.body.couleur || '#6366F1';
    const caption = (req.body.caption || '').trim().slice(0, 200) || null;
    const contenu = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    const photo = await run(() => db.photos.create(voyage.id, { auteur, couleur, caption, contenu }));
    res.status(201).json({ id: photo.id, auteur: photo.auteur, couleur: photo.couleur, caption: photo.caption, created_at: photo.created_at });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// Servir le contenu image (data URL → image réelle pour les <img src>)
app.get('/api/photos/:id/img', async (req, res) => {
  try {
    const photo = await run(() => db.photos.getById(req.params.id));
    if (!photo) return res.status(404).send('Introuvable');
    const match = photo.contenu.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return res.status(500).send('Données corrompues');
    const buf = Buffer.from(match[2], 'base64');
    res.set('Content-Type', match[1]);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).send('Erreur'); }
});

// Suppression d'une photo — admin uniquement
app.delete('/api/photos/:id', authMiddleware, async (req, res) => {
  try {
    const photo = await run(() => db.photos.getById(req.params.id));
    if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
    const ok = await checkVoyageOwnership(photo.voyage_id, req.user.id);
    if (!ok) return res.status(403).json({ error: 'Accès refusé' });
    await run(() => db.photos.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// Suppression photo par le participant auteur (avec session token)
app.delete('/api/partage/:token/photos/:id', verifyParticipantSession, async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Token invalide' });

    const photo = await run(() => db.photos.getById(req.params.id));
    if (!photo || photo.voyage_id !== voyage.id)
      return res.status(404).json({ error: 'Photo introuvable' });

    const { participantSession } = req;
    // Vérification rétrocompat : participantId OU auteur string
    const isOwner =
      (photo.participant_id && photo.participant_id === participantSession.participantId) ||
      photo.auteur === participantSession.nom;

    if (!isOwner)
      return res.status(403).json({ error: 'Tu ne peux supprimer que tes propres photos' });

    await run(() => db.photos.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) {
    console.error('[DELETE PHOTO]', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── CREWIREWIND — Likes photos ────────────────────────────────────────────

const { toggleLike, getLikesForVoyage, scorePhotos } = require('./services/photoLikes');

// GET tous les likes d'un voyage (public, token)
app.get('/api/partage/:token/photos/likes', async (req, res) => {
  try {
    const v = await run(() => db.voyages.getByToken(req.params.token));
    if (!v) return res.status(404).json({ error: 'Voyage introuvable' });
    res.json(await getLikesForVoyage(v.id));
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// POST toggle like (public, token) — bloqué si archivé
app.post('/api/partage/:token/photos/:id/like', async (req, res) => {
  try {
    const v = await run(() => db.voyages.getByToken(req.params.token));
    if (!v) return res.status(404).json({ error: 'Voyage introuvable' });
    if (v.statut === 'archived') return res.status(403).json({ error: 'La période de vote est terminée' });
    const { auteur } = req.body;
    if (!auteur) return res.status(400).json({ error: 'auteur requis' });
    const photo = await run(() => db.photos.getById(+req.params.id));
    if (!photo || photo.voyage_id !== v.id) return res.status(404).json({ error: 'Photo introuvable' });
    const result = await toggleLike(+req.params.id, v.id, auteur);
    res.json(result);
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// ─── CREWIREWIND — Top photos, résumé IA, email, mémoires ──────────────────

// GET top photos scorées (admin)
app.get('/api/voyages/:id/top-photos', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    const topIds = await scorePhotos(voyage.id);
    await run(() => db.trip_top_photos.upsert(voyage.id, { photo_ids: JSON.stringify(topIds) }));
    const photos = await run(() => db.photos.getByVoyage(voyage.id));
    const top = topIds.map(id => photos.find(p => p.id === id)).filter(Boolean);
    res.json({ photo_ids: topIds, photos: top });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// POST résumé IA (admin, derrière ENABLE_AI_SUMMARY)
app.post('/api/voyages/:id/summary', authMiddleware, requireVoyageOwner(), async (req, res) => {
  if (process.env.ENABLE_AI_SUMMARY !== 'true')
    return res.status(503).json({ error: 'Résumé IA désactivé (ENABLE_AI_SUMMARY)' });
  try {
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    const participants = await run(() => db.participants.getByVoyage(req.params.id));
    const photos = await run(() => db.photos.getByVoyage(req.params.id));
    const topRec = await run(() => db.trip_top_photos.getByVoyage(voyage.id));
    const topIds = topRec ? JSON.parse(topRec.photo_ids || '[]') : [];
    const { generateSummary } = require('./services/tripSummaryAI');
    const summary = await generateSummary(voyage, participants, photos, topIds);
    await run(() => db.voyages.setMemorySummary(voyage.id, summary));
    res.json({ summary });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: e.message }); }
});

// POST email souvenir (admin)
app.post('/api/voyages/:id/send-memory-email', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    const participants = await run(() => db.participants.getByVoyage(req.params.id));
    const photos = await run(() => db.photos.getByVoyage(req.params.id));
    const topRec = await run(() => db.trip_top_photos.getByVoyage(voyage.id));
    const topIds = topRec ? JSON.parse(topRec.photo_ids || '[]') : [];
    const { sendMemoryEmail } = require('./services/tripMemoryEmail');
    await sendMemoryEmail(voyage, participants, topIds, photos);
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: e.message }); }
});

// GET mémoires publiques (token) — résumé + top photos si completed|archived
app.get('/api/partage/:token/memory', async (req, res) => {
  try {
    const v = await run(() => db.voyages.getByToken(req.params.token));
    if (!v) return res.status(404).json({ error: 'Voyage introuvable' });
    if (!['completed', 'archived'].includes(v.statut))
      return res.json({ available: false });
    const topRec = await run(() => db.trip_top_photos.getByVoyage(v.id));
    const topIds = topRec ? JSON.parse(topRec.photo_ids || '[]') : [];
    const photos = await run(() => db.photos.getByVoyage(v.id));
    const top = topIds.map(id => photos.find(p => p.id === id)).filter(Boolean);
    const likes = await getLikesForVoyage(v.id);
    res.json({
      available: true,
      statut: v.statut,
      completed_at: v.completed_at,
      archived_at: v.archived_at,
      summary: v.memory_summary || null,
      top_photos: top,
      likes
    });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: 'Erreur interne' }); }
});

// Route /api/voyages/archives déplacée avant /:id (voir ligne 205)

// ─── CREWIREWIND — Capsules Mémoire ────────────────────────────────────────

// GET /api/partage/:token/capsules — liste des capsules (visibles si tu as soumis la tienne)
app.get('/api/partage/:token/capsules', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    const nom = (req.query.nom || '').trim();
    const mine = nom ? await run(() => db.capsules.getMine(voyage.id, nom)) : null;
    const all  = await run(() => db.capsules.getByVoyage(voyage.id));
    res.json({
      capsules:      mine ? all : [],   // révélées seulement si l'utilisateur a soumis la sienne
      mine:          mine || null,
      total:         all.length,
      voyageStatut:  voyage.statut,
      voyageNom:     voyage.nom,
      voyageDest:    voyage.destination,
    });
  } catch(e) { console.error('[CAPSULES GET]', e.message); res.status(500).json({ error: 'Erreur interne' }); }
});

// POST /api/partage/:token/capsule — créer ou mettre à jour ma capsule
app.post('/api/partage/:token/capsule', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Voyage introuvable' });
    if (voyage.statut !== 'archived' && voyage.statut !== 'completed')
      return res.status(403).json({ error: 'Capsules disponibles 24h après la fin du voyage' });
    const { nom, couleur, photo_id, mots_cles, moment_prefere, ferait_differemment, note } = req.body;
    if (!nom?.trim()) return res.status(400).json({ error: 'Nom requis' });
    const mots = Array.isArray(mots_cles) ? mots_cles.slice(0, 3).map(m => String(m).slice(0, 30)) : [];
    const item = await run(() => db.capsules.upsert(voyage.id, nom.trim(), {
      participant_couleur:  couleur || '#6366F1',
      photo_id:             photo_id ? +photo_id : null,
      mots_cles:            JSON.stringify(mots),
      moment_prefere:       moment_prefere ? String(moment_prefere).slice(0, 500) : null,
      ferait_differemment:  ferait_differemment ? String(ferait_differemment).slice(0, 500) : null,
      note:                 note ? Math.min(5, Math.max(1, parseInt(note))) : null,
    }));
    res.status(201).json(item);
  } catch(e) { console.error('[CAPSULE POST]', e.message); res.status(500).json({ error: e.message.split('\n')[0] || 'Erreur interne' }); }
});

// GET /api/voyages/:id/capsules — admin : voir toutes les capsules d'un voyage
app.get('/api/voyages/:id/capsules', authMiddleware, requireVoyageOwner(), async (req, res) => {
  try {
    const capsules = await run(() => db.capsules.getByVoyage(req.params.id));
    res.json(capsules);
  } catch(e) { res.status(500).json({ error: 'Erreur interne' }); }
});

// POST cron tick manuel (debug)
app.post('/api/admin/cron/tick', authMiddleware, async (req, res) => {
  try {
    const { runDailyJob } = require('./services/tripClosure');
    await runDailyJob();
    res.json({ ok: true });
  } catch(e) { console.error('[API ERROR]', e); res.status(500).json({ error: e.message }); }
});

// ─── DIAGNOSTIC (Railway debug) ─────────────────────────────────────────────
app.get('/api/diag', async (req, res) => {
  const mode = IS_CLOUD ? 'postgresql' : 'json';
  if (!IS_CLOUD) return res.json({ ok: true, mode, info: 'mode local - pas de PostgreSQL' });
  try {
    const pool = db._pool || null;
    if (!pool) return res.json({ ok: false, mode, error: 'pgPool non disponible' });
    // Vérifier les colonnes de la table depenses
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='depenses' ORDER BY ordinal_position`);
    const colNames = cols.rows.map(r => r.column_name);
    // Tester un INSERT minimal avec voyage_id=0 (échouera sur FK mais pas sur colonnes)
    let insertTest = 'non testé';
    try {
      await pool.query(`INSERT INTO depenses(voyage_id,titre,montant,payeur_id,participants_ids,date,categorie) VALUES(0,'__diag__',0.01,null,'[]','2026-01-01','autre')`);
      await pool.query(`DELETE FROM depenses WHERE titre='__diag__'`);
      insertTest = 'ok';
    } catch(e2) {
      insertTest = e2.message;
    }
    res.json({ ok: true, mode, colonnes: colNames, insert_test: insertTest });
  } catch(e) {
    res.json({ ok: false, mode, error: e.message });
  }
});

// ─── CREWIREWIND — Cron clôture automatique ────────────────────────────────
if (process.env.ENABLE_TRIP_CLOSURE !== 'false') {
  const { runDailyJob } = require('./services/tripClosure');
  runDailyJob().catch(e => console.error('[CrewiRewind] Boot job:', e.message));
  setInterval(() => runDailyJob().catch(e => console.error('[CrewiRewind] Cron:', e.message)), 24 * 60 * 60 * 1000);
}

// ─── R7 — Purge des magic links expirés (24h) ─────────────────────────────
// En mode PostgreSQL : DELETE SQL direct.
// En mode JSON local : purge du fichier via fs (dev uniquement).
async function purgeExpiredMagicLinks() {
  try {
    if (IS_CLOUD) {
      const result = await db._pool.query("DELETE FROM magic_links WHERE expires_at < NOW()");
      console.log(`[PURGE] ${result.rowCount} magic link(s) expiré(s) supprimé(s)`);
    } else {
      // Mode fichiers JSON — accès direct (chemin connu)
      const DATA_DIR   = path.join(__dirname, 'data');
      const linksPath  = path.join(DATA_DIR, 'magic_links.json');
      if (fs.existsSync(linksPath)) {
        const links  = JSON.parse(fs.readFileSync(linksPath, 'utf8') || '[]');
        const now    = new Date().toISOString();
        const valid  = links.filter(l => l.expires_at > now);
        const purged = links.length - valid.length;
        if (purged > 0) {
          fs.writeFileSync(linksPath, JSON.stringify(valid, null, 2));
          console.log(`[PURGE] ${purged} magic link(s) expiré(s) supprimé(s) (local)`);
        }
      }
    }
  } catch (e) {
    console.warn('[PURGE] Erreur nettoyage magic links:', e.message);
  }
}
// Première purge 5 min après démarrage, puis toutes les 24h
setTimeout(purgeExpiredMagicLinks, 5 * 60_000);
setInterval(purgeExpiredMagicLinks, 24 * 60 * 60_000);

// ─── DÉMARRAGE ─────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) { localIP = alias.address; break; }
    }
    if (localIP !== 'localhost') break;
  }
  if (process.env.DATABASE_URL) {
    console.log(`\n🌍 MES VOYAGES (cloud) → port ${PORT}\n`);
  } else {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║       🌍  MES VOYAGES - Démarré !        ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Mac    → http://localhost:${PORT}          ║`);
    console.log(`║  iPhone → http://${localIP}:${PORT}   ║`);
    console.log('╚══════════════════════════════════════════╝\n');
  }
});
