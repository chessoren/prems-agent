# Architecture

## Le flux, de bout en bout

```
Cloud Scheduler ──▶ prems-scrape-bienici   (1 min)   collecte
                ──▶ prems-enrich           (5 min)   embeddings + doublons
                ──▶ prems-match            (1 min)   matching + équité
                ──▶ prems-apply            (2 min)   candidatures par e-mail
                ──▶ prems-inbox            (8h)      lecture des réponses
                                │
                                ▼
                        Supabase Postgres  ──▶ Realtime ──▶ interface (à venir)
                                │
                        pg_cron (10 min) ──▶ alertes de santé
```

**Rien n'est dans le chemin critique du site.** Le produit fonctionne site fermé ;
l'interface de la prochaine session sera une lecture de `events`, rien de plus.

## Où vit quoi

| Couche | Hébergement | Pourquoi |
|---|---|---|
| Site + parcours d'inscription | Vercel, Astro statique | Rien à servir dynamiquement |
| Données | Supabase Postgres (`eu-west-1`) | Vérité unique, RLS, Realtime |
| Cinq workers | Cloud Run Jobs, `europe-west9` | 24h/24, indépendants du site |
| OCR pièces | Cloud Run `prems-api` | Porte des secrets |
| Boîte mail & agenda du client | Composio (Gmail, Google Calendar) | Voir « Le canal », plus bas |
| Les trois agents | Agent Development Kit (`@google/adk`) | Des outils déclarés, pas un prompt qui demande poliment |
| Modèle | Vertex AI, `gemini-3.7-flash`, endpoint `global` | Le choix entre quatre outils est là où les modèles plus anciens cèdent |
| Repli UE | `gemini-3.5-flash`, `europe-west3` | Le plus récent servi depuis l'Union européenne |
| Embeddings | `text-multilingual-embedding-002`, 768 dim, `europe-west9` | Corpus français |

Une seule image Docker sert les cinq jobs ; seul `MODE` (ou `SOURCE_SLUG`) diffère.
Ajouter une source ou un mode n'est jamais un nouveau déploiement.

**Une ligne de ce tableau est un arbitrage, pas un choix technique.**
`gemini-3.7-flash` n'est servi que par l'endpoint global — vérifié : 404 dans
les six régions européennes essayées. Les prompts — nom, situation
professionnelle, revenu net, disponibilités, correspondance privée avec
l'agence — sortent donc de l'Union européenne. Le repli à résidence UE est
`gemini-3.5-flash` en `europe-west3` (Francfort), le modèle le plus récent
servi depuis l'UE ; deux variables d'environnement, pas une ligne de code. Les
embeddings, eux, n'ont jamais quitté Paris. La matrice complète, mesurée, est
dans `RUNBOOK.md` §4.

![Architecture](architecture.svg)

## Les trois agents, et pourquoi un seul a des outils

Le système contient exactement trois agents, tous décrits dans
`workers/src/agent.ts` pour le modèle et l'authentification, et définis chacun
dans le worker qui s'en sert.

| Agent | Fichier | Outils | Ce qu'il décide |
|---|---|---|---|
| `prems_application_writer` | `draft.ts` | aucun | Le texte de la candidature |
| `prems_reply_classifier` | `inbox.ts` | aucun | Ce que l'agence vient de dire |
| `prems_negotiator` | `negotiate.ts` | 4 | S'il répond, et avec quel créneau |

**Deux d'entre eux n'ont pas d'outils, et c'est un choix.** Écrire une
candidature à partir de faits déjà réunis, ou ranger un message dans quatre
catégories, ne demande pas d'aller chercher quoi que ce soit. Leur sortie est
contrainte par un schéma de réponse plutôt que réclamée en prose : « réponds en
JSON strict » était une consigne que le modèle pouvait ignorer, un
`outputSchema` est une contrainte que l'API applique.

**Le négociateur en a quatre, et c'est ce qui a changé.** Ses disponibilités
étaient auparavant interpolées dans le prompt : un modèle qui les ignorait
produisait une phrase plausible nommant un jour où personne n'était libre, et
rien en aval ne pouvait distinguer ça d'une vraie proposition.

| Outil | Ce qu'il rend |
|---|---|
| `get_client_availability` | Les créneaux enregistrés, ou l'instruction de demander à l'agence |
| `get_client_facts` | Les faits connus sur le candidat — un champ absent est une information qu'on n'a pas |
| `queue_reply` | Met le message en file. Idempotent : un second appel est refusé, pas appliqué |
| `stand_down` | Ne rien envoyer, en disant pourquoi |

Les appels effectivement passés sont enregistrés dans `events`, à côté du
message produit. « Pourquoi a-t-il proposé mardi ? » a donc une réponse qui
n'est pas une supposition sur ce que pensait le modèle.

**Les garde-fous ne sont pas dans le prompt.** Une règle qu'un modèle peut se
convaincre de contourner n'est pas une règle :

- un refus arrête le fil **avant** que l'agent ne soit construit ;
- le plafond de relances par fil et l'interrupteur d'exploitation sont lus dans
  `settings`, en base, et vérifiés en amont ;
- si le client avait des disponibilités et que l'agent n'a pas appelé l'outil
  qui les rend, le message est remplacé par la version plate — quoi qu'il ait
  écrit, il ne l'a pas lu ici ;
