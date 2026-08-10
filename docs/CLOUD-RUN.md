# Google Cloud Run — état et déploiement

Ce service existe pour une seule raison : **héberger ce qui porte un secret**.
Les clés Document AI et la clé `service_role` Supabase ne doivent jamais
atteindre un navigateur. Tout le reste du parcours fonctionne sans lui — les
raccourcis photo se désactivent, la saisie manuelle ne bouge pas.

## Infrastructure — fait

| Élément | Valeur |
|---|---|
| Projet | `gen-lang-client-0781599139` (*prems-prod*) |
| Région Cloud Run / Artifact Registry | `europe-west9` (Paris) |
| Facturation | associée |
| API activées | Cloud Run Admin, Artifact Registry, Cloud Build, Document AI, Secret Manager |
| Dépôt Docker | `prems` |
| Processeur *Identity Document* | `30486f64a209a15e` (localisation `eu`) |
| Processeur *Expense* | `3f381d89249d38bb` (localisation `eu`) |
| Compte de service | `prems-api@gen-lang-client-0781599139.iam.gserviceaccount.com` |
| Rôles | `Document AI API User`, `Secret Manager Secret Accessor` |
| Clé JSON | aucune — Cloud Run donne l'identité au conteneur |
| Secrets | `supabase-service-role`, `supabase-jwt-issuer` |

> **Localisation Document AI.** `europe-west9` n'est pas proposé comme
> localisation de processeur. Les processeurs sont en `eu`, la multi-région
> européenne : les données restent dans l'UE, ce qui est la contrainte
> réellement applicable. Cloud Run et Artifact Registry sont bien à Paris.

## Le service — fait

Le code vit dans [`services/prems-api/`](../services/prems-api/) : quatre routes
sur le serveur HTTP de Node, un Dockerfile en deux étapes tournant en
utilisateur non-root, et un `cloudbuild.yaml` qui construit, pousse et déploie
en montant les deux secrets depuis Secret Manager.

Les valeurs de l'infrastructure ci-dessus sont déjà les substitutions par défaut
du `cloudbuild.yaml`. Rien à ressaisir.

## Déploiement — la commande

```bash
gcloud config set project gen-lang-client-0781599139
cd services/prems-api

gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_ALLOWED_ORIGINS="https://prems.getmira.run\,http://localhost:4321"
```

Puis récupérer l'URL publique :

```bash
gcloud run services describe prems-api --region europe-west9 \
  --format='value(status.url)'
```

## Ce qu'il reste à faire

1. **Lancer le déploiement** ci-dessus.
2. **Me transmettre l'URL publique** (`https://prems-api-….a.run.app`) → elle va
   dans `PUBLIC_PREMS_API_URL`, et les trois raccourcis photo s'activent seuls.
3. **Confirmer le domaine de production.** `prems.getmira.run` est pris comme
   hypothèse dans la commande ci-dessus. Il sert à deux choses : la liste blanche
   CORS du service, et la liste des redirections autorisées côté Supabase Auth
   (nécessaire pour Google OAuth). Si le domaine final diffère, les deux sont à
   corriger.
4. **Google OAuth** : Client ID + Secret à coller dans Supabase Auth, avec
   `https://budbfhrqdeghyufeizpv.supabase.co/auth/v1/callback` déclaré côté
   Google. Le bouton est déjà en place dans le parcours.
5. **Rotation des clés** : `sb_secret` et le token d'accès Supabase ont transité
   par un canal de conversation. À régénérer depuis le dashboard avant la mise
   en production, puis à mettre à jour dans Secret Manager.

Le rattachement de `prems.getmira.run` à Cloud Run n'est **pas** nécessaire : ce
domaine sert au site, le service API garde son URL `run.app` et n'est appelé
qu'en XHR depuis le navigateur. Un domaine personnalisé sur l'API ne serait utile
que pour éviter un préconnect supplémentaire — pas prioritaire.

## Vérifications déjà passées

Contre le vrai projet Supabase, avec une session anonyme réelle :

- jeton absent ou invalide → `401`
- dossier d'un autre utilisateur → `403`
- traversée de chemin (`<uid>/../autre/x`) → `400`
- bucket hors liste → `403`
- propre dossier, fichier absent → `404`
- préflight CORS : origine autorisée reflétée, origine inconnue refusée

Le seul chemin non exercé de bout en bout est l'appel Document AI lui-même, qui
demande des identifiants GCP indisponibles depuis l'environnement de
développement. Il se vérifiera au premier scan réel après déploiement.
