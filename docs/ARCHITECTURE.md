# Architecture

## Où vit quoi

| Couche | Hébergement | Pourquoi |
|---|---|---|
| Site + parcours d'inscription | Vercel, Astro statique | Rien à servir dynamiquement ; le parcours est du JS de 14 ko |
| Données | Supabase Postgres (`eu-west-1`) | Source de vérité unique, RLS, Realtime pour l'interface à venir |
| OCR (pièces, bulletins) | Cloud Run `prems-api`, `europe-west9` | Porte des secrets que le navigateur ne doit jamais voir |
| Scrapers, matching, envoi | Cloud Run Jobs + Pub/Sub (à venir) | Doivent tourner 24h/24, indépendamment du site |

Le principe : **le site n'est jamais dans le chemin critique**. Tout ce qui
produit de la valeur — détecter, matcher, candidater — tourne sur GCP et écrit
dans Supabase. L'interface de la prochaine session sera une lecture temps réel
de `events`, rien de plus.

## Le monorepo

L'application Astro reste **à la racine**. Ce n'est pas un oubli : le projet
Vercel est configuré avec `rootDirectory: null`, et ce réglage ne peut pas être
changé depuis le connecteur MCP de cette session. Déplacer le site sous
`apps/web/` casserait le déploiement de production sans qu'on puisse le
réparer d'ici.

```
/                      le site Astro (pages, composants, styles, tools/)
packages/core/         le domaine : types, filtre dur, score, dédoublonnage
supabase/migrations/   le schéma, en SQL idempotent
services/prems-api/    le service OCR Cloud Run
docs/                  ce dossier
```

`packages/*` sont des workspaces npm. `npm run ci` fait typecheck + tests + build.

## Le schéma

Deux migrations, toutes deux ré-exécutables sans effet de bord.

- **0001** — ce dont le parcours d'inscription a besoin : `profiles`,
  `searches`, `documents`, `funnel_events`, et `demo_listings` (le catalogue de
  démonstration derrière l'écran « 8 appartements matchent »).
- **0002** — la machine : `sources`, `scrape_runs`, `listings`,
  `listing_embeddings`, `listing_duplicates`, `matches`, `applications`,
  `application_replies`, `consents`, `events`.

### Le renommage qui compte

0001 appelait son catalogue de démonstration `listings`. 0002 le renomme en
`demo_listings` et donne ce nom au catalogue scrapé. **Ce n'est pas cosmétique :**
la table de démonstration porte une policy `using (true)` — lisible par
n'importe qui, ce qui est voulu pour l'écran d'accroche. Laisser 0001 pointer
sur `listings` aurait réappliqué cette policy sur le catalogue de production à
la migration suivante, c'est-à-dire une fuite déguisée en no-op.

Trois endroits devaient suivre le renommage, et les trois l'ont fait :
`src/lib/prems/listings.js`, `tools/supabase/seed-listings.mjs` (qui fait un
`DELETE` sur toute sa table cible avant d'écrire), et 0001 lui-même.

### Ce que voit un navigateur

`sources`, `scrape_runs`, `listing_embeddings` et `listing_duplicates` ont la
RLS activée et **aucune policy** : RLS sans policy refuse tout, ce qui est
exactement le bon réglage pour des tables que seul le pipeline touche.

`listings` n'est lisible que par jointure sur un match qui vous appartient. Le
catalogue est l'actif du produit ; il n'est pas lisible en gros.

## Le score

`packages/core/src/match.ts`. Filtre dur d'abord (arithmétique pure sur des
colonnes indexées), score ensuite, sémantique en dernier — l'ordre inverse
reviendrait à embedder chaque annonce contre chaque client.

La **fraîcheur pèse plus que n'importe quel critère de confort** (0,27 contre
0,20 pour le budget), demi-vie de 90 minutes. C'est la thèse du produit : face
à un logement légèrement mieux adapté mais vieux de quatre heures, celui publié
il y a une minute est celui que le client peut encore obtenir.

Quand un client n'a pas écrit de texte libre, le poids sémantique est
**redistribué** sur les autres composantes plutôt que compté comme zéro —
sinon `min_score` cesserait silencieusement de vouloir dire ce qu'il dit.

## Ce qui n'est pas encore fait

Les scrapers, le matching en production, l'envoi de candidatures. Le schéma les
attend ; voir `docs/RUNBOOK.md` pour les rôles IAM qui manquent encore.
