// ═══════════════════════════════════════════════════════
//  MES VOYAGES — Application Frontend
// ═══════════════════════════════════════════════════════

const API = '';  // même origin
let voyageActuel = null;
let filtreActuel = 'tous';

// ─── INIT ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  chargerVoyages();
});

// ─── NAVIGATION ─────────────────────────────────────

function afficherAccueil() {
  document.getElementById('screen-voyage').classList.remove('active');
  document.getElementById('screen-home').classList.add('active');
  voyageActuel = null;
  chargerVoyages();
}

function afficherVoyage(id) {
  voyageActuel = id;
  fetch(`${API}/api/voyages/${id}`)
    .then(r => r.json())
    .then(voyage => {
      document.getElementById('screen-home').classList.remove('active');
      document.getElementById('screen-voyage').classList.add('active');
      document.getElementById('voyage-nom').textContent = voyage.nom;
      document.getElementById('voyage-dates').textContent = formatDates(voyage.date_debut, voyage.date_fin);

      const header = document.getElementById('voyage-header');
      header.style.borderBottom = `3px solid ${voyage.couleur}`;

      // Reset onglet actif
      changerOnglet('reservations', document.querySelector('[data-tab="reservations"]'));
    });
}

function changerOnglet(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');

  if (tab === 'reservations') chargerReservations();
  if (tab === 'agenda') chargerAgenda();
  if (tab === 'carte') chargerCarte();
  if (tab === 'documents') chargerDocuments();
}

// ─── VOYAGES ─────────────────────────────────────────

async function chargerVoyages() {
  const voyages = await fetch(`${API}/api/voyages`).then(r => r.json());
  const liste = document.getElementById('liste-voyages');
  const empty = document.getElementById('empty-state');

  if (voyages.length === 0) {
    liste.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  liste.innerHTML = voyages.map(v => {
    const statut = getStatut(v.date_debut, v.date_fin);
    const duree = getDuree(v.date_debut, v.date_fin);
    return `
    <div class="voyage-card" onclick="afficherVoyage(${v.id})">
      <div class="voyage-card-banner" style="background:${v.couleur}"></div>
      <div class="voyage-card-body">
        <div class="voyage-card-header">
          <h2>${v.nom}</h2>
          <span class="voyage-badge badge-${statut.classe}">${statut.label}</span>
        </div>
        <p class="voyage-destination">${v.destination}</p>
        ${v.date_debut ? `<p class="voyage-dates">${formatDates(v.date_debut, v.date_fin)}${duree ? ` · ${duree}` : ''}</p>` : ''}
      </div>
    </div>`;
  }).join('');
}

function ouvrirModalVoyage(id = null) {
  const modal = document.getElementById('modal-voyage');
  document.getElementById('modal-voyage-titre').textContent = id ? 'Modifier le voyage' : 'Nouveau voyage';
  document.getElementById('v-id').value = id || '';

  if (id) {
    fetch(`${API}/api/voyages/${id}`).then(r => r.json()).then(v => {
      document.getElementById('v-nom').value = v.nom;
      document.getElementById('v-destination').value = v.destination;
      document.getElementById('v-date-debut').value = v.date_debut || '';
      document.getElementById('v-date-fin').value = v.date_fin || '';
      document.getElementById('v-description').value = v.description || '';
      document.getElementById('v-couleur').value = v.couleur || '#3B82F6';
      document.querySelectorAll('.color-opt').forEach(el => {
        el.classList.toggle('active', el.dataset.color === (v.couleur || '#3B82F6'));
      });
    });
  } else {
    document.getElementById('form-voyage').reset();
    document.getElementById('v-couleur').value = '#3B82F6';
    document.querySelectorAll('.color-opt').forEach((el, i) => el.classList.toggle('active', i === 0));
  }
  modal.classList.remove('hidden');
}

async function sauvegarderVoyage(e) {
  e.preventDefault();
  const id = document.getElementById('v-id').value;
  const data = {
    nom: document.getElementById('v-nom').value,
    destination: document.getElementById('v-destination').value,
    date_debut: document.getElementById('v-date-debut').value || null,
    date_fin: document.getElementById('v-date-fin').value || null,
    description: document.getElementById('v-description').value,
    couleur: document.getElementById('v-couleur').value
  };

  const url = id ? `${API}/api/voyages/${id}` : `${API}/api/voyages`;
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  fermerModal('modal-voyage');
  toast(id ? '✅ Voyage modifié' : '✅ Voyage créé');
  chargerVoyages();
}

function menuVoyageActuel() {
  document.getElementById('menu-voyage').classList.remove('hidden');
  document.getElementById('overlay-sheet').classList.remove('hidden');
}

function modifierVoyageActuel() {
  fermerBottomSheet();
  ouvrirModalVoyage(voyageActuel);
}

async function supprimerVoyageActuel() {
  if (!confirm('Supprimer ce voyage et toutes ses données ?')) return;
  fermerBottomSheet();
  await fetch(`${API}/api/voyages/${voyageActuel}`, { method: 'DELETE' });
  toast('🗑️ Voyage supprimé');
  afficherAccueil();
}

// ─── RÉSERVATIONS ─────────────────────────────────────

async function chargerReservations() {
  const reservations = await fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json());
  afficherReservations(reservations, filtreActuel);
}

