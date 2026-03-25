const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const os = require('os');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper pour supporter db sync (local JSON) et async (PostgreSQL)
const run = async (fn) => {
  const result = fn();
  return result instanceof Promise ? result : result;
};

// ─── VOYAGES ───────────────────────────────────────────────────────────────

app.get('/api/voyages', async (req, res) => {
  try { res.json(await run(() => db.voyages.getAll())); } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/voyages/:id', async (req, res) => {
  try {
    const v = await run(() => db.voyages.getById(req.params.id));
    if (!v) return res.status(404).json({ error: 'Voyage non trouvé' });
    res.json(v);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/voyages', async (req, res) => {
  try { const item = await run(() => db.voyages.create(req.body)); res.json({ id: item.id }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/voyages/:id', async (req, res) => {
  try { await run(() => db.voyages.update(req.params.id, req.body)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/voyages/:id', async (req, res) => {
  try { await run(() => db.voyages.delete(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

// ─── RÉSERVATIONS ──────────────────────────────────────────────────────────

app.get('/api/voyages/:id/reservations', async (req, res) => {
  try { res.json(await run(() => db.reservations.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/voyages/:id/reservations', async (req, res) => {
  try { const item = await run(() => db.reservations.create(req.params.id, req.body)); res.json({ id: item.id }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/reservations/:id', async (req, res) => {
  try { await run(() => db.reservations.update(req.params.id, req.body)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/reservations/:id', async (req, res) => {
  try { await run(() => db.reservations.delete(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

// ─── AGENDA ────────────────────────────────────────────────────────────────

app.get('/api/voyages/:id/agenda', async (req, res) => {
  try { res.json(await run(() => db.agenda.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/voyages/:id/agenda', async (req, res) => {
  try { const item = await run(() => db.agenda.create(req.params.id, req.body)); res.json({ id: item.id }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/agenda/:id', async (req, res) => {
  try { await run(() => db.agenda.update(req.params.id, req.body)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/agenda/:id', async (req, res) => {
  try { await run(() => db.agenda.delete(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

// ─── DOCUMENTS ─────────────────────────────────────────────────────────────

app.get('/api/voyages/:id/documents', async (req, res) => {
  try { res.json(await run(() => db.documents.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/voyages/:id/documents', upload.single('fichier'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
  try {
    const item = await run(() => db.documents.create(req.params.id, {
      nom: req.file.originalname,
      type_fichier: req.file.mimetype,
      taille: req.file.size,
      categorie: req.body.categorie || 'autre',
      contenu: req.file.buffer.toString('base64')
    }));
    res.json({ id: item.id });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/documents/:id/download', async (req, res) => {
  try {
    const doc = await run(() => db.documents.getById(req.params.id));
    if (!doc) return res.status(404).json({ error: 'Document non trouvé' });
    res.setHeader('Content-Type', doc.type_fichier || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${doc.nom}"`);
    res.send(Buffer.from(doc.contenu, 'base64'));
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/documents/:id', async (req, res) => {
  try { await run(() => db.documents.delete(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

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
