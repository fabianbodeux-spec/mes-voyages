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

app.get('/api/agenda/:id/documents', async (req, res) => {
  try {
    const docs = await run(() => db.documents.getByEvent ? db.documents.getByEvent(req.params.id) : []);
    res.json(docs);
  } catch(e) { res.status(500).json({error: e.message}); }
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
      event_id: req.body.event_id ? parseInt(req.body.event_id) : null,
      reservation_id: req.body.reservation_id ? parseInt(req.body.reservation_id) : null,
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

app.put('/api/documents/:id', async (req, res) => {
  try { await run(() => db.documents.update(req.params.id, req.body)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/documents/:id', async (req, res) => {
  try { await run(() => db.documents.delete(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

// ─── PARTICIPANTS ──────────────────────────────────────────────────────────

app.get('/api/voyages/:id/participants', async (req, res) => {
  try { res.json(await run(() => db.participants.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/voyages/:id/participants', async (req, res) => {
  try { const item = await run(() => db.participants.create(req.params.id, req.body)); res.json({ id: item.id }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/participants/:id', async (req, res) => {
  try { await run(() => db.participants.delete(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

// ─── DÉPENSES ──────────────────────────────────────────────────────────────

app.get('/api/voyages/:id/depenses', async (req, res) => {
  try { res.json(await run(() => db.depenses.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/voyages/:id/depenses', async (req, res) => {
  try { const item = await run(() => db.depenses.create(req.params.id, req.body)); res.json({ id: item.id }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/depenses/:id', async (req, res) => {
  try { await run(() => db.depenses.update(req.params.id, req.body)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/depenses/:id', async (req, res) => {
  try { await run(() => db.depenses.delete(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

// ─── BAGAGES ───────────────────────────────────────────────────────────────

app.get('/api/voyages/:id/bagages', async (req, res) => {
  try { res.json(await run(() => db.bagages.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/voyages/:id/bagages', async (req, res) => {
  try { const item = await run(() => db.bagages.create(req.params.id, req.body)); res.json({ id: item.id }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/voyages/:vid/bagages/bulk', async (req, res) => {
  try {
    const { participant_id, items } = req.body;
    await run(() => db.bagages.deleteByVoyageParticipant(req.params.vid, participant_id));
    for (const item of items) {
      await run(() => db.bagages.create(req.params.vid, { ...item, participant_id }));
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/bagages/:id', async (req, res) => {
  try { await run(() => db.bagages.update(req.params.id, req.body)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/bagages/:id', async (req, res) => {
  try { await run(() => db.bagages.delete(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

// ─── PARTAGE ────────────────────────────────────────────────────────────────

function genererToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 12; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

app.post('/api/voyages/:id/partager', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getById(req.params.id));
    if (!voyage) return res.status(404).json({ error: 'Voyage non trouvé' });
    let token = voyage.share_token;
    if (!token) {
      token = genererToken();
      await run(() => db.voyages.setToken(req.params.id, token));
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ token, url: `${baseUrl}/partage/${token}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/partage/:token', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const [reservations, agenda, participants, depenses, bagages] = await Promise.all([
      run(() => db.reservations.getByVoyage(voyage.id)),
      run(() => db.agenda.getByVoyage(voyage.id)),
      run(() => db.participants.getByVoyage(voyage.id)),
      run(() => db.depenses.getByVoyage(voyage.id)),
      run(() => db.bagages.getByVoyage(voyage.id))
    ]);
    res.json({ voyage, reservations, agenda, participants, depenses, bagages });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/partage/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'partage.html'));
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
