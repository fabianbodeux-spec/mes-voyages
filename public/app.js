// ═══════════════════════════════════════════════════════
//  MES VOYAGES — Application Frontend
// ═══════════════════════════════════════════════════════

const API = '';  // même origin
let voyageActuel = null;
let filtreActuel = 'tous';
let participantsActuels = [];
let participantBagageActuel = null;
let voyageInfoActuel = null;

// ─── INIT ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  chargerVoyages();

  // ── Animated search placeholder ────────────────────
  const destinations = ['Paris, France…', 'Tokyo, Japon…', 'Marrakech, Maroc…', 'Corse, France…', 'Bali, Indonésie…', 'Rome, Italie…', 'Barcelone, Espagne…', 'Lisbonne, Portugal…', 'New York, USA…', 'Maldives…'];
  let dIdx = 0;
  const ph = document.getElementById('home-search-anim');
  if (ph) {
    setInterval(() => {
      ph.style.transition = 'opacity 0.28s ease';
      ph.style.opacity = '0';
      setTimeout(() => {
        dIdx = (dIdx + 1) % destinations.length;
        ph.textContent = destinations[dIdx];
        ph.style.opacity = '1';
      }, 280);
    }, 2800);
  }

  // ── Scroll shadow on detail header ─────────────────
  const mainContent = document.querySelector('#screen-voyage .main-content');
  const detailHeader = document.getElementById('voyage-header');
  if (mainContent && detailHeader) {
    mainContent.addEventListener('scroll', () => {
      detailHeader.style.boxShadow = mainContent.scrollTop > 4
        ? '0 2px 20px rgba(0,0,0,0.09)'
        : '';
    });
  }
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
      changerOnglet('accueil', document.querySelector('[data-tab="accueil"]'));
    });
}

function changerOnglet(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');

  if (tab === 'accueil') chargerAccueil();
  if (tab === 'programme') chargerProgramme();
  if (tab === 'carte') chargerCarte();
  if (tab === 'budget') chargerBudget();
  if (tab === 'bagages') chargerBagages();
  if (tab === 'admin') chargerAdmin();
}

// ─── VOYAGES ─────────────────────────────────────────

/**
 * Charge la photo emblématique de chaque destination via Wikimedia Commons.
 * Cartes rendues d'abord avec le dégradé couleur, puis la photo s'insère en fondu.
 */
async function enrichirPhotos(voyages) {
  for (const v of voyages) {
    const dest = (v.destination || '').split(',')[0].trim();
    if (!dest) continue;

    const cacheKey = `wkp2_${dest}`;
    let url = localStorage.getItem(cacheKey);

    if (!url) {
      url = await _commonsPhoto(dest);
      // Fallback : résumé Wikipedia (évite les maps SVG et drapeaux)
      if (!url) url = await _wpSummaryPhoto(dest);
      if (url) localStorage.setItem(cacheKey, url);
    }

    if (url) _appliquerPhoto(v.id, url);
  }
}

/**
 * Cherche une photo emblématique sur Wikimedia Commons.
 * Filtre les maps, drapeaux, logos. Retourne un thumbnail 800px.
 */
async function _commonsPhoto(dest) {
  const EXCL = ['map','flag','logo','icon','coat','blason','carte','plan','schema','wapen','locator','relief'];
  try {
    // Étape 1 : chercher un fichier JPG qui correspond à la destination
    const r = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&list=search` +
      `&srnamespace=6&srsearch=${encodeURIComponent(dest)}&srlimit=20&format=json&origin=*`
    );
    const d = await r.json();
    const hits = d?.query?.search || [];
    const hit = hits.find(h => {
      const name = h.title.toLowerCase();
      return (name.endsWith('.jpg') || name.endsWith('.jpeg')) &&
             !EXCL.some(x => name.includes(x));
    });
    if (!hit) return null;

    // Étape 2 : récupérer l'URL du thumbnail
    const r2 = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query` +
      `&titles=${encodeURIComponent(hit.title)}&prop=imageinfo` +
      `&iiprop=url&iiurlwidth=800&format=json&origin=*`
    );
    const d2 = await r2.json();
    const page = Object.values(d2?.query?.pages || {})[0];
    return page?.imageinfo?.[0]?.thumburl || null;
  } catch { return null; }
}

/** Fallback : thumbnail de la page Wikipedia (ignoré si c'est un SVG/map/flag) */
async function _wpSummaryPhoto(dest) {
  try {
    const r = await fetch(
      `https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(dest)}`
    );
    const d = await r.json();
    const src = d?.thumbnail?.source;
    if (!src) return null;
    const low = src.toLowerCase();
    if (low.includes('.svg') || low.includes('flag') || low.includes('map') ||
        low.includes('blason') || low.includes('locator')) return null;
    return src;
  } catch { return null; }
}

/** Applique la photo sur la carte voyage avec un fondu */
function _appliquerPhoto(voyageId, photoUrl) {
  const card = document.querySelector(`.voyage-card[data-id="${voyageId}"]`);
  if (!card) return;
  const img  = card.querySelector('.voyage-card-banner-img');
  const band = card.querySelector('.voyage-card-banner');
  if (!img) return;
  const tmp = new Image();
  tmp.onload = () => {
    img.src = photoUrl;
    img.style.opacity = '1';
    if (band) band.style.removeProperty('background');
  };
  tmp.src = photoUrl;
}

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

  // Stats pour le banner
  const aVenir = voyages.filter(v => getStatut(v.date_debut, v.date_fin).classe === 'upcoming').length;
  const enCours = voyages.filter(v => getStatut(v.date_debut, v.date_fin).classe === 'ongoing').length;
  const statsEl = document.getElementById('home-stats');
  if (statsEl) {
    const pills = [];
    if (enCours > 0) pills.push(`<span class="stat-pill">🟢 ${enCours} en cours</span>`);
    if (aVenir > 0) pills.push(`<span class="stat-pill">📅 ${aVenir} à venir</span>`);
    pills.push(`<span class="stat-pill">✈️ ${voyages.length} voyage${voyages.length > 1 ? 's' : ''}</span>`);
    statsEl.innerHTML = pills.join('');
  }

  liste.innerHTML = voyages.map(v => {
    const statut = getStatut(v.date_debut, v.date_fin);
    const duree = getDuree(v.date_debut, v.date_fin);
    return `
    <div class="voyage-card" data-id="${v.id}" onclick="afficherVoyage(${v.id})">
      <div class="voyage-card-banner" style="background:linear-gradient(135deg,${v.couleur}dd,${v.couleur}88)">
        <img class="voyage-card-banner-img" src="" alt="${v.destination}" style="opacity:0">
        <div class="voyage-card-destination">📍 ${v.destination}</div>
      </div>
      <div class="voyage-card-body">
        <div class="voyage-card-header">
          <h2>${v.nom}</h2>
          <span class="voyage-badge badge-${statut.classe}">${statut.label}</span>
        </div>
        <div class="voyage-card-footer">
          <span class="voyage-dates">📅 ${v.date_debut ? formatDates(v.date_debut, v.date_fin) : 'Dates à définir'}</span>
          ${duree ? `<span class="voyage-duree">${duree}</span>` : '<span class="voyage-arrow">›</span>'}
        </div>
      </div>
    </div>`;
  }).join('');

  // Chargement asynchrone des photos emblématiques depuis Wikipedia
  enrichirPhotos(voyages);
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

// Cache local pour l'affichage du détail sans re-fetch
let _resasCache = [];
let _docsCache  = [];

