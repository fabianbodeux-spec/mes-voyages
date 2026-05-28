const db = require('../database');
const run = db.isAsync
  ? (fn) => fn()
  : (fn) => Promise.resolve(fn());

// Délai avant activation du CrewiRewind — réduit à 1 jour (était 3)
// pour exploiter le pic émotionnel du retour de voyage (24-48h max).
const VOTE_WINDOW_DAYS = 1;

function daysAgo(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24));
}

async function checkAndClose(voyage) {
  if (voyage.statut !== 'actif' && voyage.statut !== 'active') return;
  if (!voyage.date_fin) return;
  const today = new Date().toISOString().slice(0, 10);
  if (voyage.date_fin < today) {
    await run(() => db.voyages.setStatutFull(voyage.id, 'completed', {
      completed_at: new Date().toISOString()
    }));
    console.log(`[CrewiRewind] Voyage ${voyage.id} cloturé automatiquement`);
  }
}

async function checkAndArchive(voyage) {
  if (voyage.statut !== 'completed') return;
  if (!voyage.completed_at) return;
  if (daysAgo(voyage.completed_at) >= VOTE_WINDOW_DAYS) {
    const { scorePhotos } = require('./photoLikes');
    const topPhotoIds = await scorePhotos(voyage.id);
    if (topPhotoIds.length > 0) {
      await run(() => db.trip_top_photos.upsert(voyage.id, {
        photo_ids: JSON.stringify(topPhotoIds)
      }));
    }
    await run(() => db.voyages.setStatutFull(voyage.id, 'archived', {
      archived_at: new Date().toISOString()
    }));
    console.log(`[CrewiRewind] Voyage ${voyage.id} archivé, ${topPhotoIds.length} top photos scorées`);

    // Récupérer les données complètes du voyage (share_token, nom…)
    const voyageFull   = await run(() => db.voyages.getById(voyage.id));
    // Participants nécessaires pour l'email ET la pression sociale du push
    const participants = await run(() => db.participants.getByVoyage(voyage.id));

    if (process.env.ENABLE_MEMORY_EMAIL !== 'false') {
      try {
        const { sendMemoryEmail } = require('./tripMemoryEmail');
        const photos = await run(() => db.photos.getByVoyage(voyage.id));
        await sendMemoryEmail(voyageFull, participants, topPhotoIds, photos);
      } catch (e) {
        console.error('[CrewiRewind] Email souvenir échoué:', e.message);
      }
    }

    // ── Push CrewiRewind initial : notifier tous les participants 24h après le retour ──
    await _pushCapsuleReminder(voyageFull, participants, { isInitial: true });
  }
}

