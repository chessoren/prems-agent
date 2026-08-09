# Google Cloud Run — checklist de mise en place

Ce service existe pour une seule raison : **héberger ce qui porte un secret**.
Les clés Document AI, les identifiants d'agrégation bancaire et la clé
`service_role` de Supabase ne doivent jamais atteindre un navigateur. Tout le
reste du parcours fonctionne déjà sans lui.

Tant que `PUBLIC_PREMS_API_URL` est vide, les raccourcis « scanner ma pièce » et
« photographier mon bulletin » restent visibles mais désactivés, avec une
explication au survol. La saisie manuelle — la voie normale — n'en dépend pas.

---

## Étape 1 — Le projet et la facturation

1. Console Google Cloud → **Créer un projet**, nom `prems-prod`.
2. Noter le **Project ID** (il diffère du nom, ex. `prems-prod-418302`).
3. **Facturation → Associer un compte de facturation.** Sans ça, Cloud Run et
   Document AI refusent de démarrer.
4. Choisir la région **`europe-west9` (Paris)** ou `europe-west1` (Belgique).
   C'est une contrainte RGPD, pas une préférence de latence : le service
   manipulera des pièces d'identité de résidents français.

➜ **À me transmettre :** `GCP_PROJECT_ID`, la région retenue.

## Étape 2 — Activer les API

Dans **API et services → Bibliothèque**, activer :

| API | Pourquoi |
|---|---|
| Cloud Run Admin API | héberger le service |
| Artifact Registry API | stocker l'image du conteneur |
| Cloud Build API | construire l'image |
| Document AI API | OCR des pièces et bulletins |
| Secret Manager API | stocker les clés hors du code |

➜ **À me confirmer :** les cinq API sont activées.

## Étape 3 — Artifact Registry

1. **Artifact Registry → Créer un dépôt**
2. Nom `prems`, format **Docker**, région identique à l'étape 1.

➜ **À me transmettre :** le nom du dépôt.

## Étape 4 — Les processeurs Document AI

1. **Document AI → Explorer les processeurs**
2. Créer **Identity Document Parser** → noter le **Processor ID**
3. Créer **Expense Parser** (ou *Form Parser*) pour les bulletins de salaire →
   noter le **Processor ID**
4. Vérifier que les deux sont dans la même région qu'à l'étape 1.

➜ **À me transmettre :** `DOCAI_IDENTITY_PROCESSOR_ID`,
`DOCAI_PAYSLIP_PROCESSOR_ID`.

> Alternative sérieuse : **Mindee**. Une seule clé API, des modèles français
> prêts à l'emploi (CNI, titre de séjour, fiche de paie), nettement moins de
> configuration. Si vous préférez cette voie, les étapes 4 et 5 se résument à
> me donner la clé API.

## Étape 5 — Le compte de service

1. **IAM et admin → Comptes de service → Créer**
2. Nom `prems-api`
3. Rôles à accorder :
   - `Document AI API User`
   - `Secret Manager Secret Accessor`
   - `Cloud Run Invoker` *(uniquement si un autre service doit l'appeler)*
4. **Ne pas générer de clé JSON.** Cloud Run donne l'identité au conteneur
   automatiquement ; une clé exportée est un secret de plus à faire fuiter.

➜ **À me transmettre :** l'adresse du compte de service
(`prems-api@<project-id>.iam.gserviceaccount.com`).

## Étape 6 — Les secrets

Dans **Secret Manager**, créer :

| Secret | Contenu |
|---|---|
| `supabase-service-role` | la clé `sb_secret_…` |
| `supabase-jwt-issuer` | `https://budbfhrqdeghyufeizpv.supabase.co/auth/v1` |
| `mindee-api-key` | si vous partez sur Mindee |

Le service vérifiera chaque requête entrante contre le JWKS Supabase
(`https://budbfhrqdeghyufeizpv.supabase.co/auth/v1/.well-known/jwks.json`) :
seul un utilisateur authentifié peut faire scanner un document, et il ne peut
scanner que le sien.

## Étape 7 — Déploiement et CORS

Au premier déploiement, autoriser en CORS **uniquement** :

```
http://localhost:4321
https://<votre-domaine-de-production>
```

➜ **À me transmettre :** l'**URL publique du service** une fois déployé
(`https://prems-api-xxxxx-ew.a.run.app`). Elle va dans `PUBLIC_PREMS_API_URL`,
et les raccourcis s'activent seuls.

## Étape 8 — Le domaine de production

Le parcours a besoin de connaître son origine finale pour deux choses :
la liste blanche de redirection Supabase (OAuth Google) et le CORS ci-dessus.

➜ **À me transmettre :** le domaine de production définitif.

---

## Récapitulatif

```
GCP_PROJECT_ID
région (europe-west9 ou europe-west1)
nom du dépôt Artifact Registry
DOCAI_IDENTITY_PROCESSOR_ID  +  DOCAI_PAYSLIP_PROCESSOR_ID   (ou MINDEE_API_KEY)
adresse du compte de service prems-api
URL publique Cloud Run  →  PUBLIC_PREMS_API_URL
domaine de production
```

## Les endpoints prévus

| Route | Rôle |
|---|---|
| `POST /ocr/identity` | lit une CNI / passeport / titre de séjour, renvoie les champs à **pré-remplir** — l'utilisateur garde toujours la main pour corriger |
| `POST /ocr/payslip` | extrait le net mensuel d'un bulletin |
| `POST /match` | remplace le catalogue de démo par le vrai moteur 350+ sites |
| `POST /dossier/verify` | contrôle la conformité au décret Alur avant la célébration |

Aucun de ces endpoints ne stocke de fichier : le document est déjà dans le
bucket privé de l'utilisateur, le service ne fait que le lire via une URL
signée à durée courte et renvoyer du texte.