async function chargerReservations() {
  const [reservations, documents] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/documents`).then(r => r.json())
  ]);
  _resasCache = reservations;
  _docsCache  = documents;
  afficherReservations(reservations, filtreActuel, documents);
}

function afficherReservations(reservations, filtre, documents = []) {
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
        ${items.map(r => renderResa(r, documents.filter(d => d.reservation_id == r.id))).join('')}
      </div>
    `).join('')
  }</div>`;
}

function renderResa(r, docs = []) {
  const icones = { transport: '✈️', hebergement: '🏠', vehicule: '🚗', activite: '🎯', restaurant: '🍽️' };
  // Indicateurs compacts sur la carte
  const hasLink = !!r.lien;
  const docCount = docs.length;
  return `
  <div class="resa-card" onclick="voirReservation(${r.id})">
    <div class="resa-card-inner">
      <div class="resa-icon icon-${r.type}">${icones[r.type] || '📌'}</div>
      <div class="resa-body">
        <div class="resa-titre">${r.titre}</div>
        <div class="resa-meta">
          ${r.heure_debut ? `<span>🕐 ${r.heure_debut}${r.heure_fin ? ' → ' + r.heure_fin : ''}</span>` : ''}
          ${r.lieu ? `<span>📍 ${r.lieu}</span>` : ''}
          ${r.date_fin && r.date_fin !== r.date_debut ? `<span>📅 jusqu'au ${formatDate(r.date_fin)}</span>` : ''}
        </div>
        <div class="resa-card-badges">
          ${r.numero_confirmation ? `<span class="resa-badge-mini">📋 ${r.numero_confirmation}</span>` : ''}
          ${hasLink ? `<span class="resa-badge-mini resa-badge-lien">🔗 Lien</span>` : ''}
          ${docCount ? `<span class="resa-badge-mini resa-badge-doc">📎 ${docCount}</span>` : ''}
        </div>
      </div>
      <div class="resa-actions" onclick="event.stopPropagation()">
        <button class="btn-mini btn-mini-edit" onclick="modifierReservation(${r.id})" title="Modifier">✏️</button>
        <button class="btn-mini btn-mini-del" onclick="supprimerReservation(${r.id})" title="Supprimer">🗑️</button>
      </div>
    </div>
  </div>`;
}

function voirReservation(id) {
  const r = _resasCache.find(x => x.id === id);
  if (!r) return;
  const docs = _docsCache.filter(d => d.reservation_id == id);
  const icones = { transport: '✈️', hebergement: '🏠', vehicule: '🚗', activite: '🎯', restaurant: '🍽️' };

  const docsHtml = docs.length ? `
    <div class="rd-section">
      <div class="rd-section-label">📎 Documents liés</div>
      <div class="resa-docs">
        ${docs.map(d => `
          <button class="resa-doc-badge" onclick="ouvrirDocViewer(${d.id}, \`${d.nom.replace(/`/g,'')}\`)">
            ${getDocIcon(d.type_fichier)} <span>${d.nom}</span>
          </button>`).join('')}
      </div>
    </div>` : '';

  document.getElementById('resa-detail-body').innerHTML = `
    <div class="rd-header">
      <div class="rd-icon icon-${r.type}">${icones[r.type] || '📌'}</div>
      <div class="rd-header-text">
        <div class="rd-titre">${r.titre}</div>
        ${r.date_debut ? `<div class="rd-date">${formatDate(r.date_debut)}</div>` : ''}
      </div>
    </div>

    <div class="rd-rows">
      ${r.heure_debut ? `<div class="rd-row"><span class="rd-row-icon">🕐</span><span>${r.heure_debut}${r.heure_fin ? ' → ' + r.heure_fin : ''}</span></div>` : ''}
      ${r.date_fin && r.date_fin !== r.date_debut ? `<div class="rd-row"><span class="rd-row-icon">📅</span><span>Jusqu'au ${formatDate(r.date_fin)}${r.heure_fin ? ' · ' + r.heure_fin : ''}</span></div>` : ''}
      ${r.lieu    ? `<div class="rd-row"><span class="rd-row-icon">📍</span><span>${r.lieu}</span></div>` : ''}
      ${r.adresse ? `<div class="rd-row"><span class="rd-row-icon">🏠</span><span>${r.adresse}</span></div>` : ''}
      ${r.numero_confirmation ? `
        <div class="rd-row">
          <span class="rd-row-icon">📋</span>
          <span class="rd-code">${r.numero_confirmation}</span>
          <button class="rd-copy-btn" onclick="navigator.clipboard.writeText('${r.numero_confirmation.replace(/'/g,"\\'")}').then(()=>toast('✅ Copié !'))">Copier</button>
        </div>` : ''}
    </div>

    ${r.notes ? `<div class="rd-notes">${r.notes.replace(/\n/g,'<br>')}</div>` : ''}

    ${r.lien ? `<a href="${r.lien}" target="_blank" rel="noopener" class="rd-lien-btn" onclick="event.stopPropagation()">🔗 Ouvrir le lien de réservation</a>` : ''}

    ${docsHtml}

    <div class="rd-actions">
      <button class="sheet-btn" onclick="fermerBottomSheet(); modifierReservation(${id})">✏️ Modifier</button>
      <button class="sheet-btn danger" onclick="fermerBottomSheet(); supprimerReservation(${id})">🗑️ Supprimer</button>
    </div>
  `;

  document.getElementById('resa-detail-sheet').classList.remove('hidden');
  document.getElementById('overlay-sheet').classList.remove('hidden');
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
        document.getElementById('r-lien').value = r.lien || '';
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
    notes: document.getElementById('r-notes').value,
    lien: document.getElementById('r-lien').value || null
  };

  const url = id ? `${API}/api/reservations/${id}` : `${API}/api/voyages/${voyageActuel}/reservations`;
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  fermerModal('modal-reservation');
  toast(id ? '✅ Réservation modifiée' : '✅ Réservation ajoutée');
  chargerAdmin();
}

async function supprimerReservation(id) {
  if (!confirm('Supprimer cette réservation ?')) return;
  await fetch(`${API}/api/reservations/${id}`, { method: 'DELETE' });
  toast('🗑️ Réservation supprimée');
  chargerAdmin();
}

// ─── DASHBOARD ACCUEIL ───────────────────────────────────────────────────────

async function chargerAccueil() {
  const container = document.getElementById('dash-content');
  container.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-muted)">Chargement…</div>`;

  const [voyage, reservations, bagages] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/bagages`).then(r => r.json())
  ]);

  const today = new Date(); today.setHours(0,0,0,0);
  const debut = voyage.date_debut ? new Date(voyage.date_debut + 'T00:00:00') : null;
  const fin   = voyage.date_fin   ? new Date(voyage.date_fin   + 'T00:00:00') : null;

  // ── Statut du voyage ──────────────────────────────────────────────────────
  let heroClass = 'upcoming', heroLabel = '', heroDays = '';
  if (!debut) {
    heroClass = 'past'; heroLabel = 'À planifier';
  } else if (debut > today) {
    const diff = Math.ceil((debut - today) / 86400000);
    heroClass = 'upcoming';
    heroLabel = '🗓️ Départ dans';
    heroDays  = `${diff} jour${diff > 1 ? 's' : ''}`;
  } else if (fin && fin < today) {
    const diff = Math.ceil((today - fin) / 86400000);
    heroClass = 'past';
    heroLabel = 'Voyage terminé';
    heroDays  = `il y a ${diff} jour${diff > 1 ? 's' : ''}`;
  } else {
    const totalDays = fin ? Math.round((fin - debut) / 86400000) + 1 : null;
    const jourN = Math.round((today - debut) / 86400000) + 1;
    heroClass = 'ongoing';
    heroLabel = '🌍 En cours';
    heroDays  = totalDays ? `Jour ${jourN} / ${totalDays}` : `Jour ${jourN}`;
  }

  // ── Prochaine réservation ─────────────────────────────────────────────────
  const todayStr = today.toISOString().split('T')[0];
  const futures = reservations
    .filter(r => r.date_debut && r.date_debut >= todayStr)
    .sort((a, b) => a.date_debut < b.date_debut ? -1 : 1);
  const prochaine = futures[0] || null;

  // ── Statistiques bagages ──────────────────────────────────────────────────
  const bagTotal  = bagages.length;
  const bagCoches = bagages.filter(b => b.checked).length;
  const bagPct    = bagTotal > 0 ? Math.round(bagCoches / bagTotal * 100) : 0;

  // ── Rendu principal ────────────────────────────────────────────────────────
  const resaIcons = { transport:'✈️', hebergement:'🏠', vehicule:'🚗', activite:'🎯', restaurant:'🍽️' };

  container.innerHTML = `
    <!-- Hero countdown -->
    <div class="dash-hero dash-hero-${heroClass}">
      <div class="dash-hero-eyebrow">${heroLabel}</div>
      <div class="dash-hero-days">${heroDays}</div>
      <div class="dash-hero-dest">📍 ${voyage.destination || voyage.nom}</div>
      ${debut ? `<div class="dash-hero-period">${formatDates(voyage.date_debut, voyage.date_fin)}</div>` : ''}
    </div>

    <!-- Stats grid -->
    <div class="dash-stats-grid">
      <div class="dash-stat-card">
        <div class="dash-stat-value">${reservations.length}</div>
        <div class="dash-stat-label">Réservations</div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-value">${bagPct}<span style="font-size:1rem">%</span></div>
        <div class="dash-stat-label">Bagages prêts</div>
        <div class="dash-stat-bar"><div class="dash-stat-bar-fill" style="width:${bagPct}%"></div></div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-value">${bagCoches}<span style="font-size:.85rem;color:var(--text-muted)">/${bagTotal}</span></div>
        <div class="dash-stat-label">Articles cochés</div>
      </div>
    </div>

    <!-- Prochaine réservation -->
    ${prochaine ? `
    <div class="dash-section-title">🎫 Prochaine réservation</div>
    <div class="dash-next-card" onclick="voirReservation(${prochaine.id})">
      <div class="dash-next-icon">${resaIcons[prochaine.type] || '📌'}</div>
      <div class="dash-next-body">
        <div class="dash-next-titre">${prochaine.titre}</div>
        <div class="dash-next-date">${formatDate(prochaine.date_debut)}${prochaine.heure ? ' · ' + prochaine.heure : ''}</div>
        ${prochaine.adresse ? `<div class="dash-next-lieu">📍 ${prochaine.adresse}</div>` : ''}
      </div>
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="flex-shrink:0;color:var(--text-muted)"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
    </div>` : ''}

    <!-- Météo -->
    <div class="dash-section-title">🌤️ Météo à destination</div>
    <div id="dash-meteo"><div style="padding:16px;text-align:center;color:var(--text-muted);font-size:.88rem">Chargement de la météo…</div></div>

    <!-- Description -->
    ${voyage.description ? `
    <div class="dash-section-title">📝 Notes du voyage</div>
    <div class="dash-notes">${voyage.description}</div>` : ''}

    <div style="height:24px"></div>
  `;

  // Charger la météo de façon asynchrone
  chargerMeteo(voyage.destination || voyage.nom);
}

async function chargerMeteo(destination) {
  const el = document.getElementById('dash-meteo');
  if (!el) return;

  try {
    const dest = (destination || '').split(',')[0].trim();
    // Géocodage via Open-Meteo
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(dest)}&count=1&language=fr&format=json`);
    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) {
      el.innerHTML = `<div class="dash-meteo-na">Météo indisponible pour cette destination</div>`;
      return;
    }
    const { latitude, longitude, name, country } = geoData.results[0];

    // Prévisions 7 jours
    const wtRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7`);
    const wtData = await wtRes.json();
    const d = wtData.daily;

    const days = d.time.map((date, i) => ({
      date,
      code: d.weathercode[i],
      tmax: Math.round(d.temperature_2m_max[i]),
      tmin: Math.round(d.temperature_2m_min[i]),
      rain: d.precipitation_probability_max[i]
    }));

    const dayNames = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];

    el.innerHTML = `
      <div class="dash-weather-card">
        <div class="dash-weather-loc">📍 ${name}, ${country}</div>
        <div class="dash-weather-row">
          ${days.map((day, i) => {
            const dn = new Date(day.date + 'T00:00:00');
            const label = i === 0 ? "Auj." : dayNames[dn.getDay()];
            return `
            <div class="dash-forecast-day">
              <div class="dash-forecast-label">${label}</div>
              <div class="dash-forecast-emoji">${wmoEmoji(day.code)}</div>
              <div class="dash-forecast-temps"><span class="dash-tmax">${day.tmax}°</span><span class="dash-tmin">${day.tmin}°</span></div>
              ${day.rain !== null ? `<div class="dash-forecast-rain">${day.rain}%</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>`;
  } catch(e) {
    el.innerHTML = `<div class="dash-meteo-na">Météo temporairement indisponible</div>`;
  }
}

function wmoEmoji(code) {
  if (code === 0)  return '☀️';
  if (code <= 2)   return '⛅';
  if (code <= 3)   return '☁️';
  if (code <= 49)  return '🌫️';
  if (code <= 59)  return '🌦️';
  if (code <= 69)  return '🌧️';
  if (code <= 79)  return '❄️';
  if (code <= 82)  return '🌧️';
  if (code <= 84)  return '🌨️';
  if (code <= 94)  return '⛈️';
  return '🌩️';
}

// ─── AGENDA (modal helpers — kept for create/edit) ───────────────────────────

// ─── PROGRAMME (timeline jour par jour) ──────────────────────────────────────

async function chargerProgramme() {
  const [evts, resas, voyage] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}`).then(r => r.json())
  ]);

  const container = document.getElementById('liste-programme');

  // Fusionner : chaque résa avec une date → apparaît dans la timeline
  const items = [];

  evts.forEach(ev => {
    if (!ev.date) return;
    items.push({
      date: ev.date,
      heure: ev.heure || null,
      titre: ev.titre,
      lieu: ev.lieu || null,
      description: ev.description || null,
      lien: ev.lien || null,
      type: ev.type,
      source: 'agenda',
      id: ev.id
    });
  });

  resas.forEach(r => {
    const date = r.date_debut || r.date;
    if (!date) return;
    items.push({
      date,
      heure: r.heure || null,
      titre: r.titre,
      lieu: r.adresse || r.lieu || null,
      description: r.notes || null,
      lien: r.lien || null,
      type: r.type,
      source: 'resa',
      id: r.id
    });
  });

  if (items.length === 0) {
    container.innerHTML = `<div class="empty-tab"><div class="empty-tab-icon">📆</div><p>Aucun élément planifié</p><p style="font-size:.83rem;margin-top:6px;color:var(--text-muted)">Ajoutez des réservations ou des événements avec une date</p></div>`;
    return;
  }

  // Trier par date puis heure
  items.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ha = a.heure || '99:99', hb = b.heure || '99:99';
    return ha < hb ? -1 : 1;
  });

  // Grouper par date
  const grouped = {};
  items.forEach(it => {
    if (!grouped[it.date]) grouped[it.date] = [];
    grouped[it.date].push(it);
  });

  const today = new Date().toISOString().split('T')[0];

  // Calculer les bornes du voyage pour "jour X / N"
  const debut = voyage.date_debut;
  const fin = voyage.date_fin;
  const totalDays = (debut && fin) ? Math.round((new Date(fin) - new Date(debut)) / 86400000) + 1 : null;

  function jourNum(dateStr) {
    if (!debut) return null;
    const n = Math.round((new Date(dateStr) - new Date(debut)) / 86400000) + 1;
    return n >= 1 ? n : null;
  }

  function resaIcon(type) {
    const m = { transport: '✈️', hebergement: '🏠', vehicule: '🚗', activite: '🎯', restaurant: '🍽️' };
    return m[type] || '📌';
  }

  container.innerHTML = Object.entries(grouped).map(([date, dayItems]) => {
    const isToday = date === today;
    const isPast = date < today;
    const jourLabel = jourNum(date) ? `Jour ${jourNum(date)}${totalDays ? ` / ${totalDays}` : ''}` : '';

    return `
    <div class="prog-day ${isToday ? 'prog-day-today' : ''} ${isPast ? 'prog-day-past' : ''}">
      <div class="prog-day-header">
        <div class="prog-day-label">
          <span class="prog-day-date">${formatDateLong(date)}${isToday ? ' · <strong>Aujourd\'hui</strong>' : ''}</span>
          ${jourLabel ? `<span class="prog-day-num">${jourLabel}</span>` : ''}
        </div>
      </div>
      <div class="prog-items">
        ${dayItems.map((it, idx) => {
          const isLast = idx === dayItems.length - 1;
          const color = it.source === 'resa' ? getResaColor(it.type) : getAgendaColor(it.type);
          const icon = it.source === 'resa' ? resaIcon(it.type) : getAgendaIcon(it.type);
          const badge = it.source === 'resa'
            ? `<span class="prog-badge prog-badge-resa">Réservation</span>`
            : `<span class="prog-badge prog-badge-agenda">Agenda</span>`;
          const editFn = it.source === 'resa' ? `modifierReservation(${it.id})` : `modifierAgenda(${it.id})`;
          const delFn = it.source === 'resa' ? `supprimerReservation(${it.id})` : `supprimerAgenda(${it.id})`;

          return `
          <div class="prog-item">
            <div class="prog-spine">
              <div class="prog-dot" style="background:${color}"></div>
              ${!isLast ? `<div class="prog-line" style="background:${color}22"></div>` : ''}
            </div>
            <div class="prog-card">
              <div class="prog-card-top">
                <span class="prog-icon">${icon}</span>
                <div class="prog-card-body">
                  <div class="prog-titre">${it.titre}</div>
                  ${it.heure ? `<span class="prog-heure">🕐 ${it.heure}</span>` : ''}
                  ${it.lieu ? `<div class="prog-lieu">📍 ${it.lieu}</div>` : ''}
                  ${it.description ? `<div class="prog-desc">${it.description}</div>` : ''}
                  ${it.lien ? `<a href="${it.lien}" target="_blank" rel="noopener" class="prog-lien">🔗 Ouvrir</a>` : ''}
                </div>
                <div class="prog-actions">
                  ${badge}
                  <div style="display:flex;gap:4px;margin-top:6px">
                    <button class="btn-mini btn-mini-edit" onclick="event.stopPropagation();${editFn}">✏️</button>
                    <button class="btn-mini btn-mini-del" onclick="event.stopPropagation();${delFn}">🗑️</button>
                  </div>
                </div>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

function getResaColor(type) {
  const colors = { transport: '#3B82F6', hebergement: '#10B981', vehicule: '#F59E0B', activite: '#8B5CF6', restaurant: '#EC4899' };
  return colors[type] || '#C9622F';
}

function ouvrirModalAgenda(id = null) {
  document.getElementById('modal-agenda-titre').textContent = id ? 'Modifier l\'événement' : 'Nouvel événement';
  document.getElementById('a-id').value = id || '';
  if (!id) {
    document.getElementById('form-agenda').reset();
    document.getElementById('a-lien').value = '';
  }
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
  document.getElementById('a-lien').value = item.lien || '';
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
    type: document.getElementById('a-type').value,
    lien: document.getElementById('a-lien').value || null
  };

  const url = id ? `${API}/api/agenda/${id}` : `${API}/api/voyages/${voyageActuel}/agenda`;
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  fermerModal('modal-agenda');
  toast(id ? '✅ Événement modifié' : '✅ Événement ajouté');
  chargerProgramme();
}

async function supprimerAgenda(id) {
  if (!confirm('Supprimer cet événement ?')) return;
  await fetch(`${API}/api/agenda/${id}`, { method: 'DELETE' });
  toast('🗑️ Événement supprimé');
  chargerProgramme();
}

// ─── CARTE ───────────────────────────────────────────

async function chargerCarte() {
  const [reservations, agenda, voyage] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}`).then(r => r.json())
  ]);

  const lieuxResa = reservations
    .filter(r => r.adresse || r.lieu)
    .map(r => ({ titre: r.titre, lieu: r.adresse || r.lieu, type: r.type }));

  const lieuxAgenda = agenda
    .filter(a => a.lieu)
    .map(a => ({ titre: a.titre, lieu: a.lieu, type: a.type }));

  const lieux = [...lieuxResa, ...lieuxAgenda];

  const icones = { transport: '✈️', hebergement: '🏠', vehicule: '🚗', activite: '🎯', restaurant: '🍽️', sport: '🏄', libre: '☀️' };

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
  const [docs, events, reservations] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/documents`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json())
  ]);
  const container = document.getElementById('liste-documents');

  if (docs.length === 0) {
    container.innerHTML = `<div class="empty-tab"><div class="empty-tab-icon">📁</div><p>Aucun document ajouté</p></div>`;
    return;
  }

  // Index des événements et réservations par id
  const eventsById = {};
  events.forEach(ev => { eventsById[ev.id] = ev; });
  const resaById = {};
  reservations.forEach(r => { resaById[r.id] = r; });

  const iconeResa = { transport: '✈️', hebergement: '🏠', vehicule: '🚗', activite: '🎯', restaurant: '🍽️' };

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
          ${items.map(d => {
            const ev   = d.event_id       ? eventsById[d.event_id] : null;
            const resa = d.reservation_id ? resaById[d.reservation_id] : null;
            let lienHtml = '';
            if (resa) lienHtml = `<div class="doc-event-link">${iconeResa[resa.type] || '📌'} ${resa.titre}</div>`;
            else if (ev) lienHtml = `<div class="doc-event-link">📅 ${ev.titre}</div>`;
            return `
            <div class="doc-card">
              <span class="doc-icon">${getDocIcon(d.type_fichier)}</span>
              <div class="doc-body">
                <div class="doc-nom">${d.nom}</div>
                <div class="doc-meta">${formatTaille(d.taille)} · ${formatDate(d.created_at?.split('T')[0])}</div>
                ${lienHtml}
              </div>
              <div class="doc-actions">
                <button class="btn-mini btn-mini-view" onclick="ouvrirDocViewer(${d.id}, \`${d.nom.replace(/`/g, '')}\`)" title="Ouvrir">👁️</button>
                <button class="btn-mini btn-mini-edit" onclick="modifierDocument(${d.id})" title="Modifier">✏️</button>
                <button class="btn-mini btn-mini-del" onclick="supprimerDocument(${d.id})" title="Supprimer">🗑️</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
    `).join('');
}

