# prems-api

Le service Cloud Run qui porte **ce qui ne doit jamais atteindre un navigateur** :
les identifiants Document AI et la clé `service_role` Supabase.

Tout le reste du parcours tourne côté client contre des tables protégées par RLS.
C'est pour ça que ce service reste minuscule — et que l'onboarding continue de
fonctionner quand il est indisponible : les raccourcis photo se désactivent, la
saisie manuelle ne bouge pas.

## Endpoints

| Route | Rôle |
|---|---|
| `GET /health` | sonde de démarrage, répond avant toute vérification d'identifiants |
| `POST /ocr/identity` | lit une CNI / passeport / titre de séjour |
| `POST /ocr/payslip` | extrait le net mensuel d'un bulletin de paie |
| `POST /dossier/verify` | contrôle la complétude au regard du décret n° 2015-1437 |

Les trois routes authentifiées attendent `{ bucket, path }` et un en-tête
`Authorization: Bearer <jeton Supabase>`.

## Les trois garanties

**Aucun fichier ne transite par ici deux fois.** Le navigateur envoie le document
directement dans le bucket privé, puis ne transmet que son chemin. Le service le
relit avec la clé `service_role`.

**Un utilisateur ne peut lire que son propre dossier.** C'est la conséquence du
point précédent : la clé `service_role` contourne la RLS, donc le contrôle doit
être refait ici. Un chemin n'est accepté que s'il commence par l'identifiant
porté par le jeton, et la traversée (`..`) est rejetée avant ce test — sinon
`<uid>/../<autre>/x` passerait en ayant l'air de commencer au bon endroit.

**Les jetons sont vérifiés localement.** Supabase signe en ES256 et publie la
clé publique ; `jose` la met en cache et la recharge à la rotation. Pas de secret
partagé, pas d'aller-retour réseau par requête.

## Ce que renvoie l'OCR

Des **suggestions**, jamais des valeurs validées. Le parcours les écrit dans des
champs modifiables et la personne vérifie avant de valider. Une lecture fausse et
sûre d'elle reste ainsi une gêne corrigeable, pas un dossier erroné.

Sur les bulletins français, le *Expense Parser* renvoie fréquemment le brut ou un
total de ligne plutôt que ce qui arrive sur le compte. Le libellé imprimé est
bien plus fiable — mais « le montant à côté du libellé » est une propriété
**géométrique**, pas textuelle : un bulletin est un tableau, et l'OCR le
sérialise souvent colonne par colonne, si bien que le texte qui suit
« NET À PAYER » peut être le brut de trois lignes plus haut. Le montant est donc
lu sur la **même rangée** que le libellé, d'après la position des jetons.

Un bulletin de test à 2 450 € net remontait 3 150 € — le brut — avec l'ancienne
heuristique textuelle. C'est ce que cette lecture géométrique empêche.

Quand la rangée ne donne rien, le champ revient **vide** plutôt que rempli par
le parseur seul : un salaire faux mais plausible, que la personne ne remarque
pas, est bien pire qu'un champ à saisir soi-même.

## Déploiement

Depuis Cloud Shell, qui démarre sur un répertoire vide :

```bash
gcloud config set project gen-lang-client-0781599139

git clone -b claude/prems-onboarding-flow-2d2er5 \
  https://github.com/chessoren/prems-landing-page.git
cd prems-landing-page/services/prems-api

gcloud builds submit --config cloudbuild.yaml
```

Aucune substitution à passer : les valeurs du projet provisionné sont déjà les
valeurs par défaut du `cloudbuild.yaml`, y compris la liste blanche d'origines.

Celle-ci est exacte, sans joker : refléter une origine arbitraire laisserait
n'importe quelle page du web appeler ce service avec un jeton volé. Elle est
séparée par des points-virgules parce que `gcloud` découpe `--substitutions`
sur les virgules — un séparateur virgule demanderait un échappement qui dépend
du shell.

Récupérer ensuite l'URL publique et la renseigner côté front :

```bash
gcloud run services describe prems-api --region europe-west9 \
  --format='value(status.url)'
```

→ `PUBLIC_PREMS_API_URL` dans le `.env` du site. Les raccourcis s'activent seuls.

## En local

```bash
npm install
SUPABASE_URL=https://budbfhrqdeghyufeizpv.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
GCP_PROJECT_ID=gen-lang-client-0781599139 \
DOCAI_IDENTITY_PROCESSOR_ID=30486f64a209a15e \
DOCAI_PAYSLIP_PROCESSOR_ID=3f381d89249d38bb \
ALLOWED_ORIGINS=http://localhost:4321 \
npm start
```

Les appels Document AI ont besoin d'identifiants applicatifs par défaut
(`gcloud auth application-default login`). Le reste — santé, authentification,
isolation par utilisateur, CORS — fonctionne sans.

## Note sur la localisation

Document AI ne propose pas `europe-west9` comme localisation de processeur. Les
processeurs sont donc en `eu`, la multi-région européenne : les données restent
dans l'UE, ce qui est la contrainte réellement applicable. Cloud Run et Artifact
Registry, eux, sont bien à Paris.
