# CLEANUP_AUDIT.md — Audit du code mort (Agent 1, analyse seule)

> Date : 2026-06-12 · Branche cible pour Agent 2 : `cleanup/dead-code`
> Principe directeur : **la stabilité prime sur l'exhaustivité**. En cas de
> doute → classé DOUTEUX, listé pour arbitrage humain, **jamais supprimé
> automatiquement**.

---

## 1. Cartographie des fichiers et de leurs liens

### Fichiers HTML servis et ce qu'ils chargent
| HTML | Servi par | Charge (local) |
|------|-----------|----------------|
| `public/index.html` | route `/app` (server.js:108) | `style.css`, `i18n.js`, `app.js` |
| `public/partage.html` | route `/share/:token` (server.js:2236) | `/style.css`, `/app.js` (+ CSS/JS inline) |
| `public/landing.html` | module `./landing.js` (GET `/`) | `favicon.svg`, `logo-icon.png` (styles inline) |
| `public/offline.html` | fallback SW | rien (inline) |
| `public/confidentialite.html` | route `/confidentialite` (server.js:146) | rien (inline) |
| `public/cockpit/index.html` | module `./cockpit.js` (`/cockpit`) | `/cockpit/cockpit.js` |

### Modules serveur (tous montés dans server.js → VIVANTS)
`server.js` → `require('./cockpit')` (L153), `require('./landing')` (L158),
`require('./database')`, `require('./sessions')`, `services/*` (magicLink,
parseTripAI, photoLikes, tripClosure, tripMemoryEmail, tripSummaryAI,
verifyParticipantSession). Tous référencés → **non morts**.

### Service Worker
`public/sw.js` (route `/sw.js`, server.js:141) — pré-cache `/`, `index.html`,
`offline.html`, logos, manifest, polices. **Vivant.**

### Assets vérifiés
- `public/favicon.svg` → référencé par `landing.html` → **vivant** (existe).
- Logos `logo-icon/192/512.png` → référencés (HTML + manifest + sw) → vivants.
- Polices `fonts/Satoshi-*.woff2` → préchargées + précache SW → vivantes.

---

## 2. Classement

### 🟢 CERTAIN — aucune référence nulle part (sûr à retirer)

#### 2.1 Fichiers orphelins (non servis, non liés, 0 référence tierce)
| Fichier | Preuve |
|---------|--------|
| `maquette-bandeau.html` | racine repo, hors `public/` → non servi par express.static ; `grep -r "maquette-bandeau"` = 0 référence tierce |
| `maquette-create-trip.html` | idem → 0 référence tierce. Maquette de prototypage |
| `public/logo-preview.html` | servi statiquement à `/logo-preview.html` mais **lié par aucun HTML/JS** ; `grep -r "logo-preview"` = 0 référence tierce. Outil de prévisualisation interne |

#### 2.2 Fonctions JS jamais appelées (`public/app.js`)
Preuve : `grep -rn "<nom>" --include=*.js --include=*.html .` ne retourne **que
la ligne de définition** (aucun appelant, aucun `onclick=`, aucun `window[...]`,
aucune concaténation). Corpus croisé : index.html + app.js + i18n.js + partage.html.

| Fonction | Lignes (approx.) | Preuve |
|----------|------------------|--------|
| `filtrerReservations(filtre, btn)` | ~2084–2089 | 1 seule occurrence repo. Ancien handler de filtre (paramètre `btn` = ex-`onclick`) |
| `chargerDocuments()` | ~3170–3227 | 1 seule occurrence repo. Loader d'onglet superseded |
| `envoyerPhotoAdmin()` | ~4809–4831 | 1 seule occurrence repo. Envoi photo côté admin superseded |
| `_nomAdminModal(defaultName)` | ~5122–5151 | 1 seule occurrence repo. Doublon de `_nomAdminPromise` (partage.html) |

> ⚠️ NB important — **NON morts** malgré une seule occurrence : les IIFE
> auto-exécutées `installFetchInterceptor`, `initPWAInstallApp`,
> `initAccountMenu`, `initResumeReconcile` (forme `(function X(){…})()`). Leur
> nom n'est qu'un label ; elles s'exécutent au chargement. **À conserver.**

---

### 🟠 DOUTEUX — listé pour arbitrage, NE PAS supprimer automatiquement