async function ouvrirModalDocument() {
  document.getElementById('doc-filename').textContent = '';
  document.getElementById('upload-doc-input').value = '';
  document.getElementById('doc-type').value = 'transport';
  document.getElementById('doc-event').value = '';
  document.getElementById('doc-reservation-id').value = '';
  document.querySelectorAll('[data-doctype]').forEach((el, i) => el.classList.toggle('active', i === 0));

  // Sélecteur unifié : réservations + agenda
  const select = document.getElementById('doc-lien-select');
  select.innerHTML = '<option value="">— Non lié —</option>';
  try {
    const [reservations, events] = await Promise.all([
      fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
      fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json())
    ]);

    const icones = { transport: '✈️', hebergement: '🏠', vehicule: '🚗', activite: '🎯', restaurant: '🍽️' };

    if (reservations.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '── Réservations ──';
      reservations.forEach(r => {
        const opt = document.createElement('option');
        opt.value = `resa:${r.id}`;
        opt.textContent = `${icones[r.type] || '📌'} ${r.titre}`;
        grp.appendChild(opt);
      });
      select.appendChild(grp);
    }

    if (events.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '── Agenda ──';
      events.forEach(ev => {
        const opt = document.createElement('option');
        opt.value = `event:${ev.id}`;
        opt.textContent = `📅 ${ev.date ? formatDate(ev.date) + ' — ' : ''}${ev.titre}`;
        grp.appendChild(opt);
      });
      select.appendChild(grp);
    }
  } catch(e) {}

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

  // Décoder la valeur du sélecteur unifié (resa:id ou event:id)
  const lienVal = document.getElementById('doc-lien-select').value;
  if (lienVal.startsWith('resa:')) {
    formData.append('reservation_id', lienVal.split(':')[1]);
  } else if (lienVal.startsWith('event:')) {
    formData.append('event_id', lienVal.split(':')[1]);
  }

  const resp = await fetch(`${API}/api/voyages/${voyageActuel}/documents`, { method: 'POST', body: formData });
  if (resp.ok) {
    fermerModal('modal-document');
    toast('✅ Document ajouté');
    chargerAdmin();
  } else {
    toast('❌ Erreur lors de l\'upload');
  }
  input.value = '';
}

