// ═══════════════════════════════════════════════════════
//  MES VOYAGES — Application Frontend
// ═══════════════════════════════════════════════════════

const API = '';  // même origin

// ─── AUTH ────────────────────────────────────────────────────────────────────
let currentUser = null;
// try/catch : localStorage.getItem() lève une exception en navigation privée iOS
let _authToken = (() => { try { return localStorage.getItem('crewigo_token'); } catch { return null; } })();

// ── Fix C : IndexedDB — backup du token résistant à la purge iOS ──────────────
// iOS Safari peut vider localStorage si la PWA n'est pas ouverte depuis >7 jours.
// IndexedDB est plus persistant (origine distincte, moins purgé).
const _IDB_NAME = 'crewigo_auth_v1';
const _IDB_STORE = 'tokens';

function _openTokenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(_IDB_STORE, { keyPath: 'k' });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}
async function _saveTokenIDB(token) {
  try {
    const db = await _openTokenDB();
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    tx.objectStore(_IDB_STORE).put({ k: 'token', v: token });
  } catch {}
}
async function _readTokenIDB() {
  try {
    const db = await _openTokenDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(_IDB_STORE, 'readonly');
      const req = tx.objectStore(_IDB_STORE).get('token');
      req.onsuccess = () => resolve(req.result?.v || null);
      req.onerror   = () => resolve(null);
    });
  } catch { return null; }
}
async function _clearTokenIDB() {
  try {
    const db = await _openTokenDB();
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    tx.objectStore(_IDB_STORE).delete('token');
  } catch {}
}

// Décode le payload JWT côté client (sans vérification de signature)
// Utilisé comme fallback quand le serveur est injoignable
function _decodeJwtPayload(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    return JSON.parse(atob(b64));
  } catch { return null; }
}

// Cache utilisateur local — évite l'écran de login à chaque ouverture
const _USER_CACHE_KEY = 'crewigo_user';
function _cacheUser(user) {
  try { localStorage.setItem(_USER_CACHE_KEY, JSON.stringify(user)); } catch {}
}
function _getCachedUser() {
  try { return JSON.parse(localStorage.getItem(_USER_CACHE_KEY) || 'null'); } catch { return null; }
}

// Intercepteur global : injecte le token JWT sur tous les appels /api/
// Fix B : 401 gracieux — ne déconnecte PAS immédiatement sur un 401 secondaire.
// Valide d'abord le token sur /api/auth/me ; si confirmé invalide → logout.
// Évite les déconnexions sauvages sur cold-start Railway ou erreur transitoire.
let _401Pending = false;
(function installFetchInterceptor() {
  const _native = window.fetch.bind(window);
  window.fetch = function(url, opts = {}) {
    const u = typeof url === 'string' ? url : (url.url || '');
    if (_authToken && u.startsWith('/api/') && !u.startsWith('/api/auth/')) {
      opts = { ...opts, headers: { 'Authorization': `Bearer ${_authToken}`, ...(opts.headers || {}) } };
    }
    return _native(url, opts).then(r => {
      if (r.status === 401 && u.startsWith('/api/') && !u.startsWith('/api/auth/')) {
        _handle401Gracieux();
      }
      return r;
    });
  };
})();

// Fix B — vérification avant logout : évite les faux-positifs sur cold start
async function _handle401Gracieux() {
  if (_401Pending) return;     // déjà en cours de vérification
  _401Pending = true;
  try {
    // Re-vérifier le token directement sur /me
    const check = await window.fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${_authToken}` }
    });
    if (check.status === 401) {
      // Token véritablement invalide → logout propre
      _doLogout();
    } else {
      // 401 transitoire (cold start, race condition) → session maintenue
      // On renouvelle silencieusement au cas où
      _renewTokenSilently();
      _401Pending = false;
    }
  } catch {
    // Erreur réseau → ne pas déconnecter
    _401Pending = false;
  }
}

async function initAuth() {
  // Lire les paramètres ?auth=, ?email=, ?v= (deep-link interface unique)
  const params    = new URLSearchParams(window.location.search);
  const authParam = params.get('auth');
  const emailParam = params.get('email');
  // ?v=TOKEN : deep-link depuis /voyage/:token → ouvrir automatiquement ce voyage
  const voyageToken = params.get('v');
  // Persistance du token de retour : si un rechargement survient PENDANT le boot
  // (typiquement l'activation d'un nouveau Service Worker → controllerchange →
  // reload), l'URL ?v= est déjà nettoyée et le retour atterrirait sur l'accueil
  // (« le retour ne fonctionne pas »), voire sur un écran blanc mi-rechargement
  // en PWA standalone iOS. La copie sessionStorage survit au reload, est
  // reconsommée ci-dessous, puis effacée seulement une fois la vue voyage
  // réellement affichée (afficherVoyage / _openVoyageByToken).
  let _returnToken = voyageToken;
  if (_returnToken) {
    try { sessionStorage.setItem('crewigo_return_token', _returnToken); } catch {}
    // Empêcher le rechargement auto déclenché par une MAJ de SW PENDANT ce retour :
    // un reload mi-boot effacerait la cible et afficherait un écran blanc bloquant.
    window._suppressSwReload = true;
  } else {
    try { _returnToken = sessionStorage.getItem('crewigo_return_token') || null; } catch {}
  }
  if (_returnToken) window._pendingVoyageToken = _returnToken;

  if (authParam || emailParam) {
    const cleanUrl = window.location.pathname + window.location.hash;
    history.replaceState(null, '', cleanUrl);
  }

  // Fix C : si localStorage est vide (purge iOS), tenter la récupération depuis IndexedDB
  if (!_authToken) {
    const idbToken = await _readTokenIDB();
    if (idbToken) {
      _authToken = idbToken;
      try { localStorage.setItem('crewigo_token', _authToken); } catch {}
    }
  }

  // Aucun token → écran de connexion
  if (!_authToken) {
    // ── AP-2 : Redirect standalone participant PWA ──────────────────────────
    // Un participant (sans compte organisateur) qui a installé la PWA depuis /
    // ou depuis /app se retrouve sur l'écran de login alors qu'il a déjà rejoint
    // un voyage via un lien de partage. Si son identité de participant est
    // stockée (partage_id_TOKEN) et que l'app est en mode standalone, on le
    // redirige directement vers sa page participant plutôt que d'afficher le login.
    const _isStandalonePWA = window.matchMedia('(display-mode: standalone)').matches
                          || window.navigator.standalone === true;
    // IMPORTANT : ne PAS rediriger vers /share si un retour « MODE ORGANISATEUR »
    // est en cours (_returnToken / ?v=). Sinon, un organisateur dont le token a été
    // purgé par iOS rebondirait sans fin entre la page participant et /app sans
    // jamais pouvoir se reconnecter. Dans ce cas on affiche l'écran de connexion :
    // après reconnexion, _postAuthBoot() le ramène droit sur le voyage visé.
    if (_isStandalonePWA && !_returnToken) {
      try {
        // Prendre le token le plus récent (dernier accès)
        // partage_id_TOKEN → storé dans partage.html quand le participant rejoint
        let _bestToken = null;
        let _bestTs    = 0;
        for (let _i = 0; _i < localStorage.length; _i++) {
          const _k = localStorage.key(_i);
          if (_k && _k.startsWith('partage_id_')) {
            const _token = _k.slice('partage_id_'.length);
            if (!_token) continue;
            // Préférer le token avec le ts le plus élevé (accès_*) si disponible,
            // sinon prendre le premier trouvé
            const _ts = parseInt(localStorage.getItem('partage_ts_' + _token) || '0', 10);
            if (!_bestToken || _ts > _bestTs) { _bestToken = _token; _bestTs = _ts; }
          }
        }
        if (_bestToken) {
          window.location.replace('/share/' + _bestToken);
          return;
        }
      } catch {}
    }
    _showAuthScreen();
    if (authParam === 'register' || authParam === 'login') switchAuthForm(authParam);
    // Pré-remplir l'email d'inscription si redirigé depuis la landing (?auth=register&email=)
    if (emailParam && authParam === 'register') {
      const regEmailEl = document.getElementById('register-email');
      if (regEmailEl) {
        regEmailEl.value = emailParam;
        regEmailEl.dispatchEvent(new Event('input'));
        setTimeout(() => {
          const regPwdEl = document.getElementById('register-password');
          if (regPwdEl) regPwdEl.focus();
        }, 300);
      }
    }
    // Pré-remplir l'email si redirigé depuis une page de partage (magic link)
    else if (emailParam) {
      const loginEmailEl = document.getElementById('login-email');
      if (loginEmailEl) {
        loginEmailEl.value = emailParam;
        loginEmailEl.dispatchEvent(new Event('input'));
        // Petit toast discret pour contextualiser
        setTimeout(() => {
          const pwdEl = document.getElementById('login-password');
          if (pwdEl) pwdEl.focus();
        }, 300);
      }
    }
    return;
  }

  // ── Stratégie "offline-first" ──────────────────────────────────────────
  // 1. Si un user est en cache : afficher l'app immédiatement
  const cached = _getCachedUser();
  if (cached) {
    currentUser = cached;
    _hideAuthScreen();
    _updateHeaderUser();
    // Valider silencieusement en arrière-plan (sans bloquer l'UI)
    _validateTokenSilently();
    return;
  }

  // 2. Premier lancement avec token mais sans cache : vérifier le serveur
  try {
    const r = await fetch('/api/auth/me');
    if (r.status === 401) { _doLogout(); return; }   // token explicitement invalide
    if (!r.ok) {
      // Erreur serveur (503, cold start…) — utiliser le payload JWT comme fallback
      const decoded = _decodeJwtPayload(_authToken);
      if (decoded?.id) {
        currentUser = { id: decoded.id, email: decoded.email, nom: decoded.nom || decoded.email };
        _cacheUser(currentUser);
        _hideAuthScreen();
        _updateHeaderUser();
        chargerVoyages();
      } else {
        _showAuthScreen();
      }
      return;
    }
    currentUser = await r.json();
    _cacheUser(currentUser);
    _hideAuthScreen();
    _updateHeaderUser();
  } catch {
    // Pas de réseau — utiliser le payload JWT comme fallback
    const decoded = _decodeJwtPayload(_authToken);
    if (decoded?.id) {
      currentUser = { id: decoded.id, email: decoded.email, nom: decoded.nom || decoded.email };
      _cacheUser(currentUser);
      _hideAuthScreen();
      _updateHeaderUser();
      chargerVoyages();
    } else {
      _showAuthScreen();
    }
  }
}

// Vérifie le token en arrière-plan sans bloquer ni déconnecter sur erreur réseau
// Fix A : renouvelle également le token (sliding window 365j)
async function _validateTokenSilently() {
  try {
    const r = await fetch('/api/auth/me');
    if (r.status === 401) { _doLogout(); return; }   // token expiré ou révoqué
    if (!r.ok) return;                                // erreur serveur → ignorer
    const fresh = await r.json();
    currentUser = fresh;
    _cacheUser(fresh);
    _updateHeaderUser();
    // Renouveler le token silencieusement à chaque session active
    _renewTokenSilently();
  } catch {
    // Pas de réseau → session locale maintenue, aucune action
  }
}

// Fix A — émet un nouveau token (365j) sans déconnecter l'utilisateur
async function _renewTokenSilently() {
  try {
    const r = await fetch('/api/auth/refresh');
    if (!r.ok) return;
    const { token } = await r.json();
    if (!token) return;
    _authToken = token;
    try { localStorage.setItem('crewigo_token', token); } catch {}
    _saveTokenIDB(token);  // Fix C : double sauvegarde IDB
  } catch {}               // Pas de réseau → token actuel reste valide
}

function _showAuthScreen() {
  const s = document.getElementById('auth-screen');
  if (s) s.classList.add('active');
  document.getElementById('screen-home')?.classList.remove('active');
}

function _hideAuthScreen() {
  const s = document.getElementById('auth-screen');
  if (s) s.classList.remove('active');
  document.getElementById('screen-home')?.classList.add('active');
}

function _updateHeaderUser() {
  const nom = currentUser ? (currentUser.nom || currentUser.email || '') : '';
  const el = document.getElementById('header-user-nom');
  if (el) el.textContent = nom;
  const ini = document.getElementById('header-user-initial');
  if (ini) ini.textContent = (nom.trim()[0] || '?').toUpperCase();
}

function switchAuthForm(form) {
  document.getElementById('auth-login')?.classList.toggle('active', form === 'login');
  document.getElementById('auth-register')?.classList.toggle('active', form === 'register');
  document.getElementById('login-error').textContent = '';
  document.getElementById('register-error').textContent = '';
}

// Après une authentification réussie (login OU register), décider où atterrir.
// Si un retour « MODE ORGANISATEUR » est en attente (deep-link ?v= ou session de
// retour conservée), l'organisateur vient de re-saisir son mot de passe PENDANT
// ce retour (typiquement parce que iOS a purgé le token de la PWA). On le ramène
// alors DIRECTEMENT sur le voyage visé plutôt que sur l'accueil — sinon le retour
// « échouait » silencieusement sur l'écran d'accueil après reconnexion.
function _postAuthBoot() {
  let pending = window._pendingVoyageToken;
  if (!pending) { try { pending = sessionStorage.getItem('crewigo_return_token') || null; } catch {} }
  if (pending) {
    window._pendingVoyageToken = null;
    try { history.replaceState(null, '', '/app'); } catch {}
    _openVoyageByToken(pending);
    return;
  }
  chargerVoyages();
}

async function submitLogin() {
  const email    = document.getElementById('login-email')?.value?.trim();
  const password = document.getElementById('login-password')?.value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Email et mot de passe requis'; return; }
  btn.disabled = true; btn.textContent = 'Connexion…';
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await r.json();
    if (!r.ok) { errEl.textContent = data.error || 'Erreur de connexion'; return; }
    _authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('crewigo_token', _authToken);
    _saveTokenIDB(_authToken);   // Fix C : double sauvegarde IDB
    _cacheUser(currentUser);
    _hideAuthScreen();
    _updateHeaderUser();
    _postAuthBoot();
    if (data.newParticipations > 0) {
      const n = data.newParticipations;
      toast(`🎭 ${n} voyage${n > 1 ? 's' : ''} participé${n > 1 ? 's' : ''} retrouvé${n > 1 ? 's' : ''} !`, 4000);
    }
  } catch { errEl.textContent = 'Erreur réseau'; }
  finally { btn.disabled = false; btn.textContent = 'Se connecter'; }
}

async function submitRegister() {
  const nom      = document.getElementById('register-nom')?.value?.trim();
  const email    = document.getElementById('register-email')?.value?.trim();
  const password = document.getElementById('register-password')?.value;
  const errEl    = document.getElementById('register-error');
  const btn      = document.getElementById('register-btn');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Email et mot de passe requis'; return; }
  if (password.length < 8) { errEl.textContent = 'Mot de passe trop court (8 caractères minimum)'; return; }
  btn.disabled = true; btn.textContent = 'Création…';
  try {
    const r = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, nom })
    });
    const data = await r.json();
    if (!r.ok) { errEl.textContent = data.error || 'Erreur lors de la création'; return; }
    _authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('crewigo_token', _authToken);
    _saveTokenIDB(_authToken);   // Fix C : double sauvegarde IDB
    _cacheUser(currentUser);
    _hideAuthScreen();
    _updateHeaderUser();
    _postAuthBoot();
  } catch { errEl.textContent = 'Erreur réseau'; }
  finally { btn.disabled = false; btn.textContent = 'Créer mon compte'; }
}

function logout() {
  // confirm() est bloqué en mode PWA standalone iOS (retourne false immédiatement)
  // → déconnexion directe sans confirmation dialog
  _doLogout();
}

function _doLogout() {
  _authToken = null;
  currentUser = null;
  _401Pending = false;
  localStorage.removeItem('crewigo_token');
  localStorage.removeItem(_USER_CACHE_KEY);
  _clearTokenIDB();   // Fix C : purge IDB aussi
  _showAuthScreen();
}

// ─── SÉCURITÉ : échappement HTML ──────────────────────
// Utiliser h() pour toute donnée utilisateur injectée
// dans innerHTML via template literals.
function h(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// JSON.parse sécurisé — retourne [] en cas de valeur corrompue
function parseIds(str) {
  try { return JSON.parse(str || '[]'); } catch { return []; }
}

// ─── Système d'icônes CrewiGO ─────────────────────────────────
// Icônes SVG filled blancs sur fond dégradé orange
const _CGO_PATHS = {
  link:     '<path fill="white" d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7C4.24 7 2 9.24 2 12s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zm4.1 1h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>',
  trash:    '<path fill="white" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
  send:     '<path fill="white" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>',
  map:      '<path fill="white" d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/>',
  wallet:   '<path fill="white" d="M21 18v1c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V5c0-1.1.89-2 2-2h14c1.1 0 2 .9 2 2v1h-9c-1.11 0-2 .9-2 2v8c0 1.1.89 2 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>',
  luggage:  '<path fill="white" d="M9.5 4h5c.28 0 .5.22.5.5V6h2V4.5C17 3.12 15.88 2 14.5 2h-5C8.12 2 7 3.12 7 4.5V6h2V4.5c0-.28.22-.5.5-.5zM20 6H4C2.9 6 2 6.9 2 8v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-2 11H6V8h12v9z"/>',
  car:      '<path fill="white" d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/>',
  document: '<path fill="white" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>',
  home:     '<path fill="white" d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>',
  activity: '<path fill="white" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>',
  food:     '<path fill="white" d="M18.06 22.99h1.66c.84 0 1.53-.64 1.63-1.46L23 5.05h-5V1h-1.97v4.05h-4.97l.3 2.34c1.71.47 3.31 1.32 4.27 2.26 1.44 1.42 2.43 2.89 2.43 5.29v8.05zM1 21.99V21h15.03v.99c0 .55-.45 1-1.01 1H2.01c-.56 0-1.01-.45-1.01-1zm15.03-7c0-8-15.03-8-15.03 0h15.03zM1.02 17h15v2H1z"/>',
  edit:     '<path fill="white" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
  settings: '<path fill="white" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>',
  archive:  '<path fill="white" d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/>',
};

function cgoIcon(name, size = 40) {
  const path = _CGO_PATHS[name] || _CGO_PATHS.activity;
  const r = Math.round(size * 0.28);
  return `<span class="cgo-icon" style="width:${size}px;height:${size}px;border-radius:${r}px"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${path}</svg></span>`;
}

let voyageActuel = null;
let _shareTokenCourant = null; // token de partage du voyage ouvert
let _adminSousOnglet = 'reservations';
let _chatPollAdmin = null;
let _budgetPollAdmin = null;
let filtreActuel = 'tous';
let participantsActuels = [];
let participantBagageActuel = null;
let voyageInfoActuel = null;

// ─── INIT ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // ── GARDE PAGE : app.js est aussi chargé par partage.html (page participant)
  // pour ses fonctions utilitaires partagées. Mais le BOOT organisateur ci-dessous
  // (initAuth → afficherVoyage/chargerVoyages) manipule #screen-home / #screen-voyage
  // qui N'EXISTENT PAS sur partage.html → crash null `classList` → page cassée/blanche.
  // On ne lance le boot organisateur QUE sur le shell organisateur (présence de
  // #screen-home). L'enregistrement du Service Worker, lui, reste actif partout.
  const _isOrgShell = !!document.getElementById('screen-home');
  if (_isOrgShell) initAuth().then(() => {
    if (!currentUser) return; // non connecté → écran de login déjà géré par initAuth
    // RETOUR VUE ORGANISATEUR (?v=token) : on ouvre le voyage de façon INDÉPENDANTE
    // du rendu de l'accueil. Auparavant le deep-link était traité À LA FIN de
    // chargerVoyages() : si le rendu de l'accueil échouait (une carte voyage qui
    // plante), le retour ne se faisait jamais et on restait sur un accueil blanc.
    // Désormais la résolution token→id se fait côté serveur, puis afficherVoyage().
    if (window._pendingVoyageToken) {
      const dvt = window._pendingVoyageToken;
      window._pendingVoyageToken = null;
      try { history.replaceState(null, '', '/app'); } catch {}
      _openVoyageByToken(dvt);
    } else {
      chargerVoyages();
    }
  });
  if ('serviceWorker' in navigator) {
    const _swActivateWaiting = (sw) => sw.postMessage({ type: 'SKIP_WAITING' });

    // Capture AVANT register() : si controller est null, c'est un premier chargement.
    // clients.claim() dans le SW déclenche controllerchange même au premier chargement
    // → sans cette garde, la bannière "Mise à jour" et le rechargement se déclenchent
    //   inutilement à la toute première visite sur un nouvel appareil.
    let _swWasAlreadyControlled = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then(reg => {
        reg.update();
        // Si un SW en attente existe déjà au moment de l'enregistrement → l'activer
        if (reg.waiting) _swActivateWaiting(reg.waiting);
        // Observer les nouvelles installations de SW
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              // Nouveau SW prêt → activer immédiatement
              _swActivateWaiting(sw);
            }
          });
        });
      })
      .catch(console.error);

    // Quand le nouveau SW prend le contrôle → mise à jour disponible
    // Problème iOS standalone : window.location.href est parfois ignoré après controllerchange,
    // et _swReloading en mémoire est perdu après le rechargement → boucle infinie possible.
    // Fix : stocker le flag dans sessionStorage (persiste au rechargement de page).
    let _swReloading = false;
    try {
      if (sessionStorage.getItem('sw_reloading')) {
        // On vient d'être rechargé suite à une MAJ SW — supprimer le flag
        sessionStorage.removeItem('sw_reloading');
        _swReloading = true; // empêche un 2e rechargement si controllerchange se redéclenche
      }
    } catch {}

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Ignorer le controllerchange dû à clients.claim() au premier chargement
      // (controller était null avant register → ce n'est pas une mise à jour)
      if (!_swWasAlreadyControlled) { _swWasAlreadyControlled = true; return; }
      if (_swReloading) return;
      // Retour deep-link en cours (?v=token → vue organisateur) : NE PAS recharger.
      // Un reload mi-boot efface la cible (?v= déjà nettoyé de l'URL) et provoque un
      // écran blanc bloquant en PWA standalone iOS. Le nouveau SW contrôle déjà la
      // page et tous les assets sont servis network-first → aucune perte de fraîcheur.
      // La MAJ du shell pré-caché s'appliquera proprement au prochain lancement.
      let _returnInProgress = false;
      try { _returnInProgress = !!sessionStorage.getItem('crewigo_return_token'); } catch {}
      if (window._suppressSwReload || _returnInProgress || window._pendingVoyageToken) return;
      _swReloading = true;
      try { sessionStorage.setItem('sw_reloading', '1'); } catch {}

      // Bannière persistante (fonctionne même si la navigation auto est bloquée)
      const banner = document.createElement('div');
      banner.id = 'sw-update-banner';
      Object.assign(banner.style, {
        position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '99999',
        background: '#1a73e8', color: '#fff', display: 'flex',
        alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', fontSize: '14px',
        boxShadow: '0 -2px 8px rgba(0,0,0,.25)', fontFamily: 'inherit'
      });
      banner.innerHTML = `
        <span>🔄 Mise à jour disponible</span>
        <button id="sw-update-btn"
          style="background:#fff;color:#1a73e8;border:none;border-radius:6px;
                 padding:7px 16px;font-weight:700;cursor:pointer;font-size:13px">
          Recharger
        </button>`;
      document.body.appendChild(banner);
      // Rechargement UNIQUEMENT à l'initiative de l'utilisateur. On ne recharge
      // JAMAIS automatiquement : un reload forcé mi-utilisation provoquait un écran
      // blanc bloquant en PWA standalone iOS (et faisait perdre la vue voyage en
      // cours). Le nouveau SW contrôle déjà la page ; les assets sont network-first.
      // Si l'utilisateur recharge via la bannière, crewigo_return_token (conservé)
      // rouvre le voyage en cours plutôt que l'accueil.
      document.getElementById('sw-update-btn').addEventListener('click', () => {
        window.location.reload();
      });
    });
  }

  // ── PWA Install (in-app, post-auth) ──────────────────────────────────
  (function initPWAInstallApp() {
    const STORAGE_KEY  = 'crewigo_pwa_dismissed';
    const DISMISS_DAYS = 30;
    const btnApp       = document.getElementById('pwa-install-btn-app');
    if (!btnApp) return;

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                      || window.navigator.standalone === true;
    if (isStandalone) return; // déjà installée

    let deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault();
      deferredPrompt = e;
      const ts = localStorage.getItem(STORAGE_KEY);
      const dismissed = ts && (Date.now() - parseInt(ts, 10) < DISMISS_DAYS * 86400000);
      if (!dismissed) btnApp.style.display = 'inline-flex';
    });

    window.addEventListener('appinstalled', function() {
      btnApp.style.display = 'none';
    });

    btnApp.addEventListener('click', async function() {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const result = await deferredPrompt.userChoice;
      if (result.outcome === 'dismissed') {
        localStorage.setItem(STORAGE_KEY, Date.now().toString());
      }
      deferredPrompt = null;
      btnApp.style.display = 'none';
    });
  })();
  // ─────────────────────────────────────────────────────────────────────

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

// ─── BARRE MODE PARTICIPANT ─────────────────────────────────────────────────
// Met à jour la barre orange affichée dans la vue admin quand l'organisateur
// a déjà rejoint le voyage en tant que participant (session stockée en localStorage).
function _updateParticipantModeBar() {
  const bar     = document.getElementById('mode-participant-bar');
  const btn     = document.getElementById('mpb-switch-btn');
  const quitBtn = document.getElementById('mpb-quit-btn');
  const nom     = document.getElementById('mpb-nom');
  const av      = document.getElementById('mpb-avatar');
  if (!bar) return;

  if (!_shareTokenCourant) { bar.classList.add('hidden'); return; }

  let session = null;
  try { session = JSON.parse(localStorage.getItem('partage_id_' + _shareTokenCourant) || 'null'); } catch {}

  if (session?.nom) {
    if (nom) nom.textContent = session.nom;
    if (av) {
      av.textContent = session.nom[0].toUpperCase();
      av.style.background = session.couleur || 'var(--accent)';
    }
    if (btn) btn.onclick = () => { window.location.href = `/partage/${_shareTokenCourant}`; };
    // P6 — Bouton "Quitter" : efface la session participant pour ce voyage
    if (quitBtn) {
      quitBtn.onclick = () => {
        if (_shareTokenCourant) {
          localStorage.removeItem('partage_id_' + _shareTokenCourant);
        }
        _updateParticipantModeBar();
      };
    }
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

function afficherAccueil() {
  // Retour volontaire à l'accueil → on oublie la cible de retour persistée, sinon
  // un rechargement ultérieur rouvrirait le dernier voyage au lieu de l'accueil.
  try { sessionStorage.removeItem('crewigo_return_token'); } catch {}
  window._suppressSwReload = false;
  const _sv = document.getElementById('screen-voyage');
  const _sh = document.getElementById('screen-home');
  if (!_sh) return; // pas le shell organisateur (ex: partage.html) → ne rien faire
  _sv?.classList.remove('active');
  _sh.classList.add('active');
  voyageActuel = null;
  chargerVoyages();
}

async function afficherVoyage(id) {
  voyageActuel = id;
  try {
    const r = await fetch(`${API}/api/voyages/${id}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const voyage = await r.json();
    // Réponse invalide (erreur API, payload vide) → ne PAS basculer d'écran :
    // on évite un en-tête sans contenu (« bandeau + écran blanc »).
    if (!voyage || !voyage.id) throw new Error('voyage invalide');
    // Garde : si on n'est pas sur le shell organisateur (partage.html n'a pas ces
    // écrans), ne pas tenter de basculer de vue → éviterait un crash null classList.
    if (!document.getElementById('screen-home') || !document.getElementById('screen-voyage'))
      throw new Error('shell organisateur absent');

    _shareTokenCourant = voyage.share_token || null;
    // Mettre en cache les métadonnées pour la page offline
    try { localStorage.setItem(`voyage_cache_${id}`, JSON.stringify({ id: voyage.id, nom: voyage.nom, destination: voyage.destination || '' })); } catch {}
    document.getElementById('screen-home').classList.remove('active');
    document.getElementById('screen-voyage').classList.add('active');
    document.getElementById('voyage-nom').textContent = voyage.nom;
    document.getElementById('voyage-dates').textContent = formatDates(voyage.date_debut, voyage.date_fin);

    const header = document.getElementById('voyage-header');
    header.style.borderBottom = `3px solid ${voyage.couleur}`;

    // Le retour vers la vue participant n'encombre plus le header : il reste
    // accessible via l'onglet Hub et le menu « ⋯ » (Rejoindre le voyage).
    // Nettoyage défensif d'un éventuel chip laissé par une version cache.
    const _existingChip = document.getElementById('role-switch-chip');
    if (_existingChip) _existingChip.remove();

    // Mettre à jour la barre de mode participant (session admin active ?)
    _updateParticipantModeBar();

    // Reset onglet actif
    changerOnglet('accueil', document.querySelector('[data-tab="accueil"]'));

    // Activer les notifications push pour l'admin
    _initPushAdmin(id);
    // NB : on NE vide PAS ici crewigo_return_token. Il est conservé pour toute la
    // session afin qu'un éventuel rechargement (tap sur la bannière de MAJ, refresh
    // iOS…) rouvre CE voyage plutôt que l'accueil. Il n'est effacé qu'au retour
    // explicite vers l'accueil (afficherAccueil).
    window.__vErr = null;
    return true;
  } catch (e) {
    // Échec (réseau, 401/500, payload invalide) → ne JAMAIS laisser un écran
    // blanc : on revient sur l'accueil organisateur ET on le RE-RENDONS
    // (afficherAccueil → chargerVoyages) pour éviter un accueil vide sous le bandeau.
    window.__vErr = (e && e.message) || String(e);
    console.warn('afficherVoyage : échec, retour à l\'accueil', id, e);
    afficherAccueil();
    return false;
  }
}

