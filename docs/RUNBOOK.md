# Runbook

## Commandes

```bash
npm run ci            # typecheck + tests + build — ce que la CI exécute
npm run db:migrate    # applique toutes les migrations (idempotent)
npm run db:seed       # régénère le catalogue de démonstration (demo_listings)
npm run build         # site statique dans dist/
npm run shots:onboarding   # les 13 écrans dans un vrai Chromium, 2 breakpoints
```

`db:migrate` ré-exécute **tous** les fichiers à chaque fois. Il n'y a pas de
registre de migrations, volontairement : chaque fichier est écrit pour être
idempotent, donc « tout appliquer » et « appliquer ce qui manque » sont la même
opération. Un registre ajouterait une seconde source de vérité sur le schéma, et
celle qui dérive est toujours le registre.

---

## À faire avant d'ouvrir le produit

### 1. Faire tourner les secrets — **prioritaire**

Le PAT Supabase, la clé `service_role`, la clé secrète et la clé privée du
compte de service GCP ont transité par un canal de conversation. Elles donnent
un accès total : la clé `service_role` contourne **toutes** les policies RLS.

- Supabase → Settings → API → régénérer les clés ; Account → Access Tokens →
  révoquer le PAT.
- GCP → IAM → Comptes de service → `prems-workers` → supprimer la clé
  `f48564883c8c…` et en créer une nouvelle.

Mieux encore côté GCP : supprimer la clé JSON et passer en **Workload Identity
Federation** depuis GitHub Actions, ce qui supprime le fichier de secret plutôt
que de le remplacer.

### 2. Trois rôles IAM manquent

Vérifié en appelant les API : `prems-workers` peut lire Cloud Run, Artifact
Registry et Cloud Scheduler, mais reçoit un 403 sur Pub/Sub, Secret Manager et
Vertex AI. Les trois sont nécessaires à la suite du pipeline.

```bash
PROJECT=gen-lang-client-0781599139
SA=prems-workers@$PROJECT.iam.gserviceaccount.com

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role=roles/pubsub.admin
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role=roles/secretmanager.admin
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role=roles/aiplatform.user
```

### 3. Le scraper est déployé et tourne — fait

`iam.serviceAccountUser` a été accordé, et le déploiement est allé au bout :

| Élément | Valeur |
|---|---|
| Image | `europe-west9-docker.pkg.dev/gen-lang-client-0781599139/prems/prems-scraper:v1` |
| Cloud Run Job | `prems-scrape-bienici`, `europe-west9`, SA `prems-workers` |
| Secret | `supabase-service-role-key`, monté depuis Secret Manager |
| Cloud Scheduler | `prems-scrape-bienici-tick`, `* * * * *`, Europe/Paris, ENABLED |
| Première exécution | réussie en 10,4 s |

Vérifié comme il faut l'être : après création du planificateur, de nouveaux
`scrape_runs` sont apparus **sans que personne ne les déclenche** — #8, #9, #10
à 01:39, 01:40, 01:41, une par minute. `source_health.is_stale` est repassé à
`false`.

Pour redéployer après modification du code :

```bash
docker build -f workers/Dockerfile -t prems-scraper:local .
TOKEN=$(gcloud auth print-access-token)
echo "$TOKEN" | docker login -u oauth2accesstoken --password-stdin europe-west9-docker.pkg.dev
IMG=europe-west9-docker.pkg.dev/gen-lang-client-0781599139/prems/prems-scraper
docker tag prems-scraper:local $IMG:v2 && docker push $IMG:v2
gcloud run jobs update prems-scrape-bienici --image=$IMG:v2 --region=europe-west9
```

`workers/cloudbuild.yaml` fait la même chose côté CI, s'il reçoit un jour
`roles/cloudbuild.builds.editor` et `roles/storage.admin`.

Ajouter une source : un adaptateur, une ligne dans `ADAPTERS`, une ligne dans
`sources`, puis un job et un tick qui ne diffèrent que par `SOURCE_SLUG`. La
même image sert tout le monde.

### Les cinq jobs déployés

