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

### 4. Le modèle et sa région — à revérifier avant tout déploiement

Les modèles sont nommés une seule fois, dans `workers/src/agent.ts`. Aucun autre
fichier ne contient d'identifiant de modèle.

| | Modèle | Région |
|---|---|---|
| Agents | `gemini-3.5-flash` | `eu` (multi-région européenne) |
| Embeddings | `text-multilingual-embedding-002` | `europe-west9` |

**Deux choses sont vérifiées, une troisième ne l'est pas.**

Vérifié : `text-multilingual-embedding-002` répond en 768 dimensions depuis
`europe-west9` — c'est la dimension figée dans `listing_embeddings`, et le
corpus est français, là où `text-embedding-004` est entraîné majoritairement sur
de l'anglais.

Vérifié aussi, et c'est l'erreur qui a coûté le plus de temps : **« Gemini 3.5
Flash-Lite » n'existe pas.** La famille Flash-Lite s'arrête à
`gemini-2.5-flash-lite`, et `gemini-3-flash-lite` répond 404. La conclusion
qu'on en avait tirée — « la famille 3.x n'existe pas » — était fausse :
`gemini-3.5-flash`, sans le Lite, est le modèle courant. Un 404 sur une variante
ne dit rien de la famille.

**Non vérifié depuis cette machine : la région.** `gemini-3.5-flash` est
documenté comme servi depuis `eu`, la multi-région européenne, et n'est pas
documenté comme disponible depuis `europe-west9` — même situation que les
processeurs Document AI, et pour la même raison. `eu` garde la requête dans
l'Union européenne, ce qui est la contrainte réellement applicable ; `global` ne
la garderait pas. Mais c'est une lecture de la documentation, pas un appel.
**Avant de déployer, faites l'appel :**

```bash
PROJECT=gen-lang-client-0781599139
TOKEN=$(gcloud auth print-access-token)

for LOC in eu europe-west9; do
  echo -n "$LOC : "
  curl -s -o /dev/null -w '%{http_code}\n' \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "https://${LOC}-aiplatform.googleapis.com/v1/projects/$PROJECT/locations/${LOC}/publishers/google/models/gemini-3.5-flash:generateContent" \
    -d '{"contents":[{"role":"user","parts":[{"text":"ping"}]}]}'
done
```

200 sur `eu` : rien à faire, c'est le défaut. 200 sur `europe-west9` aussi :
posez `GCP_MODEL_LOCATION=europe-west9` sur les jobs et tout revient à Paris.
404 sur les deux : le modèle a encore changé de nom, et c'est `agent.ts` — un
seul fichier — qu'il faut corriger.

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