// ─── Push capsule avec pression sociale ─────────────────────────────────────
// Appelée à l'archivage (isInitial=true) puis chaque jour (J+2 à J+4)
// pour les participants qui n'ont pas encore soumis leur capsule.
// Le message s'adapte au nombre de soumissions déjà reçues.
async function _pushCapsuleReminder(voyageFull, participants, { isInitial = false } = {}) {
  try {
    const shareToken = voyageFull?.share_token;
    if (!shareToken) return;

    const webpush  = require('web-push');
    const subs     = await run(() => db.push_subscriptions.getByVoyage(voyageFull.id));
    if (!subs.length) return;

    // Capsules déjà soumises — on récupère les noms pour la pression sociale
    const capsules      = await run(() => db.capsules.getByVoyage(voyageFull.id));
    const nbSoumis      = capsules.length;
    const nbTotal       = participants.length;
    const nomsSoumis    = capsules.map(c => c.participant_nom);
    const premiers      = nomsSoumis.slice(0, 2);

    // Construire le payload personnalisé selon le contexte de chaque abonné
    const buildPayload = (sub) => {
      // Identifier le participant lié à cette souscription
      const participant = sub.participant_id
        ? participants.find(p => p.id === +sub.participant_id)
        : null;

      // Ne pas ré-envoyer aux participants qui ont déjà soumis
      if (participant && nomsSoumis.includes(participant.nom)) return null;

      let title, body;

      if (nbSoumis === 0) {
        // Personne n'a encore soumis — invitation directe
        title = '🎞️ CrewiRewind est disponible !';
        body  = `Sois le premier à créer ta capsule mémoire pour "${voyageFull.nom}" 🌍`;
      } else if (nbSoumis < nbTotal) {
        // Pression sociale : X membres ont soumis, toi pas encore
        const qui = premiers.length === 1
          ? premiers[0]
          : premiers.length === 2
            ? `${premiers[0]} et ${premiers[1]}`
            : `${premiers[0]} et ${nbSoumis - 1} autre${nbSoumis > 2 ? 's' : ''}`;
        title = `🎞️ ${nbSoumis}/${nbTotal} capsules prêtes !`;
        body  = `${qui} t'attendent. Ta capsule manque pour révéler les souvenirs de "${voyageFull.nom}".`;
      } else {
        // Tout le monde a soumis sauf ce participant — urgence maximale
        title = `🎞️ Tu es le dernier ! ${nbSoumis}/${nbTotal} membres prêts`;
        body  = `Tout le crew attend ta capsule pour que le reveal de "${voyageFull.nom}" puisse commencer !`;
      }

      return JSON.stringify({ title, body, tag: 'crewirewind', url: `/partage/${shareToken}?tab=souvenirs` });
    };

    let sent = 0, skipped = 0;
    for (const sub of subs) {
      const payload = buildPayload(sub);
      if (!payload) { skipped++; continue; } // Déjà soumis → skip
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        sent++;
      } catch (e2) {
        if (e2.statusCode === 410 || e2.statusCode === 404) {
          run(() => db.push_subscriptions.deleteByEndpoint?.(sub.endpoint)).catch(() => {});
        }
      }
    }
    const label = isInitial ? 'initial' : 'rappel';
    console.log(`[CrewiRewind] Push ${label} : ${sent} envoyés, ${skipped} ignorés (déjà soumis) — voyage ${voyageFull.id}`);
  } catch (e) {
    console.error('[CrewiRewind] Push capsule échoué:', e.message);
  }
}

// ─── Rappels quotidiens pour les non-soumetteurs (J+2 à J+4) ───────────────
// Envoie un rappel avec pression sociale aux participants qui n'ont
// pas encore soumis leur capsule, pendant les 3 jours suivant l'archivage.
const REMINDER_WINDOW_DAYS = 4; // Arrête les rappels après J+4

async function checkCapsuleReminders(voyage) {
  if (voyage.statut !== 'archived') return;
  if (!voyage.archived_at) return;

  const daysSinceArchive = daysAgo(voyage.archived_at);
  // J+1 = push initial (déjà envoyé à l'archivage), J+2 à J+4 = rappels
  if (daysSinceArchive < 2 || daysSinceArchive > REMINDER_WINDOW_DAYS) return;

  // Vérifier s'il reste des participants sans capsule
  const [voyageFull, participants, capsules] = await Promise.all([
    run(() => db.voyages.getById(voyage.id)),
    run(() => db.participants.getByVoyage(voyage.id)),
    run(() => db.capsules.getByVoyage(voyage.id))
  ]);

  const nomsSoumis = capsules.map(c => c.participant_nom);
  const restants   = participants.filter(p => !nomsSoumis.includes(p.nom));
  if (!restants.length) return; // Tout le monde a soumis → plus de rappel

  await _pushCapsuleReminder(voyageFull, participants, { isInitial: false });
}

async function runDailyJob() {
  try {
    const voyages = db.isAsync
      ? (await db.voyages.getAll(null)).concat ? [] : []
      : db.voyages.getAll();
    // En mode local on récupère tous les voyages directement
    const allVoyages = db.isAsync
      ? (await db._pool.query('SELECT * FROM voyages')).rows
      : db.voyages.getAll();
    for (const v of allVoyages) {
      await checkAndClose(v);
      await checkAndArchive(v);
      await checkCapsuleReminders(v);
    }
  } catch (e) {
    console.error('[CrewiRewind] Daily job erreur:', e.message);
  }
}

module.exports = { runDailyJob, checkAndClose, checkAndArchive };