function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - b64.length % 4) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function _initPushAdmin(voyageId) {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission === 'denied') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Demander l'autorisation via une modale explicative si c'est la première fois
      if (Notification.permission === 'default') {
        const notifKey = `push_prompted_${voyageId}`;
        if (!localStorage.getItem(notifKey)) {
          localStorage.setItem(notifKey, '1');
          const ok = await _confirmModal({
            title: '🔔 Activer les rappels ?',
            message: 'Reçois une notification la veille du départ et dès qu\'un nouveau participant rejoint ton voyage.',
            confirmLabel: 'Activer',
            danger: false
          });
          if (!ok) return;
        }
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      const { publicKey } = await fetch(`${API}/api/push/vapid-key`).then(r => r.json());
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      toast('🔔 Rappels activés');
    }
    await fetch(`${API}/api/push/subscribe/${voyageId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub)
    });
  } catch(e) { console.error('Push init:', e); }
}

function changerOnglet(tab, btn) {
  // Fermer la lightbox photos si elle est ouverte (z-index 9100 bloquerait les modals)
  const _lb = document.getElementById('adm-photo-lightbox');
  if (_lb && _lb.style.display === 'flex') fermerLightboxAdmin();

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');

  if (tab === 'accueil') (window.chargerAccueil || chargerAccueil)();
  if (tab === 'preparation') (window.chargerPreparationAdmin || chargerPreparationAdmin)();
  if (tab === 'programme') (window.chargerProgramme || chargerProgramme)();
  if (tab === 'budget') {
    const _fnBudget = window.chargerBudget || chargerBudget;
    _fnBudget();
    clearInterval(_budgetPollAdmin);
    _budgetPollAdmin = setInterval(_fnBudget, 20000);
  } else {
    clearInterval(_budgetPollAdmin);
    _budgetPollAdmin = null;
  }
  if (tab === 'admin') (window.chargerAdmin || chargerAdmin)();
  if (tab === 'crewipics') chargerPhotosAdmin();
  if (tab === 'discussion') {
    const _fnChat = window.chargerCommentairesAdmin || chargerCommentairesAdmin;
    _fnChat();
    clearInterval(_chatPollAdmin);
    _chatPollAdmin = setInterval(_fnChat, 5000);
    // FAB scroll tracking
    const mainEl = document.querySelector('#screen-voyage .main-content');
    if (mainEl && !mainEl._chatAdminScrollBound) {
      mainEl._chatAdminScrollBound = true;
      mainEl.addEventListener('scroll', () => {
        if (_chatPollAdmin) _updateScrollFabAdmin();
      }, { passive: true });
    }
  } else {
    clearInterval(_chatPollAdmin);
    _chatPollAdmin = null;
  }
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

/** Applique la photo comme texture sombre, cohérente avec le brand */
function _appliquerPhoto(voyageId, photoUrl) {
  const card = document.querySelector(`.voyage-card[data-id="${voyageId}"]`);
  if (!card) return;
  const img = card.querySelector('.voyage-card-banner-img');
  if (!img) return;
  const tmp = new Image();
  tmp.onload = () => {
    img.src = photoUrl;
    img.style.opacity = '0.55';
    img.style.filter  = 'saturate(0.65) brightness(0.72)';
    img.style.transition = 'opacity 0.5s ease';
  };
  tmp.src = photoUrl;
}

// ─── ONBOARDING ──────────────────────────────────────────────────────────────
const _OB_KEY = 'crewigo_onboarding_done';

/** Affiche l'onboarding si l'utilisateur ne l'a pas encore vu. */
function _maybeShowOnboarding() {
  try { if (localStorage.getItem(_OB_KEY)) return; } catch {}
  // Ne JAMAIS afficher l'onboarding par-dessus l'écran de connexion (z-index
  // supérieur → superposition « connexion + Lance ton trip ») ni pendant un
  // retour « MODE ORGANISATEUR » : l'utilisateur revient sur un voyage existant,
  // pas sur un premier lancement.
  if (document.getElementById('auth-screen')?.classList.contains('active')) return;
  if (window._pendingVoyageToken) return;
  try { if (sessionStorage.getItem('crewigo_return_token')) return; } catch {}
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;

  let _obSlide = 0;
  const slides = overlay.querySelectorAll('.onboarding-slide');
  const dots   = overlay.querySelectorAll('.onboarding-dot');
  const cta    = document.getElementById('onboarding-cta');
  const skip   = document.getElementById('onboarding-skip');
  const TOTAL  = slides.length || 3;

  // Garde-fou anti-écran-blanc : si le markup d'onboarding est absent/cassé
  // (aucun slide), on NE montre PAS l'overlay opaque plein écran (sinon =
  // écran blanc bloquant). On marque l'onboarding comme vu et on laisse
  // l'empty-state « Créer un trip » visible dessous.
  if (slides.length === 0) {
    try { localStorage.setItem(_OB_KEY, '1'); } catch {}
    return;
  }

  // Activer le premier slide
  slides[0].classList.add('active');

  function _goTo(n, dir = 1) {
    // Sortie du slide courant
    slides[_obSlide]?.classList.remove('active');
    slides[_obSlide]?.classList.add(dir >= 0 ? 'exit-left' : '');
    dots[_obSlide]?.classList.remove('active');

    _obSlide = n;

    // Entrée du nouveau slide (reset state d'abord)
    const next = slides[_obSlide];
    if (next) {
      next.style.transform   = dir >= 0 ? 'translateX(40px)' : 'translateX(-40px)';
      next.style.opacity     = '0';
      next.classList.remove('exit-left');
      next.classList.add('active');
      // Forcer reflow, puis laisser la transition CSS s'exécuter
      void next.offsetWidth;
      next.style.transform = '';
      next.style.opacity   = '';
    }
    dots[_obSlide]?.classList.add('active');

    // Libérer les exits
    slides.forEach(s => { if (!s.classList.contains('active')) s.classList.remove('exit-left'); });

    // Mettre à jour le bouton CTA (i18n si disponible)
    const _tFn = window.t || (k => k);
    if (cta) cta.textContent = _obSlide === TOTAL - 1 ? _tFn('ob.start') : _tFn('ob.next');
  }

  function _close() {
    try { localStorage.setItem(_OB_KEY, '1'); } catch {}
    overlay.classList.add('fading');
    setTimeout(() => { overlay.classList.add('hidden'); overlay.classList.remove('fading'); }, 350);
    // Focus sur le bouton "Créer" de l'empty state
    setTimeout(() => { document.getElementById('empty-create-btn')?.focus(); }, 400);
  }

  // CTA
  cta?.addEventListener('click', () => {
    if (_obSlide < TOTAL - 1) _goTo(_obSlide + 1);
    else _close();
  });

  // Skip
  skip?.addEventListener('click', _close);

  // Dots navigation
  dots.forEach((dot, i) => {
    dot.addEventListener('click', () => { if (i !== _obSlide) _goTo(i, i > _obSlide ? 1 : -1); });
  });

  // Swipe support (touch + pointeur)
  let _swipeStartX = null;
  overlay.addEventListener('pointerdown', e => { _swipeStartX = e.clientX; }, { passive: true });
  overlay.addEventListener('pointerup', e => {
    if (_swipeStartX === null) return;
    const dx = e.clientX - _swipeStartX;
    _swipeStartX = null;
    if (Math.abs(dx) < 50) return;
    if (dx < 0 && _obSlide < TOTAL - 1) _goTo(_obSlide + 1, 1);
    else if (dx > 0 && _obSlide > 0)    _goTo(_obSlide - 1, -1);
  }, { passive: true });

  // Keyboard navigation
  overlay.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { if (_obSlide < TOTAL - 1) _goTo(_obSlide + 1); }
    if (e.key === 'ArrowLeft')  { if (_obSlide > 0)         _goTo(_obSlide - 1, -1); }
    if (e.key === 'Escape')     _close();
  });

  // Re-apply translations when language changes
  window.addEventListener('langchange', () => {
    if (window.i18n) window.i18n.apply(overlay);
    const _tFn = window.t || (k => k);
    if (cta) cta.textContent = _obSlide === TOTAL - 1 ? _tFn('ob.start') : _tFn('ob.next');
  }, { once: false });

  // Afficher l'overlay — UNIQUEMENT si un slide est bien actif (anti-écran-blanc)
  if (!overlay.querySelector('.onboarding-slide.active')) {
    try { localStorage.setItem(_OB_KEY, '1'); } catch {}
    return;
  }
  overlay.classList.remove('hidden');
  overlay.setAttribute('tabindex', '-1');
  overlay.focus();
}

// Participations liées au compte admin (chargées en parallèle avec les voyages admin)
let _myParticipations = [];
// Vrai quand le dashboard mélange voyages organisés + participations → on affiche
// alors le chip de rôle « Organisateur » pour lever l'ambiguïté (F2)
let _dashboardMixed = false;

// Rendu d'une carte voyage TOLÉRANT aux pannes : si une carte plante (champ
// manquant, date corrompue…), on l'ignore au lieu de faire échouer le .map()
// entier — ce qui laissait auparavant l'accueil blanc sous le bandeau.
function _safeRenderVoyageCard(v, section) {
  try {
    return _renderVoyageCard(v, section, v._partOpts);
  } catch (e) {
    console.warn('Carte voyage ignorée (rendu impossible)', v?.id, e);
    return '';
  }
}

let _lastHomeStatus = 0;
async function chargerVoyages() {
  // Charger admin voyages + participations en parallèle
  const [data, participations] = await Promise.all([
    fetch(`${API}/api/voyages/home-summary`).then(r => { _lastHomeStatus = r.status; return r.ok ? r.json() : []; }).catch(() => { _lastHomeStatus = -1; return []; }),
    fetch(`${API}/api/auth/my-participations`).then(r => r.ok ? r.json() : []).catch(() => [])
  ]);
  const voyages = Array.isArray(data) ? data : [];
  _myParticipations = Array.isArray(participations) ? participations : [];

  // Mettre à jour le cache offline : supprimer les voyages qui n'existent plus
  try {
    const currentIds = new Set(voyages.map(v => String(v.id)));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('voyage_cache_')) {
        const id = key.replace('voyage_cache_', '');
        if (!currentIds.has(id)) localStorage.removeItem(key);
      }
    }
  } catch {}

  const container = document.getElementById('voyages-container');
  const empty = document.getElementById('empty-state');

  const joinBar = document.getElementById('join-voyage-bar');

  // Filtrer les participations qui ne sont pas déjà dans les voyages admin
  const adminIds   = new Set(voyages.map(v => v.id));
  const partUniques = _myParticipations.filter(p => !adminIds.has(p.id));
  // Dashboard « mixte » : au moins un voyage organisé ET au moins une participation
  _dashboardMixed = voyages.length > 0 && partUniques.length > 0;

  if (voyages.length === 0 && partUniques.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    if (joinBar) joinBar.classList.add('hidden');
    // Onboarding « Lance ton trip en 30 s » : réservé à un VRAI premier lancement.
    // Un organisateur qui REVIENT d'une vue participant (deep-link ?v= → token de
    // retour persisté) n'est pas un nouvel utilisateur : ne pas lui superposer
    // l'intro sur un accueil (momentanément) vide. Idem si l'accueil est vide à
    // cause d'une réponse réseau ratée (is-owner / home-summary) plutôt qu'un
    // compte réellement neuf.
    let _isReturnFlow = false;
    try { _isReturnFlow = !!sessionStorage.getItem('crewigo_return_token'); } catch {}
    if (!_isReturnFlow && !window._pendingVoyageToken) _maybeShowOnboarding();
    return;
  }
  empty.classList.add('hidden');
  if (joinBar) joinBar.classList.remove('hidden');

  // ── Grouper admin voyages par statut ───────────────────────────
  const MEMORY_STATUTS = new Set(['terminé', 'completed', 'archived']);
  const ongoing = [], upcoming = [], memories = [];
  // Classement défensif : une date corrompue ne doit jamais faire planter le rendu
  // complet de l'accueil (→ accueil blanc). En cas d'erreur, on range en souvenirs.
  const _classe = (debut, fin) => { try { return getStatut(debut, fin).classe; } catch { return 'memories'; } };
  for (const v of voyages) {
    if (MEMORY_STATUTS.has(v.statut)) {
      memories.push({ ...v, _role: 'admin' });
    } else {
      const c = _classe(v.date_debut, v.date_fin);
      if (c === 'ongoing')       ongoing.push({ ...v, _role: 'admin' });
      else if (c === 'upcoming') upcoming.push({ ...v, _role: 'admin' });
      else                       memories.push({ ...v, _role: 'admin' });
    }
  }

  // ── Intégrer les participations dans les bonnes sections ───────
  for (const p of partUniques) {
    const opts = { role: 'participant', participantNom: p.participant_nom, shareToken: p.share_token };
    if (MEMORY_STATUTS.has(p.statut)) {
      memories.push({ ...p, _role: 'participant', _partOpts: opts });
    } else {
      const c = _classe(p.date_debut, p.date_fin);
      if (c === 'ongoing')       ongoing.push({ ...p, _role: 'participant', _partOpts: opts });
      else if (c === 'upcoming') upcoming.push({ ...p, _role: 'participant', _partOpts: opts });
      else                       memories.push({ ...p, _role: 'participant', _partOpts: opts });
    }
  }

  // ── Stats banner ───────────────────────────────────────────────
  const statsEl = document.getElementById('home-stats');
  if (statsEl) {
    // Bandeau allégé : 2 pilules max (total + en cours) pour réduire le bruit visuel
    const pills = [];
    pills.push(`<span class="stat-pill stat-pill--total"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>${voyages.length} voyage${voyages.length > 1 ? 's' : ''}</span>`);
    if (ongoing.length > 0) pills.push(`<span class="stat-pill stat-pill--ongoing"><svg viewBox="0 0 24 24" fill="currentColor" width="8" height="8"><circle cx="12" cy="12" r="6"/></svg>${ongoing.length} en cours</span>`);
    statsEl.innerHTML = pills.slice(0, 2).join('');
  }

  // ── Rendu 3 sections ──────────────────────────────────────────
  let html = '';

  if (ongoing.length > 0) {
    html += `<section class="home-section home-section--ongoing">
      <div class="home-section-hd">
        <span class="home-section-bar"></span>
        <span class="home-section-title">🔥 En cours</span>
        <span class="home-section-count">${ongoing.length}</span>
      </div>
      <div class="voyage-grid voyage-grid--ongoing">
        ${ongoing.map(v => _safeRenderVoyageCard(v, 'ongoing')).join('')}
      </div>
    </section>`;
  }

  if (upcoming.length > 0) {
    html += `<section class="home-section home-section--upcoming">
      <div class="home-section-hd">
        <span class="home-section-bar"></span>
        <span class="home-section-title">✈️ À venir</span>
        <span class="home-section-count">${upcoming.length}</span>
      </div>
      <div class="voyage-grid voyage-grid--upcoming">
        ${upcoming.map(v => _safeRenderVoyageCard(v, 'upcoming')).join('')}
      </div>
    </section>`;
  }

  if (memories.length > 0) {
    html += `<section class="home-section home-section--memories">
      <div class="home-section-hd">
        <span class="home-section-bar"></span>
        <span class="home-section-title">🏆 Souvenirs</span>
        <span class="home-section-count">${memories.length}</span>
      </div>
      <div class="voyage-grid voyage-grid--memories">
        ${memories.map(v => _safeRenderVoyageCard(v, 'memories')).join('')}
      </div>
    </section>`;
  }

  container.innerHTML = html;

  // ── Photos Wikipedia pour ongoing + upcoming ───────────────────
  enrichirPhotos([...ongoing, ...upcoming].filter(v => v._role !== 'participant'));
  // ── Top photos internes pour les souvenirs ─────────────────────
  _enrichirPhotosSouvenirs(memories.filter(v => v._role !== 'participant'));
  // NB : le deep-link de retour (?v=token) est désormais traité dans le
  // DOMContentLoaded, INDÉPENDAMMENT de ce rendu, pour qu'une erreur d'affichage
  // de l'accueil ne puisse jamais bloquer le retour en vue organisateur.
}

// Résout un share_token en id de voyage côté serveur puis ouvre la vue
// organisateur. Indépendant de la liste d'accueil → fiable même si le résumé
// ne contient pas (encore) le voyage. Silencieux si l'utilisateur n'est pas
// propriétaire ou en cas d'erreur (on reste sur l'accueil).
async function _openVoyageByToken(token) {
  if (!token) { chargerVoyages(); return; }

  // iOS PWA — au retour depuis la page participant, la 1ʳᵉ salve d'appels peut
  // partir AVANT que le token JWT ne soit pleinement disponible (localStorage
  // momentanément vide / cold-start) → is-owner ET home-summary répondent vides
  // et l'accueil paraît « sans voyages » (onboarding superposé). On RE-SYNCHRONISE
  // donc le token depuis le stockage avant de résoudre.
  try {
    if (!_authToken) {
      _authToken = localStorage.getItem('crewigo_token') || (await _readTokenIDB()) || _authToken;
    }
  } catch {}

  let lastStatus = 0, attempts = 0, res = null;
  for (attempts = 1; attempts <= 3 && !res; attempts++) {
    try {
      const r = await fetch(`${API}/api/voyages/by-token/${token}/is-owner`);
      lastStatus = r.status;
      if (r.ok) { res = await r.json(); break; }
    } catch { lastStatus = -1; }
    if (attempts < 3) await new Promise(r => setTimeout(r, 500 * attempts)); // backoff
  }

  if (res && res.isOwner && res.voyageId) {
    const ok = await afficherVoyage(res.voyageId);
    // Diagnostic AFFICHÉ UNIQUEMENT si l'ouverture du voyage a échoué (bug =
    // retour sur l'accueil). Silencieux quand le voyage s'ouvre normalement.
    if (!ok) _bootDiag('voyage KO', { vid: res.voyageId, st: lastStatus, err: window.__vErr || '?' });
    return;
  }
  if (res && res.isOwner === false) {
    // Réponse FIABLE « pas propriétaire » → oublier le token, accueil normal.
    try { sessionStorage.removeItem('crewigo_return_token'); } catch {}
    window._suppressSwReload = false;
    _bootDiag('pas owner', { token: token.slice(0,6), st: lastStatus, auth: !!_authToken });
    chargerVoyages();
    return;
  }
  // Toutes les tentatives ont échoué (réseau/cold start) : NE PAS oublier le token
  // (un prochain lancement rouvrira le voyage). Accueil rendu sans onboarding.
  _bootDiag('is-owner injoignable', { token: token.slice(0,6), tries: attempts-1, st: lastStatus, auth: !!_authToken });
  chargerVoyages();
}

// Badge de diagnostic TEMPORAIRE — n'apparaît QUE dans le cas de bug (le retour
// « MODE ORGANISATEUR » n'a pas pu ouvrir le voyage). Invisible pour un retour
// réussi. Permet de capturer la cause exacte en une copie d'écran.
function _bootDiag(reason, info) {
  try {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;'
      + 'background:#1a1a2e;color:#fff;font:12px/1.4 monospace;padding:10px 12px;'
      + 'border:1px solid #F97316;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    el.textContent = `⚠️ retour: ${reason} · ${Object.entries(info).map(([k,v])=>`${k}=${v}`).join(' · ')}`;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.style.cssText = 'float:right;background:none;border:none;color:#F97316;font-weight:700;cursor:pointer;margin-left:8px';
    x.onclick = () => el.remove();
    el.prepend(x);
    document.body.appendChild(el);
  } catch {}
}

/** Construit le HTML d'une carte voyage selon sa section
 *  opts = { role: 'participant', participantNom, shareToken } pour les voyages participants
 */
function _renderVoyageCard(v, section, opts = null) {
  const isParticipant = opts?.role === 'participant';
  const isMemory  = section === 'memories';
  const isOngoing = section === 'ongoing';

  const statut = ['terminé','completed','archived'].includes(v.statut)
    ? { label: 'Terminé', classe: 'done' }
    : getStatut(v.date_debut, v.date_fin);

  const duree = getDuree(v.date_debut, v.date_fin);

  // ── Countdown "à venir" ──
  let countdownHtml = '';
  if (section === 'upcoming' && v.date_debut) {
    const daysUntil = Math.ceil((new Date(v.date_debut) - new Date()) / (1000*60*60*24));
    if (daysUntil > 0 && daysUntil <= 60) {
      const urgent = daysUntil <= 7 ? ' voyage-countdown--urgent' : '';
      countdownHtml = `<span class="voyage-countdown${urgent}">🗓️ Dans ${daysUntil}j</span>`;
    }
  }

  // ── Progression "en cours" ──
  let progressHtml = '';
  if (isOngoing && v.date_debut && v.date_fin) {
    const total   = new Date(v.date_fin)   - new Date(v.date_debut);
    const elapsed = new Date()             - new Date(v.date_debut);
    const pct     = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
    const dayN    = Math.max(1, Math.ceil(elapsed / (1000*60*60*24)));
    const dayTot  = Math.max(1, Math.round(total  / (1000*60*60*24)));
    progressHtml = `<div class="voyage-progress">
      <div class="voyage-progress-bar" style="width:${pct}%"></div>
    </div>
    <span class="voyage-progress-label">Jour ${dayN} / ${dayTot}</span>`;
  }

  // ── Stats mémoire ──
  let memoryStatsHtml = '';
  if (isMemory) {
    let s = '';
    if (v.avg_capsule_note != null)
      s += `<span class="memory-stat memory-stat--rating">⭐ ${v.avg_capsule_note}<span class="memory-stat-sub"> (${v.capsule_count||0} capsule${(v.capsule_count||0)>1?'s':''})</span></span>`;
    if (v.participant_count > 0)
      s += `<span class="memory-stat memory-stat--crew">👥 ${v.participant_count} crewmate${v.participant_count>1?'s':''}</span>`;
    if (s) memoryStatsHtml = `<div class="memory-stats">${s}</div>`;
  }

  // ── Click handler ──
  let clickHandler, ctaLabel;
  if (isParticipant) {
    // /voyage/ = URL canonique interface unique (les deux routes fonctionnent, /voyage/ est la référence)
    const shareUrl = opts.shareToken ? `/voyage/${opts.shareToken}` : '#';
    clickHandler = `onclick="window.location.href='${shareUrl}'"`;
    ctaLabel     = isMemory ? '🎞️ Voir les souvenirs' : '→ Accéder au voyage';
  } else {
    clickHandler = isMemory && v.share_token
      ? `onclick="window.location.href='/partage/${v.share_token}?tab=souvenirs'"`
      : `onclick="afficherVoyage(${v.id})"`;
    ctaLabel = isMemory ? '🎞️ Voir les souvenirs' : 'Ouvrir le trip';
  }

  // ── Chip de rôle (participant = violet, organisateur = ambre) ──
  // Le chip « Organisateur » n'apparaît que sur un dashboard mixte (admin + participations),
  // sinon il serait redondant sur toutes les cartes → on garde alors le badge de statut.
  const roleChip = isParticipant
    ? `<span class="voyage-role-chip voyage-role-chip--participant">→ Participe · ${h(opts.participantNom || '')}</span>`
    : (_dashboardMixed ? `<span class="voyage-role-chip voyage-role-chip--admin">★ Organisateur</span>` : '');

  return `<div class="voyage-card${isMemory?' voyage-card--memory':''}${isParticipant?' voyage-card--participant':''}" data-id="${h(String(v.id))}" ${clickHandler}>
    <div class="voyage-card-banner">
      <div class="voyage-card-accent" style="background:${h(v.couleur)}"></div>
      <img class="voyage-card-banner-img" src="" alt="" style="opacity:0">
      <div class="voyage-card-color-wash" style="background:linear-gradient(135deg,${h(v.couleur)}33 0%,transparent 70%)"></div>
      <div class="voyage-card-banner-content">
        <div class="voyage-card-banner-top">
          ${roleChip || `<span class="voyage-badge badge-${statut.classe}">${statut.label}</span>`}
        </div>
        <div class="voyage-card-banner-bottom">
          <span class="voyage-card-dest">
            <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
            ${h(v.destination)}
          </span>
        </div>
      </div>
    </div>
    <div class="voyage-card-body">
      <h2 class="voyage-card-title">${h(v.nom)}</h2>
      ${progressHtml}
      ${memoryStatsHtml}
      <div class="voyage-card-meta">
        <span class="voyage-dates">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="13" height="13"><rect x="3" y="4" width="18" height="18" rx="2"/><path stroke-linecap="round" d="M16 2v4M8 2v4M3 10h18"/></svg>
          ${v.date_debut ? formatDates(v.date_debut, v.date_fin) : '<em>Dates à définir</em>'}
        </span>
        ${countdownHtml || (duree ? `<span class="voyage-duree">${duree}</span>` : '')}
      </div>
      <div class="voyage-card-cta">
        <span class="voyage-card-open-btn">${ctaLabel}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M15 6l6 6-6 6"/></svg>
        </span>
      </div>
    </div>
  </div>`;
}

/** Charge les top photos des voyages archivés dans les cartes mémoire */
function _enrichirPhotosSouvenirs(voyages) {
  for (const v of voyages) {
    if (!v.top_photo_id) continue;
    const card = document.querySelector(`.voyage-card[data-id="${v.id}"]`);
    if (!card) continue;
    const img = card.querySelector('.voyage-card-banner-img');
    if (!img) continue;
    const tmp = new Image();
    tmp.onload = () => {
      img.src = `${API}/api/photos/${v.top_photo_id}/img`;
      img.style.opacity = '0.7';
      img.style.filter  = 'saturate(0.85) brightness(0.75)';
      img.style.transition = 'opacity 0.5s ease';
    };
    tmp.src = `${API}/api/photos/${v.top_photo_id}/img`;
  }
}

// ═══════════════════════════════════════════════════════
//  WIZARD CRÉER UN TRIP
// ═══════════════════════════════════════════════════════

const _P_COLORS = ['#6366F1','#F97316','#10B981','#EC4899','#F59E0B','#14B8A6','#EF4444','#8B5CF6'];
let _createSelectedColor = '#F97316';
let _createParticipants = [];
let _createPColorIdx = 0;
let _createTripType = null;

// ─── Flux « Créer un trip » IA-first : entrée langage naturel → récap éditable ───
const _TYPE_META = {
  ski:{e:'🎿',l:'Ski'}, city:{e:'🏙️',l:'City Trip'}, plage:{e:'🏖️',l:'Plage'},
  ile:{e:'🏝️',l:'Île'}, road:{e:'🚗',l:'Road Trip'}, evg:{e:'🎉',l:'EVG'},
  evf:{e:'💍',l:'EVF'}, camping:{e:'🏕️',l:'Camping'}, rando:{e:'🌿',l:'Rando'},
  plongee:{e:'🤿',l:'Plongée'}, potes:{e:'🍻',l:'Entre potes'}, autre:{e:'✈️',l:'Autre'}
};
const _AI_EXAMPLES = [
  "EVG de Tom à Barcelone, 1er week-end de juillet, on est 8",
  "Ski à Chamonix avec 6 potes en février",
  "Road trip Portugal cet été, 10 jours, 4 personnes",
  "City trip Lisbonne en mai, juste nous deux"
];
const _AI_PLACEHOLDERS = [
  "EVG de Tom à Barcelone, 1er week-end de juillet, on est 8…",
  "Ski à Chamonix avec 6 potes en février…",
  "Weekend entre filles à Lisbonne en mai…",
  "Road trip Islande cet été, 12 jours…"
];
let _aiNbHint = null, _aiPhIdx = 0, _aiPhTimer = null, _aiSubTimer = null;

function ouvrirCreateTrip() {
  // Marquer l'onboarding comme terminé si on crée un voyage depuis l'empty state
  try { localStorage.setItem(_OB_KEY, '1'); } catch {}
  const _ob = document.getElementById('onboarding-overlay');
  if (_ob && !_ob.classList.contains('hidden')) {
    _ob.classList.add('fading');
    setTimeout(() => { _ob.classList.add('hidden'); _ob.classList.remove('fading'); }, 300);
  }

  _createSelectedColor = '#F97316';
  _createParticipants = [];
  _createPColorIdx = 0;
  _createTripType = null;
  _aiNbHint = null;

  // Afficher le screen
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-create').classList.add('active');

  // Phases : entrée visible, récap + confirm cachés
  document.getElementById('create-entry')?.classList.remove('hidden');
  document.getElementById('create-recap')?.classList.add('hidden');
  document.getElementById('create-confirm')?.classList.add('hidden');
  _hideAILoading();
  closeEditSheet();

  // Reset des champs cachés (réutilisés par les sheets d'édition)
  ['c-pays','c-ville','c-nom','c-date-debut','c-date-fin','c-p-nom','c-orga-nom'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const orgaInput = document.getElementById('c-orga-nom');
  if (orgaInput && currentUser?.nom) orgaInput.value = currentUser.nom;
  const orgaAvatar = document.getElementById('create-orga-avatar');
  if (orgaAvatar) orgaAvatar.textContent = currentUser?.nom ? currentUser.nom[0].toUpperCase() : '?';
  document.querySelectorAll('.create-type-card').forEach(c => c.classList.remove('active'));
  const dB = document.getElementById('c-date-debut-val'); if (dB) dB.textContent = '—';
  const dF = document.getElementById('c-date-fin-val');   if (dF) dF.textContent = '—';
  const duree = document.getElementById('create-duree-badge'); if (duree) { duree.textContent = ''; duree.style.display = 'none'; }
  const pList = document.getElementById('create-p-list'); if (pList) pList.innerHTML = '';

  // Champ IA
  const ta = document.getElementById('c-ai-input'); if (ta) ta.value = '';
  _updateAISend();
  _renderAIChips();
  _startAIPlaceholders();
}

function fermerCreateTrip() {
  _stopAIPlaceholders();
  _hideAILoading();
  closeEditSheet();
  document.getElementById('screen-create')?.classList.remove('active');
  document.getElementById('screen-home')?.classList.add('active');
}

// ── Champ IA : chips, placeholder rotatif, état du bouton ──
function _renderAIChips() {
  const c = document.getElementById('create-chips');
  if (!c) return;
  c.innerHTML = _AI_EXAMPLES.map(ex => `<button class="create-chip">${h(ex)}</button>`).join('');
  c.querySelectorAll('.create-chip').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      const ta = document.getElementById('c-ai-input');
      if (ta) { ta.value = _AI_EXAMPLES[i]; _updateAISend(); lancerAITrip(); }
    });
  });
}
function _updateAISend() {
  const ta = document.getElementById('c-ai-input');
  const btn = document.getElementById('create-ai-send');
  if (btn && ta) btn.disabled = ta.value.trim().length < 3;
}
function _startAIPlaceholders() {
  _stopAIPlaceholders();
  const ta = document.getElementById('c-ai-input');
  if (!ta) return;
  ta.placeholder = _AI_PLACEHOLDERS[0];
  _aiPhTimer = setInterval(() => {
    if (document.activeElement === ta || ta.value) return;
    _aiPhIdx = (_aiPhIdx + 1) % _AI_PLACEHOLDERS.length;
    ta.placeholder = _AI_PLACEHOLDERS[_aiPhIdx];
  }, 2600);
}
function _stopAIPlaceholders() { if (_aiPhTimer) { clearInterval(_aiPhTimer); _aiPhTimer = null; } }

// ── Overlay « IA réfléchit » : animation CSS pure, sous-titre cosmétique ──
const _AI_SUBS = ['Lecture de ta phrase','Identification de la destination','Choix du type de trip','Génération du nom','Calcul des dates'];
function _showAILoading() {
  const ld = document.getElementById('create-ai-loading'); if (!ld) return;
  ld.classList.add('show');
  const subEl = document.getElementById('ai-loading-sub');
  let i = 0; if (subEl) subEl.textContent = _AI_SUBS[0];
  _aiSubTimer = setInterval(() => {
    i = (i + 1) % _AI_SUBS.length;
    if (subEl) { subEl.style.opacity = '0'; setTimeout(() => { subEl.textContent = _AI_SUBS[i]; subEl.style.opacity = '1'; }, 180); }
  }, 700);
}
function _hideAILoading() {
  document.getElementById('create-ai-loading')?.classList.remove('show');
  if (_aiSubTimer) { clearInterval(_aiSubTimer); _aiSubTimer = null; }
}

// ── Appel IA → récap (fallback gracieux si IA indisponible) ──
async function lancerAITrip() {
  const ta = document.getElementById('c-ai-input');
  const text = (ta?.value || '').trim();
  if (text.length < 3) return;
  _stopAIPlaceholders();
  _showAILoading();
  try {
    const res = await fetch(`${API}/api/ai/parse-trip`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error('parse failed');
    const data = await res.json();
    _applyAITrip(data.trip || {});
    _hideAILoading();
    _renderRecap(true);
    _showRecap();
  } catch (e) {
    _hideAILoading();
    toast('✨ IA indisponible — complète à la main');
    _applyAITrip({});
    _renderRecap(false);
    _showRecap();
  }
}

function ouvrirRecapManuel() {
  _stopAIPlaceholders();
  _applyAITrip({});
  _renderRecap(false);
  _showRecap();
}

// Injecte le résultat IA dans les champs cachés + l'état
function _applyAITrip(t) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('c-nom', t.nom);
  set('c-ville', t.ville);
  set('c-pays', t.pays);
  set('c-date-debut', t.date_debut);
  set('c-date-fin', t.date_fin);
  _createTripType = (t.type && _TYPE_META[t.type]) ? t.type : null;
  _aiNbHint = t.nb_participants || null;
  document.querySelectorAll('.create-type-card').forEach(c =>
    c.classList.toggle('active', c.dataset.type === _createTripType));
  createUpdateDuree();
}

function _showRecap() {
  document.getElementById('create-entry')?.classList.add('hidden');
  document.getElementById('create-recap')?.classList.remove('hidden');
}
function retourEntry() {
  closeEditSheet();
  document.getElementById('create-recap')?.classList.add('hidden');
  document.getElementById('create-entry')?.classList.remove('hidden');
  _startAIPlaceholders();
}

// ── Rendu des cartes de récap ──
function _renderRecap(fromAI) {
  const v = id => (document.getElementById(id)?.value || '').trim();
  const ville = v('c-ville'), pays = v('c-pays'), nom = v('c-nom');
  const dd = v('c-date-debut'), df = v('c-date-fin');
  const dest = ville ? (ville + (pays ? ', ' + pays : '')) : (pays || '');
  const fmtD = s => s ? new Date(s).toLocaleDateString('fr-BE', { day:'numeric', month:'short' }) : '';
  const dates = (dd && df) ? (fmtD(dd) + ' → ' + fmtD(df)) : (dd ? fmtD(dd) : '');
  const tm = _createTripType ? _TYPE_META[_createTripType] : null;
  const orga = v('c-orga-nom');

  const members = [];
  if (orga) members.push({ nom: orga, couleur: _createSelectedColor });
  _createParticipants.forEach(p => members.push(p));

  const cards = [
    { key:'nom',   emoji:'✏️',                label:'Nom du trip', value:nom,  ai:fromAI && !!nom },
    { key:'dest',  emoji:'📍',                label:'Destination', value:dest, ai:fromAI && !!dest },
    { key:'type',  emoji:(tm ? tm.e : '❓'),  label:'Type',        value:(tm ? tm.l : ''), ai:fromAI && !!tm },
    { key:'dates', emoji:'📅',                label:'Dates',       value:dates, ai:fromAI && !!dates },
    { key:'crew',  emoji:'👥',                label:'Le crew',     crew:true }
  ];

  const list = document.getElementById('create-recap-list');
  if (!list) return;
  list.innerHTML = cards.map(c => {
    let body;
    if (c.crew) {
      if (members.length) {
        const av = members.slice(0, 6).map(m =>
          `<span class="crew-av" style="background:${h(m.couleur || '#6366F1')}">${h((m.nom || '?')[0].toUpperCase())}</span>`).join('');
        const extra = members.length > 6 ? `<span class="crew-av crew-av--more">+${members.length - 6}</span>` : '';
        const hint = (_aiNbHint && _aiNbHint > members.length) ? `<span class="crew-hint">≈ ${_aiNbHint} prévus</span>` : '';
        body = `<div class="crew-avs">${av}${extra}${hint}</div>`;
      } else {
        body = `<div class="rcard-val empty">Toi + ajoute ton crew</div>`;
      }
    } else {
      body = c.value ? `<div class="rcard-val">${h(String(c.value))}</div>` : `<div class="rcard-val empty">À compléter</div>`;
    }
    return `<button class="rcard ${c.ai ? 'ai' : ''}" onclick="openEditSheet('${c.key}')">
      <span class="rcard-emoji">${c.emoji}</span>
      <span class="rcard-body"><span class="rcard-label">${c.label}</span>${body}</span>
      <span class="rcard-edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4v16h16v-7M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></span>
    </button>`;
  }).join('');
}

// ── Sheet d'édition (un panel par champ) ──
const _EDIT_TITLES = { nom:'Nom du trip', dest:'Destination', type:'Type de trip', dates:'Dates', crew:'Le crew' };
function openEditSheet(field) {
  const titleEl = document.getElementById('create-edit-title');
  if (titleEl) titleEl.textContent = _EDIT_TITLES[field] || 'Modifier';
  document.querySelectorAll('.cedit-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === field));
  if (field === 'crew') _renderCreateParticipants();
  document.getElementById('create-edit-mask')?.classList.add('show');
  document.getElementById('create-edit-sheet')?.classList.add('show');
  setTimeout(() => {
    const focusMap = { nom:'c-nom', dest:'c-ville', dates:'c-date-debut', crew:'c-orga-nom' };
    if (focusMap[field]) document.getElementById(focusMap[field])?.focus();
  }, 280);
}
function saveEditSheet() {
  createUpdateDuree();
  closeEditSheet();
  _renderRecap(false);
}
function closeEditSheet() {
  document.getElementById('create-edit-mask')?.classList.remove('show');
  document.getElementById('create-edit-sheet')?.classList.remove('show');
}

function createSelectType(type, btn) {
  _createTripType = type;
  document.querySelectorAll('.create-type-card').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
}

function createUpdateDuree() {
  const d1 = document.getElementById('c-date-debut').value;
  const d2 = document.getElementById('c-date-fin').value;
  const v1El = document.getElementById('c-date-debut-val');
  const v2El = document.getElementById('c-date-fin-val');
  const badge = document.getElementById('create-duree-badge');

  v1El.textContent = d1 ? new Date(d1).toLocaleDateString('fr-BE', { day:'numeric', month:'short' }) : '—';
  v2El.textContent = d2 ? new Date(d2).toLocaleDateString('fr-BE', { day:'numeric', month:'short' }) : '—';

  if (d1 && d2) {
    const diff = Math.round((new Date(d2) - new Date(d1)) / 86400000);
    badge.textContent = diff > 0 ? `${diff} jour${diff > 1 ? 's' : ''} de trip` : '';
    badge.style.display = diff > 0 ? '' : 'none';
  } else {
    badge.style.display = 'none';
  }
}

function createAddParticipant() {
  const input = document.getElementById('c-p-nom');
  const nom = input.value.trim();
  if (!nom) return;
  const couleur = _P_COLORS[_createPColorIdx % _P_COLORS.length];
  _createPColorIdx++;
  const id = Date.now();
  _createParticipants.push({ id, nom, couleur });
  input.value = '';
  _renderCreateParticipants();
  input.focus();
}

function _renderCreateParticipants() {
  const list = document.getElementById('create-p-list');
  if (_createParticipants.length === 0) { list.innerHTML = ''; return; }
  list.innerHTML = _createParticipants.map(p => `
    <div class="create-p-item">
      <div class="create-p-avatar" style="background:${h(p.couleur)}">${h(p.nom[0].toUpperCase())}</div>
      <span class="create-p-nom">${h(p.nom)}</span>
      <button class="create-p-del" onclick="createRemoveP(${p.id})">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
  `).join('');
}

function createRemoveP(id) {
  _createParticipants = _createParticipants.filter(p => p.id !== id);
  _renderCreateParticipants();
}

async function _creerTrip() {
  const ville       = (document.getElementById('c-ville')?.value || '').trim();
  const pays        = (document.getElementById('c-pays')?.value  || '').trim();
  const destination = [ville, pays].filter(Boolean).join(', ');
  const nom         = document.getElementById('c-nom').value.trim();
  const date_debut  = document.getElementById('c-date-debut').value;
  const date_fin    = document.getElementById('c-date-fin').value;
  const orgaNom     = (document.getElementById('c-orga-nom')?.value || '').trim();

  if (!nom) { toast('Donne un nom à ton trip'); openEditSheet('nom'); return; }

  closeEditSheet();
  const btn = document.getElementById('create-recap-cta');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

  try {
    // Créer le voyage
    const res  = await fetch(`${API}/api/voyages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nom, destination, date_debut: date_debut || null, date_fin: date_fin || null, couleur: _createSelectedColor })
    });
    const { id } = await res.json();

    // Créer l'organisateur en premier
    if (orgaNom) {
      await fetch(`${API}/api/voyages/${id}/participants`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nom: orgaNom, couleur: _createSelectedColor })
      });
    }

    // Créer les participants supplémentaires
    for (const p of _createParticipants) {
      await fetch(`${API}/api/voyages/${id}/participants`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nom: p.nom, couleur: p.couleur })
      });
    }

    // Phase 3 — confirmation
    const recap = document.getElementById('create-recap');

    // Générer le lien de partage en parallèle (idem à ce que fait l'onglet Admin)
    const partagePromise = fetch(`${API}/api/voyages/${id}/partager`, { method: 'POST' })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);

    setTimeout(async () => {
      if (recap) recap.classList.add('hidden');
      const conf = document.getElementById('create-confirm');
      conf.classList.remove('hidden');
      const totalPax = _createParticipants.length + (orgaNom ? 1 : 0);
      document.getElementById('create-confirm-sub').textContent =
        `${h(nom)}${destination ? ' · ' + h(destination) : ''}${totalPax ? ` · ${totalPax} voyageur${totalPax > 1 ? 's' : ''}` : ''}`;

      // Attendre le lien de partage et l'afficher
      const partageData = await partagePromise;
      const loadingEl = document.getElementById('create-confirm-loading');
      const shareEl   = document.getElementById('create-confirm-share');
      if (loadingEl) loadingEl.style.display = 'none';
      if (partageData?.url && shareEl) {
        // Stocker le lien complet pour les actions Copy / Share
        window._confirmShareFullUrl = partageData.url;
        // Afficher uniquement le chemin relatif (plus lisible)
        const displayUrl = partageData.url.replace(/^https?:\/\/[^/]+/, '');
        const urlEl = document.getElementById('create-confirm-share-url');
        if (urlEl) urlEl.textContent = displayUrl;
        shareEl.classList.remove('hidden');

        // QW9 — Bloc CTA de partage contextuel (injecté dynamiquement)
        const existingCta = document.getElementById('wizard-share-cta');
        if (!existingCta && shareEl.parentNode) {
          const ctaBlock = document.createElement('div');
          ctaBlock.id = 'wizard-share-cta';
          ctaBlock.className = 'share-cta-block';
          ctaBlock.style.cssText = 'margin:16px 0;padding:16px;background:rgba(249,115,22,.12);border:1px solid rgba(249,115,22,.30);border-radius:12px;text-align:center';
          ctaBlock.innerHTML = `
            <p style="margin:0 0 12px;font-size:14px;color:#fed7aa;font-weight:600">📱 Envoie ce lien à ton équipe</p>
            <button id="wizard-share-btn" onclick="wizardShare()" style="background:#f97316;color:#fff;border:none;border-radius:10px;padding:12px 20px;font-size:14px;font-weight:700;cursor:pointer;width:100%">
              Partager via WhatsApp / SMS ↗
            </button>`;
          shareEl.parentNode.insertBefore(ctaBlock, shareEl.nextSibling);
        }
      }

      // Stocker l'id pour la navigation depuis les boutons
      window._confirmVoyageId = id;
    }, 300);

  } catch(e) {
    toast('⚠️ Erreur lors de la création');
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

// ─── Actions de la confirmation post-création ───────────────────────────────

function _confirmShareCopy() {
  const url = window._confirmShareFullUrl;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    toast('✅ Lien copié !');
  }).catch(() => {
    // Fallback pour les vieux navigateurs
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('✅ Lien copié !');
  });
}

