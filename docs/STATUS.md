# État du système

> **Mise à jour du 14 septembre 2026 — agents portés sur Strands + Amazon Bedrock.**
> Les trois agents tournent désormais sur le **Strands Agents SDK** (TypeScript) avec
> **Claude Opus 5 via Amazon Bedrock** (`eu.anthropic.claude-opus-5`, `eu-west-3`).
> Les passages ci-dessous qui parlent d'ADK, de Gemini ou de Vertex AI pour les agents
> décrivent l'état antérieur ; Vertex AI ne sert plus qu'aux embeddings. La référence à
> jour est le [README](../README.md) et `npm run bedrock:models` remplace `gcp:models`.


À lire en premier. Les détails sont dans `ARCHITECTURE.md` (comment c'est fait),
`RUNBOOK.md` (comment l'exploiter) et `sources/README.md` (ce qui a été mesuré
sur les sites).

## Ce qui tourne, sans surveillance

Six jobs Cloud Run en `europe-west9`, une seule image, seul `MODE` diffère.

| Job | Cadence | État |
|---|---|---|
| `prems-scrape-bienici` | 1 min | **1 440 runs / 24 h, 0 échec** |
| `prems-enrich` | 5 min | 720/720 embeddings |
| `prems-match` | 1 min | ~390 ms par annonce |
| `prems-apply` | 2 min | en attente d'une boîte Gmail connectée |
| `prems-inbox` | 8 h | jamais exécuté en conditions réelles |
| `prems-agencies` | 15 min | résout les adresses, en cours |

Alerting : `pg_cron` toutes les 10 min, dans la base — une alarme sur le pipeline
ne doit pas dépendre du pipeline.

## L'agent vu par le client — onglet « Agent »

`events` portait déjà chaque décision ; personne ne pouvait les lire. Le
cinquième onglet de `/app` les affiche : ce que l'agent a regardé, ce qu'il en a
conclu, quels outils il a appelés pour le conclure, et ce qu'il attend de toi.

Deux choses y vivent :

- **Ce qu'il attend**, en haut, parce qu'une demande ouverte bloque une
  candidature alors qu'un journal ne bloque rien. Quand l'agence réclame une
  pièce que le dossier n'a pas, l'agent appelle `request_document` : la demande
  apparaît ici avec son motif et un dépôt de fichier à côté.
- **Le journal**, une frise où une *pensée* (« a écarté un logement ») et une
  *action* (« a envoyé la candidature ») ne se lisent pas pareil — confondre les
  deux est ce qui rend un agent inquiétant.

Les outils appelés sont affichés en clair sous chaque entrée : « a consulté ton
agenda Google, a relu ton dossier, a rédigé la réponse ». C'est la différence
entre une décision vérifiable et une décision qu'il faut croire.

**Prérequis** : `npm run db:migrate` — la migration `0017` crée
`agent_requests` et la vue `agent_activity`. Sans elle l'onglet s'affiche vide
plutôt que de casser.

## Ce qui décide, dans ces jobs

Trois agents, tous sur `gemini-3.7-flash` via Vertex AI, construits avec l'Agent
Development Kit. Le modèle et son authentification sont nommés dans un seul
fichier, `workers/src/agent.ts` — c'est là qu'on change de modèle, et nulle part
ailleurs.

| Agent | Outils | Appelé par |
|---|---|---|
| `prems_application_writer` | aucun | `prems-apply` |
| `prems_reply_classifier` | aucun | `prems-inbox` |
| `prems_negotiator` | 4 | `prems-inbox` |

Les garde-fous du négociateur sont en code et non dans le prompt ; les cinq cas
sont rejoués sans modèle dans `workers/test/negotiate.test.ts`. Détail dans
`ARCHITECTURE.md`.

**Vérifié le 27 août, plus supposé.** `npm run gcp:models` appelle chaque
endpoint et rend la matrice ; elle est dans `RUNBOOK.md` §4. Ce qu'elle a
corrigé :

- `gemini-3.7-flash@global` **répond**. C'est ce que le code vise.
- **`eu` n'existe pas pour Vertex AI** — 400 « Invalid hostname ». Le repli
  documenté ici pendant deux commits aurait échoué au premier appel.
- Le vrai repli à résidence UE est **`gemini-3.5-flash@europe-west3`**
  (Francfort), seule région européenne à servir un modèle 3.x.
- `europe-west9` s'arrête à 2.5 ; les embeddings y répondent toujours.

**L'arbitrage.** L'endpoint global n'offre **aucune résidence des données**. Les
prompts portent le nom du client, son revenu, ses disponibilités et sa
correspondance avec l'agence. Le repli est deux variables sur `prems-apply` et
`prems-inbox`, sans redéploiement. La décision est loggée à chaque run.

## Les chiffres, mesurés

```
815 annonces    146 joignables (17,9 %)    737 matches    0 en DLQ
1 440 runs/24 h  0 échec                   59 tests       CI verte
```

Les matches sont passés de 1 230 à 737 non pas en perdant quelque chose, mais
en cessant de compter deux fois : 493 étaient le même appartement trouvé par
les deux recherches d'un même client.

### Couverture : mesurée contre la source, pas déduite des logs

**41 annonces sur 41, soit 0 manquante sur 51 heures.** Relevé en interrogeant
directement Bien'ici (600 annonces nationales, tri par date de publication),
en filtrant sur les zones réellement scrapées, puis en comparant les
identifiants à la base.

C'est le seul contrôle qui vaut : `1 440 runs, 0 échec` dit que le scraper
tourne, pas qu'il trouve tout. Un scraper qui rate la moitié du marché produit
exactement les mêmes logs verts.

Deux réserves honnêtes sur ce chiffre : l'échantillon ne contient que des
annonces encore en ligne (`onTheMarket`), donc il ne mesure pas celles publiées
puis retirées dans l'intervalle ; et il couvre 51 heures, pas un mois.

**Le volume est faible et ce n'est pas une panne.** ~7 nouvelles annonces par
jour, parce que `active_scrape_zones()` suit la demande : un seul client actif
demande `75, 92, 93, 94`, donc on ne collecte que ces quatre départements. La
chute de ~190/jour à ~7/jour est le balayage initial du catalogue qui se
termine, plus ce rétrécissement — pas une régression.

Conséquence de conception à connaître : **un client aux critères étroits
rétrécit le catalogue pour tout le monde**, y compris pour le prochain inscrit
qui voudrait le 77 ou le 95. Le repli « toute l'Île-de-France » ne s'applique
qu'à zéro client actif. Élargir se fait en une ligne dans
`active_scrape_zones()` — union des zones clients **et** du défaut — si l'on
préfère un catalogue chaud d'avance à un crawl strictement à la demande.

## Les blocages, et ils ne sont pas techniques

**0. La clé Composio — résolu.** La clé d'origine était en lecture seule. La
nouvelle exécute les outils et écrit les configurations ; elle est en Secret
Manager et les jobs la montent. Le préflight passe.

**1. Aucun client n'a encore connecté sa boîte — et il n'y a plus rien à
construire pour ça.**

Cette section a dit pendant plusieurs sessions qu'il manquait un bouton dans
l'interface. **C'est faux, et ça l'était déjà.** La chaîne est complète et
vérifiée :

| Maillon | Où | État |
|---|---|---|
| Le bouton « Connecter ma boîte mail » | `src/scripts/app/profile.js` › `mailboxSection` | écrit, rendu dans /app › Profil |
| L'appel navigateur | `src/lib/prems/mailbox.js` | `start`, puis `finish` en polling |
| La fonction serveur | `supabase/functions/connect-mailbox` | **déployée** — répond 401 sans jeton |
| L'écriture du compte | même fonction | seulement si Composio dit `ACTIVE` |
| La lecture par les workers | `apply.ts`, `inbox.ts` | `profiles.gmail_account_id`, à chaque passage |

Les deux configurations Composio existent (Gmail `ac_BDCvl8Std_Rq`, Google
Calendar `ac_H4AoPOZxFKAL`). `npm run preflight` interroge chacun de ces
maillons et dit lequel manque.

**Ce qui manque n'est donc pas du code : c'est un humain qui clique.** La
connexion passe par l'écran de consentement Google, qui exige une personne
réelle devant un navigateur réel — aucun accès serveur ne remplace ça.

/app › Profil › Boîte mail › « Connecter ma boîte mail ». Deux minutes. À
partir de là, `prems-apply` s'en aperçoit au tick suivant, soit deux minutes
plus tard, et la première candidature part.

Câblage détaillé dans `FRONTEND.md`, section
« Connecter la boîte mail du client ».

Tant que c'est nul, le pipeline n'engage rien : les matches restent `new` et
attendent. Autrement dit, jusqu'à la session front end, la machine **détecte et
matche, sans jamais candidater**.

**2. La joignabilité — à reconfirmer.** Mesurée à 15,7 % par l'e-mail direct.
Le formulaire de contact de Bien'ici couvrirait 100 % du catalogue, mais mes
tests le trouvent authentifié : 401 avec charge valide, 401 avec cookies de
session anonyme, et l'objet `contact` refuse tous les champs d'identité
(`firstName`, `email`, `phone` → « additional properties not allowed »). Le
formulaire du navigateur fait peut-être une étape que je n'ai pas reproduite —
à trancher en observant la requête réelle depuis un navigateur.

Si elle passe, la joignabilité monte à 100 % et le canal `form_post` est déjà
prévu dans le schéma. Sinon, l'arbitrage reste : Les trois voies ont été testées et
mesurées (voir `sources/README.md`). C'est un arbitrage produit :

- d'autres sources qui publient l'adresse — vivier étroit ;
- accepter un compte Bien'ici authentifié — 100 % de leur catalogue, mais
  l'envoi ne part plus de la boîte du client, donc l'interception des réponses
  redevient un problème ouvert ;
- une source d'adresses payante — les annuaires ouverts ne suffisent pas.

## Ce qui attend une réponse

Sept questions sur la priorité, posées et non tranchées. **Elles ne bloquent
rien** : chaque paramètre vit dans `settings` et se change par `UPDATE`.
Les valeurs actuelles sont des recommandations, chacune commentée avec ce que
coûte l'erreur.

`Phase 8` (LeBonCoin, SeLoger, PAP) attend une décision d'achat de proxy.

## À faire avant d'ouvrir à de vrais utilisateurs

Faire tourner les secrets : PAT Supabase, clé `service_role`, clé secrète, clé
privée GCP, **et la clé Composio**. Toutes ont transité par une conversation.
Détail dans `RUNBOOK.md`, section 1.

## Les huit défauts trouvés, et ce qu'ils ont en commun

Aucun n'a été trouvé en relisant du code. Tous en exécutant, et six ne levaient
aucune erreur.

| Défaut | Ce qu'il coûtait |
|---|---|
| Policy RLS sur `listings` | Aurait exposé tout le catalogue à la migration suivante |
| Courbe de budget linéaire | Rendait inmatchable tout logement proche du plafond |
| `tsbuildinfo` hors de `dist/` | Typecheck vert avec un binaire disparu |
| Watermark sans recul | Perdait des lots entiers d'annonces, définitivement |
| Backfill sans différence SQL | Annonçait un succès en n'écrivant rien |
| `search_path` sans `extensions` | pgvector invisible |
| File de matching sans curseur | Retraitait les mêmes annonces à l'infini |
| DLQ sur « pas de Gmail » | 103 appartements perdus le jour de la connexion |
| Un client concourant contre lui-même | 86 refus faux, affichés au client, et le plafond starvé |
| Plafond dépensé avant l'envoi | 61 candidats brûlés pour des candidatures jamais faites |
| Alerte sur une config permanente | 22 alarmes/jour, et un vrai silence retardé d'une heure |
| Réparation de migration non bornée | Effaçait l'historique des skips à chaque `db:migrate` |
| `skipped_reason` jamais remis à zéro | 7 matches « servis » affichant « quelqu'un d'autre a été servi » |
| Score sémantique sans vecteur client | 15 % du classement éteint, sans erreur ni zéro visible |

Deux pièges de méthode valent d'être retenus : **un 400 de schéma ne prouve
jamais l'absence d'authentification**, et **un `code: -1` de Cloud Scheduler
signifie « jamais tenté », pas « échec »**.

Les six derniers ont tous été trouvés en interrogeant ce que le système
produisait, pas en relisant ce qui le produit. Le plus instructif est le
premier : « 147 matches écartés » semblait normal jusqu'à ce qu'on demande
*qui* avait gagné. La réponse — le même client, avec son autre recherche — ne
figurait dans aucun log.
