const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const os = require('os');
const webpush = require('web-push');
const db = require('./database');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL || 'mailto:admin@mes-voyages.app',
  process.env.VAPID_PUBLIC_KEY || 'BCV64icXiouIl1g8KVeaEyGMLbhD0M5RFx_qDc5LGiAbIS49-QGP1XOeQWnLEGUnOfmMBH6dQbn20J1sekxQWF0',
  process.env.VAPID_PRIVATE_KEY || 'oGmkLaP2ogT0DaQy1s805q2pEe-vCb-XYVRlNEJe6FU'
);

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

app.put('/api/participants/:id', async (req, res) => {
  try { await run(() => db.participants.update(req.params.id, req.body)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/participants/:id', async (req, res) => {
  try { await run(() => db.participants.delete(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/partage/:token/verify-pin', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Token invalide' });
    const { participant_id, pin } = req.body;
    const parts = await run(() => db.participants.getByVoyage(voyage.id));
    const p = parts.find(x => x.id === +participant_id);
    if (!p || !p.pin) return res.json({ ok: false });
    res.json({ ok: p.pin === String(pin) });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    res.json({ token, url: `${baseUrl}/share/${token}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
  } catch(e) { res.status(500).json({ error: e.message }); }
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

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || 'BCV64icXiouIl1g8KVeaEyGMLbhD0M5RFx_qDc5LGiAbIS49-QGP1XOeQWnLEGUnOfmMBH6dQbn20J1sekxQWF0' });
});

app.post('/api/push/subscribe/:voyageId', async (req, res) => {
  try {
    await run(() => db.push_subscriptions.upsert(req.params.voyageId, req.body));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/push/subscribe-partage/:token', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    await run(() => db.push_subscriptions.upsert(voyage.id, req.body));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/voyages/:id/demandes', async (req, res) => {
  try { res.json(await run(() => db.demandes.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/demandes/:id', async (req, res) => {
  try { await run(() => db.demandes.update(req.params.id, req.body)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ATTRIBUTIONS PRIVÉES ────────────────────────────────────────────────────

app.get('/api/voyages/:id/attributions', async (req, res) => {
  try { res.json(await run(() => db.attributions.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/voyages/:id/attributions', async (req, res) => {
  try { const item = await run(() => db.attributions.create(req.params.id, req.body)); res.json({ id: item.id }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/attributions/:id', async (req, res) => {
  try { await run(() => db.attributions.delete(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/partage/:token/mes-infos/:participantId', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const items = await run(() => db.attributions.getByParticipant(voyage.id, req.params.participantId));
    // Pour chaque attribution avec un document_id, inclure les métadonnées du doc
    const enriched = await Promise.all(items.map(async (a) => {
      if (!a.document_id) return a;
      const doc = await run(() => db.documents.getById(a.document_id));
      return { ...a, document: doc ? { id: doc.id, nom: doc.nom, type_fichier: doc.type_fichier } : null };
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── MESSAGES PRIVÉS ───────────────────────────────────────────────────────

app.get('/api/voyages/:id/messages-prives', async (req, res) => {
  try { res.json(await run(() => db.messages_prives.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/voyages/:id/messages-prives', async (req, res) => {
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
              url: voyage?.share_token ? `/share/${voyage.share_token}?tab=mes-infos` : '/'
            })
          );
        } catch(e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            await run(() => db.push_subscriptions.deleteByEndpoint && db.push_subscriptions.deleteByEndpoint(sub.endpoint)).catch(() => {});
          }
        }
      }
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/voyages/:id/messages-prives/:msgId', async (req, res) => {
  try { await run(() => db.messages_prives.delete(req.params.msgId)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/partage/:token/messages-prives/:participantId', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const msgs = await run(() => db.messages_prives.getByParticipant(voyage.id, req.params.participantId));
    // Marquer comme lus
    msgs.filter(m => !m.lu).forEach(m => run(() => db.messages_prives.marquerLu(m.id)).catch(() => {}));
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── COMMENTAIRES ──────────────────────────────────────────────────────────

app.get('/api/partage/:token/commentaires', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    res.json(await run(() => db.commentaires.getByVoyage(voyage.id)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/partage/:token/commentaires', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const { auteur, message } = req.body;
    if (!auteur || !message?.trim()) return res.status(400).json({ error: 'Données manquantes' });
    const item = await run(() => db.commentaires.create(voyage.id, { auteur, message: message.trim() }));
    res.json(item);
    const apercu = message.trim().length > 60 ? message.trim().slice(0, 60) + '…' : message.trim();
    pushToAll(voyage.id, {
      title: `💬 ${voyage.nom}`,
      body: `${auteur} : ${apercu}`,
      tag: 'commentaire-' + voyage.id,
      url: `/share/${req.params.token}?tab=discussion`
    }).catch(() => {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/partage/:token/commentaires/:id', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    await run(() => db.commentaires.delete(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/voyages/:id/commentaires', async (req, res) => {
  try { res.json(await run(() => db.commentaires.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/voyages/:id/commentaires', async (req, res) => {
  try {
    const { auteur, message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message vide' });
    const nom = auteur || 'Organisateur';
    const item = await run(() => db.commentaires.create(req.params.id, { auteur: nom, message: message.trim() }));
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/voyages/:id/commentaires/:cid', async (req, res) => {
  try { await run(() => db.commentaires.delete(req.params.cid)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── DOCS PARTICIPANTS ──────────────────────────────────────────────────────

app.get('/api/partage/:token/mes-docs/:participantId', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    res.json(await run(() => db.docs_participants.getByParticipant(voyage.id, req.params.participantId)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/partage/:token/mes-docs', upload.single('fichier'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const doc = await run(() => db.docs_participants.create(voyage.id, {
      participant_id: +req.body.participant_id,
      nom: req.file.originalname,
      type_fichier: req.file.mimetype,
      taille: req.file.size,
      categorie: req.body.categorie || 'autre',
      contenu: req.file.buffer.toString('base64')
    }));
    res.json({ id: doc.id, nom: doc.nom, type_fichier: doc.type_fichier, taille: doc.taille });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/partage/:token/mes-docs/:docId/download', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const doc = await run(() => db.docs_participants.getById(req.params.docId));
    if (!doc || doc.voyage_id !== voyage.id) return res.status(404).json({ error: 'Document introuvable' });
    res.setHeader('Content-Type', doc.type_fichier || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${doc.nom}"`);
    res.send(Buffer.from(doc.contenu, 'base64'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/partage/:token/mes-docs/:docId', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Lien invalide' });
    const doc = await run(() => db.docs_participants.getById(req.params.docId));
    if (!doc || doc.voyage_id !== voyage.id) return res.status(404).json({ error: 'Document introuvable' });
    await run(() => db.docs_participants.delete(req.params.docId));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/voyages/:id/docs-participants', async (req, res) => {
  try { res.json(await run(() => db.docs_participants.getByVoyage(req.params.id))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/voyages/:id/docs-participants/:docId/download', async (req, res) => {
  try {
    const doc = await run(() => db.docs_participants.getById(req.params.docId));
    if (!doc || doc.voyage_id !== +req.params.id) return res.status(404).json({ error: 'Document introuvable' });
    res.setHeader('Content-Type', doc.type_fichier || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${doc.nom}"`);
    res.send(Buffer.from(doc.contenu, 'base64'));
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Fallback REST (utilisé si SSE indisponible)
app.get('/api/partage/:token/locations', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Token invalide' });
    res.json(await run(() => db.locations.getByVoyage(voyage.id)));
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/partage/:token/location/:device_id', async (req, res) => {
  try {
    const voyage = await run(() => db.voyages.getByToken(req.params.token));
    if (!voyage) return res.status(404).json({ error: 'Token invalide' });
    await run(() => db.locations.delete(voyage.id, req.params.device_id));
    broadcastLocations(voyage.id); // push SSE — retire le marker chez tout le monde
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Anciens liens /partage/ → redirect vers /share/ même depuis bfcache
app.get('/partage/:token', (req, res) => {
  const t = req.params.token;
  res.set('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/share/${t}">
<script>
location.replace('/share/${t}');
window.addEventListener('pageshow',function(e){if(e.persisted)location.replace('/share/${t}');});
</script></head><body></body></html>`);
});

app.get('/share/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
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