async function supprimerDocument(id) {
  if (!confirm('Supprimer ce document ?')) return;
  await fetch(`${API}/api/documents/${id}`, { method: 'DELETE' });
  toast('🗑️ Document supprimé');
  chargerAdmin();
}

async function modifierDocument(id) {
  // Charger le doc depuis le cache ou via l'API
  const docs = await fetch(`${API}/api/voyages/${voyageActuel}/documents`).then(r => r.json());
  const doc = docs.find(d => d.id === id);
  if (!doc) return;

  // Pré-remplir le nom
  document.getElementById('doc-edit-id').value = id;
  document.getElementById('doc-edit-nom').value = doc.nom;

  // Pré-sélectionner la catégorie
  const cat = doc.categorie || 'autre';
  document.getElementById('doc-edit-categorie').value = cat;
  document.querySelectorAll('[data-doctype-edit]').forEach(el => {
    el.classList.toggle('active', el.dataset.doctypeEdit === cat);
  });

  // Charger le sélecteur de lien (réservations + agenda)
  const select = document.getElementById('doc-edit-lien-select');
  select.innerHTML = '<option value="">— Non lié —</option>';
  try {
    const [reservations, events] = await Promise.all([
      fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
      fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json())
    ]);
    const icones = { transport: '✈️', hebergement: '🏠', vehicule: '🚗', activite: '🎯', restaurant: '🍽️' };

    if (reservations.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '── Réservations ──';
      reservations.forEach(r => {
        const opt = document.createElement('option');
        opt.value = `resa:${r.id}`;
        opt.textContent = `${icones[r.type] || '📌'} ${r.titre}`;
        if (doc.reservation_id == r.id) opt.selected = true;
        grp.appendChild(opt);
      });
      select.appendChild(grp);
    }
    if (events.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '── Agenda ──';
      events.forEach(ev => {
        const opt = document.createElement('option');
        opt.value = `event:${ev.id}`;
        opt.textContent = `📅 ${ev.date ? formatDate(ev.date) + ' — ' : ''}${ev.titre}`;
        if (doc.event_id == ev.id) opt.selected = true;
        grp.appendChild(opt);
      });
      select.appendChild(grp);
    }
  } catch(e) {}

  document.getElementById('modal-doc-edit').classList.remove('hidden');
}