function afficherReservations(reservations, filtre) {
  const container = document.getElementById('liste-reservations');
  const filtered = filtre === 'tous' ? reservations : reservations.filter(r => r.type === filtre);

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-tab"><div class="empty-tab-icon">🎫</div><p>Aucune réservation${filtre !== 'tous' ? ' dans cette catégorie' : ''}</p></div>`;
    return;
  }

  // Grouper par date
  const grouped = {};
  filtered.forEach(r => {
    const key = r.date_debut || 'Sans date';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  });

  container.innerHTML = `<div class="resa-list">${
    Object.entries(grouped).map(([date, items]) => `
      <div style="margin-bottom:4px">
        ${date !== 'Sans date' ? `<p style="font-size:0.78rem;font-weight:700;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">${formatDate(date)}</p>` : ''}
        ${items.map(r => renderResa(r)).join('')}
      </div>
    `).join('')
  }</div>`;
}

function renderResa(r) {
  const icones = { transport: '✈️', hebergement: '🏠', vehicule: '🚗', activite: '🎯', restaurant: '🍽️' };
  return `
  <div class="resa-card">
    <div class="resa-icon icon-${r.type}">${icones[r.type] || '📌'}</div>
    <div class="resa-body">
      <div class="resa-titre">${r.titre}</div>
      <div class="resa-meta">
        ${r.heure_debut ? `<span>🕐 ${r.heure_debut}${r.heure_fin ? ' → ' + r.heure_fin : ''}</span>` : ''}
        ${r.lieu ? `<span>📍 ${r.lieu}</span>` : ''}
        ${r.date_fin && r.date_fin !== r.date_debut ? `<span>📅 jusqu'au ${formatDate(r.date_fin)}</span>` : ''}
      </div>
      ${r.numero_confirmation ? `<span class="resa-confirmation">📋 ${r.numero_confirmation}</span>` : ''}
      ${r.notes ? `<p style="font-size:.78rem;color:var(--text-muted);margin-top:6px">${r.notes}</p>` : ''}
    </div>
    <div class="resa-actions">
      <button class="btn-mini btn-mini-edit" onclick="modifierReservation(${r.id})" title="Modifier">✏️</button>
      <button class="btn-mini btn-mini-del" onclick="supprimerReservation(${r.id})" title="Supprimer">🗑️</button>
    </div>
  </div>`;
}

function filtrerReservations(filtre, btn) {
  filtreActuel = filtre;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  chargerReservations();
}

function ouvrirModalReservation(id = null) {
  document.getElementById('modal-resa-titre').textContent = id ? 'Modifier la réservation' : 'Nouvelle réservation';
  document.getElementById('r-id').value = id || '';

  if (id) {
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`)
      .then(r => r.json())
      .then(list => {
        const r = list.find(x => x.id === id);
        if (!r) return;
        document.getElementById('r-titre').value = r.titre;
        document.getElementById('r-date-debut').value = r.date_debut || '';
        document.getElementById('r-date-fin').value = r.date_fin || '';
        document.getElementById('r-heure-debut').value = r.heure_debut || '';
        document.getElementById('r-heure-fin').value = r.heure_fin || '';
        document.getElementById('r-lieu').value = r.lieu || '';
        document.getElementById('r-adresse').value = r.adresse || '';
        document.getElementById('r-confirmation').value = r.numero_confirmation || '';
        document.getElementById('r-notes').value = r.notes || '';
        document.getElementById('r-type').value = r.type;
        document.querySelectorAll('.type-opt').forEach(el => el.classList.toggle('active', el.dataset.type === r.type));
      });
  } else {
    document.getElementById('form-reservation').reset();
    document.getElementById('r-type').value = 'transport';
    document.querySelectorAll('.type-opt').forEach((el, i) => el.classList.toggle('active', i === 0));
  }
  document.getElementById('modal-reservation').classList.remove('hidden');
}

