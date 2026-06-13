// Base de données — JSON local OU PostgreSQL cloud selon l'environnement
const fs = require('fs');
const path = require('path');

const USE_POSTGRES = !!process.env.DATABASE_URL;

// ─── MODE LOCAL : fichiers JSON ────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const FICHIERS = {
  users:               path.join(DATA_DIR, 'users.json'),
  voyages:             path.join(DATA_DIR, 'voyages.json'),
  reservations:        path.join(DATA_DIR, 'reservations.json'),
  agenda:              path.join(DATA_DIR, 'agenda.json'),
  documents:           path.join(DATA_DIR, 'documents.json'),
  participants:        path.join(DATA_DIR, 'participants.json'),
  depenses:            path.join(DATA_DIR, 'depenses.json'),
  bagages:             path.join(DATA_DIR, 'bagages.json'),
  push_subscriptions:  path.join(DATA_DIR, 'push_subscriptions.json'),
  demandes:            path.join(DATA_DIR, 'demandes.json'),
  attributions:        path.join(DATA_DIR, 'attributions.json'),
  docs_participants:   path.join(DATA_DIR, 'docs_participants.json'),
  commentaires:        path.join(DATA_DIR, 'commentaires.json'),
  messages_prives:     path.join(DATA_DIR, 'messages_prives.json'),
  locations:           path.join(DATA_DIR, 'locations.json'),
  hype_votes:           path.join(DATA_DIR, 'hype_votes.json'),
  participant_profiles: path.join(DATA_DIR, 'participant_profiles.json'),
  wishlist:             path.join(DATA_DIR, 'wishlist.json'),
  sondages:             path.join(DATA_DIR, 'sondages.json'),
  photos:               path.join(DATA_DIR, 'photos.json'),
  photo_likes:          path.join(DATA_DIR, 'photo_likes.json'),
  trip_memory_emails:   path.join(DATA_DIR, 'trip_memory_emails.json'),
  trip_top_photos:      path.join(DATA_DIR, 'trip_top_photos.json'),
  capsules:             path.join(DATA_DIR, 'capsules.json'),
  participant_emails:      path.join(DATA_DIR, 'participant_emails.json'),
  magic_links:             path.join(DATA_DIR, 'magic_links.json'),
  user_participant_links:  path.join(DATA_DIR, 'user_participant_links.json'),
  attribution_links:       path.join(DATA_DIR, 'attribution_links.json'),
  participant_sessions:    path.join(DATA_DIR, 'participant_sessions.json'),
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
  users: {
    // Mode local : les comptes sont persistés dans data/users.json
    // Permet login + register normaux sans PostgreSQL
    getByEmail: (email) => charger('users').find(u => u.email === email) || null,
    // Même sélection qu'en cloud : on n'expose jamais password_hash via getById
    getById: (id) => { const u = charger('users').find(u => u.id === +id); if (!u) return null; const { password_hash, ...safe } = u; return safe; },
    create: (email, hash, nom) => {
      const list = charger('users');
      const item = { id: nextId(list), email, password_hash: hash, nom, created_at: new Date().toISOString() };
      list.push(item);
      sauvegarder('users', list);
      return item;
    },
    getAll: () => charger('users'),
    count: () => charger('users').length,
    claimOrphanVoyages: (userId) => {
      const list = charger('voyages');
      let changed = false;
      list.forEach(v => { if (!v.owner_id) { v.owner_id = userId; changed = true; } });
      if (changed) sauvegarder('voyages', list);
    },
    // RGPD art. 17 — supprime le compte + données liées à l'email
    delete: (id) => {
      const user = charger('users').find(u => u.id === +id);
      sauvegarder('users', charger('users').filter(u => u.id !== +id));
      sauvegarder('user_participant_links', charger('user_participant_links').filter(l => l.user_id !== +id));
      if (user?.email) {
        sauvegarder('magic_links', charger('magic_links').filter(m => m.email !== user.email));
        sauvegarder('participant_emails', charger('participant_emails').filter(p => p.email !== user.email));
      }
    }
  },
  voyages: {
    getAllForReminders: () => charger('voyages').filter(v => v.date_debut && v.statut !== 'terminé'),
    getAll: () => charger('voyages').sort((a,b) => (a.date_debut||'').localeCompare(b.date_debut||'')),
    getAllWithSummary: () => {
      const voyages = charger('voyages').sort((a,b) => (a.date_debut||'').localeCompare(b.date_debut||''));
      const capsulesList = charger('capsules');
      const topPhotosList = charger('trip_top_photos');
      const participantsList = charger('participants');
      return voyages.map(v => {
        const isMemory = ['archived','completed','terminé'].includes(v.statut);
        const parts = participantsList.filter(p => p.voyage_id === v.id);
        if (!isMemory) return { ...v, participant_count: parts.length };
        const caps = capsulesList.filter(c => c.voyage_id === v.id);
        const notes = caps.map(c => c.note).filter(n => n != null);
        const avgNote = notes.length ? Math.round((notes.reduce((a,b)=>a+b)/notes.length)*10)/10 : null;
        const topRec = topPhotosList.find(t => t.voyage_id === v.id);
        const topIds = topRec ? JSON.parse(topRec.photo_ids || '[]') : [];
        return { ...v, participant_count: parts.length, top_photo_id: topIds[0]||null, avg_capsule_note: avgNote, capsule_count: caps.length };
      });
    },
    getById: (id) => charger('voyages').find(v => v.id === +id),
    getByToken: (token) => charger('voyages').find(v => v.share_token === token),
    setToken: (id, token) => { const list = charger('voyages'); const idx = list.findIndex(v => v.id === +id); if (idx !== -1) { list[idx].share_token = token; sauvegarder('voyages', list); } return true; },
    setStatut: (id, statut) => { const list = charger('voyages'); const idx = list.findIndex(v => v.id === +id); if (idx !== -1) { list[idx].statut = statut; sauvegarder('voyages', list); } return true; },
    setStatutFull: (id, statut, extra = {}) => { const list = charger('voyages'); const idx = list.findIndex(v => v.id === +id); if (idx !== -1) { list[idx].statut = statut; Object.assign(list[idx], extra); sauvegarder('voyages', list); } return true; },
    setMemorySummary: (id, summary) => { const list = charger('voyages'); const idx = list.findIndex(v => v.id === +id); if (idx !== -1) { list[idx].memory_summary = summary; sauvegarder('voyages', list); } return true; },
    create: (data) => { const list = charger('voyages'); const item = { ...data, id: nextId(list), created_at: new Date().toISOString() }; list.push(item); sauvegarder('voyages', list); return item; },
    update: (id, data) => { const list = charger('voyages'); const idx = list.findIndex(v => v.id === +id); if (idx===-1) return false; list[idx] = { ...list[idx], ...data }; sauvegarder('voyages', list); return true; },
    delete: (id) => {
      sauvegarder('bagages', charger('bagages').filter(b => b.voyage_id !== +id));
      sauvegarder('depenses', charger('depenses').filter(d => d.voyage_id !== +id));
      sauvegarder('participants', charger('participants').filter(p => p.voyage_id !== +id));
      sauvegarder('reservations', charger('reservations').filter(r => r.voyage_id !== +id));
      sauvegarder('agenda', charger('agenda').filter(a => a.voyage_id !== +id));
      sauvegarder('documents', charger('documents').filter(d => d.voyage_id !== +id));
      sauvegarder('hype_votes', charger('hype_votes').filter(h => h.voyage_id !== +id));
      sauvegarder('participant_profiles', charger('participant_profiles').filter(p => p.voyage_id !== +id));
      sauvegarder('wishlist', charger('wishlist').filter(w => w.voyage_id !== +id));
      sauvegarder('sondages', charger('sondages').filter(s => s.voyage_id !== +id));
      sauvegarder('photos', charger('photos').filter(p => p.voyage_id !== +id));
      sauvegarder('photo_likes', charger('photo_likes').filter(l => l.voyage_id !== +id));
      sauvegarder('trip_memory_emails', charger('trip_memory_emails').filter(e => e.voyage_id !== +id));
      sauvegarder('trip_top_photos', charger('trip_top_photos').filter(t => t.voyage_id !== +id));
      sauvegarder('voyages', charger('voyages').filter(v => v.id !== +id));
    }
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
    getById: (id) => charger('agenda').find(a => a.id === +id),
    create: (vid, data) => { const list = charger('agenda'); const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() }; list.push(item); sauvegarder('agenda', list); return item; },
    update: (id, data) => { const list = charger('agenda'); const idx = list.findIndex(a => a.id === +id); if (idx===-1) return false; list[idx] = { ...list[idx], ...data }; sauvegarder('agenda', list); return true; },
    delete: (id) => sauvegarder('agenda', charger('agenda').filter(a => a.id !== +id))
  },
  documents: {
    getByVoyage: (vid) => charger('documents').filter(d => d.voyage_id === +vid).map(d => ({ ...d, contenu: undefined })).sort((a,b) => b.created_at.localeCompare(a.created_at)),
    getById: (id) => charger('documents').find(d => d.id === +id),
    create: (vid, data) => { const list = charger('documents'); const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() }; list.push(item); sauvegarder('documents', list); return item; },
    update: (id, data) => { const list = charger('documents'); const idx = list.findIndex(d => d.id === +id); if (idx !== -1) { list[idx] = { ...list[idx], nom: data.nom ?? list[idx].nom, categorie: data.categorie ?? list[idx].categorie, event_id: data.event_id ?? null, reservation_id: data.reservation_id ?? null }; sauvegarder('documents', list); } return list[idx]; },
    delete: (id) => sauvegarder('documents', charger('documents').filter(d => d.id !== +id))
  },
  participants: {
    getByVoyage: (vid) => charger('participants').filter(p => p.voyage_id === +vid),
    getById: (id) => charger('participants').find(p => p.id === +id),
    create: (vid, data) => { const list = charger('participants'); const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() }; list.push(item); sauvegarder('participants', list); return item; },
    update: (id, data) => { const list = charger('participants'); const idx = list.findIndex(p => p.id === +id); if (idx === -1) return false; list[idx] = { ...list[idx], ...data }; sauvegarder('participants', list); return true; },
    setRole: (id, role) => { const list = charger('participants'); const idx = list.findIndex(p => p.id === +id); if (idx === -1) return false; list[idx] = { ...list[idx], role }; sauvegarder('participants', list); return true; },
    delete: (id) => {
      sauvegarder('bagages', charger('bagages').filter(b => b.participant_id !== +id));
      sauvegarder('participants', charger('participants').filter(p => p.id !== +id));
    }
  },
  depenses: {
    getByVoyage: (vid) => charger('depenses').filter(d => d.voyage_id === +vid).sort((a,b) => (b.date||'').localeCompare(a.date||'')),
    getById: (id) => charger('depenses').find(d => d.id === +id),
    create: (vid, data) => { const list = charger('depenses'); const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() }; list.push(item); sauvegarder('depenses', list); return item; },
    update: (id, data) => { const list = charger('depenses'); const idx = list.findIndex(d => d.id === +id); if (idx===-1) return false; list[idx] = { ...list[idx], ...data }; sauvegarder('depenses', list); return true; },
    delete: (id) => sauvegarder('depenses', charger('depenses').filter(d => d.id !== +id))
  },
  bagages: {
    getByVoyage: (vid) => charger('bagages').filter(b => b.voyage_id === +vid),
    getByParticipant: (vid, pid) => charger('bagages').filter(b => b.voyage_id === +vid && b.participant_id === +pid),
    getById: (id) => charger('bagages').find(b => b.id === +id),
    create: (vid, data) => { const list = charger('bagages'); const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() }; list.push(item); sauvegarder('bagages', list); return item; },
    update: (id, data) => { const list = charger('bagages'); const idx = list.findIndex(b => b.id === +id); if (idx===-1) return false; list[idx] = { ...list[idx], ...data }; sauvegarder('bagages', list); return true; },
    delete: (id) => sauvegarder('bagages', charger('bagages').filter(b => b.id !== +id)),
    deleteByVoyageParticipant: (vid, pid) => sauvegarder('bagages', charger('bagages').filter(b => !(b.voyage_id === +vid && b.participant_id === +pid)))
  },
  push_subscriptions: {
    getByVoyage: (vid) => charger('push_subscriptions').filter(s => s.voyage_id === +vid),
    getByParticipant: (vid, pid) => charger('push_subscriptions').filter(s => s.voyage_id === +vid && s.participant_id === +pid),
    upsert: (vid, sub) => {
      const list = charger('push_subscriptions');
      const idx = list.findIndex(s => s.endpoint === sub.endpoint);
      const item = { voyage_id: +vid, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, participant_id: sub.participant_id || null };
      if (idx === -1) { list.push({ ...item, id: nextId(list) }); } else { list[idx] = { ...list[idx], ...item }; }
      sauvegarder('push_subscriptions', list);
      return true;
    },
    deleteByEndpoint: (endpoint) => {
      const list = charger('push_subscriptions').filter(s => s.endpoint !== endpoint);
      sauvegarder('push_subscriptions', list);
      return true;
    }
  },
  messages_prives: {
    getByVoyage: (vid) => charger('messages_prives').filter(m => m.voyage_id === +vid).sort((a,b) => b.created_at.localeCompare(a.created_at)),
    getByParticipant: (vid, pid) => charger('messages_prives').filter(m => m.voyage_id === +vid && m.participant_id === +pid).sort((a,b) => a.created_at.localeCompare(b.created_at)),
    getById: (id) => charger('messages_prives').find(m => m.id === +id),
    create: (vid, data) => { const list = charger('messages_prives'); const item = { ...data, id: nextId(list), voyage_id: +vid, lu: false, created_at: new Date().toISOString() }; list.push(item); sauvegarder('messages_prives', list); return item; },
    marquerLu: (id) => { const list = charger('messages_prives'); const idx = list.findIndex(m => m.id === +id); if (idx !== -1) { list[idx].lu = true; sauvegarder('messages_prives', list); } },
    delete: (id) => sauvegarder('messages_prives', charger('messages_prives').filter(m => m.id !== +id))
  },
  demandes: {
    getByVoyage: (vid) => charger('demandes').filter(d => d.voyage_id === +vid).sort((a,b) => b.created_at.localeCompare(a.created_at)),
    getById: (id) => charger('demandes').find(d => d.id === +id),
    create: (vid, data) => {
      const list = charger('demandes');
      const item = { ...data, id: nextId(list), voyage_id: +vid, statut: 'en_attente', created_at: new Date().toISOString() };
      list.push(item); sauvegarder('demandes', list); return item;
    },
    update: (id, data) => {
      const list = charger('demandes');
      const idx = list.findIndex(d => d.id === +id);
      if (idx === -1) return false;
      list[idx] = { ...list[idx], ...data }; sauvegarder('demandes', list); return true;
    },
    delete: (id) => sauvegarder('demandes', charger('demandes').filter(d => d.id !== +id))
  },
  attributions: {
    getByVoyage: (vid) => charger('attributions').filter(a => a.voyage_id === +vid).sort((a,b) => a.participant_id - b.participant_id),
    getByParticipant: (vid, pid) => charger('attributions').filter(a => a.voyage_id === +vid && a.participant_id === +pid),
    getById: (id) => charger('attributions').find(a => a.id === +id),
    create: (vid, data) => {
      const list = charger('attributions');
      const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() };
      list.push(item); sauvegarder('attributions', list); return item;
    },
    delete: (id) => sauvegarder('attributions', charger('attributions').filter(a => a.id !== +id))
  },
  attribution_links: {
    getByAttribution: (aid) => charger('attribution_links')
      .filter(l => l.attribution_id === +aid)
      .sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id),
    getById: (id) => charger('attribution_links').find(l => l.id === +id),
    create: (aid, data) => {
      const list = charger('attribution_links');
      const maxPos = list.filter(l => l.attribution_id === +aid).reduce((m, l) => Math.max(m, l.position || 0), 0);
      const item = { ...data, id: nextId(list), attribution_id: +aid, position: maxPos + 1, created_at: new Date().toISOString() };
      list.push(item); sauvegarder('attribution_links', list); return item;
    },
    update: (id, data) => {
      const list = charger('attribution_links');
      const idx = list.findIndex(l => l.id === +id);
      if (idx === -1) return null;
      list[idx] = { ...list[idx], ...data, id: +id };
      sauvegarder('attribution_links', list); return list[idx];
    },
    deleteByAttribution: (aid) => sauvegarder('attribution_links', charger('attribution_links').filter(l => l.attribution_id !== +aid)),
    delete: (id) => sauvegarder('attribution_links', charger('attribution_links').filter(l => l.id !== +id))
  },
  commentaires: {
    getByVoyage: (vid) => charger('commentaires').filter(c => c.voyage_id === +vid).sort((a,b) => a.created_at.localeCompare(b.created_at)),
    create: (vid, data) => {
      const list = charger('commentaires');
      const item = {
        id: nextId(list), voyage_id: +vid,
        auteur: data.auteur, message: data.message,
        reply_to_id: data.reply_to_id || null,
        reply_to_auteur: data.reply_to_auteur || null,
        reply_to_preview: data.reply_to_preview || null,
        reactions: '{}',
        created_at: new Date().toISOString()
      };
      list.push(item); sauvegarder('commentaires', list); return item;
    },
    react: (id, emoji, auteur) => {
      const list = charger('commentaires');
      const item = list.find(c => c.id === +id);
      if (!item) return null;
      let reactions = {};
      try { reactions = JSON.parse(item.reactions || '{}'); } catch(e) {}
      if (!reactions[emoji]) reactions[emoji] = [];
      const idx = reactions[emoji].indexOf(auteur);
      if (idx === -1) reactions[emoji].push(auteur);
      else reactions[emoji].splice(idx, 1);
      if (reactions[emoji].length === 0) delete reactions[emoji];
      item.reactions = JSON.stringify(reactions);
      sauvegarder('commentaires', list);
      return item;
    },
    delete: (id) => sauvegarder('commentaires', charger('commentaires').filter(c => c.id !== +id))
  },
  docs_participants: {
    getByVoyage: (vid) => charger('docs_participants').filter(d => d.voyage_id === +vid).map(({ contenu, ...m }) => m).sort((a,b) => a.participant_id - b.participant_id || b.created_at.localeCompare(a.created_at)),
    getByParticipant: (vid, pid) => charger('docs_participants').filter(d => d.voyage_id === +vid && d.participant_id === +pid).map(({ contenu, ...m }) => m).sort((a,b) => b.created_at.localeCompare(a.created_at)),
    getById: (id) => charger('docs_participants').find(d => d.id === +id),
    create: (vid, data) => { const list = charger('docs_participants'); const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() }; list.push(item); sauvegarder('docs_participants', list); return item; },
    delete: (id) => sauvegarder('docs_participants', charger('docs_participants').filter(d => d.id !== +id))
  },
  locations: {
    getByVoyage: (vid) => {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000);
      return charger('locations').filter(l => l.voyage_id === +vid && new Date(l.updated_at) > cutoff);
    },
    upsert: (vid, data) => {
      const list = charger('locations');
      const idx = list.findIndex(l => l.voyage_id === +vid && l.device_id === data.device_id);
      const item = { voyage_id: +vid, device_id: data.device_id, participant_id: data.participant_id || null, nom: data.nom, couleur: data.couleur || '#6366F1', lat: data.lat, lng: data.lng, updated_at: new Date().toISOString() };
      if (idx === -1) { list.push({ ...item, id: nextId(list) }); } else { list[idx] = { ...list[idx], ...item }; }
      sauvegarder('locations', list);
      return true;
    },
    delete: (vid, device_id) => { sauvegarder('locations', charger('locations').filter(l => !(l.voyage_id === +vid && l.device_id === device_id))); }
  },
  hype_votes: {
    getByVoyage: (vid) => charger('hype_votes').filter(h => h.voyage_id === +vid),
    upsert: (vid, data) => {
      const list = charger('hype_votes');
      const idx = list.findIndex(h => h.voyage_id === +vid && h.auteur === data.auteur);
      const item = { voyage_id: +vid, auteur: data.auteur, score: data.score, emoji: data.emoji || null, updated_at: new Date().toISOString() };
      if (idx === -1) { list.push({ ...item, id: nextId(list) }); } else { list[idx] = { ...list[idx], ...item }; }
      sauvegarder('hype_votes', list);
      return true;
    }
  },
  participant_profiles: {
    getByVoyage: (vid) => charger('participant_profiles').filter(p => p.voyage_id === +vid),
    upsert: (vid, data) => {
      const list = charger('participant_profiles');
      const idx = list.findIndex(p => p.voyage_id === +vid && p.auteur === data.auteur);
      const item = { voyage_id: +vid, auteur: data.auteur, participant_id: data.participant_id || null, couleur: data.couleur || '#6B7280', truc_en_voyage: data.truc_en_voyage || null, chaud_pour: data.chaud_pour || null, refuse: data.refuse || null, updated_at: new Date().toISOString() };
      if (idx === -1) { list.push({ ...item, id: nextId(list) }); } else { list[idx] = { ...list[idx], ...item }; }
      sauvegarder('participant_profiles', list);
      return true;
    }
  },
  wishlist: {
    getByVoyage: (vid) => charger('wishlist').filter(w => w.voyage_id === +vid).sort((a,b) => b.created_at.localeCompare(a.created_at)),
    getById: (id) => charger('wishlist').find(w => w.id === +id),
    create: (vid, data) => {
      const list = charger('wishlist');
      const item = { ...data, id: nextId(list), voyage_id: +vid, likes: [], created_at: new Date().toISOString() };
      list.push(item); sauvegarder('wishlist', list); return item;
    },
    toggleLike: (id, auteur) => {
      const list = charger('wishlist');
      const idx = list.findIndex(w => w.id === +id);
      if (idx === -1) return false;
      const likes = list[idx].likes || [];
      const pos = likes.indexOf(auteur);
      if (pos === -1) { likes.push(auteur); } else { likes.splice(pos, 1); }
      list[idx].likes = likes;
      sauvegarder('wishlist', list);
      return pos === -1; // true = liké, false = unliké
    },
    delete: (id) => sauvegarder('wishlist', charger('wishlist').filter(w => w.id !== +id))
  },
  sondages: {
    getByVoyage: (vid) => charger('sondages').filter(s => s.voyage_id === +vid).sort((a,b) => b.created_at.localeCompare(a.created_at)),
    getById: (id) => charger('sondages').find(s => s.id === +id),
    create: (vid, data) => {
      const list = charger('sondages');
      const options = (data.options || []).map((texte, i) => ({ id: i + 1, texte }));
      const item = { id: nextId(list), voyage_id: +vid, titre: data.titre, created_by: data.created_by, statut: 'ouvert', options, votes: [], created_at: new Date().toISOString() };
      list.push(item); sauvegarder('sondages', list); return item;
    },
    vote: (id, optionId, auteur) => {
      const list = charger('sondages');
      const idx = list.findIndex(s => s.id === +id);
      if (idx === -1) return false;
      // Retirer le vote précédent de cet auteur
      list[idx].votes = (list[idx].votes || []).filter(v => v.auteur !== auteur);
      list[idx].votes.push({ option_id: +optionId, auteur });
      sauvegarder('sondages', list);
      return true;
    },
    fermer: (id) => {
      const list = charger('sondages');
      const idx = list.findIndex(s => s.id === +id);
      if (idx !== -1) { list[idx].statut = 'fermé'; sauvegarder('sondages', list); }
      return true;
    },
    delete: (id) => sauvegarder('sondages', charger('sondages').filter(s => s.id !== +id))
  },
  photos: {
    getByVoyage: (vid) => charger('photos').filter(p => p.voyage_id === +vid).sort((a,b) => b.created_at.localeCompare(a.created_at)),
    getById: (id) => charger('photos').find(p => p.id === +id),
    create: (vid, data) => { const list = charger('photos'); const item = { ...data, id: nextId(list), voyage_id: +vid, created_at: new Date().toISOString() }; list.push(item); sauvegarder('photos', list); return item; },
    delete: (id) => { sauvegarder('photo_likes', charger('photo_likes').filter(l => l.photo_id !== +id)); sauvegarder('photos', charger('photos').filter(p => p.id !== +id)); }
  },
  photo_likes: {
    getByVoyage: (vid) => charger('photo_likes').filter(l => l.voyage_id === +vid),
    toggle: (photoId, voyageId, auteur) => {
      const list = charger('photo_likes');
      const idx = list.findIndex(l => l.photo_id === +photoId && l.auteur === auteur);
      if (idx !== -1) { list.splice(idx, 1); sauvegarder('photo_likes', list); return false; }
      list.push({ id: nextId(list), photo_id: +photoId, voyage_id: +voyageId, auteur, created_at: new Date().toISOString() });
      sauvegarder('photo_likes', list);
      return true;
    }
  },
  trip_memory_emails: {
    getByVoyage: (vid) => charger('trip_memory_emails').find(e => e.voyage_id === +vid),
    create: (vid, data) => { const list = charger('trip_memory_emails'); const item = { ...data, id: nextId(list), voyage_id: +vid, sent_at: new Date().toISOString() }; list.push(item); sauvegarder('trip_memory_emails', list); return item; }
  },
  trip_top_photos: {
    getByVoyage: (vid) => charger('trip_top_photos').find(t => t.voyage_id === +vid),
    upsert: (vid, data) => {
      const list = charger('trip_top_photos');
      const idx = list.findIndex(t => t.voyage_id === +vid);
      const item = { voyage_id: +vid, photo_ids: data.photo_ids, scored_at: new Date().toISOString() };
      if (idx === -1) { list.push({ ...item, id: nextId(list) }); } else { list[idx] = { ...list[idx], ...item }; }
      sauvegarder('trip_top_photos', list);
      return true;
    }
  },
  capsules: {
    getByVoyage: (vid) => charger('capsules').filter(c => c.voyage_id === +vid).sort((a,b) => a.created_at.localeCompare(b.created_at)),
    getMine: (vid, nom) => charger('capsules').find(c => c.voyage_id === +vid && c.participant_nom === nom),
    upsert: (vid, nom, data) => {
      const list = charger('capsules');
      const idx = list.findIndex(c => c.voyage_id === +vid && c.participant_nom === nom);
      const now = new Date().toISOString();
      const item = { ...data, voyage_id: +vid, participant_nom: nom, id: idx >= 0 ? list[idx].id : nextId(list), created_at: idx >= 0 ? list[idx].created_at : now };
      if (idx >= 0) list[idx] = item; else list.push(item);
      sauvegarder('capsules', list);
      return item;
    },
    deleteByVoyage: (vid) => sauvegarder('capsules', charger('capsules').filter(c => c.voyage_id !== +vid))
  },
  magic_links: {
    create: (data) => {
      const list = charger('magic_links');
      const item = { ...data, id: nextId(list), used_at: null, created_at: new Date().toISOString() };
      list.push(item);
      sauvegarder('magic_links', list);
      return item;
    },
    getByToken: (token) => charger('magic_links').find(l => l.token === token) || null,
    markUsed: (token) => {
      const list = charger('magic_links');
      const idx = list.findIndex(l => l.token === token);
      if (idx !== -1) { list[idx].used_at = new Date().toISOString(); sauvegarder('magic_links', list); }
    }
  },
  user_participant_links: {
    upsert: (userId, participantId, voyageId, participantNom) => {
      const list = charger('user_participant_links');
      const idx  = list.findIndex(l => l.user_id === +userId && l.voyage_id === +voyageId && l.participant_nom === participantNom);
      const item = { user_id: +userId, participant_id: participantId ? +participantId : null, voyage_id: +voyageId, participant_nom: participantNom, linked_at: new Date().toISOString() };
      if (idx === -1) { list.push({ ...item, id: nextId(list) }); } else { list[idx] = { ...list[idx], ...item }; }
      sauvegarder('user_participant_links', list);
      return true;
    },
    getByUser:    (userId)    => charger('user_participant_links').filter(l => l.user_id    === +userId),
    getByVoyage:  (voyageId)  => charger('user_participant_links').filter(l => l.voyage_id  === +voyageId),
  },
  participant_emails: {
    save: (vid, nom, email) => {
      const list = charger('participant_emails');
      const idx = list.findIndex(e => e.voyage_id === +vid && e.participant_nom === nom);
      const item = { voyage_id: +vid, participant_nom: nom, email: email.toLowerCase().trim(), saved_at: new Date().toISOString() };
      if (idx === -1) { list.push({ ...item, id: nextId(list) }); } else { list[idx] = { ...list[idx], ...item }; }
      sauvegarder('participant_emails', list);
      return true;
    },
    getByVoyage: (vid) => charger('participant_emails').filter(e => e.voyage_id === +vid),
    getAllByEmail: (email) => charger('participant_emails').filter(e =>
      e.email && e.email.toLowerCase() === String(email).toLowerCase()
    ),
  },
  // Sessions participant (invités/owner en vue participant). Persistées en DB
  // pour survivre aux redéploiements. expires_at = date_fin du voyage + 5 jours.
  participant_sessions: {
    create: ({ token, participantId, voyageId, nom, couleur, role, expiresAt }) => {
      const list = charger('participant_sessions');
      const item = {
        token,
        participant_id: participantId != null ? +participantId : null,
        voyage_id: +voyageId,
        nom: nom || null,
        couleur: couleur || null,
        role: role || 'participant',
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
      };
      list.push(item);
      sauvegarder('participant_sessions', list);
      return item;
    },
    getByToken: (token) => charger('participant_sessions').find(s => s.token === token) || null,
    deleteByToken: (token) => {
      const list = charger('participant_sessions');
      const next = list.filter(s => s.token !== token);
      if (next.length !== list.length) sauvegarder('participant_sessions', next);
      return true;
    },
    purgeExpired: () => {
      const now = Date.now();
      const list = charger('participant_sessions');
      const next = list.filter(s => new Date(s.expires_at).getTime() > now);
      if (next.length !== list.length) sauvegarder('participant_sessions', next);
      return list.length - next.length;
    },
  },
};