function choisirDocTypeEdit(btn) {
  document.querySelectorAll('[data-doctype-edit]').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('doc-edit-categorie').value = btn.dataset.doctypeEdit;
}

async function sauvegarderModifDocument() {
  const id       = document.getElementById('doc-edit-id').value;
  const nom      = document.getElementById('doc-edit-nom').value.trim();
  const categorie = document.getElementById('doc-edit-categorie').value;
  const lienVal  = document.getElementById('doc-edit-lien-select').value;

  if (!nom) { toast('⚠️ Le nom est requis'); return; }

  const body = { nom, categorie, event_id: null, reservation_id: null };
  if (lienVal.startsWith('resa:'))  body.reservation_id = parseInt(lienVal.split(':')[1]);
  if (lienVal.startsWith('event:')) body.event_id       = parseInt(lienVal.split(':')[1]);

  await fetch(`${API}/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  fermerModal('modal-doc-edit');
  toast('✅ Document modifié');
  chargerAdmin();
}

// ─── VISUALISEUR DOCUMENT ───────────────────────────

function ouvrirDocViewer(docId, nom) {
  const url = `${API}/api/documents/${docId}/download`;
  document.getElementById('doc-viewer-nom').textContent = nom;
  document.getElementById('doc-viewer-frame').src = url;
  document.getElementById('modal-doc-viewer').classList.remove('hidden');
  // Bloquer le scroll derrière
  document.body.style.overflow = 'hidden';
}

function fermerDocViewer() {
  document.getElementById('modal-doc-viewer').classList.add('hidden');
  document.getElementById('doc-viewer-frame').src = '';
  document.body.style.overflow = '';
}

// ─── BAGAGES ─────────────────────────────────────────

const CAT_LABELS = { documents:'📄 Documents', vetements:'👕 Vêtements', toilette:'🧴 Toilette', sante:'💊 Santé', electronique:'📱 Électronique', plage:'🏖️ Plage / Sport', divers:'📦 Divers' };
const CAT_ORDER = ['documents','vetements','toilette','sante','electronique','plage','divers'];

// Base de suggestions par catégorie
const SUGGESTIONS_BASE = {
  documents: ['Passeport','Carte d\'identité','Permis de conduire','Carte bancaire','Assurance voyage','Billet avion','Réservation hôtel','Carnet de vaccination'],
  vetements: ['T-shirts','Pantalons','Sous-vêtements','Chaussettes','Pull / Sweat','Veste','Pyjama','Chaussures de ville','Baskets','Tongs','Ceinture'],
  toilette: ['Brosse à dents','Dentifrice','Shampooing','Gel douche','Déodorant','Rasoir','Crème visage','Maquillage','Coton-tiges','Serviette'],
  sante: ['Ordonnances','Médicaments habituels','Antidouleur','Anti-diarrhéique','Pansements','Thermomètre','Répulsif moustiques'],
  electronique: ['Téléphone','Chargeur téléphone','Batterie externe','Adaptateur voyage','Appareil photo','Écouteurs','Câble USB'],
  plage: [],
  divers: ['Sac à dos','Cadenas','Parapluie','Livre / Liseuse','Snacks voyage','Sac réutilisable']
};

// Suggestions selon destination/météo/activités
function getSuggestionsContextuelles(voyage, agenda) {
  const suggestions = JSON.parse(JSON.stringify(SUGGESTIONS_BASE));
  const dest = (voyage.destination + ' ' + voyage.nom).toLowerCase();
  const nuits = voyage.date_debut && voyage.date_fin
    ? Math.round((new Date(voyage.date_fin) - new Date(voyage.date_debut)) / 86400000)
    : 7;
  const activites = agenda.map(a => (a.titre + ' ' + (a.description||'')).toLowerCase()).join(' ');

  // Vêtements selon durée
  const nbTshirts = Math.min(nuits + 1, 10);
  suggestions.vetements = suggestions.vetements.filter(i => i !== 'T-shirts');
  suggestions.vetements.unshift(`T-shirts (×${nbTshirts})`);

  const ctx = dest + ' ' + activites;

  // Destination plage / mer / soleil
  if (/corse|mer|plage|mediterran|caraib|maldiv|bali|thailand|egypt|egypte|maroc|tunisie|espagne|portugal|grece|italie|reunion|antilles|ocean/i.test(ctx)) {
    suggestions.plage.push('Maillot de bain','Crème solaire SPF50','Après-soleil','Lunettes de soleil','Chapeau / Bob','Serviette de plage','Sac de plage','Tapis de plage');
    suggestions.vetements.push('Shorts','Robe légère / Chemise légère');
    suggestions.sante.push('Médicaments contre mal de mer');
  }

  // Plongée / snorkeling
  if (/plong|snorkel|diving|scuba/i.test(ctx)) {
    suggestions.plage.push('Masque et tuba','Palmes','Combinaison néoprène','Lampe torche étanche','Carnet waterproof','Ordinateur de plongée','Bouteille de plongée');
    suggestions.documents.push('Brevet de plongée (PADI/CMAS)','Carnet de plongée');
    suggestions.sante.push('Médicaments anti-nausées','Gouttes auriculaires');
    suggestions.electronique.push('GoPro / Caméra étanche');
  }

  // Montagne / randonnée
  if (/vosges|alpes|montagne|ski|randon|trek|pyren/i.test(ctx)) {
    suggestions.vetements.push('Veste imperméable','Polaire','Bonnet','Gants','Chaussettes de randonnée','Chaussures de randonnée');
    suggestions.divers.push('Bâtons de randonnée','Carte IGN','Gourde','Lampe frontale');
    suggestions.sante.push('Crème solaire montagne','Protection lèvres');
  }

  // Froid / hiver / ski
  if (/hiver|neige|ski|snowboard/i.test(ctx)) {
    suggestions.vetements.push('Sous-vêtements thermiques','Écharpe','Chaussures imperméables','Masque de ski','Gants de ski');
    suggestions.sante.push('Protège-lèvres SPF');
  }

  // Camping / chalet
  if (/chalet|camping|glamping|bivouac/i.test(ctx)) {
    suggestions.divers.push('Lampe de poche','Allume-feu','Couteau suisse','Gants de cuisine','Sac de couchage');
  }

  // Professionnel / salon / conférence
  if (/interschutz|salon|conf.rence|professionnel|business|hannov/i.test(ctx)) {
    suggestions.vetements.push('Costume / Tenue professionnelle','Chemises','Chaussures habillées','Cravate');
    suggestions.divers.push('Cartes de visite','Bloc-notes','Stylo','Sac à dos professionnel');
    suggestions.electronique.push('Ordinateur portable','Souris sans fil','Chargeur laptop');
  }

  // Sport / activités
  if (/sport|v.lo|bike|tennis|golf|surf|kayak/i.test(ctx)) {
    suggestions.plage.push('Tenue de sport','Chaussures de sport');
  }

  return suggestions;
}

async function chargerBagages() {
  const [participants, bagages, voyage, agenda] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/participants`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/bagages`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json())
  ]);
  participantsActuels = participants;
  voyageInfoActuel = { voyage, agenda };

  // Sélecteur de participants
  const selector = document.getElementById('bagages-participant-selector');
  if (participants.length === 0) {
    selector.innerHTML = `<p style="font-size:.82rem;color:var(--text-muted)">Ajoute d'abord les participants dans l'onglet 💰 Budget</p>`;
    document.getElementById('liste-bagages').innerHTML = '';
    return;
  }
  if (!participantBagageActuel || !participants.find(p => p.id === participantBagageActuel)) {
    participantBagageActuel = participants[0].id;
  }
  selector.innerHTML = participants.map(p => `
    <div class="avatar-chip ${p.id === participantBagageActuel ? 'active' : ''}" onclick="selectionnerParticipantBagage(${p.id})" style="${p.id === participantBagageActuel ? 'border-color:'+p.couleur+';background:'+p.couleur+'22' : ''}">
      <div class="avatar" style="background:${p.couleur}">${p.nom[0].toUpperCase()}</div>
      <span class="avatar-nom">${p.nom}</span>
    </div>
  `).join('');

  afficherBagages(bagages.filter(b => +b.participant_id === +participantBagageActuel));
}

function selectionnerParticipantBagage(id) {
  participantBagageActuel = id;
  chargerBagages();
}

function afficherBagages(items) {
  const container = document.getElementById('liste-bagages');
  const progress = document.getElementById('bagages-progress-bar');

  if (items.length === 0) {
    progress.style.display = 'none';
    container.innerHTML = `
      <div class="empty-tab">
        <div class="empty-tab-icon">🧳</div>
        <p>Clique sur <strong>✨ Suggestions intelligentes</strong> pour générer ta liste automatiquement, ou ajoute des articles manuellement</p>
      </div>`;
    return;
  }

  // Progression
  const total = items.length, coches = items.filter(i => i.checked).length;
  progress.style.display = 'block';
  document.getElementById('bagages-progress-text').textContent = `${coches} / ${total} articles`;
  document.getElementById('bagages-progress-fill').style.width = `${Math.round(coches/total*100)}%`;

  // Grouper par catégorie
  const grouped = {};
  CAT_ORDER.forEach(c => { grouped[c] = []; });
  items.forEach(i => { const c = i.categorie || 'divers'; (grouped[c] || grouped['divers']).push(i); });

  container.innerHTML = CAT_ORDER.filter(c => grouped[c].length > 0).map(cat => `
    <div class="bagage-section">
      <div class="bagage-cat-header">${CAT_LABELS[cat]} <span class="bagage-count">${grouped[cat].filter(i=>i.checked).length}/${grouped[cat].length}</span></div>
      ${grouped[cat].map(item => `
        <div class="bagage-item ${item.checked ? 'checked' : ''}" onclick="toggleBagage(${item.id}, ${!item.checked})">
          <div class="bagage-check ${item.checked ? 'checked' : ''}">
            ${item.checked ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>' : ''}
          </div>
          <span class="bagage-nom">${item.nom}</span>
          <button class="bagage-del" onclick="event.stopPropagation();supprimerArticle(${item.id})">×</button>
        </div>
      `).join('')}
    </div>
  `).join('');
}

async function toggleBagage(id, checked) {
  await fetch(`${API}/api/bagages/${id}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ checked })
  });
  chargerBagages();
}