| Job | Mode | Cadence | Rôle |
|---|---|---|---|
| `prems-scrape-bienici` | `SOURCE_SLUG=bienici` | `* * * * *` | collecte |
| `prems-enrich` | `MODE=enrich` | `*/5 * * * *` | embeddings + liens de doublons |
| `prems-match` | `MODE=match` | `* * * * *` | matching + équité |
| `prems-apply` | `MODE=apply` | `*/2 * * * *` | candidatures par e-mail |
| `prems-inbox` | `MODE=inbox` | `0 8 * * *` | lecture des réponses, agenda |
| `prems-agencies` | `MODE=agencies` | `*/15 * * * *` | résolution des adresses d'agence |

Secrets montés : `supabase-service-role-key`, `composio-api-key`.

Image courante : `prems-scraper:v10`, les six jobs sur la même.

**Construire l'image derrière le proxy de développement.** Le proxy sortant
présente son propre certificat, donc `npm ci` échoue dans le conteneur avec
`SELF_SIGNED_CERT_IN_CHAIN`. On ne désactive pas la vérification TLS et on
n'embarque pas ce certificat dans l'image de production — un secret BuildKit
le monte le temps du build, sans laisser de couche :

```bash
sed -e 's|^RUN npm ci$|RUN --mount=type=secret,id=cacert NODE_EXTRA_CA_CERTS=/run/secrets/cacert npm ci|' \
    workers/Dockerfile > /tmp/Dockerfile.proxy   # idem pour la ligne --omit=dev
DOCKER_BUILDKIT=1 docker build -f /tmp/Dockerfile.proxy \
  --secret id=cacert,src=/root/.ccr/ca-bundle.crt -t prems-scraper:local .
```

Vérifier le binaire avant de pousser — un `tsc -b` peut réussir sans rien
émettre :

```bash
docker run --rm --entrypoint sh prems-scraper:local -c "ls workers/dist/index.js"
```

**Lire un état de planificateur.** `status: {"code":-1}` signifie **« jamais
tenté »**, pas une erreur — je m'y suis laissé prendre. Un `status: {}` après un
`lastAttemptTime` est un succès.

Une seule image (`:v3`) sert les trois ; seules les variables d'environnement
diffèrent.

**Point de vigilance non résolu** : `prems-match` a une échéance de 600 s et un
tick à la minute. Si un run dépasse la minute, les runs se chevauchent. Rien ne
se duplique — la contrainte d'unicité sur `matches` l'interdit — mais du calcul
est gaspillé. À surveiller via la durée des exécutions, et à corriger en
espaçant le tick ou en réduisant `MATCH_LIMIT`.

**Latence de matching : mesurée, cible atteinte.** Un run complet de
`prems-match` prend **1 min 18 pour un lot de 200 annonces**, soit **≈ 390 ms
par annonce** contre une cible de 1 000 ms. 10 exécutions réussies, 0 échec.

Le chiffre précédent de 1,9 s par annonce était un artefact : il venait du bac à
sable américain contre une base en `eu-west-1`, où un simple aller-retour coûte
déjà 0,5 à 0,85 s. **Le réseau pesait cinq fois l'algorithme.** La leçon vaut
d'être retenue pour tout futur bench : mesurer ailleurs que là où le code
tournera ne mesure pas le code.

Réserve : les 390 ms supposent que le lot était plein (200 annonces). C'est
plausible — la file en contenait encore 320 — mais c'est une inférence, pas une
lecture directe. La ligne `match: … ms` loggée par le job donnerait le chiffre
exact ; elle n'apparaît pas dans le filtre de logs utilisé.

### 3 bis. Donner l'accès GCP à un agent ou à une CI

Le besoin revient : une machine qui n'est pas la vôtre doit pouvoir vérifier les
modèles, lire les logs, déployer un job. Elle ne peut pas passer par un
navigateur, donc `gcloud auth login` est hors de portée. Ce qu'elle peut
recevoir, c'est une variable d'environnement.

**Créer un compte de service dédié**, jamais le vôtre :

```bash
PROJECT=gen-lang-client-0781599139
SA=prems-agent@$PROJECT.iam.gserviceaccount.com

gcloud iam service-accounts create prems-agent \
  --project=$PROJECT --display-name="Agent / CI"

for ROLE in aiplatform.user run.admin logging.viewer \
            artifactregistry.writer cloudbuild.builds.editor cloudscheduler.admin; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member="serviceAccount:$SA" --role="roles/$ROLE"
done

# Pour que les jobs déployés puissent endosser l'identité des workers.
gcloud iam service-accounts add-iam-policy-binding \
  prems-workers@$PROJECT.iam.gserviceaccount.com \
  --project=$PROJECT --member="serviceAccount:$SA" \
  --role=roles/iam.serviceAccountUser

gcloud iam service-accounts keys create /tmp/prems-agent.json \
  --iam-account=$SA --project=$PROJECT
```