#### 2.3 Sélecteurs CSS sans référence directe HTML/JS (`public/style.css`)
660 classes analysées. 40 sans référence directe, MAIS le croisement a prouvé
que des classes sont **construites dynamiquement** (faux positifs) :
- `badge-${statut.classe}` (app.js:1153) → `badge-done/-ongoing/-past/-upcoming`
  **sont utilisées** → **à conserver** (retirées de la liste morte).
- `alink-icon--${l.type}` (partage.html:2719/3545) → `alink-icon--billet/-voucher/
  -document/-qrcode/-information/-autre` **sont utilisées** → **à conserver**.

Restent les candidates ci-dessous : **zéro référence HTML/JS détectée**, mais
appartenant à des features potentiellement actives (agenda, création de voyage,
carte, lieux, dashboard). Le risque de classe injectée dynamiquement non
détectée impose un arbitrage feature par feature **avant** toute suppression :

| Groupe (feature) | Classes candidates |
|------------------|--------------------|
| Agenda | `agenda-actions`, `agenda-content`, `agenda-day`, `agenda-day-header`, `agenda-heure`, `agenda-item`, `agenda-lien`, `agenda-lieu`, `agenda-line` |
| Création voyage (ancien wizard ?) | `create-big-input`, `create-color-opt`, `create-color-row`, `create-dest-field`, `create-dest-fields`, `create-dest-label`, `create-suggestion-pill`, `create-suggestions-label` |
| Carte | `carte-frame`, `carte-frame-container`, `carte-header`, `carte-info` |
| Lieux | `lieu-emoji`, `lieu-item`, `lieux-list` |
| Dashboard / stats | `dash-stat-bar-fill`, `stat-pill--participant`, `stat-pill--upcoming` |
| Divers | `filter-chips`, `cloture-header-trip`, `crewigo-logo--white` |

> Plus 17 classes à préfixe dynamique avéré (`dash-*`, `icon-*`, `rd-icon`,
> `resa-confirmation`, `create-hint/-suggestions`, `adm-row-ref`,
> `crewigo-logo-icon`, `home-hero-grad`, `alink-arrow`) → **conserver**, très
> probablement injectées via template literals.

#### 2.4 Logs serveur (`server.js`)
15 `console.log/console.warn`. Côté serveur = journalisation opérationnelle
(diagnostic prod Railway), **pas du debug front**. Recommandation : **conserver**.
`public/app.js` et `public/partage.html` = **0 console.log** (déjà propres).

#### 2.5 Scripts d'exploitation / docs (ne pas toucher sans demande)
- `migrate-docs.js`, `migrate-to-cloud.js` → scripts de migration one-shot
  (ops). Non chargés au runtime mais potentiellement nécessaires. **Conserver.**
- `audit/*.html` (audit-produit, audit-technique, dossier-audit,
  video-explicative) → livrables documentaires (se référencent entre eux).
  **Conserver** (documents, pas du code applicatif).

---

## 3. Plan de suppression proposé pour l'Agent 2 (sur validation)

**Périmètre CERTAIN uniquement** (faible risque, preuve de non-référence) :

- **Lot A — fichiers orphelins** : `maquette-bandeau.html`,
  `maquette-create-trip.html`, `public/logo-preview.html`.
- **Lot B — fonctions JS jamais appelées** : `filtrerReservations`,
  `chargerDocuments`, `envoyerPhotoAdmin`, `_nomAdminModal` (app.js).

Chaque lot = 1 commit explicite, puis vérification (Agent 3) : `node -c`,
syntaxe JS inline, chargement des pages, console navigateur propre.

**Hors périmètre automatique** : tout le §2.3 (CSS) reste en arbitrage. Si tu
veux, je traite ensuite le CSS feature par feature, en confirmant pour chaque
groupe que la feature n'existe plus avant de retirer ses classes.

---

## 4. Résumé chiffré
| Catégorie | CERTAIN | DOUTEUX |
|-----------|:-------:|:-------:|
| Fichiers orphelins | 3 | 0 |
| Fonctions JS | 4 | 0 |
| Classes CSS | 0 | ~30 (après exclusion des dynamiques confirmées) |
| Logs serveur | 0 | 15 (conserver) |
| Scripts/docs | 0 | 6 (conserver) |
