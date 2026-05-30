// ─── Participant session store ────────────────────────────────────────────────
// Sessions en mémoire avec persistance dans data/sessions.json pour survivre
// aux redémarrages serveur.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24h

const participantSessions = new Map();

// ── Chargement au démarrage ──
function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const entries = JSON.parse(raw);
    const now = Date.now();
    let loaded = 0;
    for (const [token, session] of Object.entries(entries)) {
      if (session.expiresAt > now) {
        participantSessions.set(token, session);
        loaded++;
      }
    }
    console.log(`[Sessions] ${loaded} session(s) restaurée(s)`);
  } catch {
    // Fichier absent = premier démarrage, normal
  }
}

// ── Sauvegarde ──
function saveSessions() {
  try {
    const obj = Object.fromEntries(participantSessions);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
  } catch(e) {
    console.error('[Sessions] Erreur sauvegarde:', e.message);
  }
}

// ── Purge des sessions expirées ──
function purgeSessions() {
  const now = Date.now();
  let purged = 0;
  for (const [token, session] of participantSessions) {
    if (session.expiresAt < now) {
      participantSessions.delete(token);
      purged++;
    }
  }
  if (purged > 0) saveSessions();
}

// ── Créer une session ──
function createSession({ participantId, voyageId, nom, couleur, role = 'participant' }) {
  const token = randomUUID();
  participantSessions.set(token, {
    participantId,
    voyageId,
    nom,
    couleur,
    role,
    expiresAt: Date.now() + SESSION_TTL,
  });
  saveSessions();
  return token;
}

// ── Valider et récupérer une session ──
function getSession(token) {
  if (!token) return null;
  const session = participantSessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    participantSessions.delete(token);
    saveSessions();
    return null;
  }
  // Renouvellement TTL (sliding window)
  session.expiresAt = Date.now() + SESSION_TTL;
  return session;
}

// ── Initialisation + tâches périodiques ──
loadSessions();
setInterval(purgeSessions, 60 * 60 * 1000); // purge toutes les heures
setInterval(saveSessions, 5 * 60 * 1000);   // sauvegarde toutes les 5 min

// Sauvegarde propre à l'arrêt
process.on('SIGTERM', saveSessions);
process.on('SIGINT',  saveSessions);

module.exports = { participantSessions, createSession, getSession };