function _confirmShareNative() {
  const url = window._confirmShareFullUrl;
  if (!url) return;
  if (navigator.share) {
    navigator.share({
      title: 'Rejoins mon trip sur CrewiGO !',
      text: 'Je t\'invite à rejoindre notre voyage 🌍',
      url
    }).catch(() => {});
  } else {
    // Pas de Web Share API → copier directement
    _confirmShareCopy();
  }
}

function _confirmGo() {
  const id = window._confirmVoyageId;
  if (!id) return;
  chargerVoyages();
  afficherVoyage(id);
}

// QW9 — Partage contextuel depuis le wizard
function wizardShare() {
  const shareUrl = window._confirmShareFullUrl
    || document.getElementById('wizard-share-link')?.href
    || document.querySelector('[data-share-url]')?.dataset.shareUrl
    || window.location.origin;
  const voyageNom = document.getElementById('create-confirm-sub')?.textContent?.split(' · ')[0]
    || document.querySelector('.wizard-result-nom')?.textContent
    || 'notre voyage';

  if (navigator.share) {
    navigator.share({
      title: `CrewiGO — ${voyageNom}`,
      text: `Rejoins-moi sur CrewiGO pour organiser ${voyageNom} ! 🗺️`,
      url: shareUrl
    }).catch(() => {}); // L'utilisateur peut annuler — pas une erreur
  } else {
    // Fallback : copier dans le presse-papier
    navigator.clipboard?.writeText(shareUrl).then(() => {
      const btn = document.getElementById('wizard-share-btn');
      if (btn) { btn.textContent = '✅ Lien copié !'; setTimeout(() => { btn.textContent = 'Partager via WhatsApp / SMS ↗'; }, 2000); }
    }).catch(() => {
      // Dernier fallback : prompt
      prompt('Copie ce lien et envoie-le à ton équipe :', shareUrl);
    });
  }
}

// ═══════════════════════════════════════════════════════

function ouvrirModalVoyage(id = null) {
  const modal = document.getElementById('modal-voyage');
  document.getElementById('modal-voyage-titre').textContent = id ? 'Modifier le voyage' : 'Nouveau voyage';
  document.getElementById('v-id').value = id || '';

  if (id) {
    fetch(`${API}/api/voyages/${id}`).then(r => r.json()).then(v => {
      document.getElementById('v-nom').value = v.nom;
      document.getElementById('v-destination').value = v.destination;
      document.getElementById('v-date-debut').value = toDateStr(v.date_debut);
      document.getElementById('v-date-fin').value = toDateStr(v.date_fin);
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

// ── Confetti canvas — moment de joie à la création d'un voyage ──────────────
function _joyConfetti() {
  const COLORS = ['#F97316', '#FBBF24', '#34D399', '#60A5FA', '#F472B6', '#A78BFA'];
  const N = 72;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;width:100%;height:100%';
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const pieces = Array.from({ length: N }, () => ({
    x:     Math.random() * canvas.width,
    y:     -10 - Math.random() * 100,
    r:     3 + Math.random() * 5,
    dx:    (Math.random() - 0.5) * 5,
    dy:    1.5 + Math.random() * 4,
    rot:   Math.random() * 360,
    drot:  (Math.random() - 0.5) * 10,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    isRect: Math.random() > 0.45,
  }));

  let frame = 0;
  const FALL = 110;   // frames de chute
  const FADE = 30;    // frames de fondu

  function draw() {
    frame++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const alpha = frame < FALL ? 1 : Math.max(0, 1 - (frame - FALL) / FADE);
    pieces.forEach(p => {
      p.x   += p.dx;
      p.y   += p.dy;
      p.dy  += 0.09; // gravité
      p.rot += p.drot;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot * Math.PI / 180);
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = p.color;
      if (p.isRect) ctx.fillRect(-p.r, -p.r * 0.55, p.r * 2, p.r * 1.1);
      else { ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    });
    if (frame < FALL + FADE) requestAnimationFrame(draw);
    else canvas.remove();
  }
  requestAnimationFrame(draw);
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
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!r.ok) { toast('❌ Erreur lors de la sauvegarde'); return; }

  fermerModal('modal-voyage');
  if (!id) setTimeout(_joyConfetti, 180); // confetti après fermeture de la modale
  toast(id ? '✅ Voyage modifié' : '🎉 Voyage créé !');
  chargerVoyages();
}

function menuVoyageActuel() {
  const nomEl = document.getElementById('sheet-voyage-nom');
  if (nomEl) {
    const titreEl = document.getElementById('voyage-nom');
    nomEl.textContent = titreEl ? titreEl.textContent : 'Options du trip';
  }
  document.getElementById('menu-voyage').classList.remove('hidden');
  document.getElementById('overlay-sheet').classList.remove('hidden');
}

function modifierVoyageActuel() {
  fermerBottomSheet();
  ouvrirModalVoyage(voyageActuel);
}

async function supprimerVoyageActuel() {
  fermerBottomSheet();
  const ok = await _confirmModal({
    title:        'Supprimer ce voyage ?',
    message:      'Toutes les données (programme, photos, dépenses, participants…) seront <b>définitivement supprimées</b>. Cette action est irréversible.',
    confirmLabel: 'Supprimer définitivement',
    danger:       true
  });
  if (!ok) return;
  const r = await fetch(`${API}/api/voyages/${voyageActuel}`, { method: 'DELETE' });
  if (!r.ok) { toast('❌ Erreur lors de la suppression'); return; }
  toast('🗑️ Voyage supprimé');
  afficherAccueil();
}

// ─── CLÔTURE TRIP ─────────────────────────────────────

async function ouvrirCloture() {
  const [voyage, participants, depenses, agenda] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/participants`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/depenses`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json())
  ]);

  const totalDepenses = depenses.reduce((s, d) => s + parseFloat(d.montant || 0), 0);
  const nbJours = getDuree(voyage.date_debut, voyage.date_fin) || '—';
  const depParPers = participants.length > 0 ? totalDepenses / participants.length : 0;
  const transactions = _calculerTransactions(depenses, participants);
  const isTermine = voyage.statut === 'terminé';

  const settlementHtml = transactions.length === 0
    ? `<div class="bilan-ok"><svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Tout est équilibré !</div>`
    : `<div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:8px">
        ${transactions.map(t => `
          <div class="bilan-transaction">
            <div class="bilan-from">
              <div class="avatar" style="background:${h(t.from.couleur)}">${h(t.from.nom[0])}</div>
              <span>${h(t.from.nom)}</span>
            </div>
            <div class="bilan-arrow">
              <span class="bilan-amount">${t.amount.toFixed(2)} €</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
            </div>
            <div class="bilan-to">
              <div class="avatar" style="background:${h(t.to.couleur)}">${h(t.to.nom[0])}</div>
              <span>${h(t.to.nom)}</span>
            </div>
          </div>
        `).join('')}
      </div>`;

  document.getElementById('cloture-content').innerHTML = `
    ${isTermine ? `<div class="cloture-archived-banner"><svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" style="flex-shrink:0"><path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>Ce trip est archivé</div>` : ''}
    <div class="cloture-stats">
      <div class="cloture-stat">
        <div class="cloture-stat-val">${totalDepenses.toFixed(0)}€</div>
        <div class="cloture-stat-lbl">Dépensés</div>
      </div>
      <div class="cloture-stat">
        <div class="cloture-stat-val">${participants.length}</div>
        <div class="cloture-stat-lbl">Voyageurs</div>
      </div>
      <div class="cloture-stat">
        <div class="cloture-stat-val">${nbJours}</div>
        <div class="cloture-stat-lbl">Durée</div>
      </div>
      <div class="cloture-stat">
        <div class="cloture-stat-val">${depParPers > 0 ? depParPers.toFixed(0) + '€' : '—'}</div>
        <div class="cloture-stat-lbl">Par pers.</div>
      </div>
    </div>
    <div class="budget-section-header" style="padding:14px 16px 8px;border-top:1px solid var(--border)">
      <span class="budget-section-title">Soldes finaux — qui doit quoi</span>
    </div>
    ${settlementHtml}
  `;

  const btn = document.getElementById('cloture-btn-action');
  if (isTermine) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" style="flex-shrink:0"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>Réouvrir le trip';
    btn.style.cssText += ';display:inline-flex;align-items:center;gap:8px';
    btn.onclick = rouvrirVoyage;
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" style="flex-shrink:0"><path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>Archiver le trip';
    btn.style.cssText += ';display:inline-flex;align-items:center;gap:8px';
    btn.onclick = archiverVoyage;
  }

  document.getElementById('modal-cloture').classList.remove('hidden');
}

function _calculerTransactions(depenses, participants) {
  const net = {};
  participants.forEach(p => { net[p.id] = 0; });
  depenses.forEach(d => {
    const parts = parseIds(d.participants_ids);
    if (!parts.length) return;
    const share = parseFloat(d.montant) / parts.length;
    parts.forEach(pid => {
      if (+pid !== +d.payeur_id) {
        net[d.payeur_id] = (net[d.payeur_id] || 0) + share;
        net[pid] = (net[pid] || 0) - share;
      }
    });
  });
  const transactions = [];
  const debtors   = participants.filter(p => net[p.id] < -0.01).map(p => ({ ...p, solde: net[p.id] })).sort((a,b) => a.solde - b.solde);
  const creditors = participants.filter(p => net[p.id] > 0.01 ).map(p => ({ ...p, solde: net[p.id] })).sort((a,b) => b.solde - a.solde);
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const amount = Math.min(-net[d.id], net[c.id]);
    if (amount > 0.01) transactions.push({ from: d, to: c, amount: Math.round(amount * 100) / 100 });
    net[d.id] += amount; net[c.id] -= amount;
    if (Math.abs(net[d.id]) < 0.01) i++;
    if (Math.abs(net[c.id]) < 0.01) j++;
  }
  return transactions;
}

async function archiverVoyage() {
  const r = await fetch(`${API}/api/voyages/${voyageActuel}/statut`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statut: 'terminé' })
  });
  if (!r.ok) { toast('❌ Erreur lors de l\'archivage'); return; }
  fermerModal('modal-cloture');
  toast('🏁 Trip archivé !');
  chargerVoyages();
  // Mettre à jour le badge dans l'entête si visible
  await afficherVoyage(voyageActuel);
}

async function rouvrirVoyage() {
  const r = await fetch(`${API}/api/voyages/${voyageActuel}/statut`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statut: 'actif' })
  });
  if (!r.ok) { toast('❌ Erreur lors de la réouverture'); return; }
  fermerModal('modal-cloture');
  toast('✅ Trip réouvert !');
  chargerVoyages();
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
    container.innerHTML = `<div class="empty-tab"><div class="empty-tab-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="36" height="36" style="opacity:.35"><path d="M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v4c1.1 0 2 .9 2 2s-.9 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2zm-5 5.5H9v-3h6v3zm0-6H9v-3h6v3zm0-6H9v-3h6v3z"/></svg></div><p>Aucune réservation${filtre !== 'tous' ? ' dans cette catégorie' : ''}</p></div>`;
    return;
  }

  // Grouper par date
  const grouped = {};
  filtered.forEach(r => {
    const key = toDateStr(r.date_debut) || 'Sans date';
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
  const icones = { transport: cgoIcon('send',32), hebergement: cgoIcon('home',32), vehicule: cgoIcon('car',32), activite: cgoIcon('activity',32), restaurant: cgoIcon('food',32) };
  // Indicateurs compacts sur la carte
  const hasLink = !!r.lien;
  const docCount = docs.length;
  return `
  <div class="resa-card" onclick="voirReservation(${r.id})">
    <div class="resa-card-inner">
      ${icones[r.type] || cgoIcon('activity',32)}
      <div class="resa-body">
        <div class="resa-titre">${h(r.titre)}</div>
        <div class="resa-meta">
          ${r.heure_debut ? `<span>🕐 ${h(r.heure_debut)}${r.heure_fin ? ' → ' + h(r.heure_fin) : ''}</span>` : ''}
          ${r.lieu ? `<span>📍 ${h(r.lieu)}</span>` : ''}
          ${r.date_fin && r.date_fin !== r.date_debut ? `<span>📅 jusqu'au ${formatDate(r.date_fin)}</span>` : ''}
        </div>
        <div class="resa-card-badges">
          ${r.numero_confirmation ? `<span class="resa-badge-mini" style="display:inline-flex;align-items:center;gap:3px"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V6h10v2z"/></svg>${h(r.numero_confirmation)}</span>` : ''}
          ${hasLink ? `<span class="resa-badge-mini resa-badge-lien">🔗 Lien</span>` : ''}
          ${docCount ? `<span class="resa-badge-mini resa-badge-doc" style="display:inline-flex;align-items:center;gap:3px"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>${docCount}</span>` : ''}
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
  const icones = { transport: cgoIcon('send',32), hebergement: cgoIcon('home',32), vehicule: cgoIcon('car',32), activite: cgoIcon('activity',32), restaurant: cgoIcon('food',32) };

  const docsHtml = docs.length ? `
    <div class="rd-section">
      <div class="rd-section-label" style="display:flex;align-items:center;gap:5px"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" style="opacity:.7"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>Documents liés</div>
      <div class="resa-docs">
        ${docs.map(d => `
          <button class="resa-doc-badge" data-doc-id="${d.id}" data-doc-nom="${h(d.nom)}" onclick="ouvrirDocViewerFromEl(this)">
            ${getDocIcon(d.type_fichier)} <span>${h(d.nom)}</span>
          </button>`).join('')}
      </div>
    </div>` : '';

  // Stocker le numéro de confirmation pour le bouton copier (évite injection dans onclick)
  window._copyConfNum = r.numero_confirmation || '';
  document.getElementById('resa-detail-body').innerHTML = `
    <div class="rd-header">
      ${icones[r.type] || cgoIcon('activity',40)}
      <div class="rd-header-text">
        <div class="rd-titre">${h(r.titre)}</div>
        ${r.date_debut ? `<div class="rd-date">${formatDate(r.date_debut)}</div>` : ''}
      </div>
    </div>

    <div class="rd-rows">
      ${r.heure_debut ? `<div class="rd-row"><span class="rd-row-icon">🕐</span><span>${h(r.heure_debut)}${r.heure_fin ? ' → ' + h(r.heure_fin) : ''}</span></div>` : ''}
      ${r.date_fin && r.date_fin !== r.date_debut ? `<div class="rd-row"><span class="rd-row-icon">📅</span><span>Jusqu'au ${formatDate(r.date_fin)}${r.heure_fin ? ' · ' + h(r.heure_fin) : ''}</span></div>` : ''}
      ${r.lieu    ? `<div class="rd-row"><span class="rd-row-icon">📍</span><span>${h(r.lieu)}</span></div>` : ''}
      ${r.adresse ? `<div class="rd-row"><span class="rd-row-icon">🏠</span><span>${h(r.adresse)}</span></div>` : ''}
      ${r.numero_confirmation ? `
        <div class="rd-row">
          <span class="rd-row-icon">📋</span>
          <span class="rd-code">${h(r.numero_confirmation)}</span>
          <button class="rd-copy-btn" onclick="navigator.clipboard.writeText(window._copyConfNum).then(()=>toast('✅ Copié !'))">Copier</button>
        </div>` : ''}
    </div>

    ${r.notes ? `<div class="rd-notes">${h(r.notes).replace(/\n/g,'<br>')}</div>` : ''}

    ${r.lien ? `<a href="${h(r.lien)}" target="_blank" rel="noopener noreferrer" class="rd-lien-btn" onclick="event.stopPropagation()">🔗 Ouvrir le lien de réservation</a>` : ''}

    ${docsHtml}

    <div class="rd-actions">
      <button class="sheet-btn" onclick="fermerBottomSheet(); modifierReservation(${id})" style="display:flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>Modifier</button>
      <button class="sheet-btn danger" onclick="fermerBottomSheet(); supprimerReservation(${id})" style="display:flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>Supprimer</button>
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
        document.getElementById('r-date-debut').value = toDateStr(r.date_debut);
        document.getElementById('r-date-fin').value = toDateStr(r.date_fin);
        document.getElementById('r-heure-debut').value = r.heure_debut || '';
        document.getElementById('r-heure-fin').value = r.heure_fin || '';
        document.getElementById('r-lieu').value = r.lieu || '';
        document.getElementById('r-adresse').value = r.adresse || '';
        document.getElementById('r-confirmation').value = r.numero_confirmation || '';
        document.getElementById('r-notes').value = r.notes || '';
        document.getElementById('r-lien').value = r.lien || '';
        document.getElementById('r-type').value = r.type;
        document.querySelectorAll('#modal-reservation .type-opt').forEach(el => el.classList.toggle('active', el.dataset.type === r.type));
      });
  } else {
    document.getElementById('form-reservation').reset();
    document.getElementById('r-type').value = 'transport';
    document.querySelectorAll('#modal-reservation .type-opt').forEach((el, i) => el.classList.toggle('active', i === 0));
  }
  document.getElementById('modal-reservation').classList.remove('hidden');
}

function modifierReservation(id) {
  ouvrirModalReservation(id);
}

// ─── EXPORT PDF ──────────────────────────────────────────────────────────────

