// Base de données — JSON local OU PostgreSQL cloud selon l'environnement
const fs = require('fs');
const path = require('path');

const USE_POSTGRES = !!process.env.DATABASE_URL;

// ─── MODE LOCAL : fichiers JSON ────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const FICHIERS = {
  voyages:      path.join(DATA_DIR, 'voyages.json'),
  reservations: path.join(DATA_DIR, 'reservations.json'),
  agenda:       path.join(DATA_DIR, 'agenda.json'),
  documents:    path.join(DATA_DIR, 'documents.json'),
};

function charger(cle) {
  if (!fs.existsSync(FICHIERS[cle])) return [];
  try { return JSON.parse(fs.readFileSync(FICHIERS[cle], 'utf8')); } catch { return []; }
}
function sauvegarder(cle, data) { fs.writeFileSync(FICHIERS[cle], JSON.stringify(data, null, 2)); }
function nextId(liste) { return liste.length === 0 ? 1 : Math.max(...liste.map(x => x.id)) + 1; }

// Données de démo au premier lancement
const voyagesInit = charger('voyages');
if (voyagesInit.length === 0) {
  sauvegarder('voyages', [
    { id: 1, nom: 'Bayonne 2026', destination: 'Bayonne, France', date_debut: '2026-05-01', date_fin: '2026-05-07', description: 'Voyage à Bayonne', couleur: '#F59E0B', created_at: new Date().toISOString() },
    { id: 2, nom: 'Corse Été 2026', destination: 'Corse, France', date_debut: '2026-06-26', date_fin: '2026-07-12', description: 'Vacances en famille en Corse', couleur: '#10B981', created_at: new Date().toISOString() },
  ]);
}

const localDB = {
  voyages: {
    getAll: () => charger('voyages').sort((a,b) => (a.date_debut||'').localeCompare(b.date_debut||'')),
    getById: (id) => charger('voyages').find(v => v.id === +id),
    create: (data) => { const list = charger('voyages'); const item = { ...data, id: nextId(list), created_at: new Date().toISOString() }; list.push(item); sauvegarder('voyages', list); return item; },
    update: (id, data) => { const list = charger('voyages'); const idx = list.findIndex(v => v.id === +id); if (idx===-1) return false; list[idx] = { ...list[idx], ...data }; sauvegarder('voyages', list); return true; },
    delete: (id) => { sauvegarder('voyages', charger('voyages').filter(v => v.id !== +id)); sauvegarder('reservations', charger('reservations').filter(r => r.voyage_id !== +id)); sauvegarder('agenda', charger('agenda').filter(a => a.voyage_id !== +id)); sauvegarder('documents', charger('documents').filter(d => d.voyage_id !== +id)); }
  },
  reservations: {
    getByVoyage: (vid) => charger('reservations').filter(r => r.voyage_id === +vid).sort((a,b) => (a.date_debut||'').localeCompare(b.date_debut||'')),
    getById: (id) => charger('reservations').find(r => r.id === +id),
    create: (vid, data) => { const list = charger('reservations'); const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() }; list.push(item); sauvegarder('reservations', list); return item; },
    update: (id, data) => { const list = charger('reservations'); const idx = list.findIndex(r => r.id === +id); if (idx===-1) return false; list[idx] = { ...list[idx], ...data }; sauvegarder('reservations', list); return true; },
    delete: (id) => sauvegarder('reservations', charger('reservations').filter(r => r.id !== +id))
  },
  agenda: {
    getByVoyage: (vid) => charger('agenda').filter(a => a.voyage_id === +vid).sort((a,b) => (a.date+(a.heure||'')).localeCompare(b.date+(b.heure||''))),
    create: (vid, data) => { const list = charger('agenda'); const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() }; list.push(item); sauvegarder('agenda', list); return item; },
    update: (id, data) => { const list = charger('agenda'); const idx = list.findIndex(a => a.id === +id); if (idx===-1) return false; list[idx] = { ...list[idx], ...data }; sauvegarder('agenda', list); return true; },
    delete: (id) => sauvegarder('agenda', charger('agenda').filter(a => a.id !== +id))
  },
  documents: {
    getByVoyage: (vid) => charger('documents').filter(d => d.voyage_id === +vid).map(d => ({ ...d, contenu: undefined })).sort((a,b) => b.created_at.localeCompare(a.created_at)),
    getById: (id) => charger('documents').find(d => d.id === +id),
    create: (vid, data) => { const list = charger('documents'); const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() }; list.push(item); sauvegarder('documents', list); return item; },
    delete: (id) => sauvegarder('documents', charger('documents').filter(d => d.id !== +id))
  }
};