async function supprimerArticle(id) {
  await fetch(`${API}/api/bagages/${id}`, { method: 'DELETE' });
  chargerBagages();
}

function ouvrirModalAjoutArticle() {
  document.getElementById('art-nom').value = '';
  document.getElementById('art-categorie').value = 'divers';
  document.getElementById('modal-article').classList.remove('hidden');
  setTimeout(() => document.getElementById('art-nom').focus(), 300);
}

async function ajouterArticle() {
  const nom = document.getElementById('art-nom').value.trim();
  if (!nom) { toast('⚠️ Entre un article'); return; }
  await fetch(`${API}/api/voyages/${voyageActuel}/bagages`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ participant_id: participantBagageActuel, nom, categorie: document.getElementById('art-categorie').value })
  });
  fermerModal('modal-article');
  toast('✅ Article ajouté');
  chargerBagages();
}

async function genererSuggestions() {
  if (!participantBagageActuel) { toast('⚠️ Sélectionne un participant'); return; }
  if (!voyageInfoActuel) return;

  const { voyage, agenda } = voyageInfoActuel;
  const suggestions = getSuggestionsContextuelles(voyage, agenda);

  // Récupérer météo via API open-meteo (gratuite, sans clé)
  let meteoInfo = '';
  try {
    const geoResp = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(voyage.destination)}&count=1&language=fr`);
    const geoData = await geoResp.json();
    if (geoData.results && geoData.results[0]) {
      const { latitude, longitude } = geoData.results[0];
      const dateDebut = voyage.date_debut || new Date().toISOString().split('T')[0];
      const meteoResp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&start_date=${dateDebut}&end_date=${dateDebut}`);
      const meteoData = await meteoResp.json();
      if (meteoData.daily) {
        const tmax = Math.round(meteoData.daily.temperature_2m_max[0]);
        const tmin = Math.round(meteoData.daily.temperature_2m_min[0]);
        const pluie = meteoData.daily.precipitation_sum[0];
        meteoInfo = `${tmin}°→${tmax}°C, ${pluie > 2 ? '🌧️ pluie prévue' : '☀️ beau temps'}`;

        // Ajustements selon météo
        if (tmax < 10) {
          suggestions.vetements.push('Doudoune','Bonnet','Gants','Chaussures imperméables');
          suggestions.vetements = suggestions.vetements.filter(i => !i.includes('Short') && !i.includes('Tongs') && !i.includes('Maillot'));
        } else if (tmax > 28) {
          suggestions.sante.push('Spray anti-chaleur','Eau thermale');
          if (!suggestions.plage.includes('Crème solaire SPF50')) suggestions.plage.push('Crème solaire SPF50','Chapeau');
        }
        if (pluie > 2) {
          suggestions.divers.push('Imperméable / K-Way','Parapluie compact');
          suggestions.vetements.push('Chaussures imperméables');
        }
      }
    }
  } catch(e) { /* météo non disponible, on continue sans */ }

  // Construire tous les articles
  const items = [];
  for (const [cat, noms] of Object.entries(suggestions)) {
    for (const nom of noms) { items.push({ nom, categorie: cat }); }
  }

  if (items.length === 0) return;

  toast(`⏳ Génération de ${items.length} suggestions...`);
  await fetch(`${API}/api/voyages/${voyageActuel}/bagages/bulk`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ participant_id: participantBagageActuel, items })
  });

  const msg = meteoInfo
    ? `✅ ${items.length} articles suggérés · Météo : ${meteoInfo}`
    : `✅ ${items.length} articles suggérés selon ta destination`;
  toast(msg, 4000);
  chargerBagages();
}