async function exporterVoyagePDF() {
  fermerBottomSheet();
  toast('⏳ Génération du PDF…');
  try {
    const [voyage, participants, reservations, agenda, depenses] = await Promise.all([
      fetch(`${API}/api/voyages/${voyageActuel}`).then(r => r.json()),
      fetch(`${API}/api/voyages/${voyageActuel}/participants`).then(r => r.json()),
      fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
      fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json()),
      fetch(`${API}/api/voyages/${voyageActuel}/depenses`).then(r => r.json())
    ]);

    const total = depenses.reduce((s, d) => s + parseFloat(d.montant || 0), 0);
    const ppp   = participants.length > 0 ? total / participants.length : 0;
    const byId  = {};
    participants.forEach(p => { byId[p.id] = p; });

    // ── Transactions (remboursements) ─────────────────────────────────────
    const transactions = _calculerTransactions(depenses, participants);

    // ── Agréger événements + réservations par date ─────────────────────────
    const items = [];
    agenda.forEach(ev => {
      if (!ev.date) return;
      items.push({ date: toDateStr(ev.date), heure: ev.heure || '', titre: ev.titre, lieu: ev.lieu || '', source: 'agenda', type: ev.type });
    });
    reservations.forEach(r => {
      const date = toDateStr(r.date_debut || r.date);
      if (!date) return;
      items.push({ date, heure: r.heure_debut || '', titre: r.titre, lieu: r.adresse || r.lieu || '', source: 'resa', type: r.type, confirmation: r.numero_confirmation || '', notes: r.notes || '' });
    });
    items.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.heure < b.heure ? -1 : 1));

    const typeLabel = { transport:'Transport', hebergement:'Hébergement', vehicule:'Véhicule', activite:'Activité', restaurant:'Restaurant', autre:'Autre' };
    const catLabel  = { transport:'Transport', hebergement:'Hébergement', vehicule:'Véhicule', activite:'Activités', restaurant:'Restauration', courses:'Courses', autre:'Divers' };

    function fmtD(d) { if (!d) return ''; try { return new Date(d + 'T00:00:00').toLocaleDateString('fr-BE', {day:'2-digit',month:'long',year:'numeric'}); } catch { return d; } }
    function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // Group items by date
    const grouped = {};
    items.forEach(it => { if (!grouped[it.date]) grouped[it.date] = []; grouped[it.date].push(it); });

    const timelineHtml = Object.entries(grouped).map(([date, dayItems]) => `
      <div class="pdf-day">
        <div class="pdf-day-header">${fmtD(date)}</div>
        ${dayItems.map(it => `
          <div class="pdf-item pdf-item--${it.source}">
            <div class="pdf-item-type">${esc(typeLabel[it.type] || it.type)}</div>
            <div class="pdf-item-title">${esc(it.titre)}</div>
            ${it.heure ? `<div class="pdf-item-detail">🕐 ${esc(it.heure)}</div>` : ''}
            ${it.lieu ? `<div class="pdf-item-detail">📍 ${esc(it.lieu)}</div>` : ''}
            ${it.confirmation ? `<div class="pdf-item-detail">🔖 ${esc(it.confirmation)}</div>` : ''}
            ${it.notes ? `<div class="pdf-item-detail">📝 ${esc(it.notes)}</div>` : ''}
          </div>`).join('')}
      </div>`).join('');

    // Dépenses par catégorie
    const byCat = {};
    depenses.forEach(d => { const c = d.categorie || 'autre'; byCat[c] = (byCat[c] || 0) + parseFloat(d.montant || 0); });
    const catHtml = Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([c, amt]) =>
      `<tr><td>${esc(catLabel[c]||c)}</td><td style="text-align:right;font-weight:600">${amt.toFixed(2)} €</td></tr>`
    ).join('');

    // Soldes par personne
    const net = {};
    participants.forEach(p => { net[p.id] = 0; });
    depenses.forEach(d => {
      const parts = parseIds(d.participants_ids);
      if (!parts.length) return;
      const share = parseFloat(d.montant) / parts.length;
      parts.forEach(pid => { if (net[pid] !== undefined) net[pid] -= share; });
      if (byId[d.payeur_id]) net[d.payeur_id] = (net[d.payeur_id] || 0) + parseFloat(d.montant);
    });
    const soldesHtml = participants.map(p => {
      const n = Math.round((net[p.id] || 0) * 100) / 100;
      const cl = n > 0.01 ? 'pdf-credit' : n < -0.01 ? 'pdf-debt' : '';
      return `<tr><td>${esc(p.nom)}</td><td class="${cl}" style="text-align:right;font-weight:600">${n >= 0 ? '+' : ''}${n.toFixed(2)} €</td></tr>`;
    }).join('');

    const rembHtml = transactions.length === 0
      ? '<p style="color:#6b7280;font-size:12px">Tout est équilibré 🎉</p>'
      : transactions.map(t => `<div class="pdf-remb">${esc(t.from.nom)} → ${esc(t.to.nom)} : <strong>${t.amount.toFixed(2)} €</strong></div>`).join('');

    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>CrewiGO — ${esc(voyage.nom || 'Mon voyage')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; font-size: 13px; color: #111827; background: #fff; padding: 32px; }
  h1 { font-size: 22px; font-weight: 800; color: #F97316; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #6b7280; margin-bottom: 24px; }
  h2 { font-size: 14px; font-weight: 700; color: #111827; margin: 24px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #F97316; }
  .crew-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .crew-chip { background: #FFF7ED; border: 1px solid #FDBA74; border-radius: 20px; padding: 3px 10px; font-size: 12px; font-weight: 600; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 8px; }
  .kpi { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 10px; padding: 10px 14px; text-align: center; }
  .kpi-val { font-size: 18px; font-weight: 800; color: #F97316; }
  .kpi-lbl { font-size: 10px; color: #6b7280; margin-top: 2px; }
  .pdf-day { margin-bottom: 14px; }
  .pdf-day-header { font-size: 12px; font-weight: 700; color: #F97316; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 6px; padding: 4px 0; }
  .pdf-item { border: 1px solid #E5E7EB; border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; background: #FAFAFA; }
  .pdf-item--resa { border-left: 3px solid #F97316; }
  .pdf-item--agenda { border-left: 3px solid #6366F1; }
  .pdf-item-type { font-size: 10px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 3px; }
  .pdf-item-title { font-size: 13px; font-weight: 600; color: #111827; margin-bottom: 4px; }
  .pdf-item-detail { font-size: 11px; color: #6b7280; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td { padding: 5px 8px; border-bottom: 1px solid #F3F4F6; }
  tr:last-child td { border-bottom: none; }
  .pdf-credit { color: #16A34A; }
  .pdf-debt   { color: #DC2626; }
  .pdf-remb { font-size: 12px; padding: 5px 0; border-bottom: 1px solid #F3F4F6; color: #374151; }
  .pdf-remb:last-child { border-bottom: none; }
  .pdf-legend { display: flex; gap: 16px; margin-top: 6px; font-size: 11px; color: #6b7280; }
  .pdf-legend span { display: flex; align-items: center; gap: 4px; }
  .pdf-legend-dot { width: 10px; height: 10px; border-radius: 2px; }
  @media print {
    body { padding: 16px; }
    @page { margin: 15mm; }
    h2 { page-break-after: avoid; }
    .pdf-day { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<h1>✈️ ${esc(voyage.nom || 'Mon voyage')}</h1>
<div class="subtitle">${voyage.destination ? esc(voyage.destination) + ' · ' : ''}${fmtD(voyage.date_debut) || ''}${voyage.date_fin ? ' → ' + fmtD(voyage.date_fin) : ''} · Exporté le ${new Date().toLocaleDateString('fr-BE')}</div>

<div class="kpis">
  <div class="kpi"><div class="kpi-val">${participants.length}</div><div class="kpi-lbl">Voyageurs</div></div>
  <div class="kpi"><div class="kpi-val">${reservations.length}</div><div class="kpi-lbl">Réservations</div></div>
  <div class="kpi"><div class="kpi-val">${agenda.length}</div><div class="kpi-lbl">Événements</div></div>
  <div class="kpi"><div class="kpi-val">${total.toFixed(0)}€</div><div class="kpi-lbl">Budget total</div></div>
</div>

<h2>👥 Le Crew</h2>
<div class="crew-chips">${participants.map(p => `<span class="crew-chip" style="border-color:${esc(p.couleur)}30;background:${esc(p.couleur)}12">${esc(p.nom)}</span>`).join('')}</div>

${items.length > 0 ? `<h2>📅 Programme chronologique</h2>
<div class="pdf-legend"><span><div class="pdf-legend-dot" style="background:#F97316"></div>Réservation</span><span><div class="pdf-legend-dot" style="background:#6366F1"></div>Agenda</span></div>
${timelineHtml}` : ''}

${depenses.length > 0 ? `
<h2>💰 Bilan financier</h2>
<div class="kpis" style="grid-template-columns:repeat(2,1fr);margin-bottom:16px">
  <div class="kpi"><div class="kpi-val">${total.toFixed(2)}€</div><div class="kpi-lbl">Total dépensé</div></div>
  <div class="kpi"><div class="kpi-val">${ppp.toFixed(2)}€</div><div class="kpi-lbl">Par personne</div></div>
</div>

<table style="margin-bottom:12px">
  <thead><tr><td style="font-weight:700;color:#6b7280;font-size:11px;padding-bottom:4px">Catégorie</td><td style="font-weight:700;color:#6b7280;font-size:11px;text-align:right;padding-bottom:4px">Total</td></tr></thead>
  <tbody>${catHtml}</tbody>
</table>

<table style="margin-bottom:12px">
  <thead><tr><td style="font-weight:700;color:#6b7280;font-size:11px;padding-bottom:4px">Personne</td><td style="font-weight:700;color:#6b7280;font-size:11px;text-align:right;padding-bottom:4px">Solde</td></tr></thead>
  <tbody>${soldesHtml}</tbody>
</table>

<div style="background:#FFF7ED;border:1px solid #FDBA74;border-radius:8px;padding:10px 14px">
  <div style="font-size:11px;font-weight:700;color:#F97316;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em">Remboursements à effectuer</div>
  ${rembHtml}
</div>` : ''}

<div style="margin-top:32px;padding-top:12px;border-top:1px solid #E5E7EB;font-size:11px;color:#9CA3AF;text-align:center">Généré par CrewiGO • crewigo.app</div>
</body>
</html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 600);
  } catch (e) {
    console.error('[exportPDF]', e);
    toast('❌ Erreur lors de la génération du PDF');
  }
}

// ─── EMAIL IMPORT ─────────────────────────────────────────────────────────────
// Parse un email de confirmation et pré-remplit le formulaire de réservation.

let _importedResa = null; // données parsées en attente d'import

function ouvrirImportEmail() {
  _importedResa = null;
  const modal = document.getElementById('modal-import-email');
  if (!modal) return;
  document.getElementById('import-email-text').value = '';
  document.getElementById('import-email-preview').classList.add('hidden');
  document.getElementById('btn-import-email-importer').classList.add('hidden');
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('import-email-text')?.focus(), 300);
}

function _parseEmailTexte(txt) {
  const result = { titre: '', type: 'transport', date_debut: '', date_fin: '', heure_debut: '', heure_fin: '', lieu: '', confirmation: '', notes: '' };

  // ── Numéro de confirmation / PNR ──────────────────────────────────────────
  const refPatterns = [
    /\b(?:PNR|booking\s*(?:ref(?:erence)?|number|code)|reservation\s*(?:number|code|ref)|confirmation\s*(?:number|code|ref|no\.?|#)|réf(?:érence)?(?:\s*de\s*réservation)?|code\s*de\s*réservation|n°\s*de\s*réservation|numéro\s*de\s*réservation)\s*[:\-]?\s*([A-Z0-9]{4,12})/i,
    /\b([A-Z]{2,3}-[A-Z0-9]{4,10})\b/,
    /\bRef\s*[:\-]\s*([A-Z0-9]{5,12})/i
  ];
  for (const rx of refPatterns) {
    const m = txt.match(rx);
    if (m) { result.confirmation = m[1]; break; }
  }

  // ── Type de réservation ──────────────────────────────────────────────────
  const txtLow = txt.toLowerCase();
  if (/\b(?:vol|flight|avion|airline|airways|air\s+\w+|airport|aéroport|départ\s+de\s+\w|arrivée\s+à\s+\w)\b/.test(txtLow)) result.type = 'transport';
  else if (/\b(?:train|tgv|thalys|eurostar|sncf|intercités|bus|coach|ferry|bateau|navette)\b/.test(txtLow)) result.type = 'transport';
  else if (/\b(?:hôtel|hotel|auberge|hostel|b&b|chambre|check.?in|check.?out|nuit|séjour|appartement|airbnb|booking\.com)\b/.test(txtLow)) result.type = 'hebergement';
  else if (/\b(?:voiture|car|rental|location\s+de\s+véhicule|hertz|europcar|sixt|avis|enterprise|alamo)\b/.test(txtLow)) result.type = 'vehicule';
  else if (/\b(?:restaurant|table|réservation\s+de\s+table|dîner|déjeuner|repas)\b/.test(txtLow)) result.type = 'restaurant';
  else if (/\b(?:activité|excursion|visite|tour|billet|ticket|entrée|attraction|événement)\b/.test(txtLow)) result.type = 'activite';

  // ── Dates : formats multiples ────────────────────────────────────────────
  const moisFr = { janvier:1,février:2,mars:3,avril:4,mai:5,juin:6,juillet:7,août:8,septembre:9,octobre:10,novembre:11,décembre:12,
                   jan:1,fév:2,mar:3,avr:4,jun:6,jul:7,aoû:8,sep:9,oct:10,nov:11,déc:12 };
  const moisEn = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,
                   jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const mois = { ...moisFr, ...moisEn };

  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d, m, y) {
    const yr = y.length === 2 ? (parseInt(y) > 50 ? '19' + y : '20' + y) : y;
    return `${yr}-${pad(m)}-${pad(d)}`;
  }

  const datePatterns = [
    // DD/MM/YYYY or DD-MM-YYYY
    /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/g,
    // YYYY-MM-DD
    /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    // "15 mars 2025" or "15 March 2025"
    /\b(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|fév|avr|aoû|déc)\s+(\d{4})\b/gi,
    // "March 15, 2025" or "Mar 15 2025"
    /\b(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|fév|avr|aoû|déc)\s+(\d{1,2}),?\s+(\d{4})\b/gi
  ];

  const foundDates = [];
  let m;
  // DD/MM/YYYY
  const rx1 = /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/g;
  while ((m = rx1.exec(txt)) !== null) {
    const d = parseInt(m[1]), mo = parseInt(m[2]), y = m[3];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) foundDates.push(toISO(d, mo, y));
  }
  // YYYY-MM-DD
  const rx2 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = rx2.exec(txt)) !== null) {
    const y = m[1], mo = parseInt(m[2]), d = parseInt(m[3]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) foundDates.push(`${y}-${pad(mo)}-${pad(d)}`);
  }
  // "15 mars 2025"
  const rx3 = /\b(\d{1,2})\s+(jan(?:vier)?|f[eé]v(?:rier)?|mar(?:s|ch)?|avr(?:il)?|apr(?:il)?|mai|may|jun(?:e|i)?|juil(?:let)?|jul(?:y)?|ao[uû]t?|aug(?:ust)?|sep(?:t(?:embre|ember)?)?|oct(?:obre|ober)?|nov(?:embre|ember)?|d[eé]c(?:embre|ember)?)\s+(\d{4})\b/gi;
  while ((m = rx3.exec(txt)) !== null) {
    const d = parseInt(m[1]), moName = m[2].toLowerCase(), y = m[3];
    const moNum = Object.entries(mois).find(([k]) => moName.startsWith(k))?.[1];
    if (moNum) foundDates.push(toISO(d, moNum, y));
  }
  // "mars 15 2025"
  const rx4 = /\b(jan(?:vier)?|f[eé]v(?:rier)?|mar(?:s|ch)?|avr(?:il)?|apr(?:il)?|mai|may|jun(?:e|i)?|juil(?:let)?|jul(?:y)?|ao[uû]t?|aug(?:ust)?|sep(?:t(?:embre|ember)?)?|oct(?:obre|ober)?|nov(?:embre|ember)?|d[eé]c(?:embre|ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/gi;
  while ((m = rx4.exec(txt)) !== null) {
    const moName = m[1].toLowerCase(), d = parseInt(m[2]), y = m[3];
    const moNum = Object.entries(mois).find(([k]) => moName.startsWith(k))?.[1];
    if (moNum) foundDates.push(toISO(d, moNum, y));
  }

  // Dédupliquer et trier
  const uniqDates = [...new Set(foundDates)].sort();
  if (uniqDates.length >= 1) result.date_debut = uniqDates[0];
  if (uniqDates.length >= 2) result.date_fin = uniqDates[uniqDates.length - 1];

  // ── Heures ───────────────────────────────────────────────────────────────
  const heures = [...txt.matchAll(/\b(\d{1,2})[h:](\d{2})(?:\s*(?:AM|PM))?\b/gi)].map(mx => {
    let h = parseInt(mx[1]), min = mx[2];
    if (/PM/i.test(mx[0]) && h < 12) h += 12;
    if (/AM/i.test(mx[0]) && h === 12) h = 0;
    return `${pad(h)}:${min}`;
  });
  if (heures.length >= 1) result.heure_debut = heures[0];
  if (heures.length >= 2) result.heure_fin = heures[1];

  // ── Titre : détecter route, nom de l'activité ─────────────────────────────
  // Patterns vol : BRU → AJA, Paris-CDG → Ajaccio
  const routeRx = /\b([A-Z]{3})\s*[→→>→\-–—]{1,3}\s*([A-Z]{3})\b/;
  const routeM = txt.match(routeRx);
  if (routeM) {
    result.titre = `Vol ${routeM[1]} → ${routeM[2]}`;
    result.type = 'transport';
  } else {
    // Première ligne non vide comme titre
    const lines = txt.split('\n').map(l => l.trim()).filter(l => l.length > 3 && l.length < 80);
    if (lines.length > 0) result.titre = lines[0].replace(/^(objet|subject|sujet)\s*:\s*/i, '').trim();
  }

  // ── Lieu ──────────────────────────────────────────────────────────────────
  const lieuRx = /(?:à|at|lieu|place|location|adresse|address|hôtel|hotel)\s*[:\-]?\s*([^\n,]{4,60})/i;
  const lieuM = txt.match(lieuRx);
  if (lieuM) result.lieu = lieuM[1].trim();

  return result;
}

function analyserEmailImport() {
  const txt = document.getElementById('import-email-text').value.trim();
  if (!txt) { toast('⚠️ Colle le texte de l\'email d\'abord'); return; }

  _importedResa = _parseEmailTexte(txt);

  const preview = document.getElementById('import-email-preview');
  const body = document.getElementById('import-email-preview-body');
  const btnImport = document.getElementById('btn-import-email-importer');

  const typeLabels = { transport:'✈️ Transport', hebergement:'🏨 Hébergement', vehicule:'🚗 Véhicule', activite:'🎯 Activité', restaurant:'🍽️ Restaurant' };
  const rows = [];
  if (_importedResa.titre) rows.push(`<div><strong>Titre :</strong> ${h(_importedResa.titre)}</div>`);
  rows.push(`<div><strong>Type :</strong> ${typeLabels[_importedResa.type] || _importedResa.type}</div>`);
  if (_importedResa.date_debut) rows.push(`<div><strong>Date début :</strong> ${_importedResa.date_debut}${_importedResa.heure_debut ? ' · ' + _importedResa.heure_debut : ''}</div>`);
  if (_importedResa.date_fin && _importedResa.date_fin !== _importedResa.date_debut) rows.push(`<div><strong>Date fin :</strong> ${_importedResa.date_fin}${_importedResa.heure_fin ? ' · ' + _importedResa.heure_fin : ''}</div>`);
  if (_importedResa.lieu) rows.push(`<div><strong>Lieu :</strong> ${h(_importedResa.lieu)}</div>`);
  if (_importedResa.confirmation) rows.push(`<div><strong>Confirmation :</strong> ${h(_importedResa.confirmation)}</div>`);

  body.innerHTML = rows.length > 0 ? rows.join('') : '<em style="color:var(--text-muted)">Aucune donnée détectée — vérifie le texte collé.</em>';
  preview.classList.remove('hidden');
  btnImport.classList.toggle('hidden', rows.length === 0);
}

function confirmerImportEmail() {
  if (!_importedResa) return;
  fermerModal('modal-import-email');
  setTimeout(() => {
    ouvrirModalReservation(null);
    // Pré-remplir le formulaire avec les données parsées
    if (_importedResa.titre) document.getElementById('r-titre').value = _importedResa.titre;
    if (_importedResa.date_debut) document.getElementById('r-date-debut').value = _importedResa.date_debut;
    if (_importedResa.date_fin) document.getElementById('r-date-fin').value = _importedResa.date_fin;
    if (_importedResa.heure_debut) document.getElementById('r-heure-debut').value = _importedResa.heure_debut;
    if (_importedResa.heure_fin) document.getElementById('r-heure-fin').value = _importedResa.heure_fin;
    if (_importedResa.lieu) document.getElementById('r-lieu').value = _importedResa.lieu;
    if (_importedResa.confirmation) document.getElementById('r-confirmation').value = _importedResa.confirmation;
    // Sélectionner le type
    document.getElementById('r-type').value = _importedResa.type;
    document.querySelectorAll('#modal-reservation .type-opt').forEach(el => el.classList.toggle('active', el.dataset.type === _importedResa.type));
    _importedResa = null;
  }, 250);
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
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!r.ok) { toast('❌ Erreur lors de la sauvegarde'); return; }

  fermerModal('modal-reservation');
  toast(id ? '✅ Réservation modifiée' : '✅ Réservation ajoutée');
  chargerAdmin();
}

async function supprimerReservation(id) {
  if (!confirm('Supprimer cette réservation ?')) return;
  const r = await fetch(`${API}/api/reservations/${id}`, { method: 'DELETE' });
  if (!r.ok) { toast('❌ Erreur lors de la suppression'); return; }
  toast('🗑️ Réservation supprimée');
  chargerAdmin();
}

// ─── DASHBOARD ACCUEIL ───────────────────────────────────────────────────────

// P5 — Construit le fil d'activité récente pour le Hub
function _buildActivityFeed(participants, depenses, agenda, reservations) {
  const items = [];

  // Participants (triés par id décroissant = plus récents en premier)
  const sortedParts = [...participants].sort((a, b) => (b.id || 0) - (a.id || 0));
  sortedParts.forEach(p => {
    items.push({
      icon: '👤',
      text: `<strong>${h(p.nom)}</strong> a rejoint le voyage`,
      sortKey: p.id || 0,
      type: 'participant'
    });
  });

  // Dépenses (triées par date ou id)
  const sortedDep = [...depenses].sort((a, b) => {
    const da = a.created_at || a.date || '';
    const db = b.created_at || b.date || '';
    return da > db ? -1 : da < db ? 1 : (b.id || 0) - (a.id || 0);
  });
  sortedDep.forEach(d => {
    const montant = parseFloat(d.montant || 0).toFixed(0);
    const payeur  = d.payeur || d.paye_par || '';
    items.push({
      icon: '💰',
      text: `<strong>${h(d.libelle || d.description || 'Dépense')}</strong> · ${montant}€${payeur ? ` — ${h(payeur)}` : ''}`,
      sortKey: d.created_at || d.date || String(d.id || 0),
      type: 'depense'
    });
  });

  // Agenda (trié par date_debut décroissant)
  const sortedAgenda = [...agenda].sort((a, b) => {
    const da = a.created_at || a.date_debut || '';
    const db = b.created_at || b.date_debut || '';
    return da > db ? -1 : da < db ? 1 : 0;
  });
  sortedAgenda.forEach(ev => {
    items.push({
      icon: '📍',
      text: `<strong>${h(ev.titre || ev.nom || 'Événement')}</strong> ajouté au programme`,
      sortKey: ev.created_at || ev.date_debut || String(ev.id || 0),
      type: 'agenda'
    });
  });

  // Réservations
  const sortedResa = [...reservations].sort((a, b) => {
    const da = a.created_at || a.date_debut || '';
    const db = b.created_at || b.date_debut || '';
    return da > db ? -1 : da < db ? 1 : 0;
  });
  sortedResa.forEach(r => {
    items.push({
      icon: '✈️',
      text: `<strong>${h(r.titre || r.nom || 'Réservation')}</strong> ajoutée`,
      sortKey: r.created_at || r.date_debut || String(r.id || 0),
      type: 'reservation'
    });
  });

  // Tri global par sortKey décroissant, limiter à 8
  const sorted = items
    .sort((a, b) => String(b.sortKey) > String(a.sortKey) ? 1 : String(b.sortKey) < String(a.sortKey) ? -1 : 0)
    .slice(0, 8);

  if (sorted.length === 0) {
    return `<p style="text-align:center;color:var(--text-muted);font-size:13px;padding:12px 0">Aucune activité récente</p>`;
  }

  return sorted.map(item => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid var(--border-subtle, rgba(255,255,255,.06))">
      <span style="font-size:1.2rem;line-height:1.2;flex-shrink:0">${item.icon}</span>
      <span style="font-size:13px;color:var(--text-secondary, var(--text-muted));line-height:1.4">${item.text}</span>
    </div>
  `).join('');
}

async function chargerAccueil() {
  const container = document.getElementById('dash-content');
  container.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-muted)">Chargement…</div>`;

  const [voyage, reservations, bagages, agenda, depenses, participants] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/bagages`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/depenses`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/participants`).then(r => r.json())
  ]);
  participantsActuels = participants;
  afficherParticipants(participants);

  const today = new Date(); today.setHours(0,0,0,0);
  const debut = voyage.date_debut ? new Date(toDateStr(voyage.date_debut) + 'T00:00:00') : null;
  const fin   = voyage.date_fin   ? new Date(toDateStr(voyage.date_fin)   + 'T00:00:00') : null;

  // ── Statut du voyage ──────────────────────────────────────────────────────
  let heroClass = 'upcoming', heroLabel = '', heroDays = '';
  if (!debut) {
    heroClass = 'past'; heroLabel = 'À planifier';
  } else if (debut > today) {
    const diff = Math.ceil((debut - today) / 86400000);
    heroClass = 'upcoming';
    heroLabel = 'Départ dans';
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
    heroLabel = 'En cours';
    heroDays  = totalDays ? `Jour ${jourN} / ${totalDays}` : `Jour ${jourN}`;
  }

  // ── Prochaine réservation ─────────────────────────────────────────────────
  const todayStr = today.toISOString().split('T')[0];
  const futures = reservations
    .filter(r => r.date_debut && toDateStr(r.date_debut) >= todayStr)
    .sort((a, b) => toDateStr(a.date_debut) < toDateStr(b.date_debut) ? -1 : 1);
  const prochaine = futures[0] || null;

  // ── Total dépenses ────────────────────────────────────────────────────────
  const totalDepenses = depenses.reduce((s, d) => s + parseFloat(d.montant || 0), 0);
  const depParPers    = participants.length > 0 ? totalDepenses / participants.length : 0;

  // ── Récap post-trip (affiché uniquement si voyage terminé) ────────────────
  const isTripped = heroClass === 'past' && fin && fin < today;
  let postTripRecap = '';
  if (isTripped && depenses.length > 0) {
    // Top catégories
    const catLabels = { transport:'Transport', hebergement:'Hébergement', restaurant:'Resto', activite:'Activités', autre:'Autres', courses:'Courses', vehicule:'Véhicule' };
    const catEmojis  = { transport:'✈️', hebergement:'🏨', restaurant:'🍽️', activite:'🎉', autre:'📦', courses:'🛒', vehicule:'🚗' };
    const byCat = {};
    depenses.forEach(d => {
      const cat = d.categorie || 'autre';
      byCat[cat] = (byCat[cat] || 0) + parseFloat(d.montant || 0);
    });
    const sorted = Object.entries(byCat).sort((a,b) => b[1] - a[1]).slice(0, 3);
    const maxCat = sorted[0]?.[1] || 1;
    const catBars = sorted.map(([cat, amt]) => {
      const pct = Math.round(amt / maxCat * 100);
      const label = catLabels[cat] || cat;
      const emoji = catEmojis[cat] || '📦';
      return `<div class="recap-cat-row">
        <span class="recap-cat-label">${emoji} ${label}</span>
        <div class="recap-cat-bar-track"><div class="recap-cat-bar-fill" style="width:${pct}%"></div></div>
        <span class="recap-cat-amt">${amt.toFixed(0)}€</span>
      </div>`;
    }).join('');
    // Dépense la plus grosse
    const bigDep = depenses.reduce((prev, cur) => parseFloat(cur.montant) > parseFloat(prev.montant) ? cur : prev, depenses[0]);
    postTripRecap = `
    <div class="recap-card">
      <div class="recap-card-header">
        <span class="recap-card-title">Récapitulatif du voyage</span>
        <button class="btn-sm" onclick="ouvrirCloture()">Bilan complet</button>
      </div>
      <div class="recap-kpis">
        <div class="recap-kpi">
          <span class="recap-kpi-val">${totalDepenses.toFixed(0)}€</span>
          <span class="recap-kpi-lbl">Total dépenses</span>
        </div>
        <div class="recap-kpi">
          <span class="recap-kpi-val">${depParPers.toFixed(0)}€</span>
          <span class="recap-kpi-lbl">Par personne</span>
        </div>
        <div class="recap-kpi">
          <span class="recap-kpi-val">${participants.length}</span>
          <span class="recap-kpi-lbl">Voyageurs</span>
        </div>
      </div>
      ${sorted.length > 0 ? `<div class="recap-cat-section">${catBars}</div>` : ''}
      ${bigDep ? `<div class="recap-bigdep"><svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13" style="flex-shrink:0;color:var(--accent)"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>Plus grosse dépense : <strong>${h(bigDep.titre)}</strong> · ${parseFloat(bigDep.montant).toFixed(2)}€</div>` : ''}
    </div>`;
  }

  // ── Rendu principal ────────────────────────────────────────────────────────
  const resaIcons = { transport: cgoIcon('send',36), hebergement: cgoIcon('home',36), vehicule: cgoIcon('car',36), activite: cgoIcon('activity',36), restaurant: cgoIcon('food',36) };

  container.innerHTML = `
    <!-- Hero countdown -->
    <div class="dash-hero dash-hero-${heroClass}">
      <div class="dash-hero-eyebrow">${heroLabel}</div>
      <div class="dash-hero-days">${heroDays}</div>
      <div class="dash-hero-dest"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" style="opacity:.75;flex-shrink:0;vertical-align:middle;margin-right:4px"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>${h(voyage.destination || voyage.nom)}</div>
      ${debut ? `<div class="dash-hero-period">${formatDates(voyage.date_debut, voyage.date_fin)}</div>` : ''}
    </div>

    <!-- Stats grid -->
    <div class="dash-stats-grid">
      <div class="dash-stat-card">
        <div class="dash-stat-value">${reservations.length}</div>
        <div class="dash-stat-label">Réservations</div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-value">${agenda.length}</div>
        <div class="dash-stat-label">Événements</div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-value" style="font-size:1.1rem">${totalDepenses.toFixed(0)}<span style="font-size:.8rem">€</span></div>
        <div class="dash-stat-label">Dépenses</div>
      </div>
    </div>

    <!-- Récap post-trip -->
    ${postTripRecap}

    <!-- Prochaine réservation -->
    ${prochaine && !isTripped ? `
    <div class="dash-section-title"><svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v4c1.1 0 2 .9 2 2s-.9 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2zm-5 5.5H9v-3h6v3zm0-6H9v-3h6v3zm0-6H9v-3h6v3z"/></svg>Prochaine réservation</div>
    <div class="dash-next-card" onclick="voirReservation(${prochaine.id})">
      <div class="dash-next-icon">${resaIcons[prochaine.type] || '📌'}</div>
      <div class="dash-next-body">
        <div class="dash-next-titre">${h(prochaine.titre)}</div>
        <div class="dash-next-date">${formatDate(prochaine.date_debut)}${prochaine.heure_debut ? ' · ' + h(prochaine.heure_debut) : ''}</div>
        ${prochaine.adresse ? `<div class="dash-next-lieu"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11" style="flex-shrink:0;opacity:.7"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>${h(prochaine.adresse)}</div>` : ''}
      </div>
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="flex-shrink:0;color:var(--text-muted)"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
    </div>` : ''}

    <!-- Météo -->
    <div class="dash-section-title"><svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/></svg>Météo à destination</div>
    <div id="dash-meteo"><div style="padding:16px;text-align:center;color:var(--text-muted);font-size:.88rem">Chargement de la météo…</div></div>

    <!-- Description -->
    ${voyage.description ? `
    <div class="dash-section-title"><svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>Notes du voyage</div>
    <div class="dash-notes">${h(voyage.description).replace(/\n/g,'<br>')}</div>` : ''}

    <!-- Fil d'activité transversal (P5) -->
    <div class="budget-section" style="margin-top:0">
      <div class="budget-section-header">
        <span class="budget-section-title" style="display:flex;align-items:center;gap:6px">
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" style="flex-shrink:0;opacity:.8"><path d="M13 2.05V4.08c3.39.49 6 3.39 6 6.92 0 2.74-1.52 5.25-3.78 6.67L13 16v5h5l-1.22-1.22C19.91 18.07 21 15.14 21 12c0-4.94-3.50-9.07-8-9.95zM11 2.05C6.5 2.93 3 7.06 3 12c0 3.14 1.09 6.07 3.22 8.28L5 21.99h5v-5l-2.22 1.67A7.908 7.908 0 0 1 5 12c0-3.53 2.61-6.43 6-6.92V2.05z"/></svg>
          Récemment
        </span>
      </div>
      <div style="padding:0 16px 16px">
        ${_buildActivityFeed(participants, depenses, agenda, reservations)}
      </div>
    </div>

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
        <div class="dash-weather-loc"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11" style="flex-shrink:0;opacity:.7"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>${name}, ${country}</div>
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
  const [evts, resas, voyage, docs] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.ok ? r.json() : []).catch(() => []),
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.ok ? r.json() : []).catch(() => []),
    fetch(`${API}/api/voyages/${voyageActuel}`).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    fetch(`${API}/api/voyages/${voyageActuel}/documents`).then(r => r.ok ? r.json() : []).catch(() => [])
  ]);

  const container = document.getElementById('liste-programme');
  if (!container) return;

  // Fusionner : chaque résa avec une date → apparaît dans la timeline
  const items = [];

  evts.forEach(ev => {
    if (!ev.date) return;
    items.push({
      date: toDateStr(ev.date),
      heure: ev.heure || null,
      titre: ev.titre,
      lieu: ev.lieu || null,
      description: ev.description || null,
      lien: ev.lien || null,
      type: ev.type,
      source: 'agenda',
      id: ev.id,
      docs: docs.filter(d => d.event_id == ev.id)
    });
  });

  resas.forEach(r => {
    const date = toDateStr(r.date_debut || r.date);
    if (!date) return;
    items.push({
      date,
      heure: r.heure_debut || r.heure || null,
      titre: r.titre,
      lieu: r.adresse || r.lieu || null,
      description: r.notes || null,
      lien: r.lien || null,
      type: r.type,
      source: 'resa',
      id: r.id,
      docs: docs.filter(d => d.reservation_id == r.id)
    });
  });

  if (items.length === 0) {
    container.innerHTML = `<div class="empty-tab" style="padding:52px 24px">
  <div class="empty-state-visual">
    <svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="10" y="18" width="56" height="46" rx="9" fill="#FFF7ED"/>
      <rect x="10" y="18" width="56" height="13" rx="9" fill="#FDBA74"/>
      <rect x="10" y="25" width="56" height="6" fill="#FDBA74"/>
      <rect x="20" y="40" width="36" height="5" rx="2.5" fill="#FED7AA"/>
      <rect x="20" y="51" width="24" height="5" rx="2.5" fill="#FED7AA" opacity=".55"/>
      <circle cx="57" cy="56" r="10" fill="#F97316" opacity=".1"/>
      <path d="M57 51v5.5l3 2" stroke="#F97316" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>
  </div>
  <p class="empty-state-title" style="font-size:.95rem;margin:0 0 6px">Road Map vide</p>
  <p class="empty-state-sub" style="margin:0 0 18px">Ajoutez des étapes, hébergements et activités pour construire le programme du voyage.</p>
  <button class="empty-state-cta" onclick="ouvrirModalAgenda()">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
    Ajouter une étape
  </button>
</div>`;
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
    const m = { transport: 'send', hebergement: 'home', vehicule: 'car', activite: 'activity', restaurant: 'food' };
    return cgoIcon(m[type] || 'activity', 32);
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

          const mapId   = it.lieu ? `map-${it.source}-${it.id}` : null;
          const mapAddr = it.lieu || null;

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
                  <div class="prog-titre">${h(it.titre)}</div>
                  ${it.heure ? `<span class="prog-heure"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11" style="flex-shrink:0;opacity:.7"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm4.24 16L11 13.18V7h1.5v5.52l4.72 2.71-.99 1.77z"/></svg>${h(it.heure)}</span>` : ''}
                  ${it.lieu ? `<div class="prog-lieu"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11" style="flex-shrink:0;opacity:.6"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>${h(it.lieu)}</div>` : ''}
                  ${it.description ? `<div class="prog-desc">${h(it.description).replace(/\n/g,'<br>')}</div>` : ''}
                  ${it.lien ? (function(){ const safeLien = /^https?:\/\//i.test(it.lien) ? it.lien : '#'; return `<a href="${h(safeLien)}" target="_blank" rel="noopener noreferrer" class="prog-lien"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11" style="flex-shrink:0"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7C4.24 7 2 9.24 2 12s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zm4.1 1h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>Ouvrir</a>`; })() : ''}
                  ${it.docs && it.docs.length ? `
                  <div class="prog-docs">
                    ${it.docs.map(d => `
                      <button class="prog-doc-badge" data-doc-id="${d.id}" data-doc-nom="${h(d.nom)}" onclick="event.stopPropagation();ouvrirDocViewerFromEl(this)">
                        ${getDocIcon(d.type_fichier)}<span>${h(d.nom)}</span>
                      </button>`).join('')}
                  </div>` : ''}
                </div>
                <div class="prog-actions">
                  ${badge}
                  <div style="display:flex;gap:4px;margin-top:6px">
                    ${mapId ? `<button class="btn-mini btn-mini-map" onclick="event.stopPropagation();toggleProgMap('${mapId}',this,'${(mapAddr||'').replace(/'/g,"\\'")}')" title="Voir sur la carte"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/></svg></button>` : ''}
                    <button class="btn-mini btn-mini-edit" onclick="event.stopPropagation();${editFn}" title="Modifier"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>
                    <button class="btn-mini btn-mini-del" onclick="event.stopPropagation();${delFn}" title="Supprimer"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
                  </div>
                </div>
              </div>
              ${mapId ? `<div id="${mapId}" class="prog-map hidden"></div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

async function toggleProgMap(mapId, btn, address) {
  const div = document.getElementById(mapId);
  if (!div) return;
  const isOpen = !div.classList.contains('hidden');
  div.classList.toggle('hidden', isOpen);
  btn.classList.toggle('active', !isOpen);

  // Initialiser la carte uniquement à la première ouverture
  if (!isOpen && !div.dataset.initialized) {
    div.dataset.initialized = 'true';
    div.innerHTML = '<div style="padding:10px;text-align:center;font-size:.8rem;color:var(--text-muted)">📍 Localisation en cours…</div>';
    try {
      const nominatimFetch = async (q) => {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
          { headers: { 'Accept-Language': 'fr' } }
        );
        return r.json();
      };
      // Essai 1 : adresse complète
      let results = await nominatimFetch(address);
      // Essai 2 : simplifié (après le premier tiret ou virgule)
      if (!results.length) {
        const simplified = address.split(/[-,]/)[0].trim();
        if (simplified && simplified !== address) results = await nominatimFetch(simplified);
      }
      if (!results.length) throw new Error('not found');
      const { lat, lon } = results[0];
      const d = 0.004;
      const bbox = `${+lon-d},${+lat-d},${+lon+d},${+lat+d}`;
      div.innerHTML = `<iframe class="prog-map-frame"
        src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}"
        frameborder="0" loading="eager"></iframe>
        <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=15" target="_blank" rel="noopener"
          style="display:block;text-align:right;font-size:.68rem;padding:2px 8px 4px;color:var(--text-muted)">
          Ouvrir dans OpenStreetMap ↗
        </a>`;
    } catch (e) {
      div.innerHTML = `<div style="padding:10px;text-align:center">
        <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}"
           target="_blank" rel="noopener" style="color:var(--accent);font-size:.8rem">
          📍 Ouvrir dans Google Maps ↗
        </a></div>`;
    }
  }
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
  // Réactiver le bouton submit (peut avoir été désactivé par une soumission précédente)
  const btn = document.querySelector('#form-agenda [type="submit"]');
  if (btn) btn.disabled = false;
  document.getElementById('modal-agenda').classList.remove('hidden');
}

async function modifierAgenda(id) {
  const items = await fetch(`${API}/api/voyages/${voyageActuel}/agenda`).then(r => r.json());
  const item = items.find(x => x.id === id);
  if (!item) return;
  document.getElementById('a-id').value = id;
  document.getElementById('a-date').value = toDateStr(item.date);
  document.getElementById('a-heure').value = item.heure || '';
  document.getElementById('a-titre').value = item.titre;
  document.getElementById('a-description').value = item.description || '';
  document.getElementById('a-lieu').value = item.lieu || '';
  document.getElementById('a-type').value = item.type;
  document.getElementById('a-lien').value = item.lien || '';
  document.getElementById('modal-agenda-titre').textContent = 'Modifier l\'événement';
  const btn = document.querySelector('#form-agenda [type="submit"]');
  if (btn) btn.disabled = false;
  document.getElementById('modal-agenda').classList.remove('hidden');
}

async function sauvegarderAgenda(e) {
  e.preventDefault();
  const submitBtn = e.submitter || e.target?.querySelector('[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; }

  const id = document.getElementById('a-id').value;
  const dateVal = document.getElementById('a-date').value;
  const titreVal = document.getElementById('a-titre').value.trim();

  // Validation client — protège contre les edge cases mobile (date picker fermé sans sélection)
  if (!dateVal) {
    toast('⚠️ Une date est requise');
    if (submitBtn) submitBtn.disabled = false;
    return;
  }
  if (!titreVal) {
    toast('⚠️ Un titre est requis');
    if (submitBtn) submitBtn.disabled = false;
    return;
  }

  // Auto-préfixer https:// si l'utilisateur tape une URL sans protocole
  const lienRaw = document.getElementById('a-lien').value.trim();
  const lienVal = lienRaw && !/^https?:\/\//i.test(lienRaw) ? 'https://' + lienRaw : lienRaw;

  const data = {
    date: dateVal,
    heure: document.getElementById('a-heure').value || null,
    titre: titreVal,
    description: document.getElementById('a-description').value,
    lieu: document.getElementById('a-lieu').value,
    type: document.getElementById('a-type').value,
    lien: lienVal || null
  };

  const url = id ? `${API}/api/agenda/${id}` : `${API}/api/voyages/${voyageActuel}/agenda`;
  const method = id ? 'PUT' : 'POST';

  // ── Étape 1 : sauvegarder (erreur remontée à l'utilisateur) ──────────────
  let saveOk = false;
  try {
    const resp = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${resp.status}`);
    }
    saveOk = true;
  } catch(err) {
    console.error('sauvegarderAgenda – erreur save:', err);
    const msg = err.message || String(err);
    // Afficher l'erreur dans une alerte pour que l'utilisateur puisse copier le message exact
    alert(`❌ Erreur création événement :\n\n${msg}\n\n(Copie ce message et envoie-le pour diagnostic)`);
    if (submitBtn) submitBtn.disabled = false;
    return;
  }

  // ── Étape 2 : feedback + rechargement (erreurs silencieuses) ─────────────
  if (saveOk) {
    fermerModal('modal-agenda');
    toast(id ? '✅ Événement modifié' : '✅ Événement ajouté');
    chargerProgramme().catch(e => console.warn('chargerProgramme post-save:', e));
  }
}

async function supprimerAgenda(id) {
  if (!confirm('Supprimer cet événement ?')) return;
  const r = await fetch(`${API}/api/agenda/${id}`, { method: 'DELETE' });
  if (!r.ok) { toast('❌ Erreur lors de la suppression'); return; }
  toast('🗑️ Événement supprimé');
  await chargerProgramme();
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
    container.innerHTML = `<div class="empty-tab"><div class="empty-tab-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="36" height="36" style="opacity:.35"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></div><p>Aucun document ajouté</p></div>`;
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
            if (resa) lienHtml = `<div class="doc-event-link">${iconeResa[resa.type] || '📌'} ${h(resa.titre)}</div>`;
            else if (ev) lienHtml = `<div class="doc-event-link">📅 ${h(ev.titre)}</div>`;
            return `
            <div class="doc-card">
              <span class="doc-icon">${getDocIcon(d.type_fichier)}</span>
              <div class="doc-body">
                <div class="doc-nom">${h(d.nom)}</div>
                <div class="doc-meta">${formatTaille(d.taille)} · ${formatDate(d.created_at?.split('T')[0])}</div>
                ${lienHtml}
              </div>
              <div class="doc-actions">
                <button class="btn-mini btn-mini-view" onclick="ouvrirDocViewer(${d.id}, \`${d.nom.replace(/`/g, '')}\`)" title="Ouvrir">👁️</button>
                <button class="btn-mini btn-mini-edit" onclick="modifierDocument(${d.id})" title="Modifier"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>
                <button class="btn-mini btn-mini-del" onclick="supprimerDocument(${d.id})" title="Supprimer"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
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

    const icones = { transport: cgoIcon('send',32), hebergement: cgoIcon('home',32), vehicule: cgoIcon('car',32), activite: cgoIcon('activity',32), restaurant: cgoIcon('food',32) };

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

// ─── SCAN / OCR ──────────────────────────────────────

let _scanFile = null;

function basculerModeDoc(mode) {
  const isScan = mode === 'scan';
  document.getElementById('doc-mode-fichier').classList.toggle('hidden', isScan);
  document.getElementById('doc-mode-scan').classList.toggle('hidden', !isScan);
  document.getElementById('scan-mode-fichier-btn').classList.toggle('active', !isScan);
  document.getElementById('scan-mode-scan-btn').classList.toggle('active', isScan);
  if (isScan) _prechargerTesseract();
}

function lancerScan(mode) {
  document.getElementById(mode === 'camera' ? 'scan-camera-input' : 'scan-file-input').click();
}

async function _prechargerTesseract() {
  if (typeof Tesseract !== 'undefined') return;
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js';
  document.head.appendChild(s);
}

async function traiterImageScan(input) {
  const file = input.files[0];
  if (!file) return;
  _scanFile = file;
  input.value = '';

  const area = document.getElementById('scan-result-area');
  area.classList.remove('hidden');
  document.getElementById('scan-nom-group').classList.add('hidden');
  document.getElementById('scan-confirm-btn').style.display = 'none';
  document.getElementById('scan-result-fields').innerHTML = '';

  // Aperçu image
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('scan-preview-img').src = e.target.result; };
  reader.readAsDataURL(file);

  // Attendre Tesseract
  const prog = document.getElementById('scan-progress-area');
  const fill = document.getElementById('scan-progress-fill');
  const pct  = document.getElementById('scan-progress-pct');
  const lbl  = document.getElementById('scan-progress-label');
  prog.classList.remove('hidden');
  lbl.textContent = 'Chargement du moteur OCR…';

  try {
    await new Promise((res, rej) => {
      if (typeof Tesseract !== 'undefined') return res();
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });

    lbl.textContent = 'Analyse du document…';

    const result = await Tesseract.recognize(file, 'fra+eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          const p = Math.round(m.progress * 100);
          fill.style.width = `${p}%`;
          pct.textContent = `${p}%`;
        }
      }
    });

    prog.classList.add('hidden');
    const infos = _extraireInfosDoc(result.data.text);
    _afficherInfosScan(infos);

  } catch(e) {
    prog.classList.add('hidden');
    document.getElementById('scan-result-fields').innerHTML =
      `<p style="color:var(--danger);font-size:.83rem">❌ Erreur lors de l'analyse. Le fichier sera importé sans extraction.</p>`;
    document.getElementById('doc-scan-nom').value = file.name;
    document.getElementById('scan-nom-group').classList.remove('hidden');
    document.getElementById('scan-confirm-btn').style.display = '';
  }
}

function _extraireInfosDoc(text) {
  const t = text;
  const infos = {};

  // Dates (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY-MM-DD)
  const dateRx = /\b(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})\b|\b(\d{4})[\/\-](\d{2})[\/\-](\d{2})\b/g;
  const dates = [];
  let dm;
  while ((dm = dateRx.exec(t)) !== null) dates.push(dm[0]);
  // Dates textuelles FR
  const moisFR = 'janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre';
  const dateTexRx = new RegExp(`\\b(\\d{1,2})\\s+(${moisFR})\\s+(\\d{4})\\b`, 'gi');
  while ((dm = dateTexRx.exec(t)) !== null) dates.push(dm[0]);
  if (dates.length) infos.dates = [...new Set(dates)].slice(0, 4);

  // Vol IATA (ex: AF1234, EK 456)
  const volMatch = t.match(/\b([A-Z]{2}\s?\d{3,4})\b/);
  if (volMatch) infos.vol = volMatch[1].replace(/\s/, '');

  // Numéro de confirmation / référence
  const refRx = /(?:confirmation|booking|réservation|reference|ref\.?|n°|numéro|pnr|dossier|code)\s*:?\s*([A-Z0-9]{5,14})/gi;
  const rm = refRx.exec(t);
  if (rm) infos.reference = rm[1];
  // Fallback : code alphanum ≥6 chars uppercase seul sur sa ligne
  if (!infos.reference) {
    const codeRx = /^([A-Z0-9]{6,12})$/gm;
    const cm = codeRx.exec(t);
    if (cm) infos.reference = cm[1];
  }

  // Montant
  const montantRx = /(\d[\d\s]*[.,]\d{2})\s*€|€\s*(\d[\d\s]*[.,]\d{2})|(\d[\d\s]*[.,]\d{2})\s*EUR/i;
  const mm = montantRx.exec(t);
  if (mm) infos.montant = (mm[1] || mm[2] || mm[3]).trim() + ' €';

  // Email
  const emailMatch = t.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6}/);
  if (emailMatch) infos.email = emailMatch[0];

  // Nom suggéré
  const parts = [];
  if (infos.vol) parts.push(`Billet ${infos.vol}`);
  else if (infos.reference) parts.push(`Réf. ${infos.reference}`);
  if (infos.dates && infos.dates[0]) parts.push(infos.dates[0].replace(/\//g, '-'));
  infos.nomSuggere = parts.length ? parts.join(' — ') : 'Document scanné';

  return infos;
}

function _afficherInfosScan(infos) {
  const container = document.getElementById('scan-result-fields');
  const rows = [];

  if (infos.vol)       rows.push(['✈️ Vol', infos.vol]);
  if (infos.reference) rows.push(['🔢 Référence', infos.reference]);
  if (infos.dates?.length) rows.push(['📅 Date(s)', infos.dates.join(' · ')]);
  if (infos.montant)   rows.push(['💶 Montant', infos.montant]);
  if (infos.email)     rows.push(['📧 Email', infos.email]);

  if (rows.length === 0) {
    container.innerHTML = `<p class="scan-no-data">Aucune information structurée détectée — le document sera importé tel quel.</p>`;
  } else {
    container.innerHTML = `<div class="scan-fields">${rows.map(([l, v]) =>
      `<div class="scan-field"><span class="scan-fl">${l}</span><span class="scan-fv">${h(v)}</span></div>`
    ).join('')}</div>`;
  }

  document.getElementById('doc-scan-nom').value = infos.nomSuggere;
  document.getElementById('scan-nom-group').classList.remove('hidden');
  document.getElementById('scan-confirm-btn').style.display = '';
}

async function confirmerImportScan() {
  if (!_scanFile) return;
  const btn = document.getElementById('scan-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Import en cours…';

  const nom = (document.getElementById('doc-scan-nom').value || _scanFile.name).trim();
  const ext = _scanFile.name.includes('.') ? _scanFile.name.split('.').pop() : 'jpg';
  const fichier = new File([_scanFile], `${nom}.${ext}`, { type: _scanFile.type });

  const formData = new FormData();
  formData.append('fichier', fichier);
  formData.append('categorie', document.getElementById('doc-type').value);

  const lienVal = document.getElementById('doc-lien-select').value;
  if (lienVal.startsWith('resa:'))  formData.append('reservation_id', lienVal.split(':')[1]);
  else if (lienVal.startsWith('event:')) formData.append('event_id', lienVal.split(':')[1]);

  const resp = await fetch(`${API}/api/voyages/${voyageActuel}/documents`, { method: 'POST', body: formData });
  btn.disabled = false;
  btn.textContent = '✅ Importer ce document';
  if (resp.ok) {
    fermerModal('modal-document');
    _scanFile = null;
    toast('✅ Document importé');
    chargerAdmin();
  } else {
    toast('❌ Erreur lors de l\'import');
  }
}

async function uploaderDocument(input) {
  const file = input.files[0];
  if (!file) return;

  document.getElementById('doc-filename').innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" style="flex-shrink:0;vertical-align:middle;margin-right:3px"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>${file.name}`;

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
    const icones = { transport: cgoIcon('send',32), hebergement: cgoIcon('home',32), vehicule: cgoIcon('car',32), activite: cgoIcon('activity',32), restaurant: cgoIcon('food',32) };

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

  const r = await fetch(`${API}/api/documents/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) { toast('❌ Erreur lors de la modification'); return; }

  fermerModal('modal-doc-edit');
  toast('✅ Document modifié');
  chargerAdmin();
}

// ─── VISUALISEUR DOCUMENT ───────────────────────────

function ouvrirDocViewerFromEl(el) {
  const id = parseInt(el.dataset.docId, 10);
  const nom = el.dataset.docNom;
  ouvrirDocViewer(id, nom);
}

function ouvrirDocViewer(docId, nom) {
  const url = `${API}/api/documents/${docId}/download`;
  document.getElementById('doc-viewer-nom').textContent = nom;
  document.getElementById('doc-viewer-frame').src = url;
  const dl = document.getElementById('doc-viewer-dl');
  if (dl) dl.href = url;
  document.getElementById('modal-doc-viewer').classList.remove('hidden');
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
      <span class="avatar-nom">${h(p.nom)}</span>
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
          <span class="bagage-nom">${h(item.nom)}</span>
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
      const dateDebut = toDateStr(voyage.date_debut) || new Date().toISOString().split('T')[0];
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
  const depContainer = document.getElementById('liste-depenses');
  if (depContainer) depContainer.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted)">Chargement…</div>';
  const [participants, depenses] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/participants`).then(r => r.ok ? r.json() : []).catch(() => []),
    fetch(`${API}/api/voyages/${voyageActuel}/depenses`).then(r => r.ok ? r.json() : []).catch(() => [])
  ]);
  const safeParticipants = Array.isArray(participants) ? participants : [];
  const safeDepenses     = Array.isArray(depenses)     ? depenses     : [];
  participantsActuels = safeParticipants;
  afficherParticipants(safeParticipants);
  afficherDepenses(safeDepenses, safeParticipants);
  afficherBilan(safeDepenses, safeParticipants);
}

function afficherParticipants(participants) {
  const container = document.getElementById('liste-participants');
  if (participants.length === 0) {
    container.innerHTML = `<p style="font-size:.82rem;color:var(--text-muted);padding:8px 0">Ajoute les personnes du voyage pour partager les dépenses</p>`;
    return;
  }
  container.innerHTML = `<div class="avatars-row">${participants.map(p => `
    <div class="avatar-chip" data-participant-id="${p.id}">
      <div class="avatar" style="background:${p.couleur}">${h(p.nom[0].toUpperCase())}</div>
      <span class="avatar-nom">${h(p.nom)}</span>
      <button class="avatar-pin ${p.pin ? 'has-pin' : ''}" title="${p.pin ? 'Modifier le PIN' : 'Ajouter un PIN'}"
        onclick="ouvrirModalPin(${p.id},'${p.nom.replace(/'/g,"\\'")}','${p.pin||''}')">
        ${p.pin
          ? `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>`
          : `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5C9.25 1 7.13 2.97 7 5.5h1.9c.14-1.47 1.36-2.6 2.85-2.6C13.27 2.9 14.5 4.13 14.5 5.5H8c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2z"/></svg>`}
      </button>
      <button class="avatar-del" onclick="supprimerParticipant(${p.id})" title="Supprimer">×</button>
    </div>
  `).join('')}</div>`;
}

function afficherDepenses(depenses, participants) {
  const container = document.getElementById('liste-depenses');
  const byId = {};
  participants.forEach(p => { byId[p.id] = p; });

  if (depenses.length === 0) {
    container.innerHTML = `<div class="empty-tab" style="padding:52px 24px">
  <div class="empty-state-visual">
    <svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="8" y="22" width="60" height="40" rx="10" fill="#FFF7ED"/>
      <rect x="8" y="32" width="60" height="12" fill="#FDBA74" opacity=".45"/>
      <rect x="16" y="47" width="18" height="8" rx="4" fill="#F97316" opacity=".25"/>
      <rect x="38" y="47" width="12" height="8" rx="4" fill="#F97316" opacity=".15"/>
      <circle cx="58" cy="28" r="11" fill="#FFF7ED" stroke="#FDBA74" stroke-width="1.5"/>
      <path d="M58 23.5v5h3.5" stroke="#F97316" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>
  </div>
  <p class="empty-state-title" style="font-size:.95rem;margin:0 0 6px">Aucune dépense</p>
  <p class="empty-state-sub" style="margin:0 0 18px">Enregistrez les dépenses du groupe pour calculer automatiquement qui doit combien à qui.</p>
  <button class="empty-state-cta" onclick="ouvrirModalDepense()">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
    Ajouter une dépense
  </button>
</div>`;
    return;
  }

  const total = depenses.reduce((s, d) => s + parseFloat(d.montant || 0), 0);
  const icones = {
    hebergement: cgoIcon('home',32),
    transport:   cgoIcon('send',32),
    restauration:cgoIcon('food',32),
    activite:    cgoIcon('activity',32),
    courses:     cgoIcon('wallet',32),
    autre:       cgoIcon('document',32)
  };

  container.innerHTML = `
    <div class="budget-total-bar">
      <span class="budget-total-label">Total dépenses</span>
      <span class="budget-total-amount">${total.toFixed(2)} €</span>
    </div>
    <div style="padding:0 16px 12px;display:flex;flex-direction:column;gap:8px">
      ${depenses.map(d => {
        const payeur = byId[d.payeur_id];
        const rawParts = parseIds(d.participants_ids);
        const allParts = rawParts.length > 0 ? rawParts : participants.map(p => p.id);
        const isTous = rawParts.length === 0;
        const share = allParts.length > 0 ? (parseFloat(d.montant) / allParts.length).toFixed(2) : '—';
        const partsLabel = isTous ? `Tous · ${share}€/pers.` : `${allParts.length} pers. · ${share}€/pers.`;
        return `
        <div class="depense-card">
          <div class="depense-cat">${icones[d.categorie] || cgoIcon('document',32)}</div>
          <div class="depense-body">
            <div class="depense-titre">${h(d.titre)}</div>
            <div class="depense-meta">
              ${d.date ? `<span>${formatDate(d.date)}</span>` : ''}
              ${payeur ? `<span style="display:inline-flex;align-items:center;gap:4px"><span class="avatar-xs" style="background:${payeur.couleur}">${h(payeur.nom[0])}</span>${h(payeur.nom)} a payé</span>` : ''}
              <span>${partsLabel}</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <span class="depense-montant">${parseFloat(d.montant).toFixed(2)}€</span>
            <div style="display:flex;gap:4px">
              <button class="btn-mini btn-mini-edit" onclick="modifierDepense(${d.id})" title="Modifier"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>
              <button class="btn-mini btn-mini-del" onclick="supprimerDepense(${d.id})" title="Supprimer"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

function afficherBilan(depenses, participants) {
  const section = document.getElementById('section-bilan');
  const container = document.getElementById('bilan-content');
  if (depenses.length === 0) { section.style.display = 'none'; return; }
  // Vérifier qu'au moins une dépense a un payeur défini
  const hasPayeur = depenses.some(d => d.payeur_id != null);
  if (!hasPayeur) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const byId = {};
  participants.forEach(p => { byId[p.id] = p; });

  // Calculer les soldes nets
  const net = {};
  participants.forEach(p => { net[p.id] = 0; });

  depenses.forEach(d => {
    if (d.payeur_id == null) return; // ignore expenses without a payeur
    const rawParts = parseIds(d.participants_ids);
    const parts = (rawParts.length > 0 ? rawParts : participants.map(p => p.id))
      .filter(pid => net[+pid] !== undefined);
    if (!parts.length) return;
    const share = parseFloat(d.montant) / parts.length;
    if (!isFinite(share)) return;
    parts.forEach(pid => {
      if (+pid !== +d.payeur_id) {
        if (net[+d.payeur_id] !== undefined) net[+d.payeur_id] += share;
        net[+pid] -= share;
      }
    });
  });

  // Snapshot avant simplification — net est muté ci-dessous, on en a besoin pour l'affichage
  const netSnapshot = { ...net };

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

  // ── Solde par personne — graphique à barres centré ──────────────────────────
  // Utilise netSnapshot (avant simplification) — net lui-même est à 0 après le while
  const maxAbs = Math.max(...participants.map(p => Math.abs(netSnapshot[p.id])), 0.01);
  const balanceSection = `
    <div style="padding:14px 16px 6px">
      <span style="font-size:.7rem;font-weight:700;color:var(--text-muted);letter-spacing:.07em;text-transform:uppercase">Solde par personne</span>
    </div>
    <div class="balance-grid">
      ${participants.map(p => {
        const amount   = Math.round(netSnapshot[p.id] * 100) / 100;
        const isCredit = amount > 0.01;
        const isDebt   = amount < -0.01;
        const pct      = Math.min(Math.abs(amount) / maxAbs * 50, 50);
        const amtStr   = isCredit ? `+${amount.toFixed(2)} €`
                       : isDebt   ? `${amount.toFixed(2)} €`
                       :            `0 €`;
        const amtCls   = isCredit ? 'balance-amount--credit'
                       : isDebt   ? 'balance-amount--debt'
                       :            'balance-amount--zero';
        return `
          <div class="balance-row">
            <div class="balance-row-name">
              <div class="avatar" style="background:${h(p.couleur)};width:22px;height:22px;font-size:.6rem;flex-shrink:0">${h(p.nom[0].toUpperCase())}</div>
              <span>${h(p.nom)}</span>
            </div>
            <div class="balance-bar-track">
              ${isCredit ? `<div class="balance-bar-fill balance-bar-fill--credit" style="width:${pct}%"></div>` : ''}
              ${isDebt   ? `<div class="balance-bar-fill balance-bar-fill--debt"   style="width:${pct}%"></div>` : ''}
            </div>
            <span class="balance-amount ${amtCls}">${amtStr}</span>
          </div>`;
      }).join('')}
    </div>`;

  if (transactions.length === 0) {
    container.innerHTML = balanceSection +
      `<div class="bilan-ok"><svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Tout est équilibré !</div>`;
    return;
  }

  container.innerHTML = balanceSection +
    `<div style="padding:6px 16px 4px">
      <span style="font-size:.7rem;font-weight:700;color:var(--text-muted);letter-spacing:.07em;text-transform:uppercase">Remboursements</span>
    </div>
    <div style="padding:0 16px 16px;display:flex;flex-direction:column;gap:8px">
      ${transactions.map(t => `
        <div class="bilan-transaction">
          <div class="bilan-from">
            <div class="avatar" style="background:${h(t.from.couleur)}">${h(t.from.nom[0])}</div>
            <span>${h(t.from.nom)}</span>
          </div>
          <div class="bilan-arrow">
            <span class="bilan-amount">${t.amount.toFixed(2)} €</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
          </div>
          <div class="bilan-to">
            <div class="avatar" style="background:${h(t.to.couleur)}">${h(t.to.nom[0])}</div>
            <span>${h(t.to.nom)}</span>
          </div>
        </div>
      `).join('')}
    </div>`;
}

function ouvrirModalParticipant() {
  document.getElementById('p-nom').value = '';
  document.getElementById('p-pin').value = '';
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
  if (!voyageActuel) { toast('⚠️ Aucun voyage sélectionné'); return; }
  const nom = document.getElementById('p-nom').value.trim();
  if (!nom) { toast('⚠️ Entre un prénom'); return; }
  const pin = document.getElementById('p-pin').value.trim() || null;
  try {
    const r = await fetch(`${API}/api/voyages/${voyageActuel}/participants`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nom, couleur: document.getElementById('p-couleur').value, pin })
    });
    if (!r.ok) {
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        toast(`⚠️ "${nom}" est déjà dans le crew`);
        // Highlight the existing participant if duplicateId provided
        if (data.duplicateId) {
          fermerModal('modal-participant');
          setTimeout(() => {
            const el = document.querySelector(`[data-participant-id="${data.duplicateId}"]`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.classList.add('highlight-pulse');
              setTimeout(() => el.classList.remove('highlight-pulse'), 1600);
            }
          }, 300);
        }
        return;
      }
      const data = await r.json().catch(() => null);
      const msg = data?.error || '';
      toast(`❌ Erreur lors de l'ajout${msg ? ' : ' + msg : ''}`);
      return;
    }
    fermerModal('modal-participant');
    toast('✅ Participant ajouté');
    chargerAccueil();
  } catch (e) {
    console.error('sauvegarderParticipant:', e);
    toast('❌ Erreur réseau, réessaie');
  }
}

function ouvrirModalPin(id, nom, pinActuel) {
  document.getElementById('pin-participant-id').value = id;
  document.getElementById('modal-pin-titre').textContent = `PIN — ${nom}`;
  document.getElementById('pin-valeur').value = pinActuel || '';
  document.getElementById('modal-pin').classList.remove('hidden');
  setTimeout(() => document.getElementById('pin-valeur').focus(), 300);
}

async function sauvegarderPin() {
  const id = document.getElementById('pin-participant-id').value;
  const pin = document.getElementById('pin-valeur').value.trim() || null;
  const p = participantsActuels.find(x => x.id === +id);
  if (!p) return;
  const r = await fetch(`${API}/api/participants/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nom: p.nom, couleur: p.couleur, pin })
  });
  if (!r.ok) { toast('❌ Erreur lors de la sauvegarde'); return; }
  fermerModal('modal-pin');
  toast(pin ? '🔒 PIN enregistré' : '🔓 PIN retiré');
  chargerAccueil();
}

async function supprimerParticipant(id) {
  if (!confirm('Supprimer ce participant ?')) return;
  const r = await fetch(`${API}/api/participants/${id}`, { method: 'DELETE' });
  if (!r.ok) { toast('❌ Erreur lors de la suppression'); return; }
  toast('🗑️ Participant supprimé');
  chargerAccueil();
}

async function ouvrirModalDepense(id = null) {
  // Défensif : si un Event est passé à la place d'un id (handler direct sur click)
  if (id instanceof Event || (id !== null && typeof id === 'object')) id = null;
  document.getElementById('modal-depense-titre').textContent = id ? 'Modifier la dépense' : 'Nouvelle dépense';
  document.getElementById('dep-id').value = id || '';
  document.getElementById('dep-date').value = new Date().toISOString().split('T')[0];

  // Charger les participants à la volée si l'onglet budget n'a jamais été ouvert
  if (participantsActuels.length === 0) {
    participantsActuels = await fetch(`${API}/api/voyages/${voyageActuel}/participants`)
      .then(r => r.ok ? r.json() : []).catch(() => []);
  }
  const participants = Array.isArray(participantsActuels) ? participantsActuels : [];
  if (participants.length === 0) {
    toast('⚠️ Ajoute d\'abord les participants au voyage');
    return;
  }

  // Remplir les sélecteurs
  document.getElementById('dep-payeur-list').innerHTML = participants.map((p, i) => `
    <label class="participant-radio">
      <input type="radio" name="dep-payeur" value="${p.id}" ${i === 0 ? 'checked' : ''}>
      <div class="avatar" style="background:${p.couleur}">${h(p.nom[0].toUpperCase())}</div>
      <span>${h(p.nom)}</span>
    </label>
  `).join('');

  document.getElementById('dep-participants-list').innerHTML = participants.map(p => `
    <label class="participant-check">
      <input type="checkbox" name="dep-part" value="${p.id}" checked>
      <div class="avatar" style="background:${p.couleur}">${h(p.nom[0].toUpperCase())}</div>
      <span>${h(p.nom)}</span>
    </label>
  `).join('');

  if (!id) {
    document.getElementById('dep-titre').value = '';
    document.getElementById('dep-montant').value = '';
    document.getElementById('dep-categorie').value = 'autre';
  } else {
    const dep = await fetch(`${API}/api/voyages/${voyageActuel}/depenses`)
      .then(r => r.ok ? r.json() : []).catch(() => [])
      .then(list => list.find(d => d.id === id));
    if (dep) {
      document.getElementById('dep-titre').value = dep.titre;
      document.getElementById('dep-montant').value = dep.montant;
      document.getElementById('dep-date').value = toDateStr(dep.date);
      document.getElementById('dep-categorie').value = dep.categorie || 'autre';
      const parts = parseIds(dep.participants_ids).map(Number);
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
  if (!id && !voyageActuel) { toast('⚠️ Aucun voyage sélectionné'); return; }
  const url = id ? `${API}/api/depenses/${id}` : `${API}/api/voyages/${voyageActuel}/depenses`;
  const method = id ? 'PUT' : 'POST';

  const btn = document.getElementById('btn-sauvegarder-depense');
  if (btn) { btn.disabled = true; btn.textContent = 'Enregistrement…'; }

  const resp = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).catch(() => null);

  if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer'; }

  if (!resp) {
    toast('❌ Serveur injoignable — vérifie ta connexion');
    return;
  }
  if (resp.status === 401) {
    fermerModal('modal-depense');
    toast('⚠️ Session expirée — reconnecte-toi');
    return;
  }
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    toast('❌ ' + (body.error || 'Erreur ' + resp.status));
    return;
  }

  fermerModal('modal-depense');
  toast(id ? '✅ Dépense modifiée' : '✅ Dépense ajoutée');
  chargerBudget();
}

async function supprimerDepense(id) {
  if (!confirm('Supprimer cette dépense ?')) return;
  const resp = await fetch(`${API}/api/depenses/${id}`, { method: 'DELETE' }).catch(() => null);
  if (!resp || !resp.ok) { toast('❌ Erreur lors de la suppression'); return; }
  toast('🗑️ Dépense supprimée');
  chargerBudget();
}

// ─── ADMIN ────────────────────────────────────────────

async function chargerAdmin() {
  const container = document.getElementById('admin-content');
  container.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-muted)">Chargement…</div>`;

  const safe = url => fetch(url).then(r => r.ok ? r.json() : []).catch(() => []);
  const [reservations, documents, demandes, attributions, participants, docsParticipants, photosAdmin] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/reservations`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/documents`).then(r => r.json()),
    safe(`${API}/api/voyages/${voyageActuel}/demandes`),
    safe(`${API}/api/voyages/${voyageActuel}/attributions`),
    safe(`${API}/api/voyages/${voyageActuel}/participants`),
    safe(`${API}/api/voyages/${voyageActuel}/docs-participants`),
    _shareTokenCourant ? safe(`${API}/api/partage/${_shareTokenCourant}/photos`) : Promise.resolve([])
  ]);

  // Badge sur l'onglet Admin si demandes en attente
  const enAttente = demandes.filter(d => d.statut === 'en_attente').length;
  const adminTab = document.querySelector('[data-tab="admin"]');
  if (adminTab) {
    const existing = adminTab.querySelector('.tab-badge');
    if (existing) existing.remove();
    if (enAttente > 0) {
      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.textContent = enAttente;
      badge.style.cssText = 'background:#EF4444;color:#fff;border-radius:10px;font-size:.65rem;font-weight:800;padding:2px 6px;margin-left:4px';
      adminTab.appendChild(badge);
    }
  }
  // Indicateur ambiant : pastille sur le kebab « ⋯ » + compteur sur la ligne Administration
  const menuDot = document.getElementById('menu-voyage-badge');
  if (menuDot) menuDot.style.display = (enAttente > 0) ? 'block' : 'none';
  const sheetAdminBadge = document.getElementById('sheet-admin-badge');
  if (sheetAdminBadge) {
    sheetAdminBadge.style.display = (enAttente > 0) ? 'inline-block' : 'none';
    sheetAdminBadge.textContent = enAttente;
  }

  // Alimenter les caches pour voirReservation()
  _resasCache = reservations;
  _docsCache  = documents;

  const catLabels = { transport:'Transport', hebergement:'Hébergement', activite:'Activité', identite:'Identité', visa:'Visa', assurance:'Assurance', autre:'Autre' };

  // Pré-calculer le HTML des docs participants
  const byId = {};
  participants.forEach(p => { byId[p.id] = p; });
  let docsPartHtml;
  if (!Array.isArray(docsParticipants) || docsParticipants.length === 0) {
    docsPartHtml = `<div class="adm-empty" style="padding:14px 16px"><p style="margin:0;font-size:.83rem;color:var(--text-muted)">Aucun document déposé par les participants.</p></div>`;
  } else {
    const byPart2 = {};
    docsParticipants.forEach(d => { if (!byPart2[d.participant_id]) byPart2[d.participant_id] = []; byPart2[d.participant_id].push(d); });
    docsPartHtml = `<div style="padding:8px 12px;display:flex;flex-direction:column;gap:10px">` +
      Object.entries(byPart2).map(([pid, docs]) => {
        const p = byId[+pid];
        return `<div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <div class="avatar" style="background:${p?.couleur||'#6366F1'};width:26px;height:26px;font-size:.65rem;flex-shrink:0">${h((p?.nom||'?')[0].toUpperCase())}</div>
            <span style="font-weight:700;font-size:.88rem">${h(p?.nom||'Participant #'+pid)}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;padding-left:34px">` +
          docs.map(d => `<div class="adm-row">
            <span class="adm-row-icon">${getDocIcon(d.type_fichier)}</span>
            <div class="adm-row-body">
              <div class="adm-row-titre">${h(d.nom)}</div>
              ${d.taille ? `<div class="adm-row-meta"><span>${formatTaille(d.taille)}</span></div>` : ''}
            </div>
            <div class="adm-row-actions">
              <a href="${API}/api/voyages/${voyageActuel}/docs-participants/${d.id}/download" target="_blank" class="btn-mini adm-btn-link" title="Télécharger"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></a>
            </div>
          </div>`).join('') +
          `</div></div>`;
      }).join('') + `</div>`;
  }

  // Pré-calculer le HTML des attributions (évite les IIFE instables dans template)
  let attributionsHtml;
  if (!Array.isArray(attributions) || attributions.length === 0) {
    attributionsHtml = `<div class="adm-empty" style="padding:14px 16px">
      <p style="margin:0 0 4px">Aucune attribution.</p>
      <p style="font-size:.78rem;color:var(--text-muted);margin:0">Assignez un billet, numéro de siège ou document privé à chaque participant — et attachez-y des liens partageables (billet en ligne, QR code…).</p>
    </div>`;
  } else {
    const byPart = {};
    attributions.forEach(a => { if (!byPart[a.participant_id]) byPart[a.participant_id] = []; byPart[a.participant_id].push(a); });
    attributionsHtml = `<div style="padding:8px 12px;display:flex;flex-direction:column;gap:10px">` +
      Object.entries(byPart).map(([pid, attrs]) => {
        const p = byId[+pid];
        return `<div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <div class="avatar" style="background:${p?.couleur||'#C9622F'};width:26px;height:26px;font-size:.65rem;flex-shrink:0">${h((p?.nom||'?')[0].toUpperCase())}</div>
            <span style="font-weight:700;font-size:.88rem">${h(p?.nom||'Participant #'+pid)}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;padding-left:34px">` +
          attrs.map(a => {
            const links = Array.isArray(a.links) ? a.links : [];
            const linksHtml = links.length === 0 ? '' :
              `<div class="attr-links-section">` +
              links.map(l => `
                <div class="attr-link-row"
                  data-link-id="${l.id}"
                  data-link-type="${h(l.type)}"
                  data-link-titre="${h(l.titre)}"
                  data-link-url="${h(l.url)}"
                  data-link-desc="${h(l.description || '')}">
                  <div class="attr-link-type-badge" style="background:${_attrLinkTypeColor(l.type)}">${_attrLinkTypeIcon(l.type)}</div>
                  <div class="attr-link-info">
                    <div class="attr-link-title">${h(l.titre)}</div>
                    <div class="attr-link-url">${h(l.url)}</div>
                  </div>
                  <div class="attr-link-actions">
                    <button class="attr-link-btn" onclick="ouvrirModalEditerLien(${l.id})" title="Modifier">✏️</button>
                    <button class="attr-link-btn attr-link-btn--del" onclick="supprimerLienAttribution(${l.id})" title="Supprimer">🗑️</button>
                  </div>
                </div>`).join('') +
              `</div>`;
            return `<div style="background:var(--bg);border-radius:10px;padding:10px 12px;border:1px solid var(--border-solid)">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
                <div style="flex:1;min-width:0">
                  <div style="font-weight:700;font-size:.85rem;margin-bottom:2px">${h(a.titre)}</div>
                  ${a.contenu ? `<div style="font-size:.8rem;color:var(--text-muted);line-height:1.4;white-space:pre-wrap">${h(a.contenu)}</div>` : ''}
                  ${a.document_id ? `<div style="margin-top:6px"><span class="resa-badge-mini resa-badge-doc" style="display:inline-flex;align-items:center;gap:3px"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>Document lié</span></div>` : ''}
                </div>
                <button class="btn-mini btn-mini-del" onclick="supprimerAttribution(${a.id})" title="Supprimer" style="flex-shrink:0"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
              </div>
              ${linksHtml}
              <button class="attr-add-link-btn" onclick="ouvrirModalAjouterLien(${a.id})">+ Ajouter un lien</button>
            </div>`;
          }).join('') +
          `</div></div>`;
      }).join('') + `</div>`;
  }

  container.innerHTML = `
    <!-- ── Sous-navigation sticky ── -->
    <nav class="adm-sub-nav">
      <button class="adm-sub-btn" data-tab="reservations" onclick="_activerSousOngletAdmin('reservations')">
        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v4c1.1 0 2 .9 2 2s-.9 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2zm-5 5.5H9v-3h6v3zm0-6H9v-3h6v3zm0-6H9v-3h6v3z"/></svg>Réservations
      </button>
      <button class="adm-sub-btn" data-tab="documents" onclick="_activerSousOngletAdmin('documents')">
        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>Documents
      </button>
      <button class="adm-sub-btn" data-tab="demandes" onclick="_activerSousOngletAdmin('demandes')">
        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>Demandes${enAttente > 0 ? `<span class="adm-sub-badge">${enAttente}</span>` : ''}
      </button>
      <button class="adm-sub-btn" data-tab="attributions" onclick="_activerSousOngletAdmin('attributions')">
        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>Attributions
      </button>
      <button class="adm-sub-btn" data-tab="photos" onclick="_activerSousOngletAdmin('photos')">
        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>Photos${photosAdmin.length > 0 ? `<span class="adm-sub-badge">${photosAdmin.length}</span>` : ''}
      </button>
      <button class="adm-sub-btn adm-sub-btn--more" onclick="_toggleAdminMore(this)"
        style="opacity:.65">
        <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>Plus
      </button>
    </nav>

    <!-- Boutons avancés (repliés par défaut) -->
    <div id="adm-more-btns" style="display:none;padding:0 12px 8px;display:none">
      <div style="display:flex;gap:6px;flex-wrap:wrap;padding:8px 0">
        <button class="adm-sub-btn" data-tab="attributions" onclick="_activerSousOngletAdmin('attributions')" style="flex:0 0 auto">
          <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>Attributions
        </button>
        <button class="adm-sub-btn" data-tab="docs-participants" onclick="_activerSousOngletAdmin('docs-participants')" style="flex:0 0 auto">
          <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>Docs invités
        </button>
      </div>
    </div>

    <!-- ── Section Réservations ── -->
    <div id="adm-sub-reservations">
      <div class="adm-stats">
        <div class="adm-stat"><span class="adm-stat-n">${reservations.length}</span><span class="adm-stat-l">Réservations</span></div>
      </div>
      <div class="adm-section">
        <div class="adm-section-head">
          <span class="adm-section-title">Réservations</span>
          <button class="btn-mini-add" onclick="ouvrirModalReservation()">+ Ajouter</button>
        </div>
        ${reservations.length === 0 ? `<div class="adm-empty">Aucune réservation</div>` : `
        <div style="padding:8px 12px">
          ${reservations.map(r => renderResa(r, documents.filter(d => d.reservation_id == r.id))).join('')}
        </div>`}
      </div>
    </div>

    <!-- ── Section Documents ── -->
    <div id="adm-sub-documents">
      <div class="adm-stats">
        <div class="adm-stat"><span class="adm-stat-n">${documents.length}</span><span class="adm-stat-l">Documents</span></div>
      </div>
      <div class="adm-section">
        <div class="adm-section-head">
          <span class="adm-section-title">Documents</span>
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
                <div class="adm-row-titre">${h(doc.nom)}</div>
                <div class="adm-row-meta">
                  <span class="adm-row-cat">${cat}</span>
                  ${doc.taille ? `<span>${formatTaille(doc.taille)}</span>` : ''}
                </div>
              </div>
              <div class="adm-row-actions">
                <a href="${API}/api/documents/${doc.id}/download" target="_blank" class="btn-mini adm-btn-link" title="Télécharger"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></a>
                <button class="btn-mini btn-mini-edit" onclick="modifierDocument(${doc.id})" title="Modifier"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>
                <button class="btn-mini btn-mini-del" onclick="supprimerDocument(${doc.id})" title="Supprimer"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
              </div>
            </div>`;
          }).join('')}
        </div>`}
      </div>
    </div>

    <!-- ── Section Demandes invités ── -->
    <div id="adm-sub-demandes">
      <div class="adm-stats">
        <div class="adm-stat">
          <span class="adm-stat-n" style="${enAttente > 0 ? 'color:#EF4444' : ''}">${demandes.length}</span>
          <span class="adm-stat-l">Demandes${enAttente > 0 ? ` · ${enAttente} en attente` : ''}</span>
        </div>
      </div>
      <div class="adm-section">
        <div class="adm-section-head">
          <span class="adm-section-title">Demandes des invités</span>
        </div>
        ${demandes.length === 0
          ? `<div class="adm-empty">Aucune demande pour l'instant.</div>`
          : `<div style="padding:8px 12px;display:flex;flex-direction:column;gap:8px">
          ${demandes.map(d => `
          <div style="background:var(--bg);border-radius:12px;padding:12px 14px;border:1px solid var(--border-solid)">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
              <div style="flex:1;min-width:0">
                <div style="font-weight:700;font-size:.88rem">${h(d.auteur || 'Invité')} <span style="font-weight:400;color:var(--text-muted)">· ${h(d.onglet)} · ${h(d.element_nom || '')}</span></div>
                <div style="color:var(--text-muted);font-size:.82rem;margin-top:4px">${h(d.message)}</div>
                <div style="font-size:.72rem;color:var(--text-muted);margin-top:4px">${new Date(d.created_at).toLocaleString('fr-BE',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0;align-items:center">
                ${d.statut === 'en_attente' ? `
                <button class="btn-mini" style="background:#dcfce7;color:#16a34a;border:none;display:inline-flex;align-items:center;gap:4px" onclick="traiterDemande(${d.id},'traitee')"><svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Traité</button>
                <button class="btn-mini" style="background:#fee2e2;color:#dc2626;border:none;display:inline-flex;align-items:center;gap:4px" onclick="traiterDemande(${d.id},'rejetee')"><svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
                ` : `<span style="font-size:.75rem;color:var(--text-muted);padding:4px 8px;background:var(--border);border-radius:8px;display:inline-flex;align-items:center;gap:4px">${d.statut === 'traitee' ? '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Traité' : '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>Rejeté'}</span>`}
              </div>
            </div>
          </div>`).join('')}
        </div>`}
      </div>
    </div>

    <!-- ── Section Attributions privées ── -->
    <div id="adm-sub-attributions">
      <div class="adm-section">
        <div class="adm-section-head">
          <span class="adm-section-title">Attributions privées</span>
          <button class="btn-mini-add" onclick="ouvrirModalAttribution()">+ Attribuer</button>
        </div>
        ${attributionsHtml}
      </div>
    </div>

    <!-- ── Section Docs participants ── -->
    <div id="adm-sub-docs-participants">
      <div class="adm-section">
        <div class="adm-section-head">
          <span class="adm-section-title">Docs déposés par les participants</span>
        </div>
        ${docsPartHtml}
      </div>
    </div>

    <!-- ── Clôture du trip ── -->
    <div class="adm-cloture-footer">
      <div class="adm-cloture-inner">
        <div class="adm-cloture-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg></div>
        <div class="adm-cloture-text">
          <div class="adm-cloture-titre">Clôture du trip</div>
          <div class="adm-cloture-desc">Soldes finaux & archivage</div>
        </div>
        <button class="adm-cloture-btn" onclick="ouvrirCloture()">
          Clôturer
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>
    </div>

    <!-- ── Section Photos ── -->
    <div id="adm-sub-photos">
      <div class="adm-stats">
        <div class="adm-stat"><span class="adm-stat-n">${photosAdmin.length}</span><span class="adm-stat-l">Photos partagées</span></div>
      </div>
      <div class="adm-section">
        <div class="adm-section-head">
          <span class="adm-section-title">📸 Album photos — modération</span>
        </div>
        ${photosAdmin.length === 0
          ? `<div class="adm-empty" style="padding:20px 16px"><p style="margin:0;font-size:.83rem;color:var(--text-muted)">Aucune photo pour l'instant.</p></div>`
          : `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:8px 12px">
              ${photosAdmin.map(p => `
                <div style="position:relative;aspect-ratio:1;border-radius:6px;overflow:hidden;background:var(--bg)">
                  <img src="${API}/api/photos/${p.id}/img" alt="${h(p.caption||'')}" loading="lazy"
                    style="width:100%;height:100%;object-fit:cover">
                  <div style="position:absolute;inset:0;background:rgba(0,0,0,0);transition:background .2s"
                    onmouseenter="this.style.background='rgba(0,0,0,.3)'" onmouseleave="this.style.background='rgba(0,0,0,0)'">
                  </div>
                  <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,.6));padding:14px 5px 4px;font-size:.6rem;color:#fff;font-weight:600;display:flex;align-items:center;gap:3px">
                    <div style="width:7px;height:7px;border-radius:50%;background:${p.couleur};flex-shrink:0"></div>
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${h(p.auteur)}</span>
                  </div>
                  <button onclick="supprimerPhotoAdmin(${p.id})" title="Supprimer"
                    style="position:absolute;top:4px;right:4px;background:rgba(239,68,68,.9);border:none;color:#fff;width:22px;height:22px;border-radius:50%;font-size:.7rem;cursor:pointer;display:flex;align-items:center;justify-content:center;font-weight:900">✕</button>
                </div>`).join('')}
             </div>`}
      </div>
    </div>

    <div style="height:24px"></div>
  `;

  _activerSousOngletAdmin(_adminSousOnglet);
}

function _activerSousOngletAdmin(tab) {
  _adminSousOnglet = tab;
  ['reservations', 'documents', 'demandes', 'attributions', 'docs-participants', 'photos'].forEach(s => {
    const el = document.getElementById(`adm-sub-${s}`);
    if (el) el.style.display = s === tab ? '' : 'none';
  });
  document.querySelectorAll('.adm-sub-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  // Si l'onglet actif est un onglet "avancé", ouvrir automatiquement la section Plus
  const advancedTabs = ['attributions', 'docs-participants'];
  if (advancedTabs.includes(tab)) {
    const more = document.getElementById('adm-more-btns');
    if (more) more.style.display = '';
  }
}

function _toggleAdminMore(btn) {
  const more = document.getElementById('adm-more-btns');
  if (!more) return;
  const isOpen = more.style.display !== 'none';
  more.style.display = isOpen ? 'none' : '';
  btn.classList.toggle('active', !isOpen);
}

async function supprimerPhotoAdmin(id) {
  if (!confirm('Supprimer cette photo définitivement ?')) return;
  try {
    const r = await fetch(`${API}/api/photos/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    toast('🗑️ Photo supprimée');
    // Rafraîchir le bon onglet selon lequel est actif
    if (document.getElementById('tab-crewipics')?.classList.contains('active')) {
      chargerPhotosAdmin();
    } else {
      chargerAdmin();
    }
  } catch(e) { toast('❌ ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CREWIPICS — Album photo dans la vue admin
// ═══════════════════════════════════════════════════════════════════════════════

let _adminPhotosCache  = [];
let _adminPhotosLikes  = {};
let _adminPhotosSortBy = 'recent';
let _adminSelectedFile = null;
let _adminLightboxPhoto = null;

/** Retourne l'identité (nom + couleur) de l'admin dans le crew du voyage actuel.
 *  Priorité : session participant (créée via rejoindreVoyage) > currentUser.nom */
function _getAdminPhotoIdentite() {
  if (!_shareTokenCourant) return { nom: currentUser?.nom || 'Organisateur', couleur: '#F97316' };
  try {
    const s = JSON.parse(localStorage.getItem('partage_id_' + _shareTokenCourant) || 'null');
    if (s?.nom) return { nom: s.nom, couleur: s.couleur || '#F97316' };
  } catch {}
  return { nom: currentUser?.nom || 'Organisateur', couleur: '#F97316' };
}

/** Charge et affiche les photos CrewiPics dans la vue admin */
async function chargerPhotosAdmin() {
  const noSess = document.getElementById('crewipics-no-session');
  const main   = document.getElementById('crewipics-main');
  if (!noSess || !main) return;

  // Afficher l'upload uniquement si une session participant existe
  let hasSession = false;
  if (_shareTokenCourant) {
    try {
      const s = JSON.parse(localStorage.getItem('partage_id_' + _shareTokenCourant) || 'null');
      if (s?.nom) hasSession = true;
    } catch {}
  }
  noSess.style.display = hasSession ? 'none' : '';
  main.style.display   = hasSession ? ''     : 'none';

  if (!_shareTokenCourant) return;
  try {
    const [photos, likes] = await Promise.all([
      fetch(`${API}/api/partage/${_shareTokenCourant}/photos`).then(r => r.json()),
      fetch(`${API}/api/partage/${_shareTokenCourant}/photos/likes`).then(r => r.json()).catch(() => ({}))
    ]);
    _adminPhotosCache = Array.isArray(photos) ? photos : [];
    _adminPhotosLikes = likes || {};
    const sortBar = document.getElementById('adm-photos-sort-bar');
    if (sortBar) sortBar.style.display = _adminPhotosCache.length > 0 ? '' : 'none';
    _renderPhotosAdmin(_adminPhotosCache);
  } catch(e) { console.error('[crewipics admin]', e); }
}

function _setPhotoSortAdmin(mode) {
  _adminPhotosSortBy = mode;
  document.getElementById('adm-sort-chip-recent')?.classList.toggle('active', mode === 'recent');
  document.getElementById('adm-sort-chip-likes')?.classList.toggle('active', mode === 'likes');
  _renderPhotosAdmin(_adminPhotosCache);
}

function _renderPhotosAdmin(photosIn) {
  const grid  = document.getElementById('adm-photos-grid');
  const empty = document.getElementById('adm-photos-empty');
  if (!grid) return;
  grid.innerHTML = '';
  if (!photosIn.length) {
    if (empty) empty.style.display = '';
    grid.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  grid.style.display = '';

  let photos = [...photosIn];
  if (_adminPhotosSortBy === 'likes') {
    photos.sort((a, b) => {
      const la = _adminPhotosLikes[a.id]?.count || 0;
      const lb = _adminPhotosLikes[b.id]?.count || 0;
      return lb - la || b.created_at.localeCompare(a.created_at);
    });
  }

  const { nom: monNom } = _getAdminPhotoIdentite();
  photos.forEach(p => {
    const likeData = _adminPhotosLikes[p.id] || { count: 0, auteurs: [] };
    const iLiked   = monNom && likeData.auteurs.includes(monNom);
    const el       = document.createElement('div');
    el.className   = 'photo-thumb';
    el.innerHTML   = `
      <img src="${API}/api/photos/${p.id}/img" alt="${h(p.caption||'')}" loading="lazy">
      <div class="photo-thumb-info">
        <div class="photo-thumb-dot" style="background:${p.couleur}"></div>
        <span>${h(p.auteur)}</span>
      </div>
      <button class="photo-del-btn" title="Supprimer (admin)">✕</button>
      <div class="pic-like-overlay">
        <button class="pic-like-btn${iLiked?' liked':''}" id="adm-like-btn-${p.id}" type="button">♥</button>
        <span class="pic-like-count" id="adm-like-count-${p.id}"
              style="${likeData.count>0?'':'display:none'}">${likeData.count}</span>
      </div>`;

    // Like
    const likeBtn = el.querySelector('.pic-like-btn');
    if (likeBtn) {
      const doLike = (e) => { e.stopPropagation(); _likerPhotoAdmin(p.id); };
      likeBtn.addEventListener('click', doLike);
      likeBtn.addEventListener('touchend', (e) => { e.stopPropagation(); e.preventDefault(); _likerPhotoAdmin(p.id); }, { passive: false });
    }
    // Supprimer (admin peut supprimer toute photo)
    const delBtn = el.querySelector('.photo-del-btn');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); supprimerPhotoAdmin(p.id); });
    }
    // Lightbox
    el.addEventListener('click', (e) => {
      if (e.target.closest('.pic-like-overlay') || e.target.closest('.photo-del-btn')) return;
      _ouvrirLightboxAdmin(p);
    });
    grid.appendChild(el);
  });
}