**Transmettre la clé comme variable d'environnement**, pas comme fichier :
`GCP_SERVICE_ACCOUNT_JSON` = le contenu entier de `/tmp/prems-agent.json`.
`tools/lib/gcp-credentials.mjs` l'écrit dans un fichier 0600 hors du dépôt et
pointe ADC dessus, donc `npm run preflight`, `npm run gcp:models` et
`google-auth-library` fonctionnent sans autre réglage.

**Ce que ça n'ouvre pas**, et c'est volontaire : ni facturation, ni IAM, ni
Secret Manager. Un agent qui doit lire un secret a besoin d'un rôle de plus, à
accorder au cas par cas plutôt qu'à l'avance.

**Révoquer, à la fin :**

```bash
gcloud iam service-accounts keys list --iam-account=$SA --project=$PROJECT
gcloud iam service-accounts keys delete <KEY_ID> --iam-account=$SA --project=$PROJECT
# ou, plus radical et plus sûr :
gcloud iam service-accounts delete $SA --project=$PROJECT
```

Mieux encore, le jour où l'appelant peut porter un jeton OIDC : **Workload
Identity Federation**, qui supprime le fichier de clé plutôt que de le faire
tourner. C'est déjà noté en §1 pour GitHub Actions ; c'est la même réponse ici.

### 3 ter. Filmer une démonstration reproductible

Le produit ne se montre de bout en bout que si une agence répond, et une agence
répond quand elle veut. `npm run db:demo` pose une annonce dont « l'agence » est
une boîte que vous relevez vous-même : vous jouez les deux rôles, et la
séquence est rejouable autant de fois qu'il faut.

```bash
npm run db:demo -- --account project.orionloop@gmail.com \
                   --agency  jenie.du.film@gmail.com
npm run db:demo -- --remove
```

**L'agent n'est au courant de rien, et c'est tout l'intérêt.** Même table, même
filtre dur, même score, même chemin d'envoi : ce qu'on filme est le comportement
réel. L'annonce est *dérivée de la recherche active du compte* — ville, type,
pièces, zone, budget — donc elle passe le filtre par construction et non par
chance.

Relancez juste avant de filmer : la fraîcheur pèse 27 % du score avec une
demi-vie de 90 minutes, et l'outil repose `published_at` à maintenant.

Le déroulé, une fois la boîte du compte connectée :

| Quand | Ce qui se passe |
|---|---|
| ≤ 1 min | `prems-match` voit l'annonce et crée le match |
| ≤ 2 min | `prems-apply` envoie la candidature à l'adresse « agence », depuis la boîte du compte |
| vous | Répondez depuis cette boîte — proposez deux créneaux, ou réclamez une pièce |
| ≤ 8 h, ou à la main | `prems-inbox` lit, classe, consulte l'agenda, répond |

Pour ne pas attendre le tick de huit heures pendant le tournage :

```bash
gcloud run jobs execute prems-inbox --region europe-west9 \
  --project gen-lang-client-0781599139 --wait
```

#### La version en une commande : le job `prems-demo`

`npm run db:demo` pose l'annonce et laisse les tickets planifiés faire le reste
— une minute pour le match, deux pour l'envoi, huit heures pour la relève. C'est
le bon rythme pour tenir un mois sans surveillance, et c'est injouable devant un
public. `prems-demo` fait exactement le même travail à la cadence d'une
démonstration : un tour complet toutes les huit secondes, pendant la durée
qu'on lui donne.

```bash
gcloud run jobs execute prems-demo --region europe-west9 \
  --project gen-lang-client-0781599139
```

Ce que fait chaque tour, dans l'ordre : poser l'annonce pour tout compte ayant
une boîte connectée et pas encore d'annonce, matcher, candidater, envoyer,
relever la boîte, répondre. Ce sont les fonctions des jobs planifiés, appelées
telles quelles — même matching, même rédaction, même classification, mêmes
garde-fous.