// ─── BUDGET ──────────────────────────────────────────

async function chargerBudget() {
  const [participants, depenses] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/participants`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/depenses`).then(r => r.json())
  ]);
  participantsActuels = participants;
  afficherParticipants(participants);
  afficherDepenses(depenses, participants);
  afficherBilan(depenses, participants);
}

function afficherParticipants(participants) {
  const container = document.getElementById('liste-participants');
  if (participants.length === 0) {
    container.innerHTML = `<p style="font-size:.82rem;color:var(--text-muted);padding:8px 0">Ajoute les personnes du voyage pour partager les dépenses</p>`;
    return;
  }
  container.innerHTML = `<div class="avatars-row">${participants.map(p => `
    <div class="avatar-chip">
      <div class="avatar" style="background:${p.couleur}">${p.nom[0].toUpperCase()}</div>
      <span class="avatar-nom">${p.nom}</span>
      <button class="avatar-del" onclick="supprimerParticipant(${p.id})" title="Supprimer">×</button>
    </div>
  `).join('')}</div>`;
}

function afficherDepenses(depenses, participants) {
  const container = document.getElementById('liste-depenses');
  const byId = {};
  participants.forEach(p => { byId[p.id] = p; });

  if (depenses.length === 0) {
    container.innerHTML = `<div class="empty-tab"><div class="empty-tab-icon">💸</div><p>Aucune dépense enregistrée</p></div>`;
    return;
  }

  const total = depenses.reduce((s, d) => s + parseFloat(d.montant || 0), 0);
  const icones = { hebergement:'🏠', transport:'✈️', restauration:'🍽️', activite:'🎯', courses:'🛒', autre:'📦' };

  container.innerHTML = `
    <div class="budget-total-bar">
      <span class="budget-total-label">Total dépenses</span>
      <span class="budget-total-amount">${total.toFixed(2)} €</span>
    </div>
    <div style="padding:0 16px 12px;display:flex;flex-direction:column;gap:8px">
      ${depenses.map(d => {
        const payeur = byId[d.payeur_id];
        const parts = JSON.parse(d.participants_ids || '[]');
        const share = parts.length > 0 ? (parseFloat(d.montant) / parts.length).toFixed(2) : '—';
        return `
        <div class="depense-card">
          <div class="depense-cat">${icones[d.categorie] || '📦'}</div>
          <div class="depense-body">
            <div class="depense-titre">${d.titre}</div>
            <div class="depense-meta">
              ${d.date ? `<span>${formatDate(d.date)}</span>` : ''}
              ${payeur ? `<span style="display:inline-flex;align-items:center;gap:4px"><span class="avatar-xs" style="background:${payeur.couleur}">${payeur.nom[0]}</span>${payeur.nom} a payé</span>` : ''}
              <span>${parts.length} pers. · ${share}€/pers.</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <span class="depense-montant">${parseFloat(d.montant).toFixed(2)}€</span>
            <div style="display:flex;gap:4px">
              <button class="btn-mini btn-mini-edit" onclick="modifierDepense(${d.id})">✏️</button>
              <button class="btn-mini btn-mini-del" onclick="supprimerDepense(${d.id})">🗑️</button>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

function afficherBilan(depenses, participants) {
  const section = document.getElementById('section-bilan');
  const container = document.getElementById('bilan-content');
  if (participants.length < 2 || depenses.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const byId = {};
  participants.forEach(p => { byId[p.id] = p; });

  // Calculer les soldes nets
  const net = {};
  participants.forEach(p => { net[p.id] = 0; });

  depenses.forEach(d => {
    const parts = JSON.parse(d.participants_ids || '[]');
    if (!parts.length) return;
    const share = parseFloat(d.montant) / parts.length;
    parts.forEach(pid => {
      if (+pid !== +d.payeur_id) {
        net[d.payeur_id] = (net[d.payeur_id] || 0) + share;
        net[pid] = (net[pid] || 0) - share;
      }
    });
  });

  // Simplifier les dettes
  const transactions = [];
  const debtors = participants.filter(p => net[p.id] < -0.01).map(p => ({ ...p, solde: net[p.id] })).sort((a,b) => a.solde - b.solde);
  const creditors = participants.filter(p => net[p.id] > 0.01).map(p => ({ ...p, solde: net[p.id] })).sort((a,b) => b.solde - a.solde);

  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const amount = Math.min(-net[d.id], net[c.id]);
    if (amount > 0.01) transactions.push({ from: d, to: c, amount: Math.round(amount * 100) / 100 });
    net[d.id] += amount;
    net[c.id] -= amount;
    if (Math.abs(net[d.id]) < 0.01) i++;
    if (Math.abs(net[c.id]) < 0.01) j++;
  }

  if (transactions.length === 0) {
    container.innerHTML = `<div class="bilan-ok">✅ Tout est équilibré !</div>`;
    return;
  }

  container.innerHTML = `<div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:8px">
    ${transactions.map(t => `
      <div class="bilan-transaction">
        <div class="bilan-from">
          <div class="avatar" style="background:${t.from.couleur}">${t.from.nom[0]}</div>
          <span>${t.from.nom}</span>
        </div>
        <div class="bilan-arrow">
          <span class="bilan-amount">${t.amount.toFixed(2)} €</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
        </div>
        <div class="bilan-to">
          <div class="avatar" style="background:${t.to.couleur}">${t.to.nom[0]}</div>
          <span>${t.to.nom}</span>
        </div>
      </div>
    `).join('')}
  </div>`;
}

function ouvrirModalParticipant() {
  document.getElementById('p-nom').value = '';
  document.getElementById('p-couleur').value = '#6366F1';
  document.querySelectorAll('#modal-participant .color-opt').forEach((el,i) => el.classList.toggle('active', i === 0));
  document.getElementById('modal-participant').classList.remove('hidden');
  setTimeout(() => document.getElementById('p-nom').focus(), 300);
}

function choisirCouleurParticipant(btn) {
  document.querySelectorAll('#modal-participant .color-opt').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('p-couleur').value = btn.dataset.color;
}

async function sauvegarderParticipant() {
  const nom = document.getElementById('p-nom').value.trim();
  if (!nom) { toast('⚠️ Entre un prénom'); return; }
  await fetch(`${API}/api/voyages/${voyageActuel}/participants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nom, couleur: document.getElementById('p-couleur').value })
  });
  fermerModal('modal-participant');
  toast('✅ Participant ajouté');
  chargerBudget();
}

async function supprimerParticipant(id) {
  if (!confirm('Supprimer ce participant ?')) return;
  await fetch(`${API}/api/participants/${id}`, { method: 'DELETE' });
  toast('🗑️ Participant supprimé');
  chargerBudget();
}

async function ouvrirModalDepense(id = null) {
  document.getElementById('modal-depense-titre').textContent = id ? 'Modifier la dépense' : 'Nouvelle dépense';
  document.getElementById('dep-id').value = id || '';
  document.getElementById('dep-date').value = new Date().toISOString().split('T')[0];

  const participants = participantsActuels;
  if (participants.length === 0) {
    toast('⚠️ Ajoute d\'abord les participants');
    return;
  }

  // Remplir les sélecteurs
  document.getElementById('dep-payeur-list').innerHTML = participants.map((p, i) => `
    <label class="participant-radio">
      <input type="radio" name="dep-payeur" value="${p.id}" ${i === 0 ? 'checked' : ''}>
      <div class="avatar" style="background:${p.couleur}">${p.nom[0].toUpperCase()}</div>
      <span>${p.nom}</span>
    </label>
  `).join('');

  document.getElementById('dep-participants-list').innerHTML = participants.map(p => `
    <label class="participant-check">
      <input type="checkbox" name="dep-part" value="${p.id}" checked>
      <div class="avatar" style="background:${p.couleur}">${p.nom[0].toUpperCase()}</div>
      <span>${p.nom}</span>
    </label>
  `).join('');

  if (!id) {
    document.getElementById('dep-titre').value = '';
    document.getElementById('dep-montant').value = '';
    document.getElementById('dep-categorie').value = 'autre';
  } else {
    const dep = await fetch(`${API}/api/voyages/${voyageActuel}/depenses`).then(r => r.json()).then(list => list.find(d => d.id === id));
    if (dep) {
      document.getElementById('dep-titre').value = dep.titre;
      document.getElementById('dep-montant').value = dep.montant;
      document.getElementById('dep-date').value = dep.date || '';
      document.getElementById('dep-categorie').value = dep.categorie || 'autre';
      const parts = JSON.parse(dep.participants_ids || '[]').map(Number);
      document.querySelectorAll('[name="dep-payeur"]').forEach(el => { el.checked = +el.value === +dep.payeur_id; });
      document.querySelectorAll('[name="dep-part"]').forEach(el => { el.checked = parts.includes(+el.value); });
    }
  }

  document.getElementById('modal-depense').classList.remove('hidden');
}

async function modifierDepense(id) { await ouvrirModalDepense(id); }

async function sauvegarderDepense() {
  const titre = document.getElementById('dep-titre').value.trim();
  const montant = parseFloat(document.getElementById('dep-montant').value);
  const payeurEl = document.querySelector('[name="dep-payeur"]:checked');
  if (!titre || isNaN(montant) || montant <= 0 || !payeurEl) { toast('⚠️ Remplis tous les champs obligatoires'); return; }

  const participants_ids = JSON.stringify(
    [...document.querySelectorAll('[name="dep-part"]:checked')].map(el => +el.value)
  );

  const data = {
    titre, montant,
    payeur_id: +payeurEl.value,
    participants_ids,
    date: document.getElementById('dep-date').value,
    categorie: document.getElementById('dep-categorie').value
  };

  const id = document.getElementById('dep-id').value;
  const url = id ? `${API}/api/depenses/${id}` : `${API}/api/voyages/${voyageActuel}/depenses`;
  const method = id ? 'PUT' : 'POST';
  await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

  fermerModal('modal-depense');
  toast(id ? '✅ Dépense modifiée' : '✅ Dépense ajoutée');
  chargerBudget();
}

async function supprimerDepense(id) {
  if (!confirm('Supprimer cette dépense ?')) return;
  await fetch(`${API}/api/depenses/${id}`, { method: 'DELETE' });
  toast('🗑️ Dépense supprimée');
  chargerBudget();
}

// ─── ADMIN ────────────────────────────────────────────

async function chargerAdmin() {
  const container = document.getElementById('admin-content');
  container.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-muted)">Chargement…</div>`;

  const [reservations, documents] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/documents`).then(r => r.json())
  ]);

  const resaIcons = { transport:'✈️', hebergement:'🏠', vehicule:'🚗', activite:'🎯', restaurant:'🍽️' };
  const catLabels = { transport:'Transport', hebergement:'Hébergement', activite:'Activité', identite:'Identité', visa:'Visa', assurance:'Assurance', autre:'Autre' };

  container.innerHTML = `
    <!-- ── En-tête stats ── -->
    <div class="adm-stats">
      <div class="adm-stat"><span class="adm-stat-n">${reservations.length}</span><span class="adm-stat-l">Réservations</span></div>
      <div class="adm-stat-sep"></div>
      <div class="adm-stat"><span class="adm-stat-n">${documents.length}</span><span class="adm-stat-l">Documents</span></div>
    </div>

    <!-- ── Section Réservations ── -->
    <div class="adm-section">
      <div class="adm-section-head">
        <span class="adm-section-title">🎫 Réservations</span>
        <button class="btn-mini-add" onclick="ouvrirModalReservation()">+ Ajouter</button>
      </div>

      ${reservations.length === 0 ? `<div class="adm-empty">Aucune réservation</div>` : `
      <div class="adm-table">
        ${reservations.map(r => `
        <div class="adm-row">
          <span class="adm-row-icon">${resaIcons[r.type] || '📌'}</span>
          <div class="adm-row-body">
            <div class="adm-row-titre">${r.titre}</div>
            <div class="adm-row-meta">
              ${r.date_debut ? `<span>📅 ${formatDate(r.date_debut)}</span>` : ''}
              ${r.confirmation ? `<span class="adm-row-ref">N° ${r.confirmation}</span>` : ''}
              ${r.adresse ? `<span>📍 ${r.adresse}</span>` : ''}
            </div>
          </div>
          <div class="adm-row-actions">
            ${r.lien ? `<a href="${r.lien}" target="_blank" rel="noopener" class="btn-mini adm-btn-link" title="Ouvrir le lien">🔗</a>` : ''}
            <button class="btn-mini btn-mini-edit" onclick="modifierReservation(${r.id})" title="Modifier">✏️</button>
            <button class="btn-mini btn-mini-del" onclick="supprimerReservation(${r.id})" title="Supprimer">🗑️</button>
          </div>
        </div>`).join('')}
      </div>`}
    </div>

    <!-- ── Section Documents ── -->
    <div class="adm-section">
      <div class="adm-section-head">
        <span class="adm-section-title">📁 Documents</span>
        <button class="btn-mini-add" onclick="ouvrirModalDocument()">+ Ajouter</button>
      </div>

      ${documents.length === 0 ? `<div class="adm-empty">Aucun document</div>` : `
      <div class="adm-table">
        ${documents.map(doc => {
          const icon = getDocIcon(doc.type_fichier);
          const cat = catLabels[doc.categorie] || doc.categorie || 'Autre';
          return `
          <div class="adm-row">
            <span class="adm-row-icon">${icon}</span>
            <div class="adm-row-body">
              <div class="adm-row-titre">${doc.nom}</div>
              <div class="adm-row-meta">
                <span class="adm-row-cat">${cat}</span>
                ${doc.taille ? `<span>${formatTaille(doc.taille)}</span>` : ''}
              </div>
            </div>
            <div class="adm-row-actions">
              <a href="${API}/api/documents/${doc.id}/download" target="_blank" class="btn-mini adm-btn-link" title="Télécharger">⬇️</a>
              <button class="btn-mini btn-mini-edit" onclick="modifierDocument(${doc.id})" title="Modifier">✏️</button>
              <button class="btn-mini btn-mini-del" onclick="supprimerDocument(${doc.id})" title="Supprimer">🗑️</button>
            </div>
          </div>`;
        }).join('')}
      </div>`}
    </div>

    <div style="height:24px"></div>
  `;
}

// ─── MODALS & BOTTOM SHEET ───────────────────────────

function fermerModal(id) {
  document.getElementById(id).classList.add('hidden');
}

async function partagerVoyage() {
  fermerBottomSheet();
  const resp = await fetch(`${API}/api/voyages/${voyageActuel}/partager`, { method: 'POST' });
  const data = await resp.json();
  document.getElementById('partage-url').textContent = data.url;
  document.getElementById('modal-partage').classList.remove('hidden');
}

function copierLienPartage() {
  const url = document.getElementById('partage-url').textContent;
  navigator.clipboard.writeText(url).then(() => {
    toast('✅ Lien copié ! Envoie-le par WhatsApp ou SMS');
  }).catch(() => {
    // Fallback pour les vieux navigateurs
    const el = document.createElement('textarea');
    el.value = url;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    toast('✅ Lien copié !');
  });
}

function fermerBottomSheet() {
  document.querySelectorAll('.bottom-sheet').forEach(s => s.classList.add('hidden'));
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