function previewPhotoUploadAdmin(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast('❌ Fichier trop lourd (max 10 Mo)'); return; }
  _adminSelectedFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('adm-photo-preview-img').src = e.target.result;
    document.getElementById('adm-photo-upload-preview').style.display = '';
    document.getElementById('adm-photo-upload-zone').style.display = 'none';
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function annulerUploadPhotoAdmin() {
  _adminSelectedFile = null;
  document.getElementById('adm-photo-upload-preview').style.display = 'none';
  document.getElementById('adm-photo-upload-zone').style.display = '';
  document.getElementById('adm-photo-caption-input').value = '';
}

async function envoyerPhotoAdmin() {
  if (!_adminSelectedFile) return;
  const btn = document.getElementById('adm-photo-send-btn');
  btn.disabled = true; btn.textContent = '⏳ Envoi…';
  const { nom, couleur } = _getAdminPhotoIdentite();
  try {
    const fd = new FormData();
    fd.append('photo',   _adminSelectedFile);
    fd.append('auteur',  nom);
    fd.append('couleur', couleur);
    const caption = document.getElementById('adm-photo-caption-input').value.trim();
    if (caption) fd.append('caption', caption);
    const resp = await fetch(`${API}/api/partage/${_shareTokenCourant}/photos`, { method: 'POST', body: fd });
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || resp.status); }
    toast('✅ Photo partagée avec le crew !');
    annulerUploadPhotoAdmin();
    await chargerPhotosAdmin();
  } catch(e) {
    toast('❌ Erreur : ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '📤 Partager';
  }
}

