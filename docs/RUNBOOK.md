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

### 3. Le modèle Gemini demandé n'existe pas

« Gemini 3.5 Flash-Lite » n'est pas un identifiant réel. La famille Flash-Lite
existe en `gemini-2.5-flash-lite`. Le code visera **`gemini-2.5-flash-lite`**,
et la vérification empirique de la liste réellement servie par le projet
attend le rôle `aiplatform.user` ci-dessus — tous les modèles ont répondu 403,
donc aucune disponibilité n'est encore confirmée.

Embeddings : **`text-multilingual-embedding-002`**, 768 dimensions, qui est la
dimension figée dans `listing_embeddings`. Le corpus est en français ;
`text-embedding-004` est entraîné majoritairement sur de l'anglais.

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