// ─── MODE CLOUD : PostgreSQL ───────────────────────────────────────────────
let pgPool = null;
if (USE_POSTGRES) {
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Initialiser les tables
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS voyages (
      id SERIAL PRIMARY KEY, nom TEXT NOT NULL, destination TEXT NOT NULL,
      date_debut TEXT, date_fin TEXT, description TEXT, couleur TEXT DEFAULT '#3B82F6',
      created_at TEXT DEFAULT now()::text
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, type TEXT, titre TEXT,
      date_debut TEXT, date_fin TEXT, heure_debut TEXT, heure_fin TEXT,
      lieu TEXT, adresse TEXT, numero_confirmation TEXT, notes TEXT,
      created_at TEXT DEFAULT now()::text
    );
    CREATE TABLE IF NOT EXISTS agenda (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, date TEXT, heure TEXT,
      titre TEXT, description TEXT, lieu TEXT, type TEXT DEFAULT 'activite',
      created_at TEXT DEFAULT now()::text
    );
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, nom TEXT,
      type_fichier TEXT, taille INTEGER, categorie TEXT DEFAULT 'autre',
      contenu TEXT, created_at TEXT DEFAULT now()::text
    );
  `).catch(console.error);
}

const pgDB = pgPool ? {
  voyages: {
    getAll: async () => (await pgPool.query('SELECT * FROM voyages ORDER BY date_debut ASC NULLS LAST')).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM voyages WHERE id=$1', [id])).rows[0],
    create: async (data) => (await pgPool.query('INSERT INTO voyages(nom,destination,date_debut,date_fin,description,couleur) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [data.nom,data.destination,data.date_debut,data.date_fin,data.description,data.couleur||'#3B82F6'])).rows[0],
    update: async (id, data) => { await pgPool.query('UPDATE voyages SET nom=$1,destination=$2,date_debut=$3,date_fin=$4,description=$5,couleur=$6 WHERE id=$7', [data.nom,data.destination,data.date_debut,data.date_fin,data.description,data.couleur,id]); return true; },
    delete: async (id) => { await pgPool.query('DELETE FROM reservations WHERE voyage_id=$1', [id]); await pgPool.query('DELETE FROM agenda WHERE voyage_id=$1', [id]); await pgPool.query('DELETE FROM documents WHERE voyage_id=$1', [id]); await pgPool.query('DELETE FROM voyages WHERE id=$1', [id]); }
  },
  reservations: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM reservations WHERE voyage_id=$1 ORDER BY date_debut ASC NULLS LAST', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM reservations WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query('INSERT INTO reservations(voyage_id,type,titre,date_debut,date_fin,heure_debut,heure_fin,lieu,adresse,numero_confirmation,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [vid,data.type,data.titre,data.date_debut,data.date_fin,data.heure_debut,data.heure_fin,data.lieu,data.adresse,data.numero_confirmation,data.notes])).rows[0],
    update: async (id, data) => { await pgPool.query('UPDATE reservations SET type=$1,titre=$2,date_debut=$3,date_fin=$4,heure_debut=$5,heure_fin=$6,lieu=$7,adresse=$8,numero_confirmation=$9,notes=$10 WHERE id=$11', [data.type,data.titre,data.date_debut,data.date_fin,data.heure_debut,data.heure_fin,data.lieu,data.adresse,data.numero_confirmation,data.notes,id]); return true; },
    delete: async (id) => pgPool.query('DELETE FROM reservations WHERE id=$1', [id])
  },
  agenda: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM agenda WHERE voyage_id=$1 ORDER BY date ASC, heure ASC NULLS LAST', [vid])).rows,
    create: async (vid, data) => (await pgPool.query('INSERT INTO agenda(voyage_id,date,heure,titre,description,lieu,type) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [vid,data.date,data.heure,data.titre,data.description,data.lieu,data.type||'activite'])).rows[0],
    update: async (id, data) => { await pgPool.query('UPDATE agenda SET date=$1,heure=$2,titre=$3,description=$4,lieu=$5,type=$6 WHERE id=$7', [data.date,data.heure,data.titre,data.description,data.lieu,data.type,id]); return true; },
    delete: async (id) => pgPool.query('DELETE FROM agenda WHERE id=$1', [id])
  },
  documents: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT id,voyage_id,nom,type_fichier,taille,categorie,created_at FROM documents WHERE voyage_id=$1 ORDER BY created_at DESC', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM documents WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query('INSERT INTO documents(voyage_id,nom,type_fichier,taille,categorie,contenu) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [vid,data.nom,data.type_fichier,data.taille,data.categorie||'autre',data.contenu])).rows[0],
    delete: async (id) => pgPool.query('DELETE FROM documents WHERE id=$1', [id])
  }
} : null;

// Export : utilise PostgreSQL en production, JSON en local
module.exports = USE_POSTGRES ? pgDB : localDB;
module.exports.isAsync = USE_POSTGRES;