async function _likerPhotoAdmin(photoId) {
  const { nom: monNom } = _getAdminPhotoIdentite();
  if (!monNom) { toast('⚠️ Identifie-toi pour liker'); return; }
  try {
    const res = await fetch(`${API}/api/partage/${_shareTokenCourant}/photos/${photoId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auteur: monNom })
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); toast('❌ ' + (err.error || res.status)); return; }
    const r = await res.json();
    if (!_adminPhotosLikes[photoId]) _adminPhotosLikes[photoId] = { count: 0, auteurs: [] };
    _adminPhotosLikes[photoId].count   = r.count;
    _adminPhotosLikes[photoId].auteurs = r.auteurs || _adminPhotosLikes[photoId].auteurs;
    const iLiked = _adminPhotosLikes[photoId].auteurs.includes(monNom);
    const btn    = document.getElementById(`adm-like-btn-${photoId}`);
    const cnt    = document.getElementById(`adm-like-count-${photoId}`);
    if (btn) { btn.classList.toggle('liked', iLiked); btn.classList.add('pulse'); setTimeout(() => btn.classList.remove('pulse'), 300); }
    if (cnt) { cnt.textContent = r.count > 0 ? r.count : ''; cnt.style.display = r.count > 0 ? '' : 'none'; }
    // Mettre à jour lightbox si ouverte sur la même photo
    if (_adminLightboxPhoto?.id === photoId) _ouvrirLightboxAdmin({ ..._adminLightboxPhoto });
  } catch(e) { toast('❌ Erreur réseau'); }
}

function _ouvrirLightboxAdmin(p) {
  _adminLightboxPhoto = p;
  const lb = document.getElementById('adm-photo-lightbox');
  document.getElementById('adm-lightbox-img').src = `${API}/api/photos/${p.id}/img`;
  const d = new Date(p.created_at).toLocaleDateString('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
  document.getElementById('adm-lightbox-info').innerHTML =
    `<strong>${h(p.auteur)}</strong>${p.caption ? ' · ' + h(p.caption) : ''}<br><span style="opacity:.6;font-size:.75rem">${d}</span>`;
  lb.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function fermerLightboxAdmin() {
  document.getElementById('adm-photo-lightbox').style.display = 'none';
  document.body.style.overflow = '';
  _adminLightboxPhoto = null;
}
async function supprimerPhotoAdminLightbox() {
  if (!_adminLightboxPhoto) return;
  const id = _adminLightboxPhoto.id;
  fermerLightboxAdmin();
  await supprimerPhotoAdmin(id);
}

async function traiterDemande(id, statut) {
  const r = await fetch(`${API}/api/demandes/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statut })
  });
  if (!r.ok) { toast('❌ Erreur lors du traitement'); return; }
  chargerAdmin();
}

async function ouvrirModalAttribution() {
  const [participants, documents] = await Promise.all([
    fetch(`${API}/api/voyages/${voyageActuel}/participants`).then(r => r.json()),
    fetch(`${API}/api/voyages/${voyageActuel}/documents`).then(r => r.json())
  ]);

  const pList = document.getElementById('attr-participant-list');
  pList.innerHTML = participants.length === 0
    ? '<p style="font-size:.8rem;color:var(--text-muted)">Aucun participant — ajoutez des participants dans l\'onglet Budget.</p>'
    : participants.map(p => `
      <label class="participant-radio">
        <input type="radio" name="attr-part" value="${p.id}">
        <span style="background:${p.couleur||'#C9622F'}22;color:${p.couleur||'#C9622F'};border:1px solid ${p.couleur||'#C9622F'};border-radius:20px;padding:4px 12px;font-size:.85rem">${h(p.nom)}</span>
      </label>`).join('');

  if (pList.querySelector('input[type=radio]')) pList.querySelector('input[type=radio]').checked = true;

  const docSel = document.getElementById('attr-document');
  docSel.innerHTML = '<option value="">— Aucun document —</option>' +
    documents.map(d => `<option value="${d.id}">${h(d.nom)}</option>`).join('');

  document.getElementById('attr-titre').value = '';
  document.getElementById('attr-contenu').value = '';
  document.getElementById('attr-participant-id').value = '';
  document.getElementById('modal-attribution').classList.remove('hidden');
}

async function sauvegarderAttribution() {
  const titre = document.getElementById('attr-titre').value.trim();
  const radio = document.querySelector('input[name="attr-part"]:checked');
  if (!titre) { toast('⚠️ Ajoute un titre'); return; }
  if (!radio) { toast('⚠️ Choisis un destinataire'); return; }

  const data = {
    participant_id: parseInt(radio.value),
    titre,
    contenu: document.getElementById('attr-contenu').value.trim() || null,
    document_id: parseInt(document.getElementById('attr-document').value) || null
  };

  const r = await fetch(`${API}/api/voyages/${voyageActuel}/attributions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  if (!r.ok) { toast('❌ Erreur lors de la création'); return; }
  const newAttrib = await r.json().catch(() => null);
  fermerModal('modal-attribution');
  await chargerAdmin();
  // Ouvrir directement la modal "Ajouter un lien" pour inviter à enrichir l'attribution
  if (newAttrib?.id) {
    setTimeout(() => ouvrirModalAjouterLien(newAttrib.id), 300);
  } else {
    toast('✅ Attribution créée');
  }
}

async function supprimerAttribution(id) {
  if (!confirm('Supprimer cette attribution ?')) return;
  const r = await fetch(`${API}/api/attributions/${id}`, { method: 'DELETE' });
  if (!r.ok) { toast('❌ Erreur lors de la suppression'); return; }
  toast('🗑️ Attribution supprimée');
  chargerAdmin();
}

// ─── LIENS D'ATTRIBUTION ──────────────────────────────────────────────────────
const _LINK_TYPE_META = {
  billet:      { icon: '🎫', color: 'rgba(249,115,22,.12)',  label: 'Billet' },
  qrcode:      { icon: '📱', color: 'rgba(16,185,129,.12)',  label: 'QR Code' },
  document:    { icon: '📄', color: 'rgba(59,130,246,.12)',  label: 'Document' },
  voucher:     { icon: '🎟️', color: 'rgba(168,85,247,.12)', label: 'Voucher' },
  information: { icon: 'ℹ️', color: 'rgba(14,165,233,.12)', label: 'Info' },
  autre:       { icon: '🔗', color: 'rgba(100,116,139,.12)', label: 'Autre' },
};
function _attrLinkTypeIcon(type) { return (_LINK_TYPE_META[type] || _LINK_TYPE_META.autre).icon; }
function _attrLinkTypeColor(type) { return (_LINK_TYPE_META[type] || _LINK_TYPE_META.autre).color; }

let _lienEditId   = null; // null = création, number = édition
let _lienAttrId   = null; // attribution parente

function _buildLienModal() {
  return document.getElementById('modal-lien-attribution');
}

function ouvrirModalAjouterLien(attributionId) {
  _lienEditId = null;
  _lienAttrId = attributionId;
  const m = _buildLienModal();
  if (!m) return;
  m.querySelector('.attr-link-modal-title').textContent = 'Nouveau lien';
  document.getElementById('lien-titre').value   = '';
  document.getElementById('lien-url').value     = '';
  document.getElementById('lien-desc').value    = '';
  // Réinitialiser la sélection de type
  m.querySelectorAll('.attr-link-type-opt').forEach(el => el.classList.remove('selected'));
  const defaultOpt = m.querySelector('.attr-link-type-opt[data-type="billet"]');
  if (defaultOpt) defaultOpt.classList.add('selected');
  m.classList.remove('hidden');
  document.getElementById('lien-titre').focus();
}

async function ouvrirModalEditerLien(linkId) {
  _lienEditId = linkId;
  try {
    // Lire les données depuis les data-attributes stockés au rendu
    const row = document.querySelector(`.attr-link-row[data-link-id="${linkId}"]`);
    const titre = row?.dataset.linkTitre || '';
    const url   = row?.dataset.linkUrl   || '';
    const desc  = row?.dataset.linkDesc  || '';
    const type  = row?.dataset.linkType  || 'autre';

    const m = _buildLienModal();
    if (!m) return;
    m.querySelector('.attr-link-modal-title').textContent = 'Modifier le lien';
    document.getElementById('lien-titre').value = titre;
    document.getElementById('lien-url').value   = url;
    document.getElementById('lien-desc').value  = desc;

    // Restaurer le type sélectionné
    m.querySelectorAll('.attr-link-type-opt').forEach(el => {
      el.classList.toggle('selected', el.dataset.type === type);
    });

    m.classList.remove('hidden');
    document.getElementById('lien-titre').focus();
  } catch {}
}

async function sauvegarderLienAttribution() {
  const titre = document.getElementById('lien-titre').value.trim();
  const url   = document.getElementById('lien-url').value.trim();
  const desc  = document.getElementById('lien-desc').value.trim();
  const type  = document.querySelector('.attr-link-type-opt.selected')?.dataset?.type || 'autre';

  if (!titre) { toast('⚠️ Titre requis'); return; }
  if (!url)   { toast('⚠️ URL requise'); return; }
  // Validation URL côté client
  try { const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol)) throw new Error(); }
  catch { toast('⚠️ URL invalide — commence par https:// ou http://'); return; }

  const body = { titre, url, description: desc || null, type };
  const btn = document.getElementById('btn-sauvegarder-lien');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    let r;
    if (_lienEditId) {
      r = await fetch(`${API}/api/attribution-links/${_lienEditId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    } else {
      r = await fetch(`${API}/api/attributions/${_lienAttrId}/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      toast(`❌ ${err.error || 'Erreur'}`);
      return;
    }
    document.getElementById('modal-lien-attribution').classList.add('hidden');
    toast(_lienEditId ? '✅ Lien modifié' : '✅ Lien ajouté');
    chargerAdmin();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer'; }
  }
}

async function supprimerLienAttribution(linkId) {
  if (!confirm('Supprimer ce lien ?')) return;
  const r = await fetch(`${API}/api/attribution-links/${linkId}`, { method: 'DELETE' });
  if (!r.ok) { toast('❌ Erreur lors de la suppression'); return; }
  toast('🗑️ Lien supprimé');
  chargerAdmin();
}

// ─── MODALS & BOTTOM SHEET ───────────────────────────

function fermerModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay || overlay.classList.contains('hidden')) return;
  // Animation de fermeture — on retire hidden après que l'anim CSS soit terminée
  overlay.classList.add('modal-closing');
  const inner = overlay.querySelector('.modal');
  let _hidden = false;
  const hide = () => {
    if (_hidden) return; _hidden = true;
    overlay.classList.remove('modal-closing');
    overlay.classList.add('hidden');
  };
  if (inner) inner.addEventListener('animationend', hide, { once: true });
  // Fallback systématique : si animationend n'arrive jamais (animation gelée par
  // une mise en pause Android, ou sautée), la modale se ferme quand même.
  setTimeout(hide, 250);
}

// Modale de confirmation custom (Promise<bool>). Remplace confirm() qui est
// bloqué en mode PWA standalone iOS (retourne false immédiatement → F11).
function _confirmModal({ title = 'Confirmer', message = '', confirmLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-overlay';
    overlay.innerHTML = `
      <div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label="${title}">
        <div class="modal-header"><h2>${title}</h2></div>
        <div class="confirm-modal-body">${message}</div>
        <div class="modal-footer">
          <button type="button" class="confirm-btn confirm-btn-cancel" data-act="cancel">${cancelLabel}</button>
          <button type="button" class="confirm-btn ${danger ? 'confirm-btn-danger' : 'confirm-btn-ok'}" data-act="ok">${confirmLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (val) => {
      document.removeEventListener('keydown', onKey);
      // Animation de fermeture avant de retirer l'overlay du DOM
      overlay.classList.add('modal-closing');
      const inner = overlay.querySelector('.modal');
      let _removed = false;
      const remove = () => { if (_removed) return; _removed = true; overlay.remove(); resolve(val); };
      if (inner) inner.addEventListener('animationend', remove, { once: true });
      setTimeout(remove, 250); // fallback : animationend gelé/sauté (pause Android)
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) return done(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') done(true);
      else if (act === 'cancel') done(false);
    });
    document.addEventListener('keydown', onKey);
    setTimeout(() => overlay.querySelector('[data-act="ok"]')?.focus(), 60);
  });
}

// Helper : modal de saisie du prénom admin pour rejoindre en vue participant
// Remplace prompt() qui est bloqué en mode PWA standalone iOS (retourne null immédiatement)
function _nomAdminModal(defaultName = '') {
  return new Promise(resolve => {
    const modal      = document.getElementById('modal-rejoindre');
    const input      = document.getElementById('rejoindre-nom');
    const btnOk      = document.getElementById('btn-rejoindre-ok');
    const btnCloseX  = document.getElementById('btn-rejoindre-close');
    const btnCancel  = document.getElementById('btn-rejoindre-close2');

    input.value = defaultName;
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 100);

    const cleanup = (val) => {
      modal.classList.add('hidden');
      btnOk.removeEventListener('click', onOk);
      btnCloseX.removeEventListener('click', onClose);
      btnCancel.removeEventListener('click', onClose);
      input.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk    = () => cleanup(input.value.trim() || null);
    const onClose = () => cleanup(null);
    const onKey   = (e) => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onClose(); };

    btnOk.addEventListener('click', onOk);
    btnCloseX.addEventListener('click', onClose);
    btnCancel.addEventListener('click', onClose);
    input.addEventListener('keydown', onKey);
  });
}

