// ─── Participant session store ────────────────────────────────────────────────
// Sessions persistées via la couche `database` (PostgreSQL en prod, JSON en local)
// afin de SURVIVRE aux redéploiements (le filesystem Railway est éphémère).
//
// Politique d'expiration (fenêtre fixe, pas de TTL glissant) :
//   expires_at = date_fin du voyage + 5 jours
//   • plancher  : au moins 48 h à partir de maintenant (retardataire qui poste
//     une photo juste après la fin du voyage)
//   • fallback  : 90 jours si le voyage n'a pas de date de fin renseignée
const { randomUUID } = require('crypto');
const db = require('./database');

const FIVE_DAYS_MS   = 5  * 24 * 60 * 60 * 1000;
const FLOOR_MS       = 48 * 60 * 60 * 1000;        // plancher 48 h
const FALLBACK_MS    = 90 * 24 * 60 * 60 * 1000;   // 90 j si pas de date_fin

// Awaite indifféremment une valeur (mode JSON local) ou une promesse (Postgres)
const _run = async (v) => (v instanceof Promise ? v : v);

/**
 * Calcule l'instant d'expiration (ms epoch) d'une session selon la date de fin.
 * @param {string|Date|null} dateFin - date_fin du voyage
 */
function computeExpiry(dateFin) {
  const now = Date.now();
  if (!dateFin) return now + FALLBACK_MS;
  const end = new Date(dateFin).getTime();
  if (Number.isNaN(end)) return now + FALLBACK_MS;
  return Math.max(now + FLOOR_MS, end + FIVE_DAYS_MS);
}

/**
 * Crée une session participant et renvoie son token (UUID).
 * @param {{participantId?:number, voyageId:number, nom?:string, couleur?:string,
 *          role?:string, dateFin?:string|Date|null}} opts
 */
async function createSession({ participantId, voyageId, nom, couleur, role = 'participant', dateFin = null }) {
  const token = randomUUID();
  const expiresAt = new Date(computeExpiry(dateFin)).toISOString();
  await _run(db.participant_sessions.create({
    token, participantId, voyageId, nom, couleur, role, expiresAt,
  }));
  return token;
}

/**
 * Valide un token et renvoie la session normalisée, ou null si absente/expirée.
 * Aucune fenêtre glissante : l'échéance est fixe (date_fin + 5 j).
 */
async function getSession(token) {
  if (!token) return null;
  let row;
  try {
    row = await _run(db.participant_sessions.getByToken(token));
  } catch (e) {
    console.error('[Sessions] getByToken:', e.message);
    return null;
  }
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    _run(db.participant_sessions.deleteByToken(token)).catch(() => {});
    return null;
  }
  return {
    participantId: row.participant_id,
    voyageId:      row.voyage_id,
    nom:           row.nom,
    couleur:       row.couleur,
    role:          row.role || 'participant',
    expiresAt:     new Date(row.expires_at).getTime(),
  };
}

/** Supprime explicitement une session (déconnexion). */
async function deleteSession(token) {
  if (!token) return;
  try { await _run(db.participant_sessions.deleteByToken(token)); } catch {}
}

// Purge périodique des sessions expirées (toutes les heures)
setInterval(() => {
  _run(db.participant_sessions.purgeExpired())
    .then(n => { if (n) console.log(`[Sessions] ${n} session(s) expirée(s) purgée(s)`); })
    .catch(() => {});
}, 60 * 60 * 1000);

module.exports = { createSession, getSession, deleteSession, computeExpiry };
