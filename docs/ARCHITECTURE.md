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
| Rédaction & classification | Vertex AI, `gemini-2.5-flash-lite` | Le moins cher qui écrit un français correct |
| Embeddings | `text-multilingual-embedding-002`, 768 dim | Corpus français |

Une seule image Docker sert les cinq jobs ; seul `MODE` (ou `SOURCE_SLUG`) diffère.
Ajouter une source ou un mode n'est jamais un nouveau déploiement.

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