- une date calendaire pour un client sans disponibilité est refusée ;
- un tour vide n'est pas un silence choisi : seul `stand_down` l'est.

Ces cinq cas sont couverts par des tests qui rejouent un script d'appels
d'outils contre les vrais outils, sans modèle : `workers/test/negotiate.test.ts`.

**Rien n'est envoyé par un agent.** `queue_reply` rend le texte à l'appelant,
qui l'écrit dans `messages` — la même file de sortie que les réponses écrites
par le client lui-même. Une seule porte de sortie, un seul endroit où un envoi
peut échouer.

## Le canal de candidature — la décision la plus structurante

Elle découle d'une recherche, pas d'une préférence. **Les deux voies HTTP sont
fermées :**

- `POST /api/contactRequests` de Bien'ici renvoie **401** sans compte connecté.
  Le 400 initial est une erreur de *schéma* : la validation de forme s'exécute
  avant le contrôle d'identité. Un 400 ne prouve jamais l'absence d'authentification.
- Les sites d'agence qui acceptent un POST anonyme — la-boite-immo, et les
  installations WordPress que la plupart utilisent — portent **tous un reCAPTCHA**.
  Trois sondés, trois avec captcha.

**L'e-mail ferme les deux**, et c'est le seul canal qui satisfait simultanément
les trois besoins du produit : aucun compte sur le portail, envoi depuis la boîte
du client plutôt que la nôtre, et surtout **la réponse de l'agence qui atterrit
dans cette même boîte** — le seul endroit où on peut la lire sans demander à
quiconque de transférer quoi que ce soit.

**La contrainte est la joignabilité, et elle est mesurée : 74 / 722, soit 10,2 %.**
Bien'ici publie un téléphone et retient l'e-mail — le formulaire derrière un
compte *est* leur produit. Les 90 % restants exposent le domaine de leur agence,
d'où la table `agencies` : une adresse résolue **par agence**, pas par annonce,
et les échecs mémorisés pour ne pas recrawler à chaque bien publié.

## L'équité, en données et non en code

Les règles de priorité vivent dans `settings`, une ligne modifiable par `UPDATE` :

| Paramètre | Défaut | Ce que coûte l'erreur |
|---|---|---|
| `applications_per_listing` | 1 | Au-delà, l'agence reçoit dix candidatures pour le même bien et la rotation cesse |
| `priority_half_life_hours` | 12 | Court = rotation brutale ; long = récupération lente |
| `max_active_applications` | 5 | Trop haut = client qui spamme ; trop bas = client sous-servi |
| `active_application_days` | 7 | Sans fenêtre d'âge, un client dont personne ne répond est bloqué à vie |
| `new_client_starts_at_top` | true | Bonne première impression, au prix de ceux qui attendent |

`client_priority()` est **dérivée** de `applications`, jamais stockée : un score
stocké dérive de ce qui s'est réellement passé.

La pertinence **conditionne** l'équité au lieu de la concurrencer : un client
sous son propre `min_score` est écarté *avant* la découpe, donc un match médiocre
ne peut jamais prendre l'appartement parfait de quelqu'un d'autre.

## Ce que voit un navigateur

`sources`, `scrape_runs`, `listing_embeddings`, `listing_duplicates`, `agencies`
ont la RLS activée et **aucune policy** : RLS sans policy refuse tout, le bon
réglage pour ce que seul le pipeline touche.

Une annonce n'est lisible qu'à travers un match qui vous appartient. Les vues
d'exploitation (`source_health`, `funnel`, `contactability`, `client_feed`) sont
révoquées pour `anon` et `authenticated` — une vue de confort ne doit pas devenir
le trou dans la policy.

## Les décisions qui ont été payées par un bug

Chacune vient d'un défaut réel, trouvé en exécutant :

- **Le watermark est reculé de 30 min.** Bien'ici stampe par lots : 720 annonces
  pour 438 horodatages. S'arrêter à `<= watermark` perdait des lots entiers,
  définitivement. Symptôme : latence médiane de 41 min contre un polling à 60 s.
- **`matched_at` existe.** Une annonce sans client éligible ne créait aucune
  ligne, restait dans la file et était réexaminée à chaque run. La file ne
  pouvait pas se vider.
- **`tsbuildinfo` vit dans `dist/`.** Laissé à côté, il faisait passer le
  typecheck avec un binaire disparu.
- **`demo_listings` porte ce nom.** La table de démo a une policy `using (true)` ;
  la laisser s'appeler `listings` aurait réappliqué « publiquement lisible » sur
  le catalogue de production à la migration suivante.
- **La courbe de budget sature à mi-budget.** Décroître jusqu'à zéro au plafond
  rendait inmatchable tout logement pourtant abordable.
- **`semantic_score` a `extensions` dans son `search_path`.** pgvector y vit ;
  sans ça l'opérateur `<=>` est invisible.

## Ce qui n'est pas fait

Une seule source. Les sites sous anti-bot (LeBonCoin, SeLoger, PAP) attendent une
décision d'achat de proxy. La joignabilité à 10 % est la limite qui compte : le
résolveur d'adresses par agence est écrit côté schéma mais son worker reste à
faire, et c'est lui qui déterminera si le produit peut candidater sur la majorité
de ce qu'il détecte.