async function modifierReservation(id) {
  ouvrirModalReservation(id);
}

async function sauvegarderReservation(e) {
  e.preventDefault();
  const id = document.getElementById('r-id').value;
  const data = {
    type: document.getElementById('r-type').value,
    titre: document.getElementById('r-titre').value,
    date_debut: document.getElementById('r-date-debut').value || null,
    date_fin: document.getElementById('r-date-fin').value || null,
    heure_debut: document.getElementById('r-heure-debut').value || null,
    heure_fin: document.getElementById('r-heure-fin').value || null,
    lieu: document.getElementById('r-lieu').value,
    adresse: document.getElementById('r-adresse').value,
    numero_confirmation: document.getElementById('r-confirmation').value,
    notes: document.getElementById('r-notes').value
  };

  const url = id ? `${API}/api/reservations/${id}` : `${API}/api/voyages/${voyageActuel}/reservations`;
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  fermerModal('modal-reservation');
  toast(id ? '✅ Réservation modifiée' : '✅ Réservation ajoutée');
  chargerReservations();
}

async function supprimerReservation(id) {
  if (!confirm('Supprimer cette réservation ?')) return;
  await fetch(`${API}/api/reservations/${id}`, { method: 'DELETE' });
  toast('🗑️ Réservation supprimée');
  chargerReservations();
}

// ─── AGENDA ──────────────────────────────────────────

async function chargerAgenda() {
  const items = await fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json());
  const container = document.getElementById('liste-agenda');

  if (items.length === 0) {
    container.innerHTML = `<div class="empty-tab"><div class="empty-tab-icon">📅</div><p>Aucun événement planifié</p></div>`;
    return;
  }

  // Grouper par date
  const grouped = {};
  items.forEach(i => {
    if (!grouped[i.date]) grouped[i.date] = [];
    grouped[i.date].push(i);
  });

  const today = new Date().toISOString().split('T')[0];
  container.innerHTML = Object.entries(grouped).map(([date, events]) => `
    <div class="agenda-day">
      <div class="agenda-day-header ${date === today ? 'today' : ''}">
        ${formatDateLong(date)}${date === today ? ' · Aujourd\'hui' : ''}
      </div>
      ${events.map(ev => `
        <div class="agenda-item">
          <span class="agenda-heure">${ev.heure || '--:--'}</span>
          <div class="agenda-line" style="background:${getAgendaColor(ev.type)}"></div>
          <div class="agenda-content">
            <div class="agenda-titre">${getAgendaIcon(ev.type)} ${ev.titre}</div>
            ${ev.lieu ? `<div class="agenda-lieu">📍 ${ev.lieu}</div>` : ''}
            ${ev.description ? `<div class="agenda-lieu">${ev.description}</div>` : ''}
          </div>
          <div class="agenda-actions">
            <button class="btn-mini btn-mini-edit" onclick="modifierAgenda(${ev.id})">✏️</button>
            <button class="btn-mini btn-mini-del" onclick="supprimerAgenda(${ev.id})">🗑️</button>
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function ouvrirModalAgenda(id = null) {
  document.getElementById('modal-agenda-titre').textContent = id ? 'Modifier l\'événement' : 'Nouvel événement';
  document.getElementById('a-id').value = id || '';
  if (!id) document.getElementById('form-agenda').reset();
  document.getElementById('modal-agenda').classList.remove('hidden');
}

async function modifierAgenda(id) {
  const items = await fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json());
  const item = items.find(x => x.id === id);
  if (!item) return;
  document.getElementById('a-id').value = id;
  document.getElementById('a-date').value = item.date;
  document.getElementById('a-heure').value = item.heure || '';
  document.getElementById('a-titre').value = item.titre;
  document.getElementById('a-description').value = item.description || '';
  document.getElementById('a-lieu').value = item.lieu || '';
  document.getElementById('a-type').value = item.type;
  document.getElementById('modal-agenda-titre').textContent = 'Modifier l\'événement';
  document.getElementById('modal-agenda').classList.remove('hidden');
}