async function partagerVoyage() {
  fermerBottomSheet();
  const resp = await fetch(`${API}/api/voyages/${voyageActuel}/partager`, { method: 'POST' });
  const data = await resp.json();
  const shareUrl = data.url || '';
  document.getElementById('partage-url').textContent = shareUrl;
  document.getElementById('modal-partage').classList.remove('hidden');
  // Charger le QR code via /api/qr
  const qrWrap = document.getElementById('partage-qr');
  if (qrWrap && shareUrl) {
    const urlParam = encodeURIComponent(shareUrl);
    const img = new Image();
    img.alt = 'QR code du lien de partage';
    img.style.cssText = 'width:140px;height:140px;object-fit:contain';
    img.onload = () => { qrWrap.innerHTML = ''; qrWrap.appendChild(img); };
    img.onerror = () => { qrWrap.style.display = 'none'; document.getElementById('partage-qr-wrap').style.display = 'none'; };
    img.src = `${API}/api/qr?url=${urlParam}`;
  }
}

// ─── S6 — Rotation du lien de partage ────────────────────────────────────────
async function revoquerLienPartage() {
  const ok = await _confirmModal({
    title: '🔄 Nouveau lien de partage ?',
    message: 'L\'ancien lien sera <b>définitivement invalide</b>. Les participants qui l\'ont ne pourront plus l\'utiliser. Tu devras leur envoyer le nouveau lien.',
    confirmLabel: 'Générer un nouveau lien',
    danger: true
  });
  if (!ok) return;
  try {
    const r = await fetch(`${API}/api/voyages/${voyageActuel}/rotate-token`, { method: 'POST' });
    if (!r.ok) { toast('❌ Erreur lors de la rotation'); return; }
    const data = await r.json();
    const shareUrl = data.url || '';
    document.getElementById('partage-url').textContent = shareUrl;
    // Mettre à jour le QR
    const qrWrap = document.getElementById('partage-qr');
    if (qrWrap && shareUrl) {
      const img = new Image();
      img.alt = 'QR code du nouveau lien de partage';
      img.style.cssText = 'width:140px;height:140px;object-fit:contain';
      img.onload = () => { qrWrap.innerHTML = ''; qrWrap.appendChild(img); };
      img.src = `${API}/api/qr?url=${encodeURIComponent(shareUrl)}`;
      document.getElementById('partage-qr-wrap').style.display = 'flex';
    }
    _shareTokenCourant = data.token;
    toast('🔗 Nouveau lien généré');
  } catch(e) {
    console.error('[revoquerLien]', e);
    toast('❌ Erreur réseau');
  }
}

async function rejoindreVoyage() {
  if (!voyageActuel) return;
  fermerBottomSheet();

  // Raccourci — session participant déjà active : navigation directe, sans modales
  // (évite de repasser par confirmation + prénom à chaque switch org→participant)
  if (_shareTokenCourant) {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('partage_id_' + _shareTokenCourant)); } catch {}
    if (stored?.sessionToken) {
      window.location.href = '/partage/' + _shareTokenCourant;
      return;
    }
  }

  // P6 — Montrer la modale de confirmation avant de basculer
  const modal = document.getElementById('modal-confirm-role-switch');
  if (modal) {
    modal.classList.remove('hidden');
    return new Promise(resolve => {
      const confirmBtn = document.getElementById('btn-confirm-role-yes');
      const cancelBtn  = document.getElementById('btn-confirm-role-no');
      const cleanup = () => {
        modal.classList.add('hidden');
        confirmBtn.removeEventListener('click', onYes);
        cancelBtn.removeEventListener('click', onNo);
        modal.removeEventListener('click', onNo);
      };
      const onYes = () => { cleanup(); resolve(_rejoindreVoyageConfirme()); };
      const onNo  = () => { cleanup(); resolve(); };
      confirmBtn.addEventListener('click', onYes);
      cancelBtn.addEventListener('click', onNo);
      modal.addEventListener('click', onNo);   // clic sur l'overlay (hors du modal) = fermer
    });
  }
  return _rejoindreVoyageConfirme();
}

async function _rejoindreVoyageConfirme() {
  // Auto-créer le lien de partage si nécessaire
  if (!_shareTokenCourant) {
    try {
      const r = await fetch(`${API}/api/voyages/${voyageActuel}/partager`, { method: 'POST' });
      if (!r.ok) { toast('❌ Impossible de créer le lien de partage'); return; }
      const d = await r.json();
      _shareTokenCourant = d.token;
    } catch(e) { toast('❌ Erreur réseau'); return; }
  }

  // Pas de saisie : on réutilise le nom déjà connu de l'organisateur
  // (saisi à la création du trip). La bascule devient immédiate et silencieuse.
  // (Le nom d'affichage participant reste modifiable depuis la page participant.)
  const nomAdmin = currentUser?.nom || currentUser?.email;
  if (!nomAdmin) return;

  try {
    const resp = await fetch(`${API}/api/voyages/${voyageActuel}/join-as-participant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_authToken}`,
      },
      body: JSON.stringify({ nom: nomAdmin.trim(), couleur: '#FF6B35' }),
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      toast(`❌ Erreur ${resp.status} : ${errData.error || 'connexion impossible'}`);
      console.error('[join-as-participant]', resp.status, errData);
      return;
    }
    const data = await resp.json();

    // Stocker la session participant dans localStorage
    const storageKey = 'partage_id_' + _shareTokenCourant;
    localStorage.setItem(storageKey, JSON.stringify({
      nom:            data.participant.nom,
      participant_id: data.participant.participant_id,
      couleur:        data.participant.couleur,
      sessionToken:   data.sessionToken,
      role:           'owner',
    }));
    // AP-2 : horodatage pour sélectionner le token le plus récent en mode standalone
    try { localStorage.setItem('partage_ts_' + _shareTokenCourant, String(Date.now())); } catch {}

    // Mettre à jour la barre de mode participant (au cas où l'user resterait sur /app)
    _updateParticipantModeBar();

    // Naviguer vers la vue participant (même onglet)
    // window.open(..., '_blank') est bloqué par Safari après des await
    // → window.location.href fonctionne partout, retour via bouton navigateur
    if (data.partageUrl) {
      toast('✅ Chargement de la vue participant…');
      window.location.href = data.partageUrl;
    } else {
      // partageUrl null → le token n'existe pas encore en DB : on ne doit pas arriver ici
      // (le bloc ci-dessus crée le token si _shareTokenCourant est null), mais par sécurité :
      toast('❌ Lien de partage introuvable. Réessaie dans quelques secondes.');
    }
  } catch(e) {
    toast('❌ Erreur réseau');
  }
}

// P1 — Ouvrir Prépa depuis Road Map (chip dans le panel programme)
function ouvrirPrepa() {
  changerOnglet('preparation', null);
}

function copierLienPartage() {
  const url = document.getElementById('partage-url').textContent;
  // Web Share API — ouvre le menu de partage natif (WhatsApp, SMS, etc.)
  if (navigator.share) {
    navigator.share({ title: 'CrewiGO — Rejoins le trip 🌍', url })
      .then(() => toast('✅ Lien partagé !'))
      .catch(() => {}); // annulation par l'utilisateur → silencieux
    return;
  }
  // Fallback : copie dans le presse-papiers
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
  document.querySelectorAll('#modal-voyage .color-opt').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('v-couleur').value = btn.dataset.color;
}

function choisirType(btn) {
  document.querySelectorAll('#modal-reservation .type-opt').forEach(el => el.classList.remove('active'));
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

function toDateStr(val) {
  if (!val) return '';
  return typeof val === 'string' ? val.split('T')[0] : val;
}

function formatDate(str) {
  if (!str) return '';
  const d = new Date(toDateStr(str) + 'T00:00:00');
  return d.toLocaleDateString('fr-BE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateLong(str) {
  if (!str) return '';
  const d = new Date(toDateStr(str) + 'T00:00:00');
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

// ─── MESSAGES PRIVÉS (organisateur) ─────────────────────────────────────────

async function ouvrirMessagePrive() {
  const participants = await fetch(`${API}/api/voyages/${voyageActuel}/participants`).then(r => r.json()).catch(() => []);
  const sel = document.getElementById('mp-participant');
  sel.innerHTML = participants.length
    ? participants.map(p => `<option value="${p.id}">${h(p.nom)}</option>`).join('')
    : '<option value="">Aucun participant</option>';
  document.getElementById('mp-message').value = '';
  document.getElementById('modal-message-prive').classList.remove('hidden');
}

async function envoyerMessagePrive() {
  const participant_id = document.getElementById('mp-participant').value;
  const message = document.getElementById('mp-message').value.trim();
  if (!participant_id) { toast('⚠️ Sélectionne un participant'); return; }
  if (!message) { toast('⚠️ Écris un message'); return; }
  try {
    const r = await fetch(`${API}/api/voyages/${voyageActuel}/messages-prives`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant_id, message })
    });
    if (!r.ok) throw new Error();
    fermerModal('modal-message-prive');
    const nom = document.getElementById('mp-participant').options[document.getElementById('mp-participant').selectedIndex]?.text;
    toast(`✅ Message envoyé à ${nom}`);
  } catch { toast('⚠️ Erreur lors de l\'envoi'); }
}

// ─── DISCUSSION ADMIN (CrewiChat) ─────────────────────────────────────────────

let _chatMessagesAdmin = [];
let _chatReplyAdmin = null;
let _chatPickerAdminMsgId = null;

function _couleurChat(nom) {
  const palette = ['#C9622F','#3B82F6','#10B981','#8B5CF6','#EC4899','#F59E0B','#6366F1','#14B8A6'];
  let _hash = 0;
  for (const c of (nom||'?')) _hash = (_hash * 31 + c.charCodeAt(0)) & 0xFFFFFF;
  return palette[_hash % palette.length];
}

function _adminNom() { return currentUser?.nom || 'Organisateur'; }
// Pour la détection "mine" : utiliser uniquement le vrai nom (sans fallback 'Organisateur')
// Évite que les anciens messages auteur:'Organisateur' soient tous côté "mine"
function _adminMoi() { return currentUser?.nom || currentUser?.email || null; }

function _relativeTimeAdmin(iso) {
  const d = new Date(iso), diff = Date.now() - d.getTime();
  if (diff < 60000) return 'À l\'instant';
  if (diff < 3600000) return `Il y a ${Math.floor(diff/60000)} min`;
  const today = new Date(); today.setHours(0,0,0,0);
  const yest = new Date(today); yest.setDate(today.getDate()-1);
  if (d >= today) return d.toLocaleTimeString('fr-BE',{hour:'2-digit',minute:'2-digit'});
  if (d >= yest) return 'Hier ' + d.toLocaleTimeString('fr-BE',{hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString('fr-BE',{day:'numeric',month:'short'}) + ' ' + d.toLocaleTimeString('fr-BE',{hour:'2-digit',minute:'2-digit'});
}

function _dateLabelAdmin(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  const yest = new Date(today); yest.setDate(today.getDate()-1);
  if (d >= today) return 'Aujourd\'hui';
  if (d >= yest) return 'Hier';
  return d.toLocaleDateString('fr-BE',{weekday:'long',day:'numeric',month:'long'});
}

function _groupClassAdmin(msgs, i) {
  const c = msgs[i], prev = msgs[i-1], next = msgs[i+1];
  const sp = prev && prev.auteur === c.auteur && (new Date(c.created_at)-new Date(prev.created_at)) < 300000;
  const sn = next && next.auteur === c.auteur && (new Date(next.created_at)-new Date(c.created_at)) < 300000;
  if (sp && sn) return 'chat-msg--middle';
  if (sp)       return 'chat-msg--last';
  if (sn)       return 'chat-msg--first';
  return 'chat-msg--solo';
}

function _showDateSepAdmin(msgs, i) {
  if (i === 0) return true;
  const d = new Date(msgs[i].created_at); d.setHours(0,0,0,0);
  const p = new Date(msgs[i-1].created_at); p.setHours(0,0,0,0);
  return d.getTime() !== p.getTime();
}

function _reactHtmlAdmin(c, moi) {
  try {
    const reactions = typeof c.reactions === 'string' ? JSON.parse(c.reactions||'{}') : (c.reactions||{});
    const pills = Object.entries(reactions).filter(([,u])=>u.length>0).map(([emoji,users])=>{
      const isMine = moi && users.includes(moi);
      return `<button class="chat-reaction-pill${isMine?' mine':''}" onclick="_reactToMessageAdmin(${c.id},'${emoji}')">${emoji}<span class="chat-reaction-count">${users.length}</span></button>`;
    }).join('');
    return pills ? `<div class="chat-reactions">${pills}</div>` : '';
  } catch(e) { return ''; }
}

function _buildMsgHtmlAdmin(c, groupClass, showSep, moi) {
  const mine = moi && c.auteur === moi;
  const couleur = _couleurChat(c.auteur);
  const initiale = (c.auteur||'?')[0].toUpperCase();
  const showMeta = groupClass === 'chat-msg--first' || groupClass === 'chat-msg--solo';

  let replyHtml = '';
  if (c.reply_to_id) {
    replyHtml = `<div class="chat-reply-quote" onclick="_scrollToMsgAdmin(${c.reply_to_id})">
      <strong>${h(c.reply_to_auteur||'')}</strong><span>${h((c.reply_to_preview||''))}</span>
    </div>`;
  }

  const metaHtml = showMeta
    ? `<div class="chat-meta">${!mine?`<span class="chat-auteur">${h(c.auteur)}</span>`:''}<span>${_relativeTimeAdmin(c.created_at)}</span></div>`
    : '';

  const esc = s => String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const actions = `<div class="chat-msg-actions">
    <button class="chat-msg-act" onclick="_openReactionPickerAdmin(${c.id},this)" title="Réagir">😊</button>
    <button class="chat-msg-act" onclick="_replyToAdmin(${c.id},'${esc(c.auteur)}','${esc((c.message||'').slice(0,80).replace(/\n/g,' '))}')" title="Répondre">↩</button>
    <button class="chat-msg-act chat-msg-del" onclick="_supprimerCommentaireAdmin(${c.id})" title="Supprimer">✕</button>
  </div>`;

  const sep = showSep ? `<div class="chat-date-sep">${_dateLabelAdmin(c.created_at)}</div>` : '';

  return `${sep}<div class="chat-msg${mine?' mine':''} ${groupClass}" data-chat-id="${c.id}">
    <div class="chat-avatar" style="background:${couleur}">${initiale}</div>
    <div class="chat-bubble">${metaHtml}${replyHtml}<div class="chat-text">${h(c.message).replace(/\n/g,'<br>')}</div>${_reactHtmlAdmin(c,moi)}</div>
    ${actions}
  </div>`;
}

function _renderCommentairesAdmin(liste) {
  const moi = _adminMoi(); // nom réel uniquement — pas de fallback 'Organisateur'
  const container = document.getElementById('discussion-messages');
  if (!container) return;

  if (!liste.length) {
    container.innerHTML = `<div class="chat-empty"><span class="chat-empty-icon">💬</span><p>Aucun message pour l'instant.</p></div>`;
    _updateScrollFabAdmin();
    return;
  }

  const existingIds = new Set([...container.querySelectorAll('[data-chat-id]')].map(el=>+el.dataset.chatId));
  const newMsgs = liste.filter(c => !existingIds.has(c.id));
  const atBottom = _isScrolledToBottomAdmin();

  if (existingIds.size === 0) {
    container.innerHTML = liste.map((c,i) => _buildMsgHtmlAdmin(c,_groupClassAdmin(liste,i),_showDateSepAdmin(liste,i),moi)).join('');
    _scrollToBottomAdmin(false);
  } else if (newMsgs.length > 0) {
    const firstNewIdx = liste.findIndex(c => !existingIds.has(c.id));
    if (firstNewIdx > 0) {
      const prevMsg = liste[firstNewIdx-1];
      const prevEl = container.querySelector(`[data-chat-id="${prevMsg.id}"]`);
      if (prevEl) {
        const nc = _groupClassAdmin(liste, firstNewIdx-1);
        prevEl.className = `chat-msg${prevMsg.auteur===moi?' mine':''} ${nc}`;
        const av = prevEl.querySelector('.chat-avatar');
        if (av) av.style.visibility = (nc==='chat-msg--middle'||nc==='chat-msg--last') ? 'hidden' : '';
        const meta = prevEl.querySelector('.chat-meta');
        if (meta) meta.style.display = (nc==='chat-msg--middle'||nc==='chat-msg--last') ? 'none' : '';
      }
    }
    const tmp = document.createElement('div');
    newMsgs.forEach(c => {
      const idx = liste.indexOf(c);
      tmp.innerHTML = _buildMsgHtmlAdmin(c,_groupClassAdmin(liste,idx),_showDateSepAdmin(liste,idx),moi);
      while (tmp.firstChild) container.appendChild(tmp.firstChild);
    });
    if (atBottom) _scrollToBottomAdmin(false);
    else _showScrollFabAdmin();
  } else {
    // Refresh reactions only
    liste.forEach(c => {
      const el = container.querySelector(`[data-chat-id="${c.id}"]`);
      if (!el) return;
      const bubble = el.querySelector('.chat-bubble');
      if (!bubble) return;
      const rc = el.querySelector('.chat-reactions');
      const newReact = _reactHtmlAdmin(c, moi);
      if (rc) rc.outerHTML = newReact || '';
      else if (newReact) bubble.insertAdjacentHTML('beforeend', newReact);
    });
  }
  _updateScrollFabAdmin();
}

function _mainAdmin() { return document.querySelector('#screen-voyage .main-content') || document.documentElement; }
function _isScrolledToBottomAdmin() { const m = _mainAdmin(); return m.scrollHeight - m.scrollTop - m.clientHeight < 100; }
function _scrollToBottomAdmin(animated) {
  const m = _mainAdmin();
  if (animated) m.scrollTo({ top: m.scrollHeight, behavior: 'smooth' });
  else m.scrollTop = m.scrollHeight;
  _hideScrollFabAdmin();
}
function _scrollToMsgAdmin(id) { document.querySelector(`[data-chat-id="${id}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' }); }
function _showScrollFabAdmin() { document.getElementById('chat-scroll-fab-admin')?.classList.remove('hidden'); }
function _hideScrollFabAdmin() { document.getElementById('chat-scroll-fab-admin')?.classList.add('hidden'); }
function _updateScrollFabAdmin() { if (_isScrolledToBottomAdmin()) _hideScrollFabAdmin(); else _showScrollFabAdmin(); }

// Reactions admin
function _openReactionPickerAdmin(msgId, btn) {
  const picker = document.getElementById('chat-reaction-picker-admin');
  if (!picker) return;
  if (_chatPickerAdminMsgId === msgId && picker.style.display !== 'none') {
    picker.style.display = 'none'; _chatPickerAdminMsgId = null; return;
  }
  _chatPickerAdminMsgId = msgId;
  picker.style.display = 'flex';
  const rect = btn.getBoundingClientRect();
  // position:fixed → relatif au viewport ; getBoundingClientRect() aussi → pas de scrollY
  const pickerH = 52;
  const top = rect.top - pickerH - 6;
  picker.style.top = Math.max(8, top) + 'px';
  picker.style.left = Math.max(8, Math.min(rect.left - 20, window.innerWidth - 260)) + 'px';
  setTimeout(() => document.addEventListener('click', _closePickerAdmin, { once: true }), 20);
}
function _closePickerAdmin() {
  const p = document.getElementById('chat-reaction-picker-admin');
  if (p) p.style.display = 'none';
  _chatPickerAdminMsgId = null;
}
function _pickReactionAdmin(emoji) {
  if (_chatPickerAdminMsgId) { _reactToMessageAdmin(_chatPickerAdminMsgId, emoji); _closePickerAdmin(); }
}
async function _reactToMessageAdmin(id, emoji) {
  try {
    const r = await fetch(`${API}/api/voyages/${voyageActuel}/commentaires/${id}/react`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ auteur: _adminNom(), emoji })
    });
    if (r.ok) {
      const updated = await r.json();
      const idx = _chatMessagesAdmin.findIndex(c => c.id === id);
      if (idx !== -1) { _chatMessagesAdmin[idx] = updated; _renderCommentairesAdmin(_chatMessagesAdmin); }
    }
  } catch(e) { toast('⚠️ Erreur réaction'); }
}

// Reply admin
function _replyToAdmin(id, auteur, preview) {
  _chatReplyAdmin = { id, auteur, preview };
  const bar = document.getElementById('chat-reply-bar-admin');
  if (bar) bar.style.display = 'flex';
  const aEl = document.getElementById('chat-reply-auteur-admin');
  const pEl = document.getElementById('chat-reply-preview-admin');
  if (aEl) aEl.textContent = auteur;
  if (pEl) pEl.textContent = preview;
  document.getElementById('discussion-input')?.focus();
}
function _cancelReplyAdmin() {
  _chatReplyAdmin = null;
  const bar = document.getElementById('chat-reply-bar-admin');
  if (bar) bar.style.display = 'none';
}

async function chargerCommentairesAdmin() {
  if (!voyageActuel) return;
  const liste = await fetch(`${API}/api/voyages/${voyageActuel}/commentaires`).then(r => r.ok ? r.json() : []).catch(() => []);
  _chatMessagesAdmin = liste;
  _renderCommentairesAdmin(liste);
}

async function _envoyerCommentaireAdmin() {
  const input = document.getElementById('discussion-input');
  const message = input?.value.trim();
  if (!message) return;
  const btn = document.getElementById('discussion-send');
  if (btn) btn.disabled = true;
  const moi = _adminNom();

  // Optimistic
  const tempId = -(Date.now());
  const optimistic = {
    id: tempId, auteur: moi, message,
    reply_to_id: _chatReplyAdmin?.id || null,
    reply_to_auteur: _chatReplyAdmin?.auteur || null,
    reply_to_preview: _chatReplyAdmin?.preview || null,
    reactions: '{}', created_at: new Date().toISOString()
  };
  _chatMessagesAdmin = [..._chatMessagesAdmin, optimistic];
  _renderCommentairesAdmin(_chatMessagesAdmin);
  document.querySelector(`[data-chat-id="${tempId}"]`)?.classList.add('pending');

  const payload = {
    auteur: moi, message,
    ..._chatReplyAdmin && {
      reply_to_id: _chatReplyAdmin.id,
      reply_to_auteur: _chatReplyAdmin.auteur,
      reply_to_preview: _chatReplyAdmin.preview
    }
  };

  input.value = '';
  input.style.height = '';
  _cancelReplyAdmin();

  try {
    const r = await fetch(`${API}/api/voyages/${voyageActuel}/commentaires`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const real = await r.json();
    // Supprimer l'élément optimistic du DOM avant le re-rendu incrémental
    document.querySelector(`[data-chat-id="${tempId}"]`)?.remove();
    _chatMessagesAdmin = _chatMessagesAdmin.filter(c => c.id !== tempId);
    _chatMessagesAdmin.push(real);
    _chatMessagesAdmin.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
    _renderCommentairesAdmin(_chatMessagesAdmin);
  } catch {
    toast('⚠️ Erreur d\'envoi');
    document.querySelector(`[data-chat-id="${tempId}"]`)?.remove();
    _chatMessagesAdmin = _chatMessagesAdmin.filter(c => c.id !== tempId);
    _renderCommentairesAdmin(_chatMessagesAdmin);
  } finally { if (btn) btn.disabled = false; }
}

async function _supprimerCommentaireAdmin(id) {
  await fetch(`${API}/api/voyages/${voyageActuel}/commentaires/${id}`, { method: 'DELETE' });
  _chatMessagesAdmin = _chatMessagesAdmin.filter(c => c.id !== id);
  _renderCommentairesAdmin(_chatMessagesAdmin);
}

function getAgendaColor(type) {
  const colors = { transport: '#3B82F6', hebergement: '#10B981', activite: '#8B5CF6', restaurant: '#EC4899', sport: '#F59E0B', libre: '#64748B', apero: '#F97316' };
  return colors[type] || '#3B82F6';
}

function getAgendaIcon(type) {
  const m = { transport: 'send', hebergement: 'home', vehicule: 'car', restaurant: 'food', activite: 'activity', sport: 'activity', libre: 'map', apero: 'food' };
  return cgoIcon(m[type] || 'activity', 32);
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

// ─── UI ANIMATIONS (migrated from inline script) ─────────────────────────────
(function () {
  const DESTS = [
    'Paris, France…', 'Tokyo, Japon…', 'Corse, France…',
    'Marrakech, Maroc…', 'Bali, Indonésie…', 'Santorin, Grèce…',
    'Lisbonne, Portugal…', 'New York, USA…', 'Barcelone, Espagne…'
  ];
  let idx = 0;
  function cycleDest() {
    const el = document.getElementById('home-search-anim');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => {
      idx = (idx + 1) % DESTS.length;
      el.textContent = DESTS[idx];
      el.style.opacity = '1';
    }, 300);
  }
  setInterval(cycleDest, 2800);

  let hero = null;
  function initParallax() {
    const screen = document.getElementById('screen-home');
    const main = screen ? screen.querySelector('.main-content') : null;
    hero = screen ? screen.querySelector('.home-hero-bg') : null;
    if (!main || !hero) return;
    main.addEventListener('scroll', () => {
      hero.style.transform = `translateY(${main.scrollTop * 0.35}px) scale(1)`;
    }, { passive: true });
  }

  const cardObserver = new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.classList && node.classList.contains('voyage-card'))
          node.style.animationPlayState = 'running';
      });
    });
  });

  document.addEventListener('DOMContentLoaded', () => {
    initParallax();
    const grid = document.getElementById('liste-voyages');
    if (grid) cardObserver.observe(grid, { childList: true });

    document.querySelectorAll('.main-content').forEach(el => {
      el.addEventListener('scroll', () => {
        const header = el.closest('.screen').querySelector('.app-header');
        if (header && !el.closest('#screen-home'))
          header.style.boxShadow = el.scrollTop > 4 ? '0 4px 24px rgba(26,26,46,0.10)' : '';
      }, { passive: true });
    });
  });
})();

// ─── EVENT BINDING — remplace tous les handlers inline ───────────────────────
function _on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

function _bindStaticHandlers() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  _on('login-btn',           'click', submitLogin);
  _on('register-btn',        'click', submitRegister);
  _on('switch-to-register',  'click', e => { e.preventDefault(); switchAuthForm('register'); });
  _on('switch-to-login',     'click', e => { e.preventDefault(); switchAuthForm('login'); });

  // ── Header / home ─────────────────────────────────────────────────────────
  _on('logout-btn',          'click', logout);
  _on('home-cta-btn',        'click', ouvrirCreateTrip);

  // Menu compte (avatar) — regroupe nom, langue, déconnexion
  (function initAccountMenu() {
    const btn  = document.getElementById('header-account-btn');
    const menu = document.getElementById('account-menu');
    if (!btn || !menu) return;
    const close = () => { menu.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); };
    const open  = () => { menu.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); };
    btn.addEventListener('click', e => {
      e.stopPropagation();
      menu.classList.contains('hidden') ? open() : close();
    });
    // Clic en dehors → fermer
    document.addEventListener('click', e => {
      if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn) close();
    });
    // Échap → fermer
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    // Sélection langue → fermer (la déconnexion change de toute façon d'écran)
    menu.querySelectorAll('.account-menu-item').forEach(it => it.addEventListener('click', close));
  })();
  _on('empty-create-btn',    'click', ouvrirCreateTrip);

  // ── RGPD — gestion du compte ──────────────────────────────────────────────
  _on('btn-compte-rgpd', 'click', () => {
    const m = document.getElementById('modal-compte-rgpd');
    if (m) { m.style.display = 'flex'; document.getElementById('compte-rgpd-warning').style.display = 'none'; }
  });
  _on('btn-close-compte-rgpd', 'click', () => {
    const m = document.getElementById('modal-compte-rgpd');
    if (m) m.style.display = 'none';
  });
  _on('btn-export-donnees', 'click', async () => {
    const btn = document.getElementById('btn-export-donnees');
    if (!btn || !_authToken) return;
    btn.disabled = true; btn.textContent = 'Préparation…';
    try {
      const r = await fetch('/api/auth/export', { headers: { Authorization: 'Bearer ' + _authToken } });
      if (!r.ok) throw new Error('Erreur serveur');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'crewigo-export.json'; a.click();
      URL.revokeObjectURL(url);
    } catch(e) { alert('Erreur lors de l\'export : ' + e.message); }
    finally { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Exporter mes données (JSON)'; }
  });
  let _deleteConfirmStep = 0;
  _on('btn-supprimer-compte', 'click', async () => {
    const btn = document.getElementById('btn-supprimer-compte');
    const warn = document.getElementById('compte-rgpd-warning');
    if (!btn || !_authToken) return;
    if (_deleteConfirmStep === 0) {
      // Premier clic : afficher l'avertissement, demander confirmation
      warn.style.display = ''; btn.textContent = 'Confirmer la suppression';
      _deleteConfirmStep = 1; return;
    }
    // Deuxième clic : suppression effective
    btn.disabled = true; btn.textContent = 'Suppression…';
    try {
      const r = await fetch('/api/auth/account', { method: 'DELETE', headers: { Authorization: 'Bearer ' + _authToken } });
      if (!r.ok) throw new Error('Erreur serveur');
      document.getElementById('modal-compte-rgpd').style.display = 'none';
      _doLogout();
    } catch(e) {
      alert('Erreur lors de la suppression : ' + e.message);
      btn.disabled = false; btn.textContent = 'Confirmer la suppression';
    }
  });

  // ── Rejoindre un voyage via lien reçu ────────────────────────────────────
  function _rejoindreViaLien(input) {
    const raw = (input?.value || '').trim();
    if (!raw) return;
    // Accepte : URL complète, chemin /share/TOKEN, ou juste TOKEN
    let token = raw;
    try {
      const u = new URL(raw.startsWith('http') ? raw : `https://x.com/${raw}`);
      const m = u.pathname.match(/\/share\/([a-zA-Z0-9_\-]{4,40})/);
      if (m) token = m[1];
    } catch { /* raw est déjà un token ou chemin */ }
    // Nettoyer un éventuel "/share/" en préfixe si collé directement
    token = token.replace(/^\/?share\//, '').split('/')[0].split('?')[0];
    if (/^[a-zA-Z0-9_\-]{4,40}$/.test(token)) {
      window.location.href = `/share/${token}`;
    } else {
      if (input) { input.style.borderColor = 'var(--error, #ef4444)'; setTimeout(() => { input.style.borderColor = ''; }, 1500); }
    }
  }
  _on('join-link-btn-empty', 'click', () => _rejoindreViaLien(document.getElementById('join-link-input-empty')));
  const joinInputEmpty = document.getElementById('join-link-input-empty');
  if (joinInputEmpty) joinInputEmpty.addEventListener('keydown', e => { if (e.key === 'Enter') _rejoindreViaLien(joinInputEmpty); });

  // Barre persistante (visible même quand l'admin a des voyages) — modal inline
  _on('join-voyage-bar-btn', 'click', () => {
    const link = prompt('Colle le lien de voyage reçu :');
    if (link) _rejoindreViaLien({ value: link });
  });

  // ── Voyage screen header ──────────────────────────────────────────────────
  _on('btn-retour-accueil',  'click', afficherAccueil);
  _on('btn-menu-voyage',     'click', menuVoyageActuel);

  // Administration : accessible depuis le menu « ⋯ » (1ʳᵉ ligne du bottom-sheet)
  _on('btn-admin-from-sheet', 'click', () => {
    fermerBottomSheet();
    changerOnglet('admin', null);
    // L'admin consulté → on éteint l'indicateur de demandes en attente
    const dot = document.getElementById('menu-voyage-badge');
    if (dot) dot.style.display = 'none';
  });

  // ── Tab nav (delegation) ──────────────────────────────────────────────────
  const tabNav = document.querySelector('.tab-nav');
  if (tabNav) tabNav.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn[data-tab]');
    if (btn) changerOnglet(btn.dataset.tab, btn);
  });

  // ── Tab panels ────────────────────────────────────────────────────────────
  _on('btn-ajouter-participant',    'click', ouvrirModalParticipant);
  _on('btn-ajouter-agenda',         'click', () => ouvrirModalAgenda());
  _on('btn-import-email-analyse',   'click', analyserEmailImport);
  _on('btn-import-email-importer',  'click', confirmerImportEmail);
  _on('btn-exporter-pdf',           'click', exporterVoyagePDF);
  _on('btn-revoquer-lien',          'click', revoquerLienPartage);
  _on('btn-generer-suggestions',    'click', genererSuggestions);
  _on('btn-ajouter-article-bagages','click', ouvrirModalAjoutArticle);
  _on('btn-ajouter-depense',        'click', () => ouvrirModalDepense());
  _on('btn-message-prive',          'click', ouvrirMessagePrive);

  // ── Discussion ────────────────────────────────────────────────────────────
  _on('discussion-input', 'keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _envoyerCommentaireAdmin(); }
  });
  _on('discussion-send', 'click', _envoyerCommentaireAdmin);

  // ── Create — flux IA-first ────────────────────────────────────────────────
  _on('create-entry-back', 'click', fermerCreateTrip);
  _on('create-recap-back', 'click', retourEntry);
  _on('create-recap-cta',  'click', _creerTrip);
  _on('create-manual-link','click', ouvrirRecapManuel);
  _on('create-ai-send',    'click', lancerAITrip);
  _on('create-edit-save',  'click', saveEditSheet);
  _on('create-edit-mask',  'click', closeEditSheet);
  _on('c-ai-input', 'input', _updateAISend);
  _on('c-ai-input', 'keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); lancerAITrip(); } });
  _on('c-date-debut', 'change', createUpdateDuree);
  _on('c-date-fin',   'change', createUpdateDuree);
  _on('c-orga-nom', 'input', function () {
    const a = document.getElementById('create-orga-avatar');
    if (a) a.textContent = this.value ? this.value[0].toUpperCase() : '?';
  });
  _on('c-p-nom', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createAddParticipant(); } });
  _on('create-p-add-btn', 'click', createAddParticipant);

  // ── Create type grid (delegation, depuis le sheet d'édition) ──────────────
  document.querySelectorAll('.create-type-grid').forEach(grid =>
    grid.addEventListener('click', e => {
      const btn = e.target.closest('.create-type-card[data-type]');
      if (btn) createSelectType(btn.dataset.type, btn);
    }));

  // ── Modal voyage ──────────────────────────────────────────────────────────
  _on('form-voyage', 'submit', sauvegarderVoyage);
  const voyagePicker = document.querySelector('#modal-voyage .color-picker');
  if (voyagePicker) voyagePicker.addEventListener('click', e => {
    const btn = e.target.closest('.color-opt');
    if (btn) choisirCouleur(btn);
  });

  // ── Modal réservation ─────────────────────────────────────────────────────
  _on('form-reservation', 'submit', sauvegarderReservation);
  const resaTypeSelector = document.querySelector('#form-reservation .type-selector');
  if (resaTypeSelector) resaTypeSelector.addEventListener('click', e => {
    const btn = e.target.closest('.type-opt');
    if (btn) choisirType(btn);
  });

  // ── Modal agenda ──────────────────────────────────────────────────────────
  _on('form-agenda', 'submit', sauvegarderAgenda);

  // ── Modal document ────────────────────────────────────────────────────────
  _on('scan-mode-fichier-btn', 'click', () => basculerModeDoc('fichier'));
  _on('scan-mode-scan-btn',    'click', () => basculerModeDoc('scan'));
  _on('upload-doc-input',      'change', function () { uploaderDocument(this); });
  _on('btn-scan-camera',       'click', () => lancerScan('camera'));
  _on('btn-scan-fichier',      'click', () => lancerScan('file'));
  _on('scan-camera-input',     'change', function () { traiterImageScan(this); });
  _on('scan-file-input',       'change', function () { traiterImageScan(this); });
  _on('scan-confirm-btn',      'click', confirmerImportScan);
  const docTypeSelector = document.querySelector('#modal-document .type-selector');
  if (docTypeSelector) docTypeSelector.addEventListener('click', e => {
    const btn = e.target.closest('.type-opt');
    if (btn) choisirDocType(btn);
  });

  // ── Modal modifier document ───────────────────────────────────────────────
  _on('btn-save-doc-edit', 'click', sauvegarderModifDocument);
  const docEditTypeSelector = document.querySelector('#modal-doc-edit .type-selector');
  if (docEditTypeSelector) docEditTypeSelector.addEventListener('click', e => {
    const btn = e.target.closest('.type-opt');
    if (btn) choisirDocTypeEdit(btn);
  });

  // ── Doc viewer ────────────────────────────────────────────────────────────
  _on('doc-viewer-close-btn', 'click', fermerDocViewer);

  // ── Modal article ─────────────────────────────────────────────────────────
  _on('btn-ajouter-article', 'click', ajouterArticle);

  // ── Modal participant ─────────────────────────────────────────────────────
  _on('btn-sauvegarder-participant', 'click', sauvegarderParticipant);
  const participantPicker = document.querySelector('#modal-participant .color-picker');
  if (participantPicker) participantPicker.addEventListener('click', e => {
    const btn = e.target.closest('.color-opt');
    if (btn) choisirCouleurParticipant(btn);
  });

  // ── Modal PIN ─────────────────────────────────────────────────────────────
  _on('pin-valeur',           'keydown', e => { if (e.key === 'Enter') sauvegarderPin(); });
  _on('btn-sauvegarder-pin',  'click', sauvegarderPin);

  // ── Modal dépense ─────────────────────────────────────────────────────────
  _on('btn-sauvegarder-depense', 'click', sauvegarderDepense);

  // ── Bottom sheet voyage ───────────────────────────────────────────────────
  _on('btn-partager-voyage',   'click', partagerVoyage);
  _on('btn-rejoindre-voyage',  'click', rejoindreVoyage);
  _on('btn-modifier-voyage',   'click', modifierVoyageActuel);
  _on('btn-supprimer-voyage',  'click', supprimerVoyageActuel);
  _on('overlay-sheet',         'click', fermerBottomSheet);

  // ── Modal partage ─────────────────────────────────────────────────────────
  _on('btn-copier-lien', 'click', copierLienPartage);

  // ── Modal attribution ─────────────────────────────────────────────────────
  _on('btn-sauvegarder-attribution', 'click', sauvegarderAttribution);
  // ── Modal lien attribution ────────────────────────────────────────────────
  _on('btn-sauvegarder-lien', 'click', sauvegarderLienAttribution);
  _on('btn-fermer-lien-modal', 'click', () => document.getElementById('modal-lien-attribution')?.classList.add('hidden'));
  // Sélection du type de lien par clic sur les tuiles
  document.querySelectorAll('.attr-link-type-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      document.querySelectorAll('.attr-link-type-opt').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });

  // ── Modal clôture ─────────────────────────────────────────────────────────
  _on('cloture-btn-action', 'click', archiverVoyage);

  // ── Modal message privé ───────────────────────────────────────────────────
  _on('btn-envoyer-message-prive', 'click', envoyerMessagePrive);

  // ── Delegation globale : fermer modals / bottom sheet ────────────────────
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-modal-close]');
    if (!btn) return;
    const target = btn.dataset.modalClose;
    if (target === 'bottom-sheet') fermerBottomSheet();
    else fermerModal(target);
  });

  // ── Inline onclick refactor (CSP scriptSrcAttr hardening) ────────────────
  // Tous les onclick= ont été supprimés du HTML et migrés ici.
  _on('lang-toggle-btn',         'click', () => window.i18n?.toggleLang());
  _on('btn-rejoindre-shortcut',  'click', rejoindreVoyage);
  _on('btn-open-prepa',          'click', ouvrirPrepa);
  _on('btn-import-email',        'click', ouvrirImportEmail);
  _on('btn-crewipics-join',      'click', rejoindreVoyage);

  // Zone upload photos (trigger file input)
  _on('adm-photo-upload-zone',   'click', () => document.getElementById('adm-photo-file-input')?.click());
  _on('adm-photo-file-input',    'change', function() { previewPhotoUploadAdmin(this); });
  _on('adm-photo-cancel-btn',    'click', annulerUploadPhotoAdmin);
  _on('adm-sort-chip-recent',    'click', () => _setPhotoSortAdmin('recent'));
  _on('adm-sort-chip-likes',     'click', () => _setPhotoSortAdmin('likes'));

  // Lightbox : overlay ferme, contenu bloque propagation
  _on('adm-photo-lightbox',      'click', fermerLightboxAdmin);
  _on('adm-lightbox-img',        'click', e => e.stopPropagation());
  _on('adm-lightbox-info',       'click', e => e.stopPropagation());
  _on('adm-lightbox-actions',    'click', e => e.stopPropagation());
  _on('adm-lightbox-del',        'click', supprimerPhotoAdminLightbox);

  // Wizard de création — bloc partage
  _on('btn-confirm-share-copy',   'click', _confirmShareCopy);
  _on('btn-confirm-share-native', 'click', _confirmShareNative);
  _on('btn-confirm-go',           'click', _confirmGo);

  // Modal rôle — empêcher fermeture par clic sur contenu
  _on('modal-confirm-role-content', 'click', e => e.stopPropagation());
}

