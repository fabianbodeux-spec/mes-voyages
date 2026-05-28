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
    const voyageFull = await run(() => db.voyages.getById(voyage.id));

    if (process.env.ENABLE_MEMORY_EMAIL !== 'false') {
      try {
        const { sendMemoryEmail } = require('./tripMemoryEmail');
        const participants = await run(() => db.participants.getByVoyage(voyage.id));
        const photos = await run(() => db.photos.getByVoyage(voyage.id));
        await sendMemoryEmail(voyageFull, participants, topPhotoIds, photos);
      } catch (e) {
        console.error('[CrewiRewind] Email souvenir échoué:', e.message);
      }
    }

    // ── Push CrewiRewind : notifier tous les participants 24h après le retour ──
    try {
      const shareToken = voyageFull?.share_token;
      if (shareToken) {
        const webpush = require('web-push');
        const subs = await run(() => db.push_subscriptions.getByVoyage(voyage.id));
        const payload = JSON.stringify({
          title: '🎞️ CrewiRewind — Tes souvenirs t\'attendent !',
          body: `Crée ta capsule mémoire pour "${voyageFull.nom}" — 3 questions, 1 photo, pour garder la magie.`,
          tag: 'crewirewind',
          url: `/partage/${shareToken}?tab=souvenirs`
        });
        let sent = 0;
        for (const sub of subs) {
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
        console.log(`[CrewiRewind] Push capsule envoyé à ${sent}/${subs.length} abonnés (voyage ${voyage.id})`);
      }
    } catch (e) {
      console.error('[CrewiRewind] Push capsule échoué:', e.message);
    }
  }
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
    }
  } catch (e) {
    console.error('[CrewiRewind] Daily job erreur:', e.message);
  }
}

module.exports = { runDailyJob, checkAndClose, checkAndArchive };