async function sauvegarderAgenda(e) {
  e.preventDefault();
  const id = document.getElementById('a-id').value;
  const data = {
    date: document.getElementById('a-date').value,
    heure: document.getElementById('a-heure').value || null,
    titre: document.getElementById('a-titre').value,
    description: document.getElementById('a-description').value,
    lieu: document.getElementById('a-lieu').value,
    type: document.getElementById('a-type').value
  };

  const url = id ? `${API}/api/agenda/${id}` : `${API}/api/voyages/${voyageActuel}/agenda`;
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  fermerModal('modal-agenda');
  toast(id ? '✅ Événement modifié' : '✅ Événement ajouté');
  chargerAgenda();
}

async function supprimerAgenda(id) {
  if (!confirm('Supprimer cet événement ?')) return;
  await fetch(`${API}/api/agenda/${id}`, { method: 'DELETE' });
  toast('🗑️ Événement supprimé');
  chargerAgenda();
}

// ─── CARTE ───────────────────────────────────────────

async function chargerCarte() {
  const [reservations, voyage] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}`).then(r => r.json())
  ]);

  const lieux = reservations
    .filter(r => r.adresse || r.lieu)
    .map(r => ({ titre: r.titre, lieu: r.adresse || r.lieu, type: r.type }));

  const icones = { transport: '✈️', hebergement: '🏠', vehicule: '🚗', activite: '🎯', restaurant: '🍽️' };

  const lieuxList = document.getElementById('carte-lieux');
  if (lieux.length === 0) {
    lieuxList.innerHTML = '<p style="font-size:.82rem;color:var(--text-muted);padding:4px 0">Ajoutez des adresses dans vos réservations pour les voir sur la carte</p>';
  } else {
    lieuxList.innerHTML = lieux.map(l => `
      <div class="lieu-item" onclick="ouvrirLieu('${encodeURIComponent(l.lieu)}')">
        <span class="lieu-emoji">${icones[l.type] || '📌'}</span>
        <div>
          <div style="font-weight:600;font-size:.85rem">${l.titre}</div>
          <div style="font-size:.78rem;color:var(--text-muted)">${l.lieu}</div>
        </div>
      </div>
    `).join('');
  }

  // Charger la carte avec la destination du voyage
  const query = lieux.length > 0 ? lieux[0].lieu : voyage.destination;
  const iframe = document.getElementById('carte-frame');
  iframe.src = `https://maps.google.com/maps?q=${encodeURIComponent(query)}&output=embed&z=10`;
}

function ouvrirLieu(lieu) {
  const iframe = document.getElementById('carte-frame');
  iframe.src = `https://maps.google.com/maps?q=${lieu}&output=embed&z=14`;
}

// ─── DOCUMENTS ───────────────────────────────────────

