# Prompt — Centre de Commandement CrewiGo (analytics & pilotage)

> Fichier de brief réutilisable. Toute session IA (Claude Code, Copilot, agent) qui
> implémente une fonctionnalité d'analytics, de dashboard ou de pilotage produit
> pour CrewiGo DOIT lire ce fichier d'abord. Il fige le contexte, le cadre
> d'expertise et les décisions d'architecture déjà validées — ne pas les re-débattre.

---

## 1. Rôle attendu

Tu interviens avec une quadruple casquette : **Product Manager + CTO + Head of Growth + UX Lead**.
Ta priorité est la **prise de décision actionnable**, pas l'accumulation de métriques.
Tu remets en question toute demande qui ajoute du bruit décisionnel.

Principe directeur : **« Le vrai risque n'est pas de manquer des données, c'est de
construire un système de mesure sophistiqué avant d'avoir quelque chose à mesurer. »**

---

## 2. Contexte produit (non négociable)

CrewiGo (crewigo.app) est une **PWA de coordination de voyage en groupe**.
Usage **épisodique et événementiel**, jamais quotidien : un organisateur crée un
voyage des semaines avant le départ, l'activité culmine autour des dates du voyage,
puis retombe. C'est normal, ce n'est pas un échec de rétention.

**Conséquence stratégique majeure :**
- ❌ NE PAS utiliser DAU / WAU / MAU au sens standard — structurellement trompeur ici.
- ✅ L'unité d'analyse n'est PAS l'utilisateur. C'est **le voyage**.
- ✅ Tout KPI doit être **normalisé par le voyage** et ancré dans son cycle de vie :
  `Création → Configuration → Invitation → Pré-voyage → Voyage actif → Post-voyage`

---

## 3. Stack technique existante

- Backend : **Node.js / Express** (`server.js`, ~134 Ko, routes REST `/api/...`).
- Données : couche d'accès custom `database.js` — **JSON local en dev**, **PostgreSQL
  en prod** (Railway). Drapeau `db.usePostgres` / `IS_CLOUD`. Toujours écrire les deux
  implémentations (JSON + PG) pour chaque nouvelle requête.
- Front : PWA vanilla JS — `public/app.js` (vue organisateur/admin),
  `public/partage.html` (vue participant/crew), `public/index.html`, `public/style.css`.
- Service Worker : `public/sw.js` — bumper `CACHE_VERSION` (`cgo-vXX`) à chaque déploiement.
- Auth : JWT (`crewigo_token`) pour l'organisateur ; identités participants en
  localStorage (`partage_id_TOKEN`) + fallback IndexedDB.
- Tables clés : `voyages`, `participants`, `commentaires` (chat), `documents`,
  `attributions` (+ `attribution_links`), `depenses`, `reservations`,
  `push_subscriptions`, `messages_prives`.

Toute route analytics admin doit passer par `authMiddleware` + `requireVoyageOwner()`
ou un middleware admin équivalent. Jamais de stats exposées sans auth.

---

## 4. Architecture validée — 5 axes (redéfinis)

1. **Adoption organisateur** — nouveaux voyages, organisateurs multi-voyages, délai
   création→1er participant, taux de setup complet.
2. **Engagement participants** — conversion lien→identité, % participants actifs
   pendant les dates, messages CrewiChat (médiane), taux d'ouverture des notifications.
3. **Adoption des fonctionnalités** — % de voyages utilisant attributions / documents /
   dépenses / QR codes.
4. **Santé technique** — taux 5xx, P95 latence API, cache hit SW, échecs push.
5. **Croissance organique** — nouveaux organisateurs par source, conversion landing→voyage,
   nb moyen de participants par voyage (viralité intrinsèque).

---

## 5. Dashboard exécutif — 12 KPI (3 minutes / semaine)

**Bloc Croissance**
1. Voyages créés cette semaine (Δ% vs semaine précédente)
2. Nouveaux participants rejoints cette semaine
3. Taux d'organisateurs multi-voyages (cumulé)

**Bloc Engagement**
4. Voyages actifs cette semaine (≥ 1 action sur 7 j)
5. Messages CrewiChat envoyés cette semaine
6. Taux d'ouverture des notifications push (7 j glissants)
7. Taux de conversion lien partagé → participant identifié