// ─── MODE CLOUD : PostgreSQL ───────────────────────────────────────────────
let pgPool = null;
if (USE_POSTGRES) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,                     // connexions simultanées (Railway autorise 25)
    idleTimeoutMillis: 30000,    // libère une connexion inactive après 30s
    connectionTimeoutMillis: 5000 // échec propre si la DB est indisponible après 5s
  });

  // Initialiser les tables — chaque instruction est exécutée séparément
  // pour qu'une erreur sur l'une ne bloque pas les suivantes.
  (async () => {
    const m = (sql) => pgPool.query(sql).catch(e => console.error('[MIGRATION ERR]', e.message, '|', sql.trim().slice(0, 80)));
    await m(`CREATE TABLE IF NOT EXISTS voyages (
      id SERIAL PRIMARY KEY, nom TEXT NOT NULL, destination TEXT NOT NULL,
      date_debut TEXT, date_fin TEXT, description TEXT, couleur TEXT DEFAULT '#3B82F6',
      created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, type TEXT, titre TEXT,
      date_debut TEXT, date_fin TEXT, heure_debut TEXT, heure_fin TEXT,
      lieu TEXT, adresse TEXT, numero_confirmation TEXT, notes TEXT, lien TEXT,
      created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS agenda (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, date TEXT, heure TEXT,
      titre TEXT, description TEXT, lieu TEXT, type TEXT DEFAULT 'activite',
      lien TEXT, created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, nom TEXT,
      type_fichier TEXT, taille INTEGER, categorie TEXT DEFAULT 'autre',
      event_id INTEGER, reservation_id INTEGER, contenu TEXT, created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS participants (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL,
      nom TEXT, couleur TEXT DEFAULT '#6366F1',
      created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS depenses (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL,
      titre TEXT, montant NUMERIC(10,2), payeur_id INTEGER,
      participants_ids TEXT, date TEXT, categorie TEXT DEFAULT 'autre',
      created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS bagages (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL, nom TEXT, categorie TEXT DEFAULT 'divers',
      checked BOOLEAN DEFAULT FALSE, created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL,
      endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT,
      created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS demandes (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL,
      auteur TEXT, onglet TEXT, element_type TEXT,
      element_id INTEGER, element_nom TEXT, message TEXT,
      statut TEXT DEFAULT 'en_attente', created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS attributions (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL, titre TEXT NOT NULL,
      contenu TEXT, document_id INTEGER,
      created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS attribution_links (
      id SERIAL PRIMARY KEY, attribution_id INTEGER NOT NULL REFERENCES attributions(id) ON DELETE CASCADE,
      titre TEXT NOT NULL, url TEXT NOT NULL,
      description TEXT, type TEXT DEFAULT 'autre',
      position INTEGER DEFAULT 1,
      created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS messages_prives (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL, auteur TEXT NOT NULL DEFAULT 'Organisateur',
      message TEXT NOT NULL, lu BOOLEAN DEFAULT FALSE,
      created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS commentaires (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL,
      auteur TEXT NOT NULL, message TEXT NOT NULL,
      reply_to_id INTEGER, reply_to_auteur TEXT, reply_to_preview TEXT,
      reactions TEXT DEFAULT '{}',
      created_at TEXT DEFAULT now()::text
    )`);
    // Migration idempotente pour les tables existantes
    await m(`ALTER TABLE commentaires ADD COLUMN IF NOT EXISTS reply_to_id INTEGER`).catch(()=>{});
    await m(`ALTER TABLE commentaires ADD COLUMN IF NOT EXISTS reply_to_auteur TEXT`).catch(()=>{});
    await m(`ALTER TABLE commentaires ADD COLUMN IF NOT EXISTS reply_to_preview TEXT`).catch(()=>{});
    await m(`ALTER TABLE commentaires ADD COLUMN IF NOT EXISTS reactions TEXT DEFAULT '{}'`).catch(()=>{});
    await m(`CREATE TABLE IF NOT EXISTS docs_participants (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL,
      participant_id INTEGER NOT NULL, nom TEXT NOT NULL,
      type_fichier TEXT, taille INTEGER, categorie TEXT DEFAULT 'autre',
      contenu TEXT, created_at TEXT DEFAULT now()::text
    )`);
    await m(`CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, device_id TEXT NOT NULL,
      participant_id INTEGER, nom TEXT NOT NULL, couleur TEXT DEFAULT '#6366F1',
      lat NUMERIC(10,6) NOT NULL, lng NUMERIC(10,6) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(voyage_id, device_id)
    )`);
    await m(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, nom TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await m(`CREATE TABLE IF NOT EXISTS hype_votes (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, auteur TEXT NOT NULL,
      score SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5), emoji TEXT,
      updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(voyage_id, auteur)
    )`);
    await m(`CREATE TABLE IF NOT EXISTS participant_profiles (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, auteur TEXT NOT NULL,
      participant_id INTEGER, couleur TEXT DEFAULT '#6B7280',
      truc_en_voyage TEXT, chaud_pour TEXT, refuse TEXT,
      updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(voyage_id, auteur)
    )`);
    await m(`CREATE TABLE IF NOT EXISTS wishlist (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, auteur TEXT NOT NULL,
      titre TEXT NOT NULL, description TEXT, type TEXT DEFAULT 'activite',
      url TEXT, likes TEXT DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await m(`CREATE TABLE IF NOT EXISTS sondages (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL, titre TEXT NOT NULL,
      created_by TEXT NOT NULL, statut TEXT DEFAULT 'ouvert',
      options JSONB DEFAULT '[]', votes JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    // Migrations ALTER TABLE — colonnes ajoutées au fil des versions
    await m(`ALTER TABLE agenda ADD COLUMN IF NOT EXISTS lien TEXT`);
    await m(`ALTER TABLE agenda ADD COLUMN IF NOT EXISTS description TEXT`);
    await m(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS lien TEXT`);
    await m(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS heure_debut TEXT`);
    await m(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS heure_fin TEXT`);
    await m(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS adresse TEXT`);
    await m(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS numero_confirmation TEXT`);
    await m(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS event_id INTEGER`);
    await m(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS reservation_id INTEGER`);
    await m(`ALTER TABLE voyages ADD COLUMN IF NOT EXISTS share_token TEXT`);
    await m(`ALTER TABLE bagages ADD COLUMN IF NOT EXISTS checked BOOLEAN DEFAULT FALSE`);
    await m(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS participant_id INTEGER`);
    await m(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS pin TEXT`);
    await m(`ALTER TABLE participants ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'participant'`);
    // Colonnes critiques pour CrewiCash (budget partagé entre participants)
    await m(`ALTER TABLE depenses ADD COLUMN IF NOT EXISTS participants_ids TEXT`);
    await m(`ALTER TABLE depenses ADD COLUMN IF NOT EXISTS payeur_id INTEGER`);
    await m(`ALTER TABLE voyages ADD COLUMN IF NOT EXISTS statut TEXT DEFAULT 'actif'`);
    await m(`ALTER TABLE voyages ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id)`);
    await m(`CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY, voyage_id INTEGER NOT NULL,
      auteur TEXT NOT NULL, couleur TEXT DEFAULT '#6366F1',
      caption TEXT, contenu TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    // CrewiRewind — colonnes voyage
    await m(`ALTER TABLE voyages ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
    await m(`ALTER TABLE voyages ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
    await m(`ALTER TABLE voyages ADD COLUMN IF NOT EXISTS memory_summary TEXT`);
    // CrewiRewind — nouvelles tables
    await m(`CREATE TABLE IF NOT EXISTS photo_likes (
      id SERIAL PRIMARY KEY,
      photo_id  INTEGER NOT NULL,
      voyage_id INTEGER NOT NULL,
      auteur    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(photo_id, auteur)
    )`);
    await m(`CREATE TABLE IF NOT EXISTS trip_memory_emails (
      id SERIAL PRIMARY KEY,
      voyage_id INTEGER NOT NULL UNIQUE,
      sent_at   TIMESTAMPTZ DEFAULT now(),
      recipients TEXT,
      status    TEXT DEFAULT 'sent'
    )`);
    await m(`CREATE TABLE IF NOT EXISTS trip_top_photos (
      id SERIAL PRIMARY KEY,
      voyage_id INTEGER NOT NULL UNIQUE,
      photo_ids TEXT NOT NULL,
      scored_at TIMESTAMPTZ DEFAULT now()
    )`);
    await m(`CREATE TABLE IF NOT EXISTS capsules (
      id SERIAL PRIMARY KEY,
      voyage_id INTEGER NOT NULL,
      participant_nom TEXT NOT NULL,
      participant_couleur TEXT DEFAULT '#6366F1',
      photo_id INTEGER,
      mots_cles TEXT DEFAULT '[]',
      moment_prefere TEXT,
      ferait_differemment TEXT,
      note INTEGER CHECK(note BETWEEN 1 AND 5),
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(voyage_id, participant_nom)
    )`);
    await m(`CREATE TABLE IF NOT EXISTS user_participant_links (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      participant_id INTEGER,
      voyage_id INTEGER NOT NULL,
      participant_nom TEXT NOT NULL,
      linked_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(user_id, voyage_id, participant_nom)
    )`);
    await m(`CREATE TABLE IF NOT EXISTS magic_links (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      voyage_id INTEGER NOT NULL,
      participant_nom TEXT NOT NULL,
      used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await m(`CREATE TABLE IF NOT EXISTS participant_emails (
      id SERIAL PRIMARY KEY,
      voyage_id INTEGER NOT NULL,
      participant_nom TEXT NOT NULL,
      email TEXT NOT NULL,
      saved_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(voyage_id, participant_nom)
    )`);
    await m(`CREATE TABLE IF NOT EXISTS participant_sessions (
      token TEXT PRIMARY KEY,
      participant_id INTEGER,
      voyage_id INTEGER NOT NULL,
      nom TEXT,
      couleur TEXT,
      role TEXT DEFAULT 'participant',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await m(`CREATE INDEX IF NOT EXISTS idx_psessions_expires ON participant_sessions(expires_at)`);
    console.log('[DB] Migrations PostgreSQL OK');
  })();
}

const pgDB = pgPool ? {
  users: {
    getByEmail: async (email) => (await pgPool.query('SELECT * FROM users WHERE email=$1', [email])).rows[0],
    getById:    async (id)    => (await pgPool.query('SELECT id,email,nom,created_at FROM users WHERE id=$1', [id])).rows[0],
    create:     async (email, passwordHash, nom) => (await pgPool.query(
      'INSERT INTO users(email,password_hash,nom) VALUES($1,$2,$3) RETURNING id,email,nom,created_at',
      [email, passwordHash, nom]
    )).rows[0],
    count: async () => parseInt((await pgPool.query('SELECT COUNT(*) FROM users')).rows[0].count, 10),
    claimOrphanVoyages: async (userId) => pgPool.query('UPDATE voyages SET owner_id=$1 WHERE owner_id IS NULL', [userId]),
    // RGPD art. 17 — supprime le compte + données liées à l'email
    delete: async (id) => {
      const { rows } = await pgPool.query('SELECT email FROM users WHERE id=$1', [id]);
      const email = rows[0]?.email;
      if (email) {
        await pgPool.query('DELETE FROM magic_links WHERE email=$1', [email]);
        await pgPool.query('DELETE FROM participant_emails WHERE email=$1', [email]);
      }
      await pgPool.query('DELETE FROM user_participant_links WHERE user_id=$1', [id]);
      await pgPool.query('DELETE FROM users WHERE id=$1', [id]);
    }
  },
  voyages: {
    getAllForReminders: async () => (await pgPool.query("SELECT id, nom, destination, date_debut, statut FROM voyages WHERE date_debut IS NOT NULL AND statut <> 'terminé' ORDER BY date_debut ASC")).rows,
    getAll: async (ownerId) => (await pgPool.query('SELECT * FROM voyages WHERE owner_id=$1 ORDER BY date_debut ASC NULLS LAST', [ownerId])).rows,
    getAllWithSummary: async (ownerId) => {
      const { rows } = await pgPool.query(`
        SELECT v.*,
          COUNT(DISTINCT p.id)::int AS participant_count,
          ROUND(AVG(c.note) FILTER (WHERE c.note IS NOT NULL)::numeric, 1) AS avg_capsule_note,
          COUNT(DISTINCT c.id)::int AS capsule_count,
          (SELECT photo_ids FROM trip_top_photos WHERE voyage_id = v.id LIMIT 1) AS top_photo_ids_raw
        FROM voyages v
        LEFT JOIN participants p ON p.voyage_id = v.id
        LEFT JOIN capsules c ON c.voyage_id = v.id
        WHERE v.owner_id = $1
        GROUP BY v.id
        ORDER BY v.date_debut ASC NULLS LAST
      `, [ownerId]);
      return rows.map(v => {
        const { top_photo_ids_raw, ...rest } = v;
        const ids = top_photo_ids_raw ? JSON.parse(top_photo_ids_raw) : [];
        return { ...rest, top_photo_id: ids[0] || null };
      });
    },
    getById: async (id) => (await pgPool.query('SELECT * FROM voyages WHERE id=$1', [id])).rows[0],
    getByToken: async (token) => (await pgPool.query('SELECT * FROM voyages WHERE share_token=$1', [token])).rows[0],
    setToken: async (id, token) => { await pgPool.query('UPDATE voyages SET share_token=$1 WHERE id=$2', [token, id]); return true; },
    setStatut: async (id, statut) => { await pgPool.query('UPDATE voyages SET statut=$1 WHERE id=$2', [statut, id]); return true; },
    setStatutFull: async (id, statut, extra = {}) => {
      const sets = ['statut=$1']; const params = [statut]; let i = 2;
      if (extra.completed_at !== undefined) { sets.push(`completed_at=$${i++}`); params.push(extra.completed_at); }
      if (extra.archived_at  !== undefined) { sets.push(`archived_at=$${i++}`);  params.push(extra.archived_at); }
      params.push(id);
      await pgPool.query(`UPDATE voyages SET ${sets.join(',')} WHERE id=$${i}`, params);
      return true;
    },
    setMemorySummary: async (id, summary) => { await pgPool.query('UPDATE voyages SET memory_summary=$1 WHERE id=$2', [summary, id]); return true; },
    create: async (data) => (await pgPool.query('INSERT INTO voyages(nom,destination,date_debut,date_fin,description,couleur,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [data.nom,data.destination,data.date_debut,data.date_fin,data.description,data.couleur||'#3B82F6',data.owner_id||null])).rows[0],
    update: async (id, data) => { await pgPool.query('UPDATE voyages SET nom=$1,destination=$2,date_debut=$3,date_fin=$4,description=$5,couleur=$6 WHERE id=$7', [data.nom,data.destination,data.date_debut,data.date_fin,data.description,data.couleur,id]); return true; },
    delete: async (id) => {
      await pgPool.query('DELETE FROM bagages WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM depenses WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM participants WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM reservations WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM agenda WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM documents WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM hype_votes WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM participant_profiles WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM wishlist WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM sondages WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM photos WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM photo_likes WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM trip_memory_emails WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM trip_top_photos WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM capsules WHERE voyage_id=$1', [id]);
      await pgPool.query('DELETE FROM voyages WHERE id=$1', [id]);
    }
  },
  reservations: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM reservations WHERE voyage_id=$1 ORDER BY date_debut ASC NULLS LAST', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM reservations WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query('INSERT INTO reservations(voyage_id,type,titre,date_debut,date_fin,heure_debut,heure_fin,lieu,adresse,numero_confirmation,notes,lien) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *', [vid,data.type,data.titre,data.date_debut,data.date_fin,data.heure_debut,data.heure_fin,data.lieu,data.adresse,data.numero_confirmation,data.notes,data.lien||null])).rows[0],
    update: async (id, data) => { await pgPool.query('UPDATE reservations SET type=$1,titre=$2,date_debut=$3,date_fin=$4,heure_debut=$5,heure_fin=$6,lieu=$7,adresse=$8,numero_confirmation=$9,notes=$10,lien=$11 WHERE id=$12', [data.type,data.titre,data.date_debut,data.date_fin,data.heure_debut,data.heure_fin,data.lieu,data.adresse,data.numero_confirmation,data.notes,data.lien||null,id]); return true; },
    delete: async (id) => pgPool.query('DELETE FROM reservations WHERE id=$1', [id])
  },
  agenda: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM agenda WHERE voyage_id=$1 ORDER BY date ASC, heure ASC NULLS LAST', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM agenda WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query('INSERT INTO agenda(voyage_id,date,heure,titre,description,lieu,type,lien) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [vid,data.date,data.heure,data.titre,data.description,data.lieu,data.type||'activite',data.lien||null])).rows[0],
    update: async (id, data) => { await pgPool.query('UPDATE agenda SET date=$1,heure=$2,titre=$3,description=$4,lieu=$5,type=$6,lien=$7 WHERE id=$8', [data.date,data.heure,data.titre,data.description,data.lieu,data.type,data.lien||null,id]); return true; },
    delete: async (id) => pgPool.query('DELETE FROM agenda WHERE id=$1', [id])
  },
  documents: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT id,voyage_id,nom,type_fichier,taille,categorie,event_id,reservation_id,created_at FROM documents WHERE voyage_id=$1 ORDER BY created_at DESC', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM documents WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query('INSERT INTO documents(voyage_id,nom,type_fichier,taille,categorie,event_id,reservation_id,contenu) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [vid,data.nom,data.type_fichier,data.taille,data.categorie||'autre',data.event_id||null,data.reservation_id||null,data.contenu])).rows[0],
    update: async (id, data) => { await pgPool.query('UPDATE documents SET nom=$1,categorie=$2,event_id=$3,reservation_id=$4 WHERE id=$5', [data.nom,data.categorie||'autre',data.event_id||null,data.reservation_id||null,id]); return true; },
    delete: async (id) => pgPool.query('DELETE FROM documents WHERE id=$1', [id])
  },
  participants: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM participants WHERE voyage_id=$1 ORDER BY created_at ASC', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM participants WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query('INSERT INTO participants(voyage_id,nom,couleur,pin,role) VALUES($1,$2,$3,$4,$5) RETURNING *', [vid,data.nom,data.couleur||'#6366F1',data.pin||null,data.role||'participant'])).rows[0],
    update: async (id, data) => { await pgPool.query('UPDATE participants SET nom=$1,couleur=$2,pin=$3 WHERE id=$4', [data.nom,data.couleur,data.pin??null,id]); return true; },
    setRole: async (id, role) => { await pgPool.query('UPDATE participants SET role=$1 WHERE id=$2', [role, id]); return true; },
    delete: async (id) => {
      await pgPool.query('DELETE FROM bagages WHERE participant_id=$1', [id]);
      await pgPool.query('DELETE FROM participants WHERE id=$1', [id]);
    }
  },
  depenses: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM depenses WHERE voyage_id=$1 ORDER BY date DESC NULLS LAST, created_at DESC', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM depenses WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query('INSERT INTO depenses(voyage_id,titre,montant,payeur_id,participants_ids,date,categorie) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [vid,data.titre,data.montant,data.payeur_id,data.participants_ids,data.date,data.categorie||'autre'])).rows[0],
    update: async (id, data) => { await pgPool.query('UPDATE depenses SET titre=$1,montant=$2,payeur_id=$3,participants_ids=$4,date=$5,categorie=$6 WHERE id=$7', [data.titre,data.montant,data.payeur_id,data.participants_ids,data.date,data.categorie,id]); return true; },
    delete: async (id) => pgPool.query('DELETE FROM depenses WHERE id=$1', [id])
  },
  bagages: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM bagages WHERE voyage_id=$1 ORDER BY participant_id, categorie, created_at ASC', [vid])).rows,
    getByParticipant: async (vid, pid) => (await pgPool.query('SELECT * FROM bagages WHERE voyage_id=$1 AND participant_id=$2 ORDER BY categorie, created_at ASC', [vid, pid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM bagages WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query('INSERT INTO bagages(voyage_id,participant_id,nom,categorie,checked) VALUES($1,$2,$3,$4,$5) RETURNING *', [vid,data.participant_id,data.nom,data.categorie||'divers',false])).rows[0],
    update: async (id, data) => {
      if ('checked' in data && Object.keys(data).length === 1) {
        await pgPool.query('UPDATE bagages SET checked=$1 WHERE id=$2', [data.checked, id]);
      } else {
        await pgPool.query('UPDATE bagages SET nom=$1,categorie=$2,checked=$3 WHERE id=$4', [data.nom,data.categorie,data.checked,id]);
      }
      return true;
    },
    delete: async (id) => pgPool.query('DELETE FROM bagages WHERE id=$1', [id]),
    deleteByVoyageParticipant: async (vid, pid) => pgPool.query('DELETE FROM bagages WHERE voyage_id=$1 AND participant_id=$2', [vid, pid])
  },
  push_subscriptions: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM push_subscriptions WHERE voyage_id=$1', [vid])).rows,
    getByParticipant: async (vid, pid) => (await pgPool.query('SELECT * FROM push_subscriptions WHERE voyage_id=$1 AND participant_id=$2', [vid, pid])).rows,
    upsert: async (vid, sub) => {
      await pgPool.query(
        `INSERT INTO push_subscriptions(voyage_id,endpoint,p256dh,auth,participant_id) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh=$3, auth=$4, voyage_id=$1, participant_id=$5`,
        [vid, sub.endpoint, sub.keys.p256dh, sub.keys.auth, sub.participant_id || null]
      );
      return true;
    }
  },
  messages_prives: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM messages_prives WHERE voyage_id=$1 ORDER BY created_at DESC', [vid])).rows,
    getByParticipant: async (vid, pid) => (await pgPool.query('SELECT * FROM messages_prives WHERE voyage_id=$1 AND participant_id=$2 ORDER BY created_at ASC', [vid, pid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM messages_prives WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query(
      'INSERT INTO messages_prives(voyage_id,participant_id,auteur,message) VALUES($1,$2,$3,$4) RETURNING *',
      [vid, data.participant_id, data.auteur || 'Organisateur', data.message]
    )).rows[0],
    marquerLu: async (id) => pgPool.query('UPDATE messages_prives SET lu=TRUE WHERE id=$1', [id]),
    delete: async (id) => pgPool.query('DELETE FROM messages_prives WHERE id=$1', [id])
  },
  demandes: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM demandes WHERE voyage_id=$1 ORDER BY created_at DESC', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM demandes WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query(
      'INSERT INTO demandes(voyage_id,auteur,onglet,element_type,element_id,element_nom,message) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [vid, data.auteur, data.onglet, data.element_type, data.element_id||null, data.element_nom, data.message]
    )).rows[0],
    update: async (id, data) => { await pgPool.query('UPDATE demandes SET statut=$1 WHERE id=$2', [data.statut, id]); return true; },
    delete: async (id) => pgPool.query('DELETE FROM demandes WHERE id=$1', [id])
  },
  attributions: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM attributions WHERE voyage_id=$1 ORDER BY participant_id, created_at ASC', [vid])).rows,
    getByParticipant: async (vid, pid) => (await pgPool.query('SELECT * FROM attributions WHERE voyage_id=$1 AND participant_id=$2 ORDER BY created_at ASC', [vid, pid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM attributions WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query(
      'INSERT INTO attributions(voyage_id,participant_id,titre,contenu,document_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [vid, data.participant_id, data.titre, data.contenu||null, data.document_id||null]
    )).rows[0],
    delete: async (id) => pgPool.query('DELETE FROM attributions WHERE id=$1', [id])
  },
  attribution_links: {
    getByAttribution: async (aid) => (await pgPool.query(
      'SELECT * FROM attribution_links WHERE attribution_id=$1 ORDER BY position ASC, id ASC', [aid]
    )).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM attribution_links WHERE id=$1', [id])).rows[0],
    create: async (aid, data) => {
      const maxRes = await pgPool.query('SELECT COALESCE(MAX(position),0)+1 AS next FROM attribution_links WHERE attribution_id=$1', [aid]);
      const pos = maxRes.rows[0].next || 1;
      return (await pgPool.query(
        'INSERT INTO attribution_links(attribution_id,titre,url,description,type,position) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [aid, data.titre, data.url, data.description||null, data.type||'autre', pos]
      )).rows[0];
    },
    update: async (id, data) => (await pgPool.query(
      'UPDATE attribution_links SET titre=$2,url=$3,description=$4,type=$5,position=$6 WHERE id=$1 RETURNING *',
      [id, data.titre, data.url, data.description||null, data.type||'autre', data.position||1]
    )).rows[0],
    deleteByAttribution: async (aid) => pgPool.query('DELETE FROM attribution_links WHERE attribution_id=$1', [aid]),
    delete: async (id) => pgPool.query('DELETE FROM attribution_links WHERE id=$1', [id])
  },
  commentaires: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM commentaires WHERE voyage_id=$1 ORDER BY created_at ASC', [vid])).rows,
    create: async (vid, data) => (await pgPool.query(
      `INSERT INTO commentaires(voyage_id,auteur,message,reply_to_id,reply_to_auteur,reply_to_preview,reactions)
       VALUES($1,$2,$3,$4,$5,$6,'{}') RETURNING *`,
      [vid, data.auteur, data.message,
       data.reply_to_id || null, data.reply_to_auteur || null, data.reply_to_preview || null]
    )).rows[0],
    react: async (id, emoji, auteur) => {
      // Atomic toggle dans JSONB-as-text : parse → toggle → save
      const row = (await pgPool.query('SELECT reactions FROM commentaires WHERE id=$1', [id])).rows[0];
      if (!row) return null;
      let reactions = {};
      try { reactions = JSON.parse(row.reactions || '{}'); } catch(e) {}
      if (!reactions[emoji]) reactions[emoji] = [];
      const idx = reactions[emoji].indexOf(auteur);
      if (idx === -1) reactions[emoji].push(auteur);
      else reactions[emoji].splice(idx, 1);
      if (reactions[emoji].length === 0) delete reactions[emoji];
      return (await pgPool.query(
        'UPDATE commentaires SET reactions=$1 WHERE id=$2 RETURNING *',
        [JSON.stringify(reactions), id]
      )).rows[0];
    },
    delete: async (id) => pgPool.query('DELETE FROM commentaires WHERE id=$1', [id])
  },
  docs_participants: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT id,voyage_id,participant_id,nom,type_fichier,taille,categorie,created_at FROM docs_participants WHERE voyage_id=$1 ORDER BY participant_id, created_at DESC', [vid])).rows,
    getByParticipant: async (vid, pid) => (await pgPool.query('SELECT id,voyage_id,participant_id,nom,type_fichier,taille,categorie,created_at FROM docs_participants WHERE voyage_id=$1 AND participant_id=$2 ORDER BY created_at DESC', [vid, pid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM docs_participants WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query(
      'INSERT INTO docs_participants(voyage_id,participant_id,nom,type_fichier,taille,categorie,contenu) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,voyage_id,participant_id,nom,type_fichier,taille,categorie,created_at',
      [vid, data.participant_id, data.nom, data.type_fichier, data.taille, data.categorie||'autre', data.contenu]
    )).rows[0],
    delete: async (id) => pgPool.query('DELETE FROM docs_participants WHERE id=$1', [id])
  },
  locations: {
    getByVoyage: async (vid) => (await pgPool.query(
      "SELECT * FROM locations WHERE voyage_id=$1 AND updated_at > now() - INTERVAL '30 minutes'",
      [vid]
    )).rows,
    upsert: async (vid, data) => {
      await pgPool.query(
        `INSERT INTO locations(voyage_id,device_id,participant_id,nom,couleur,lat,lng)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (voyage_id,device_id) DO UPDATE SET
           participant_id=EXCLUDED.participant_id, nom=EXCLUDED.nom,
           couleur=EXCLUDED.couleur, lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=now()`,
        [vid, data.device_id, data.participant_id||null, data.nom, data.couleur||'#6366F1', data.lat, data.lng]
      );
      return true;
    },
    delete: async (vid, device_id) => pgPool.query(
      'DELETE FROM locations WHERE voyage_id=$1 AND device_id=$2', [vid, device_id]
    )
  },
  hype_votes: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM hype_votes WHERE voyage_id=$1 ORDER BY updated_at DESC', [vid])).rows,
    upsert: async (vid, data) => {
      await pgPool.query(
        `INSERT INTO hype_votes(voyage_id, auteur, score, emoji) VALUES($1,$2,$3,$4)
         ON CONFLICT (voyage_id, auteur) DO UPDATE SET score=EXCLUDED.score, emoji=EXCLUDED.emoji, updated_at=now()`,
        [vid, data.auteur, data.score, data.emoji || null]
      );
      return true;
    }
  },
  participant_profiles: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM participant_profiles WHERE voyage_id=$1 ORDER BY updated_at ASC', [vid])).rows,
    upsert: async (vid, data) => {
      await pgPool.query(
        `INSERT INTO participant_profiles(voyage_id, auteur, participant_id, couleur, truc_en_voyage, chaud_pour, refuse) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (voyage_id, auteur) DO UPDATE SET participant_id=EXCLUDED.participant_id, couleur=EXCLUDED.couleur, truc_en_voyage=EXCLUDED.truc_en_voyage, chaud_pour=EXCLUDED.chaud_pour, refuse=EXCLUDED.refuse, updated_at=now()`,
        [vid, data.auteur, data.participant_id || null, data.couleur || '#6B7280', data.truc_en_voyage || null, data.chaud_pour || null, data.refuse || null]
      );
      return true;
    }
  },
  wishlist: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM wishlist WHERE voyage_id=$1 ORDER BY created_at DESC', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM wishlist WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query(
      `INSERT INTO wishlist(voyage_id, auteur, titre, description, type, url) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [vid, data.auteur, data.titre, data.description || null, data.type || 'activite', data.url || null]
    )).rows[0],
    toggleLike: async (id, auteur) => {
      const row = (await pgPool.query('SELECT likes FROM wishlist WHERE id=$1', [id])).rows[0];
      if (!row) return false;
      let likes = [];
      try { likes = JSON.parse(row.likes || '[]'); } catch {}
      const pos = likes.indexOf(auteur);
      if (pos === -1) { likes.push(auteur); } else { likes.splice(pos, 1); }
      await pgPool.query('UPDATE wishlist SET likes=$1 WHERE id=$2', [JSON.stringify(likes), id]);
      return pos === -1;
    },
    delete: async (id) => pgPool.query('DELETE FROM wishlist WHERE id=$1', [id])
  },
  sondages: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM sondages WHERE voyage_id=$1 ORDER BY created_at DESC', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM sondages WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => {
      const options = (data.options || []).map((texte, i) => ({ id: i + 1, texte }));
      return (await pgPool.query(
        `INSERT INTO sondages(voyage_id, titre, created_by, options, votes) VALUES($1,$2,$3,$4,'[]') RETURNING *`,
        [vid, data.titre, data.created_by, JSON.stringify(options)]
      )).rows[0];
    },
    vote: async (id, optionId, auteur) => {
      const row = (await pgPool.query('SELECT votes FROM sondages WHERE id=$1', [id])).rows[0];
      if (!row) return false;
      let votes = row.votes || [];
      if (typeof votes === 'string') { try { votes = JSON.parse(votes); } catch { votes = []; } }
      votes = votes.filter(v => v.auteur !== auteur);
      votes.push({ option_id: +optionId, auteur });
      await pgPool.query('UPDATE sondages SET votes=$1 WHERE id=$2', [JSON.stringify(votes), id]);
      return true;
    },
    fermer: async (id) => { await pgPool.query("UPDATE sondages SET statut='fermé' WHERE id=$1", [id]); return true; },
    delete: async (id) => pgPool.query('DELETE FROM sondages WHERE id=$1', [id])
  },
  photos: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT id,voyage_id,auteur,couleur,caption,created_at FROM photos WHERE voyage_id=$1 ORDER BY created_at DESC', [vid])).rows,
    getById: async (id) => (await pgPool.query('SELECT * FROM photos WHERE id=$1', [id])).rows[0],
    create: async (vid, data) => (await pgPool.query(
      'INSERT INTO photos(voyage_id,auteur,couleur,caption,contenu) VALUES($1,$2,$3,$4,$5) RETURNING id,voyage_id,auteur,couleur,caption,created_at',
      [vid, data.auteur, data.couleur||'#6366F1', data.caption||null, data.contenu]
    )).rows[0],
    delete: async (id) => { await pgPool.query('DELETE FROM photo_likes WHERE photo_id=$1', [id]); await pgPool.query('DELETE FROM photos WHERE id=$1', [id]); }
  },
  photo_likes: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM photo_likes WHERE voyage_id=$1 ORDER BY created_at DESC', [vid])).rows,
    toggle: async (photoId, voyageId, auteur) => {
      const existing = (await pgPool.query('SELECT id FROM photo_likes WHERE photo_id=$1 AND auteur=$2', [photoId, auteur])).rows[0];
      if (existing) { await pgPool.query('DELETE FROM photo_likes WHERE id=$1', [existing.id]); return false; }
      await pgPool.query('INSERT INTO photo_likes(photo_id,voyage_id,auteur) VALUES($1,$2,$3)', [photoId, voyageId, auteur]);
      return true;
    }
  },
  trip_memory_emails: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM trip_memory_emails WHERE voyage_id=$1', [vid])).rows[0],
    create: async (vid, data) => (await pgPool.query(
      'INSERT INTO trip_memory_emails(voyage_id,recipients,status) VALUES($1,$2,$3) RETURNING *',
      [vid, data.recipients || null, 'sent']
    )).rows[0]
  },
  trip_top_photos: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM trip_top_photos WHERE voyage_id=$1', [vid])).rows[0],
    upsert: async (vid, data) => {
      await pgPool.query(
        `INSERT INTO trip_top_photos(voyage_id,photo_ids) VALUES($1,$2)
         ON CONFLICT (voyage_id) DO UPDATE SET photo_ids=EXCLUDED.photo_ids, scored_at=now()`,
        [vid, data.photo_ids]
      );
      return true;
    }
  },
  capsules: {
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM capsules WHERE voyage_id=$1 ORDER BY created_at ASC', [vid])).rows,
    getMine: async (vid, nom) => (await pgPool.query('SELECT * FROM capsules WHERE voyage_id=$1 AND participant_nom=$2', [vid, nom])).rows[0],
    upsert: async (vid, nom, data) => (await pgPool.query(
      `INSERT INTO capsules(voyage_id,participant_nom,participant_couleur,photo_id,mots_cles,moment_prefere,ferait_differemment,note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(voyage_id,participant_nom) DO UPDATE SET
         participant_couleur=EXCLUDED.participant_couleur,
         photo_id=EXCLUDED.photo_id,
         mots_cles=EXCLUDED.mots_cles,
         moment_prefere=EXCLUDED.moment_prefere,
         ferait_differemment=EXCLUDED.ferait_differemment,
         note=EXCLUDED.note
       RETURNING *`,
      [vid, nom, data.participant_couleur||'#6366F1', data.photo_id||null,
       data.mots_cles||'[]', data.moment_prefere||null, data.ferait_differemment||null,
       data.note||null]
    )).rows[0],
    deleteByVoyage: async (vid) => pgPool.query('DELETE FROM capsules WHERE voyage_id=$1', [vid])
  },
  user_participant_links: {
    upsert: async (userId, participantId, voyageId, participantNom) => pgPool.query(
      `INSERT INTO user_participant_links(user_id, participant_id, voyage_id, participant_nom)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(user_id, voyage_id, participant_nom) DO UPDATE
         SET participant_id=EXCLUDED.participant_id, linked_at=now()`,
      [userId, participantId || null, voyageId, participantNom]
    ),
    getByUser:   async (userId)   => (await pgPool.query('SELECT * FROM user_participant_links WHERE user_id=$1',   [userId])).rows,
    getByVoyage: async (voyageId) => (await pgPool.query('SELECT * FROM user_participant_links WHERE voyage_id=$1', [voyageId])).rows,
  },
  magic_links: {
    create: async (data) => (await pgPool.query(
      `INSERT INTO magic_links(email, token, voyage_id, participant_nom, expires_at)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [data.email, data.token, data.voyage_id, data.participant_nom, data.expires_at]
    )).rows[0],
    getByToken: async (token) => (await pgPool.query(
      'SELECT * FROM magic_links WHERE token=$1', [token]
    )).rows[0] || null,
    markUsed: async (token) => pgPool.query(
      'UPDATE magic_links SET used_at=now() WHERE token=$1', [token]
    )
  },
  participant_emails: {
    save: async (vid, nom, email) => pgPool.query(
      `INSERT INTO participant_emails(voyage_id, participant_nom, email)
       VALUES($1,$2,$3)
       ON CONFLICT(voyage_id,participant_nom) DO UPDATE SET email=EXCLUDED.email, saved_at=now()`,
      [vid, nom, email.toLowerCase().trim()]
    ),
    getByVoyage: async (vid) => (await pgPool.query('SELECT * FROM participant_emails WHERE voyage_id=$1', [vid])).rows,
    getAllByEmail: async (email) => (await pgPool.query(
      'SELECT * FROM participant_emails WHERE LOWER(email)=LOWER($1)',
      [email]
    )).rows,
  },
  participant_sessions: {
    create: async ({ token, participantId, voyageId, nom, couleur, role, expiresAt }) => (await pgPool.query(
      `INSERT INTO participant_sessions(token, participant_id, voyage_id, nom, couleur, role, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [token, participantId != null ? +participantId : null, +voyageId, nom || null, couleur || null, role || 'participant', expiresAt]
    )).rows[0],
    getByToken: async (token) => (await pgPool.query(
      'SELECT * FROM participant_sessions WHERE token=$1', [token]
    )).rows[0] || null,
    deleteByToken: async (token) => pgPool.query(
      'DELETE FROM participant_sessions WHERE token=$1', [token]
    ),
    purgeExpired: async () => (await pgPool.query(
      'DELETE FROM participant_sessions WHERE expires_at < now()'
    )).rowCount,
  },
} : null;

// Export : utilise PostgreSQL en production, JSON en local
module.exports = USE_POSTGRES ? pgDB : localDB;
module.exports.isAsync = USE_POSTGRES;
module.exports.usePostgres = USE_POSTGRES;
module.exports._pool = pgPool; // diagnostic uniquement