Mesuré sur l'exécution du 28 août : boucle démarrée à 19:27:14, deux
candidatures parties à 19:27:18 et 19:27:26. Réponse humaine puis réponse de
l'agent dans les trente secondes qui suivent.

| Variable | Défaut | À quoi elle sert |
|---|---|---|
| `DEMO_AGENCY_EMAIL` | `jenie.du.film@gmail.com` | La boîte du « propriétaire », celle où quelqu'un répond en direct. Doit différer du compte connecté. |
| `DEMO_MINUTES` | `10` | Durée de la boucle. À garder sous `--task-timeout`. |
| `DEMO_TICK_MS` | `8000` | Intervalle entre deux tours. |
| `DEMO_RESET` | (actif) | `0` pour conserver l'état de la répétition précédente. |

**La remise à zéro n'est pas un confort.** Deux des trois plafonds de
`may_send` comptent des candidatures passées — deux messages vers la même
adresse en sept jours, cinq candidatures ouvertes — donc la troisième
répétition d'une démonstration ne montrerait plus rien. `demo_reset()` (0018)
efface la source `demo-agency` et, par cascade, ses matchs et candidatures. Elle
part du slug : elle ne peut atteindre aucune donnée réelle.

**La portée, elle non plus, n'est pas un confort.** Le mode démonstration
candidate depuis `matches_ready_to_send_demo` (0018), restreinte à la source
fabriquée. Ouvrir la vanne globale — en basculant
`settings.require_subscription_to_apply` à `false`, maintenant que les paiements
sont coupés côté interface — libérerait du même coup les centaines d'annonces
réelles en attente : de vrais messages vers de vraies agences, depuis la vraie
boîte du client, pendant une répétition. C'est une décision d'exploitation, pas
un réglage de démonstration.

Rien ne distingue cette annonce du catalogue réel pour le pipeline. Pour un
humain, si : sa source est `demo-agency` et son identifiant externe commence par
`demo-`. C'est ce qui permet `--remove`, et ce qui évite de la confondre avec de
vraies données dans une requête d'exploitation.

### 3 quater. Éteindre — et rallumer

Le produit ne s'éteint pas en supprimant quoi que ce soit. Tout ce qui coûte
de l'argent est déclenché par Cloud Scheduler : le scraping toutes les minutes,
les envois toutes les deux, la relève de boîte deux fois par jour. Mettre les
six planificateurs en pause suffit à tout arrêter — plus une requête sortante,
plus un appel de modèle, plus un courriel.

```bash
for j in prems-scrape-bienici-tick prems-match-tick prems-enrich-tick \
         prems-agencies-tick prems-apply-tick prems-inbox-tick; do
  gcloud scheduler jobs pause "$j" --location europe-west9 \
    --project gen-lang-client-0781599139
done
gcloud scheduler jobs list --location europe-west9 \
  --project gen-lang-client-0781599139 --format='table(name.basename(),state)'
```

`resume` à la place de `pause` remet tout en marche. Rien d'autre ne change :
les jobs Cloud Run, les images, les secrets, les rôles IAM et la base restent
exactement où ils sont, et un job Cloud Run à l'arrêt ne coûte rien.

**Ce qui continue de coûter, à l'arrêt**, et c'est peu : le stockage des images
dans Artifact Registry, et l'abonnement Supabase. Pour descendre à zéro côté
Google il faudrait supprimer les images — ce qui rendrait impossible de
rallumer sans reconstruire, donc à ne faire que pour un arrêt définitif.

**Ce que la pause ne couvre pas** : une exécution lancée à la main
(`gcloud run jobs execute`) part quand même. C'est voulu — c'est ainsi qu'on
filme une démonstration sur un système par ailleurs éteint.

### 4. Le modèle et sa région — à revérifier avant tout déploiement

Les modèles sont nommés une seule fois, dans `workers/src/agent.ts`. Aucun autre
fichier ne contient d'identifiant de modèle.

| | Modèle | Région | Résidence des données |
|---|---|---|---|
| Agents | `gemini-3.7-flash` | `global` | **aucune** — traitement mondial |
| Embeddings | `text-multilingual-embedding-002` | `europe-west9` | UE, Paris |
| *Repli UE* | `gemini-3.5-flash` | `europe-west3` | UE, Francfort |
| *Repli Paris* | `gemini-2.5-flash` | `europe-west9` | UE, avec les jobs |