**Bloc Santé technique**
8. Taux d'erreurs 5xx (7 j, seuils vert/orange/rouge)
9. P95 temps de réponse API (ms)
10. Incidents critiques actifs (Sentry)

**Bloc Signal stratégique**
11. Adoption attributions privées (% voyages actifs)
12. Taux de setup complet (création → participants → doc → 1re attribution)

**À reléguer en vues secondaires :** détail par voyage, breakdown par fonctionnalité,
historique releases/bugs, funnel d'inscription détaillé.
**À supprimer / ne jamais afficher en principal :** DAU, durée de session, taux de
rebond, « score d'engagement » composite propriétaire, volumes bruts non normalisés.

---

## 6. Règles de mesure (à appliquer systématiquement)

- Préférer la **médiane** à la moyenne (résistance aux outliers de taille de groupe).
- Toujours **normaliser par le voyage** (`% de voyages qui...`), jamais le volume absolu.
- Contextualiser par **phase du cycle de vie** et par **calendrier** (pas d'alerte sur
  une chute d'activité hors saison).
- Un KPI sans action associée = un KPI à supprimer.
- Pour les ratios d'usage réel : privilégier `uploads/téléchargements`,
  `notifications→action sous 5 min`, plutôt que les compteurs d'émission.

---

## 7. Plan d'implémentation priorisé

**Priorité 1 — immédiat**
- `Sentry` : monitoring d'erreurs front + back (1 h, ROI maximal).
- Dashboard admin custom : route `GET /api/admin/stats` agrégeant les 12 KPI depuis
  la DB existante (JSON + PG) + rendu Chart.js dans un onglet « Stats » de `app.js`.
- Logging structuré côté serveur : `route | durée | status | UA` → exploitable pour
  P95 et taux d'erreur.

**Priorité 2 — sous 3 mois**
- `PostHog` (event tracking) : `voyage_created`, `participant_joined`, `message_sent`,
  `attribution_created`, `notification_clicked`, `feature_opened`.
- Funnel d'activation landing → inscription → 1er voyage complet.
- Alertes automatiques (webhook/cron) sur les seuils ci-dessous.

**Priorité 3 — à maturité (≥ 50 voyages réels)**
- `Metabase` sur PostgreSQL (analyses SQL ad-hoc).
- Cohortes organisateurs (rétention par mois d'acquisition).
- Session replay (PostHog).

---

## 8. Décisions outils (figées)

| Outil | Verdict | Quand |
|-------|---------|-------|
| **Sentry** | ✅ Adopter | Maintenant |
| **PostHog** | ✅ Adopter | 3 mois |
| **Metabase** | ✅ Adopter | À maturité |
| **Grafana** | ⚠️ Limité | Seulement si l'infra se complexifie |
| **Supabase Analytics** | ❌ Éviter | Pas de Supabase dans la stack |
| **Power BI** | ❌ Éviter | Coût/complexité disproportionnés |

Architecture cible :
```
Maintenant : Railway logs + Sentry + dashboard custom (DB)
+3 mois     : + PostHog (events / funnels / rétention)
À maturité  : + Metabase (SQL ad-hoc)
```

---

## 9. Seuils d'alerte de référence

| Condition | Niveau | Canal |
|-----------|--------|-------|
| Taux 5xx > 1 % sur 15 min | Critique | Email + SMS |
| P95 > 3 s | Avertissement | Email |
| Échecs push > 10 % | Avertissement | Email |
| 0 voyage créé en 7 j | Signal stratégique | Email hebdo |
| Conversion lien < 30 % | Signal produit | Dashboard |

---

## 10. Définition de « terminé » pour toute tâche analytics

- [ ] La métrique est **normalisée par le voyage** (ou justification explicite si non).
- [ ] Implémentée pour **JSON ET PostgreSQL** dans `database.js`.
- [ ] Route protégée par auth admin.
- [ ] Une **action concrète** est associée au KPI (sinon, ne pas l'implémenter).
- [ ] `CACHE_VERSION` (`sw.js`) bumpé si le front change.
- [ ] Pas de DAU/MAU standard, pas de vanity metric composite, pas de volume brut en vue principale.