document.addEventListener('DOMContentLoaded', _bindStaticHandlers);

// ─── FIX CLAVIER MOBILE : ajuste la hauteur des modales quand le clavier s'ouvre ───
// Sur iOS < 16, dvh n'est pas supporté et position:fixed ne répond pas au clavier.
// Le visualViewport API donne la vraie hauteur visible, hors clavier.
if (window.visualViewport) {
  function _ajusterModalesPourClavier() {
    const vh = window.visualViewport.height;
    document.querySelectorAll('.modal-overlay:not(.hidden) .modal').forEach(modal => {
      modal.style.maxHeight = Math.floor(vh * 0.92) + 'px';
    });
  }
  window.visualViewport.addEventListener('resize', _ajusterModalesPourClavier);
}

// ─── FIX ANDROID : réconciliation de l'UI au retour d'arrière-plan ───────────
// Quand une PWA Android est mise en pause (app en arrière-plan), les timers
// (setTimeout) et les événements d'animation (transitionend/animationend) sont
// gelés ou abandonnés. Une transition de FERMETURE interrompue par la mise en
// pause ne se termine alors jamais : l'overlay plein écran reste « coincé »
// par-dessus l'app au retour → les écrans se superposent et l'interaction est
// bloquée. On force donc la finalisation de ces transitions dès que l'app
// redevient visible après une vraie mise en arrière-plan.
(function initResumeReconcile() {
  let _wasHidden = false;

  function _reconcileOverlays() {
    try {
      // 1) Modales en cours de fermeture (animationend jamais reçu) → finaliser
      document.querySelectorAll('.modal-overlay.modal-closing').forEach(ov => {
        ov.classList.remove('modal-closing');
        ov.classList.add('hidden');
      });

      // 3) Onboarding en fondu sortant (setTimeout gelé) → finaliser
      document.querySelectorAll('.onboarding-overlay.fading').forEach(ov => {
        ov.classList.remove('fading');
        ov.classList.add('hidden');
      });

      // 4) Création IA : l'overlay de chargement est piloté par la promesse
      //    fetch (pas un timer) et toutes les animations sont du CSS pur en boucle,
      //    donc rien à réconcilier ici au retour d'arrière-plan.
    } catch {}
  }

  function _onVisible() {
    if (!_wasHidden) return;       // ignore les bascules de visibilité au démarrage
    _wasHidden = false;
    // Laisser le navigateur reprendre le rendu avant de réconcilier l'UI
    requestAnimationFrame(() => requestAnimationFrame(_reconcileOverlays));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _wasHidden = true;
    else _onVisible();
  });
  // bfcache (retour navigateur) + Page Lifecycle API (resume après freeze Android)
  window.addEventListener('pageshow', e => { if (e.persisted) { _wasHidden = true; _onVisible(); } });
  document.addEventListener('resume', _onVisible);
})();

// ─── PRE-TRIP HUB (vue organisateur — interactive) ───────────────────────────
async function chargerPreparationAdmin() {
  const el = document.getElementById('tab-preparation');
  if (!el) return;

  if (!_shareTokenCourant) {
    el.innerHTML = `
      <div style="padding:32px 20px;text-align:center">
        <div style="font-size:2rem;margin-bottom:12px">🔗</div>
        <p style="color:var(--text-muted);font-size:.88rem;margin-bottom:16px">
          Génère d'abord un lien de partage pour activer le Pre-trip Hub.
        </p>
        <button class="btn-primary" onclick="partagerVoyage()">Créer le lien de partage</button>
      </div>`;
    return;
  }

  el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)">Chargement…</div>';

  const tok = _shareTokenCourant;
  const moi = currentUser?.nom || currentUser?.email || 'Organisateur';
  const couleurMoi = '#F97316';

  const [hypeData, profils, wishlist, sondages] = await Promise.all([
    fetch(`/api/partage/${tok}/hype`).then(r=>r.ok?r.json():{votes:[],moyenne:0,total:0}).catch(()=>({votes:[],moyenne:0,total:0})),
    fetch(`/api/partage/${tok}/profils`).then(r=>r.ok?r.json():[]).catch(()=>[]),
    fetch(`/api/partage/${tok}/wishlist`).then(r=>r.ok?r.json():[]).catch(()=>[]),
    fetch(`/api/partage/${tok}/sondages`).then(r=>r.ok?r.json():[]).catch(()=>[]),
  ]);

  const EMOJIS = ['😴','🙂','😃','🤩','🔥'];
  const LABELS = ['Bof…','Pas mal','Chaud !','Trop hâte','ON FIRE'];
  const pct = hypeData.moyenne ? Math.round((hypeData.moyenne/5)*100) : 0;
  const jaugeColor = pct<40?'#3B82F6':pct<70?'#F59E0B':'#F97316';
  const TYPES = {activite:'🎯',restaurant:'🍽️',destination:'🗺️',logement:'🏠',autre:'✨'};
  const monVoteHype = hypeData.votes.find(v=>v.auteur===moi);
  const monProfil = profils.find(p=>p.auteur===moi);

  el.innerHTML = `<div style="padding:12px 0">

  <!-- ── Hype Meter ───────────────────────────── -->
  <div class="prep-section">
    <div class="prep-section-header">
      <span class="prep-section-title">🔥 Hype Meter</span>
      <span class="prep-section-sub">${hypeData.total} vote${hypeData.total>1?'s':''}</span>
    </div>
    <p class="prep-section-desc">C'est quoi ton niveau d'excitation ? Vote et compare avec le groupe !</p>
    <div class="prep-hype-body">
      <div class="prep-hype-jauge-wrap">
        <div class="prep-hype-jauge"><div class="prep-hype-fill" style="width:${pct}%;background:${jaugeColor}"></div></div>
        <div class="prep-hype-score" style="color:${jaugeColor}">${hypeData.moyenne>0?hypeData.moyenne.toFixed(1):'–'}<span style="font-size:.7em;opacity:.6">/5</span></div>
      </div>
      <div class="prep-hype-btns" id="admin-hype-btns">
        ${EMOJIS.map((e,i)=>`<button class="prep-hype-btn${monVoteHype?.score===i+1?' active':''}" data-score="${i+1}" data-emoji="${e}"><span class="hype-emoji">${e}</span><span class="hype-label">${LABELS[i]}</span></button>`).join('')}
      </div>
      <p style="text-align:center;font-size:.78rem;color:var(--text-muted);margin-top:6px">
        ${monVoteHype?`Ton vote : ${EMOJIS[monVoteHype.score-1]} ${LABELS[monVoteHype.score-1]}`:'Exprime-toi !'}
      </p>
      ${hypeData.votes.length>0?`<div class="prep-hype-voters">${hypeData.votes.map(v=>`<span class="prep-voter-chip">${EMOJIS[v.score-1]} ${h(v.auteur)}</span>`).join('')}</div>`:''}
    </div>
  </div>

  <!-- ── Quick Bio ─────────────────────────────── -->
  <div class="prep-section">
    <div class="prep-section-header">
      <span class="prep-section-title">👤 Profils</span>
      <span class="prep-section-sub">${profils.length} profil${profils.length>1?'s':''}</span>
    </div>
    <p class="prep-section-desc">Quelques mots sur tes habitudes de voyage — aide le groupe à mieux te connaître 😊</p>
    <div class="prep-bio-form">
      <div style="font-size:.82rem;font-weight:700;color:var(--text-muted);margin-bottom:10px">${monProfil?'✏️ Ton profil':'👤 Complète ton profil'}</div>
      <input id="admin-bio-truc" class="prep-input" placeholder="Mon truc en voyage… (ex: je dors 10h 😴)" value="${h(monProfil?.truc_en_voyage||'')}">
      <input id="admin-bio-chaud" class="prep-input" placeholder="Je suis chaud pour… (ex: la street food 🍜)" value="${h(monProfil?.chaud_pour||'')}">
      <button class="prep-btn-primary" id="admin-bio-save">💾 Sauvegarder</button>
    </div>
    <div class="prep-bio-list">
      ${profils.map(p=>`
        <div class="prep-bio-card">
          <div class="prep-bio-avatar" style="background:${h(p.couleur||'#6B7280')}">${(h(p.auteur)||'?')[0].toUpperCase()}</div>
          <div class="prep-bio-body">
            <div class="prep-bio-nom">${h(p.auteur)}</div>
            ${p.truc_en_voyage?`<div class="prep-bio-item">✈️ ${h(p.truc_en_voyage)}</div>`:''}
            ${p.chaud_pour?`<div class="prep-bio-item">🙌 ${h(p.chaud_pour)}</div>`:''}
          </div>
        </div>`).join('')}
    </div>
  </div>

  <!-- ── Wish Wall ─────────────────────────────── -->
  <div class="prep-section">
    <div class="prep-section-header">
      <span class="prep-section-title">💡 Wish Wall</span>
      <span class="prep-section-sub">${wishlist.length} envie${wishlist.length>1?'s':''}</span>
    </div>
    <p class="prep-section-desc">Propose des idées d'activités, restos ou lieux. Like celles qui te branchent !</p>
    <div class="prep-form-box">
      <div id="admin-wish-toggle">
        <button class="prep-btn-add" id="admin-wish-show-btn">+ Ajouter une envie</button>
      </div>
      <div id="admin-wish-form" style="display:none">
        <input id="admin-wish-titre" class="prep-input" placeholder="Mon envie pour ce voyage… *" maxlength="80">
        <div style="display:flex;gap:8px">
          <select id="admin-wish-type" class="prep-select">
            <option value="activite">🎯 Activité</option>
            <option value="restaurant">🍽️ Restaurant</option>
            <option value="destination">🗺️ Destination</option>
            <option value="logement">🏠 Logement</option>
            <option value="autre">✨ Autre</option>
          </select>
        </div>
        <textarea id="admin-wish-desc" class="prep-input" rows="2" placeholder="Description (optionnel)…"></textarea>
        <input id="admin-wish-url" class="prep-input" type="url" placeholder="Lien (optionnel)…">
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="prep-btn-secondary" id="admin-wish-cancel">Annuler</button>
          <button class="prep-btn-primary" id="admin-wish-submit">Ajouter ✨</button>
        </div>
      </div>
    </div>
    <div id="admin-wish-list" style="padding:10px 14px;display:flex;flex-direction:column;gap:10px">
      ${wishlist.length>0?wishlist.map(w=>{
        const likes=Array.isArray(w.likes)?w.likes:[];
        const jaLike=likes.includes(moi);
        return `<div class="prep-wish-card" data-id="${w.id}">
          <div class="prep-wish-header">
            <span class="prep-wish-type">${TYPES[w.type]||'✨'}</span>
            <div class="prep-wish-info">
              <span class="prep-wish-titre">${h(w.titre)}</span>
              <span class="prep-wish-auteur">par ${h(w.auteur)}</span>
            </div>
            <button class="prep-btn-icon admin-wish-del" data-id="${w.id}" title="Supprimer">✕</button>
          </div>
          ${w.description?`<p class="prep-wish-desc">${h(w.description)}</p>`:''}
          <div class="prep-wish-footer">
            <button class="prep-like-btn${jaLike?' liked':''} admin-wish-like" data-id="${w.id}">${jaLike?'❤️':'🤍'} ${likes.length||''}</button>
            ${likes.length>0?`<span class="prep-like-names">${likes.slice(0,3).map(h).join(', ')}${likes.length>3?` +${likes.length-3}`:''}</span>`:''}
          </div>
        </div>`;}).join(''):`<p style="text-align:center;font-size:.82rem;color:var(--text-muted)">Aucune envie pour l'instant</p>`}
    </div>
  </div>

  <!-- ── Sondages ───────────────────────────────── -->
  <div class="prep-section">
    <div class="prep-section-header">
      <span class="prep-section-title">🗳️ Votes du groupe</span>
      <span class="prep-section-sub">${sondages.length} sondage${sondages.length>1?'s':''}</span>
    </div>
    <p class="prep-section-desc">Décidez ensemble des activités, hébergements ou autres choix collectifs.</p>
    <div class="prep-form-box">
      <div id="admin-poll-toggle">
        <button class="prep-btn-add" id="admin-poll-show-btn">+ Créer un vote</button>
      </div>
      <div id="admin-poll-form" style="display:none">
        <input id="admin-poll-titre" class="prep-input" placeholder="Votre question… *" maxlength="100">
        <div id="admin-poll-options">
          <input class="prep-input admin-poll-opt" placeholder="Option 1…" maxlength="60">
          <input class="prep-input admin-poll-opt" placeholder="Option 2…" maxlength="60">
        </div>
        <button class="prep-btn-link" id="admin-poll-add-opt">+ Ajouter une option</button>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="prep-btn-secondary" id="admin-poll-cancel">Annuler</button>
          <button class="prep-btn-primary" id="admin-poll-submit">Lancer le vote 🗳️</button>
        </div>
      </div>
    </div>
    <div id="admin-sondages-list" style="padding:10px 14px;display:flex;flex-direction:column;gap:12px">
      ${sondages.length>0?sondages.map(s=>{
        const opts=s.options||[];const votes=s.votes||[];const total=votes.length;
        const monVote=votes.find(v=>v.auteur===moi);
        const estFerme=s.statut==='fermé';
        return `<div class="prep-poll-card">
          <div class="prep-poll-header">
            <span class="prep-poll-titre">${h(s.titre)}</span>
            <div style="display:flex;gap:6px;align-items:center">
              <span class="prep-pill ${estFerme?'prep-pill-closed':'prep-pill-open'}">${estFerme?'Fermé':'Ouvert'}</span>
              ${!estFerme?`<button class="prep-btn-icon admin-poll-fermer" data-id="${s.id}" title="Fermer">🔒</button>`:''}
              <button class="prep-btn-icon admin-poll-del" data-id="${s.id}" title="Supprimer">✕</button>
            </div>
          </div>
          <div class="prep-poll-options">
            ${opts.map(opt=>{
              const nb=votes.filter(v=>v.option_id===opt.id).length;
              const p=total>0?Math.round((nb/total)*100):0;
              const jaVote=monVote?.option_id===opt.id;
              return `<div class="prep-poll-option${jaVote?' my-vote':''}" ${!estFerme?`data-sondage="${s.id}" data-option="${opt.id}" style="cursor:pointer"`:''}>
                <div class="prep-poll-bar-wrap">
                  <div class="prep-poll-bar" style="width:${p}%"></div>
                  <span class="prep-poll-label">${h(opt.texte)}</span>
                  <span class="prep-poll-pct">${total>0?p+'%':''} ${nb>0?'('+nb+')':''}</span>
                </div>
              </div>`;}).join('')}
          </div>
          <div class="prep-poll-footer"><span>${total} vote${total>1?'s':''}</span><span>par ${h(s.created_by)}</span></div>
        </div>`;}).join(''):`<p style="text-align:center;font-size:.82rem;color:var(--text-muted)">Aucun vote pour l'instant</p>`}
    </div>
  </div>

  </div>`;

  // ── Event bindings ─────────────────────────────────────────────────────────

  // Hype
  document.getElementById('admin-hype-btns')?.querySelectorAll('.prep-hype-btn').forEach(btn=>{
    btn.addEventListener('click', async()=>{
      document.getElementById('admin-hype-btns')?.querySelectorAll('.prep-hype-btn').forEach(b=>{b.disabled=true;b.style.opacity='0.5';});
      await fetch(`/api/partage/${tok}/hype`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auteur:moi,score:+btn.dataset.score,emoji:btn.dataset.emoji})});
      chargerPreparationAdmin();
    });
  });

  // Bio
  document.getElementById('admin-bio-save')?.addEventListener('click', async()=>{
    const btn=document.getElementById('admin-bio-save');
    btn.textContent='Sauvegarde…';
    await fetch(`/api/partage/${tok}/profil`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auteur:moi,couleur:couleurMoi,truc_en_voyage:document.getElementById('admin-bio-truc')?.value.trim()||null,chaud_pour:document.getElementById('admin-bio-chaud')?.value.trim()||null})});
    chargerPreparationAdmin();
  });

  // Wish — show/hide form
  document.getElementById('admin-wish-show-btn')?.addEventListener('click',()=>{
    document.getElementById('admin-wish-form').style.display='';
    document.getElementById('admin-wish-toggle').style.display='none';
  });
  document.getElementById('admin-wish-cancel')?.addEventListener('click',()=>{
    document.getElementById('admin-wish-form').style.display='none';
    document.getElementById('admin-wish-toggle').style.display='';
  });
  document.getElementById('admin-wish-submit')?.addEventListener('click', async()=>{
    const titre=document.getElementById('admin-wish-titre')?.value.trim();
    if(!titre){toast('⚠️ Titre requis');return;}
    const r=await fetch(`/api/partage/${tok}/wishlist`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auteur:moi,titre,description:document.getElementById('admin-wish-desc')?.value.trim()||null,type:document.getElementById('admin-wish-type')?.value||'activite',url:document.getElementById('admin-wish-url')?.value.trim()||null})}).then(r=>r.json()).catch(()=>({}));
    if(r.id) chargerPreparationAdmin();
  });
  // Wish — like & delete
  document.querySelectorAll('.admin-wish-like').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      await fetch(`/api/partage/${tok}/wishlist/${btn.dataset.id}/like`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auteur:moi})});
      chargerPreparationAdmin();
    });
  });
  document.querySelectorAll('.admin-wish-del').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      if(!confirm('Supprimer cette envie ?'))return;
      await fetch(`/api/partage/${tok}/wishlist/${btn.dataset.id}`,{method:'DELETE'});
      chargerPreparationAdmin();
    });
  });

  // Poll — show/hide form
  document.getElementById('admin-poll-show-btn')?.addEventListener('click',()=>{
    document.getElementById('admin-poll-form').style.display='';
    document.getElementById('admin-poll-toggle').style.display='none';
  });
  document.getElementById('admin-poll-cancel')?.addEventListener('click',()=>{
    document.getElementById('admin-poll-form').style.display='none';
    document.getElementById('admin-poll-toggle').style.display='';
  });
  document.getElementById('admin-poll-add-opt')?.addEventListener('click',()=>{
    const list=document.getElementById('admin-poll-options');
    if(list.querySelectorAll('.admin-poll-opt').length>=6){toast('Maximum 6 options');return;}
    const inp=document.createElement('input');
    inp.className='prep-input admin-poll-opt';
    inp.placeholder=`Option ${list.querySelectorAll('.admin-poll-opt').length+1}…`;
    inp.maxLength=60;
    list.appendChild(inp);
  });
  document.getElementById('admin-poll-submit')?.addEventListener('click', async()=>{
    const titre=document.getElementById('admin-poll-titre')?.value.trim();
    const options=[...document.querySelectorAll('.admin-poll-opt')].map(i=>i.value.trim()).filter(Boolean);
    if(!titre){toast('⚠️ Question requise');return;}
    if(options.length<2){toast('⚠️ Au moins 2 options');return;}
    const r=await fetch(`/api/partage/${tok}/sondages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titre,options,created_by:moi})}).then(r=>r.json()).catch(()=>({}));
    if(r.id) chargerPreparationAdmin();
  });
  // Poll — vote, fermer, supprimer
  document.querySelectorAll('.prep-poll-option[data-sondage]').forEach(opt=>{
    opt.addEventListener('click',async()=>{
      await fetch(`/api/partage/${tok}/sondages/${opt.dataset.sondage}/vote`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({option_id:+opt.dataset.option,auteur:moi})});
      chargerPreparationAdmin();
    });
  });
  document.querySelectorAll('.admin-poll-fermer').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      if(!confirm('Fermer ce vote ?'))return;
      await fetch(`/api/partage/${tok}/sondages/${btn.dataset.id}/fermer`,{method:'PATCH'});
      chargerPreparationAdmin();
    });
  });
  document.querySelectorAll('.admin-poll-del').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      if(!confirm('Supprimer ce sondage ?'))return;
      await fetch(`/api/partage/${tok}/sondages/${btn.dataset.id}`,{method:'DELETE'});
      chargerPreparationAdmin();
    });
  });
}
