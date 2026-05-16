// Migration : données locales JSON → PostgreSQL Railway
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');

function readJson(file) {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

async function migrate() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL manquant'); process.exit(1); }

  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('✅ Connecté à PostgreSQL');

  // Créer les tables si elles n'existent pas encore
  await client.query(`
    CREATE TABLE IF NOT EXISTS voyages (
      id SERIAL PRIMARY KEY, nom TEXT, destination TEXT,
      date_debut DATE, date_fin DATE, description TEXT,
      couleur TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), share_token TEXT
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY, voyage_id INT REFERENCES voyages(id) ON DELETE CASCADE,
      type TEXT, titre TEXT, description TEXT, date_debut DATE, date_fin DATE,
      heure TEXT, lieu TEXT, confirmation TEXT, prix NUMERIC, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agenda (
      id SERIAL PRIMARY KEY, voyage_id INT REFERENCES voyages(id) ON DELETE CASCADE,
      titre TEXT, date DATE, heure TEXT, lieu TEXT, type TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY, voyage_id INT REFERENCES voyages(id) ON DELETE CASCADE,
      event_id INT, reservation_id INT, nom TEXT, type_fichier TEXT,
      taille INT, categorie TEXT, contenu TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS participants (
      id SERIAL PRIMARY KEY, voyage_id INT REFERENCES voyages(id) ON DELETE CASCADE,
      nom TEXT, couleur TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS depenses (
      id SERIAL PRIMARY KEY, voyage_id INT REFERENCES voyages(id) ON DELETE CASCADE,
      titre TEXT, montant NUMERIC, payeur_id INT, participants_ids TEXT,
      date DATE, categorie TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bagages (
      id SERIAL PRIMARY KEY, voyage_id INT REFERENCES voyages(id) ON DELETE CASCADE,
      participant_id INT, nom TEXT, categorie TEXT, quantite INT DEFAULT 1,
      emballe BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Vider les tables avant import
  await client.query('TRUNCATE bagages, depenses, participants, documents, agenda, reservations, voyages RESTART IDENTITY CASCADE');
  console.log('🗑️  Tables vidées');

  // Voyages
  const voyages = readJson('voyages.json');
  for (const v of voyages) {
    await client.query(
      `INSERT INTO voyages (id, nom, destination, date_debut, date_fin, description, couleur, created_at, share_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [v.id, v.nom, v.destination, v.date_debut||null, v.date_fin||null, v.description||'', v.couleur||'#6B7280', v.created_at||new Date(), v.share_token||null]
    );
  }
  await client.query(`SELECT setval('voyages_id_seq', (SELECT MAX(id) FROM voyages))`);
  console.log(`✅ ${voyages.length} voyages importés`);

  // Réservations
  const reservations = readJson('reservations.json');
  for (const r of reservations) {
    await client.query(
      `INSERT INTO reservations (id, voyage_id, type, titre, description, date_debut, date_fin, heure, lieu, confirmation, prix, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [r.id, r.voyage_id, r.type||'', r.titre||'', r.description||'', r.date_debut||null, r.date_fin||null, r.heure||'', r.lieu||'', r.confirmation||'', r.prix||null, r.notes||'', r.created_at||new Date()]
    );
  }
  if (reservations.length) await client.query(`SELECT setval('reservations_id_seq', (SELECT MAX(id) FROM reservations))`);
  console.log(`✅ ${reservations.length} réservations importées`);

  // Agenda
  const agenda = readJson('agenda.json');
  for (const a of agenda) {
    await client.query(
      `INSERT INTO agenda (id, voyage_id, titre, date, heure, lieu, type, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.id, a.voyage_id, a.titre||'', a.date||null, a.heure||'', a.lieu||'', a.type||'', a.notes||'', a.created_at||new Date()]
    );
  }
  if (agenda.length) await client.query(`SELECT setval('agenda_id_seq', (SELECT MAX(id) FROM agenda))`);
  console.log(`✅ ${agenda.length} événements agenda importés`);

  // Documents
  const documents = readJson('documents.json');
  for (const d of documents) {
    await client.query(
      `INSERT INTO documents (id, voyage_id, event_id, reservation_id, nom, type_fichier, taille, categorie, contenu, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [d.id, d.voyage_id, d.event_id||null, d.reservation_id||null, d.nom||'', d.type_fichier||'', d.taille||0, d.categorie||'autre', d.contenu||'', d.created_at||new Date()]
    );
  }
  if (documents.length) await client.query(`SELECT setval('documents_id_seq', (SELECT MAX(id) FROM documents))`);
  console.log(`✅ ${documents.length} documents importés`);

  // Dépenses
  const depenses = readJson('depenses.json');
  for (const d of depenses) {
    await client.query(
      `INSERT INTO depenses (id, voyage_id, titre, montant, payeur_id, participants_ids, date, categorie, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [d.id, d.voyage_id, d.titre||'', d.montant||0, d.payeur_id||null, d.participants_ids||'[]', d.date||null, d.categorie||'autre', d.created_at||new Date()]
    );
  }
  if (depenses.length) await client.query(`SELECT setval('depenses_id_seq', (SELECT MAX(id) FROM depenses))`);
  console.log(`✅ ${depenses.length} dépenses importées`);

  // Bagages
  const bagages = readJson('bagages.json');
  for (const b of bagages) {
    await client.query(
      `INSERT INTO bagages (id, voyage_id, participant_id, nom, categorie, quantite, emballe, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [b.id, b.voyage_id, b.participant_id||null, b.nom||'', b.categorie||'', b.quantite||1, b.emballe||false, b.created_at||new Date()]
    );
  }
  if (bagages.length) await client.query(`SELECT setval('bagages_id_seq', (SELECT MAX(id) FROM bagages))`);
  console.log(`✅ ${bagages.length} bagages importés`);

  await client.end();
  console.log('\n🎉 Migration terminée ! Tes données sont sur Railway.');
}

migrate().catch(e => { console.error('❌ Erreur:', e.message); process.exit(1); });
