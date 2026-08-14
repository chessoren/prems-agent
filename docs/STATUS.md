# État du système

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

## Les chiffres, mesurés

```
722 annonces    113 joignables (15,7 %)    997 matches    0 en DLQ
720 embeddings  9 doublons liés (1,3 %)    44 tests       CI verte
```

## Les blocages, et ils ne sont pas techniques

**0. La clé Composio — résolu.** La clé d'origine était en lecture seule. La
nouvelle exécute les outils et écrit les configurations ; elle est en Secret
Manager et les jobs la montent. Le préflight passe.

**1. Aucune boîte Gmail connectée — une action, deux liens.**

Les deux configurations existent : Gmail `ac_BDCvl8Std_Rq`, Google Calendar
`ac_H4AoPOZxFKAL` (créée avec la nouvelle clé). Les liens d'autorisation sont
générés ; il suffit de les suivre puis d'écrire l'identifiant du compte dans
`profiles.gmail_account_id` / `calendar_account_id`. Voir `FRONTEND.md`,
section « Connecter la boîte mail ».

Tant que c'est nul, le pipeline n'engage rien : les matches restent `new` et
attendent.

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

Deux pièges de méthode valent d'être retenus : **un 400 de schéma ne prouve
jamais l'absence d'authentification**, et **un `code: -1` de Cloud Scheduler
signifie « jamais tenté », pas « échec »**.