async function chargerDocuments() {
  const docs = await fetch(`${API}/api/voyages/${voyageActuel}/documents`).then(r => r.json());
  const container = document.getElementById('liste-documents');

  if (docs.length === 0) {
    container.innerHTML = `<div class="empty-tab"><div class="empty-tab-icon">📁</div><p>Aucun document ajouté</p></div>`;
    return;
  }

  // Grouper par catégorie
  const categories = { transport: [], hebergement: [], vehicule: [], activite: [], autre: [] };
  docs.forEach(d => { const c = d.categorie || 'autre'; (categories[c] || categories.autre).push(d); });

  const labels = { transport: '✈️ Transport', hebergement: '🏠 Hébergement', vehicule: '🚗 Véhicule', activite: '🎯 Activités', autre: '📄 Autres' };

  container.innerHTML = Object.entries(categories)
    .filter(([, items]) => items.length > 0)
    .map(([cat, items]) => `
      <div style="margin-bottom:4px">
        <div style="font-size:.78rem;font-weight:700;color:var(--text-muted);padding:10px 16px 6px;text-transform:uppercase;letter-spacing:.05em">${labels[cat]}</div>
        <div class="docs-list" style="padding-top:0">
          ${items.map(d => `
            <div class="doc-card">
              <span class="doc-icon">${getDocIcon(d.type_fichier)}</span>
              <div class="doc-body">
                <div class="doc-nom">${d.nom}</div>
                <div class="doc-meta">${formatTaille(d.taille)} · ${formatDate(d.created_at?.split('T')[0])}</div>
              </div>
              <div class="doc-actions">
                <a href="${API}/api/documents/${d.id}/download" class="btn-mini btn-mini-edit" title="Ouvrir">👁️</a>
                <button class="btn-mini btn-mini-del" onclick="supprimerDocument(${d.id})" title="Supprimer">🗑️</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
}

function ouvrirModalDocument() {
  document.getElementById('doc-filename').textContent = '';
  document.getElementById('upload-doc-input').value = '';
  document.getElementById('doc-type').value = 'transport';
  document.querySelectorAll('[data-doctype]').forEach((el, i) => el.classList.toggle('active', i === 0));
  document.getElementById('modal-document').classList.remove('hidden');
}

function choisirDocType(btn) {
  document.querySelectorAll('[data-doctype]').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('doc-type').value = btn.dataset.doctype;
}

async function uploaderDocument(input) {
  const file = input.files[0];
  if (!file) return;

  document.getElementById('doc-filename').textContent = `📎 ${file.name}`;

  const formData = new FormData();
  formData.append('fichier', file);
  formData.append('categorie', document.getElementById('doc-type').value);

  const resp = await fetch(`${API}/api/voyages/${voyageActuel}/documents`, { method: 'POST', body: formData });
  if (resp.ok) {
    fermerModal('modal-document');
    toast('✅ Document ajouté');
    chargerDocuments();
  } else {
    toast('❌ Erreur lors de l\'upload');
  }
  input.value = '';
}

async function supprimerDocument(id) {
  if (!confirm('Supprimer ce document ?')) return;
  await fetch(`${API}/api/documents/${id}`, { method: 'DELETE' });
  toast('🗑️ Document supprimé');
  chargerDocuments();
}

// ─── MODALS & BOTTOM SHEET ───────────────────────────

function fermerModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function fermerBottomSheet() {
  document.getElementById('menu-voyage').classList.add('hidden');
  document.getElementById('overlay-sheet').classList.add('hidden');
}

function choisirCouleur(btn) {
  document.querySelectorAll('.color-opt').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('v-couleur').value = btn.dataset.color;
}

function choisirType(btn) {
  document.querySelectorAll('.type-opt').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('r-type').value = btn.dataset.type;
}

// Fermer modals en cliquant l'overlay
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
});

// ─── TOAST ───────────────────────────────────────────

function toast(msg, duree = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), duree);
}

// ─── HELPERS ─────────────────────────────────────────

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('fr-BE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateLong(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatDates(debut, fin) {
  if (!debut) return 'Dates non définies';
  if (!fin || debut === fin) return formatDate(debut);
  return `${formatDate(debut)} → ${formatDate(fin)}`;
}

function getDuree(debut, fin) {
  if (!debut || !fin) return '';
  const d1 = new Date(debut), d2 = new Date(fin);
  const jours = Math.round((d2 - d1) / 86400000);
  return jours > 0 ? `${jours} jour${jours > 1 ? 's' : ''}` : '';
}

function getStatut(debut, fin) {
  const today = new Date(); today.setHours(0,0,0,0);
  const d1 = debut ? new Date(debut) : null;
  const d2 = fin ? new Date(fin) : null;
  if (!d1) return { label: 'À planifier', classe: 'past' };
  if (d1 > today) return { label: 'À venir', classe: 'upcoming' };
  if (d2 && d2 < today) return { label: 'Passé', classe: 'past' };
  return { label: 'En cours', classe: 'ongoing' };
}

function getAgendaColor(type) {
  const colors = { transport: '#3B82F6', hebergement: '#10B981', activite: '#8B5CF6', restaurant: '#EC4899', sport: '#F59E0B', libre: '#64748B' };
  return colors[type] || '#3B82F6';
}

function getAgendaIcon(type) {
  const icons = { transport: '✈️', hebergement: '🏠', activite: '🎯', restaurant: '🍽️', sport: '🏄', libre: '☀️' };
  return icons[type] || '📌';
}

function getDocIcon(mime) {
  if (!mime) return '📄';
  if (mime.includes('pdf')) return '📕';
  if (mime.includes('image')) return '🖼️';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  return '📄';
}

function formatTaille(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}
