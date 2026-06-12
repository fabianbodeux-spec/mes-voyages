# CLEANUP_REPORT.md — Rapport de nettoyage (Agents 2 & 3)

> Branche : `cleanup/dead-code` · Date : 2026-06-12
> Périmètre validé par l'utilisateur : **fichiers orphelins uniquement**
> (`app.js`/`style.css` laissés totalement intacts).

---

## ✅ Supprimé (lot orphelins — commit `f6ea55d`)
| Fichier | Type | Justification |
|---------|------|---------------|
| `maquette-bandeau.html` | Maquette HTML | Hors `public/` (non servi) · 0 référence tierce |
| `maquette-create-trip.html` | Maquette HTML | Hors `public/` (non servi) · 0 référence tierce |
| `public/logo-preview.html` | Outil de preview | Servi statiquement mais lié par aucun HTML/JS · 0 référence tierce |

Total : **3 fichiers, 804 lignes retirées.**

## 🟠 Conservé pour arbitrage (non traité, sur décision utilisateur)
- **4 fonctions JS mortes** dans `app.js` (`filtrerReservations`,
  `chargerDocuments`, `envoyerPhotoAdmin`, `_nomAdminModal`) — classées CERTAIN
  dans l'audit mais **volontairement non retirées** (choix : périmètre minimal).
- **~30 classes CSS** sans référence directe — restent en DOUTEUX (cf.
  CLEANUP_AUDIT.md §2.3), arbitrage feature par feature requis.
- **15 logs serveur**, scripts de migration, `audit/*` → conservés.

## 🔍 État final vérifié (Agent 3)
| Contrôle | Résultat |
|----------|----------|
| `node -c server.js` | ✅ OK |
| Fichiers bien supprimés | ✅ 3/3 absents |
| Références pendantes (risque 404) | ✅ 0 |
| Diff sur fichiers servis (app.js, style.css, index.html, partage.html, server.js) | ✅ Aucun — app applicative intacte |
| Pages servies (`/app`, `/share/:token`, `/`, `/cockpit`) | ✅ Inchangées (aucun de leurs assets touché) |

## Conclusion
Suppression sans aucune régression possible : les 3 fichiers n'étaient chargés
ni liés par aucune page de l'application. Le code applicatif (organisateur,
partage, landing, cockpit) n'a pas été modifié d'une seule ligne dans ce lot.