#### Mesuré, plus supposé

Relevé le 27 août 2026 en appelant chaque endpoint, `npm run gcp:models` :

| | west9 | west4 | west3 | west1 | north1 | southwest1 | global |
|---|---|---|---|---|---|---|---|
| `gemini-3.7-flash` | 404 | 404 | 404 | 404 | 404 | 404 | **200** |
| `gemini-3.6-flash` | 404 | 404 | 404 | 404 | 404 | 404 | — |
| `gemini-3.5-flash` | 404 | 404 | **200** | 404 | 404 | 404 | **200** |
| `gemini-3-flash` | 404 | 404 | 404 | 404 | 404 | 404 | — |
| `gemini-2.5-flash` | **200** | **200** | **200** | **200** | **200** | **200** | — |

Trois conclusions, toutes contraires à ce que ce dépôt affirmait :

1. **`eu` n'existe pas pour Vertex AI.** `eu-aiplatform.googleapis.com` répond
   400 « Invalid hostname ». La multi-région européenne existe pour Document AI
   — c'est de là que l'idée venait — et pas pour Vertex. Le repli documenté
   pendant deux commits aurait échoué au premier appel.
2. **La famille 3.x est mondiale, à une exception près** : `gemini-3.5-flash`
   répond depuis `europe-west3` (Francfort). C'est le modèle le plus récent
   qu'on puisse servir depuis l'Union européenne.
3. **`europe-west9` ne sert aucun modèle 3.x.** Paris s'arrête à 2.5.

```bash
npm run gcp:models              # sonde chaque paire modèle × région
npm run gcp:models -- --strict  # sort en 1 si la paire configurée ne répond pas
npm run gcp:models -- --dry-run # affiche les endpoints, n'appelle rien
```

Prérequis : ADC (`gcloud auth application-default login`, `GOOGLE_APPLICATION_CREDENTIALS`
ou `GCP_SERVICE_ACCOUNT_JSON`) et l'API Vertex activée.

#### L'erreur qui a coûté le plus de temps

« Gemini 3.5 Flash-Lite n'existe pas » était **vrai de la variante et faux de la
famille** : `gemini-3-flash-lite` répond bien 404, mais `gemini-3.5-flash`
existe. Les workers sont restés deux générations en arrière sur cette
déduction. Un 404 sur une variante ne dit rien de la famille — et c'est
exactement pourquoi `gcp:models` existe et pourquoi il faut le lancer plutôt
que de lire une page de documentation.

#### La décision de résidence, en clair

Le produit tourne sur `gemini-3.7-flash`, donc sur l'endpoint global. Ce qui
sort de l'UE n'est pas abstrait : ces prompts portent le nom d'une personne, sa
situation professionnelle, son revenu net mensuel, ses disponibilités, et le
texte de sa correspondance privée avec une agence.

C'est un arbitrage, pas un oubli. Il est loggé à chaque run qui parle à un
modèle :

```
modèle: gemini-3.7-flash @ global — AUCUNE résidence des données — traitement mondial
```

Revenir en arrière ne demande aucun code, seulement deux variables sur les deux
jobs concernés (`prems-enrich` ne fait que des embeddings, restés à Paris) :

```bash
for J in prems-apply prems-inbox; do
  gcloud run jobs update $J --region europe-west9 \
    --update-env-vars GCP_MODEL=gemini-3.5-flash,GCP_MODEL_LOCATION=europe-west3
done
```

**À décider avant de prendre un client payant**, et à écrire dans la politique
de confidentialité si le global est conservé : un service qui traite des
bulletins de paie français doit pouvoir dire où ils sont traités.

---

## Index vectoriel

`listing_embeddings` n'a **pas** d'index IVFFlat, délibérément. Un index IVFFlat
construit sur une table vide n'a pas de listes à entraîner et dégrade les
résultats. En dessous de ~10 000 annonces, un balayage séquentiel est de toute
façon plus rapide.

À créer quand le corpus le justifie :

```sql
create index concurrently listing_embeddings_ann_idx
  on public.listing_embeddings
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);   -- ≈ sqrt(nombre de lignes)
analyze public.listing_embeddings;
```

---

## Diagnostic

### Un scraper est-il tombé silencieusement ?

C'est le mode de panne le plus coûteux : le site marche, le client paie, rien
n'arrive.

```sql
select s.slug,
       max(r.started_at)                                   as dernier_run,
       now() - max(r.started_at)                           as depuis,
       sum(r.items_new) filter (where r.started_at > now() - interval '24 hours') as neuf_24h
from public.sources s
left join public.scrape_runs r on r.source_id = s.id
where s.enabled
group by s.slug
having max(r.started_at) < now() - (interval '1 second' * 3 * max(s.poll_interval_seconds))
    or max(r.started_at) is null;
```

### Que s'est-il passé pour ce client ?

```sql
select created_at, type, subject_type, payload
from public.events
where user_id = '…'
order by created_at desc
limit 100;
```

### Zones réellement scrapées

```sql
select public.active_scrape_zones();
```

Sans client actif, cette fonction renvoie les huit départements d'Île-de-France
plutôt qu'un tableau vide : le catalogue doit être chaud avant l'arrivée du
premier client, pas vide le matin de son inscription.

---

## Diagnostic du pipeline complet

```sql
select * from public.funnel;          -- annonces -> joignables -> matches -> envois
select * from public.contactability;  -- % d'annonces avec e-mail agence, par source
select * from public.source_health;   -- silence, production nulle, source injoignable
select * from public.events where type = 'source.alert' order by id desc limit 5;
```

### Alertes : une par source **et par condition**

`raise_health_alerts()` émet au plus une alerte par heure et par condition
(`is_stale`, `produced_nothing_24h`, `unreachable_but_enabled`). La clé inclut
la condition, et pas seulement la source : autrement une condition permanente
occupe le créneau horaire et retarde d'une heure l'alarme d'un vrai silence.

Ce qu'on choisit délibérément de ne pas entendre est une donnée, pas du code :

```sql
select slug, muted_alerts from public.sources;

-- réentendre une alarme
update public.sources set muted_alerts = '{}' where slug = 'bienici';
```

`bienici` a `unreachable_but_enabled` en sourdine : la source est en lecture
seule par décision, pas par accident, et l'alarme sonnait 22 fois par jour sur
un fait connu. Elle se réactivera d'elle-même le jour où `contact_channel`
changera — la condition disparaît avec.

### Le plafond par annonce s'applique à l'envoi, pas au match

`applications_per_listing` est dépensé dans `matches_ready_to_send()`, au
moment où une candidature est créée. Un match reste `new` — donc encore
éligible — tant que personne n'a réellement été servi pour ce logement.
`close_lost_matches()`, appelée par `prems-apply` après l'envoi, écrit alors
`served_higher_priority_client`, qui devient une affirmation vraie.

Vérifier qu'aucun client ne peut candidater deux fois pour le même bien :

```sql
select user_id, listing_id, count(*)
from public.applications where not dead_letter
group by 1, 2 having count(*) > 1;   -- doit toujours être vide
```

L'index unique partiel `applications_one_per_client_listing` le garantit ;
la requête sert à constater qu'il est toujours là.

`funnel.contactable` est le chiffre à surveiller : détecter une annonce sans
pouvoir y candidater ne sert à rien.

### Candidatures bloquées

```sql
select dead_letter_reason, count(*)
from public.applications where dead_letter group by 1;
```

`aucune boîte Gmail connectée` n'est pas un incident : c'est un client qui n'a pas
terminé la connexion Composio. Aucun retry ne le réparera, d'où la DLQ immédiate.

## Vérifier que la RLS tient toujours

À relancer après toute migration touchant aux policies. Avec la clé
*publishable* (celle que tient un navigateur), toutes ces tables doivent
renvoyer zéro ligne :

```bash
for t in listings sources scrape_runs matches applications events consents; do
  curl -s "$PUBLIC_SUPABASE_URL/rest/v1/$t?select=*&limit=1" \
    -H "apikey: $PUBLIC_SUPABASE_ANON_KEY" -H "Authorization: Bearer $PUBLIC_SUPABASE_ANON_KEY"
done
```

`demo_listings` est la seule exception : elle est publiquement lisible par
conception, parce que l'écran d'accroche la montre avant toute inscription.
