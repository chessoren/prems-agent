# Brancher l'interface

Tout ce dont le front a besoin, et rien d'autre. Le backend est déjà en place :
l'interface **lit** et **s'abonne**, elle ne calcule rien.

## Le principe

L'interface n'écrit presque rien. Le pipeline tourne sans elle et produit un
journal ; l'interface est une vue temps réel sur ce journal. Si le site est
fermé pendant trois jours, le client retrouve trois jours de travail à son
retour.

La sécurité ne dépend d'aucune vérification côté client : **toutes les tables
sont sous RLS, scopées à `auth.uid()`**. Un bug dans le front ne peut pas
montrer les données d'un autre client, parce que Postgres refuse de les
renvoyer.

## Connexion

```ts
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.PUBLIC_SUPABASE_URL,      // https://budbfhrqdeghyufeizpv.supabase.co
  import.meta.env.PUBLIC_SUPABASE_ANON_KEY, // clé publishable — publique par conception
);
```

La clé *publishable* est publique : c'est la RLS qui protège, jamais le secret
de la clé. **Ne jamais mettre `service_role` dans le front** — elle contourne
toutes les policies.

La session existe déjà : le parcours d'inscription crée un compte anonyme
(`signInAnonymously`) à l'écran 5, et Google le remplace quand le visiteur s'y
connecte. `supabase.auth.getSession()` suffit.

---

## Le flux d'activité — l'écran principal

C'est le compte rendu temps réel que vous vouliez.

```ts
// L'historique
const { data: events } = await supabase
  .from('events')
  .select('*')
  .order('created_at', { ascending: false })
  .limit(50);

// Et la suite, en direct
supabase
  .channel('activite')
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'events' },
      ({ new: e }) => prepend(e))
  .subscribe();
```

Pas de filtre `user_id` à écrire : la RLS ne renvoie que les événements du
client connecté. Les événements système (`user_id` nul, comme les alertes de
source) ne lui sont pas visibles non plus.

### Les types d'événements

| `type` | Quand | `payload` |
|---|---|---|
| `listing.discovered` | une annonce entre en base | `source`, `city`, `postcode`, `rent`, `surface`, `rooms`, `url` |
| `match.created` | elle correspond au client | `listing_id`, `score`, `priority`, `url` |
| `application.sent` | la candidature part | `to`, `subject`, `listing_url`, `with_dossier` |
| `application.retry` | échec temporaire | `attempts`, `error` |
| `application.dead_lettered` | échec définitif | `attempts`, `error` |
| `reply.visit_offered` | l'agence propose une visite | `from`, `summary` |
| `reply.refused` | le bien est pris | `from`, `summary` |
| `reply.question` | l'agence demande une pièce | `from`, `summary`, `suggested_reply` |
| `visit.booked` | rendez-vous créé | `starts_at`, `location`, `from` |

`suggested_reply` est une réponse **rédigée, jamais envoyée**. C'est
délibéré — voir plus bas.

---

## Les écrans, et leur requête

### Mes annonces trouvées

```ts
const { data } = await supabase
  .from('matches')
  .select(`
    id, score, status, created_at,
    listings ( title, city, postcode, total_rent_eur, surface_m2, rooms,
               dpe, furnished, photos, url, agency_name, published_at )
  `)
  .order('created_at', { ascending: false })
  .limit(30);
```

Une annonce n'est lisible qu'à travers un match qui appartient au client — la
jointure fonctionne, une lecture directe de `listings` renvoie zéro ligne. Ce
n'est pas un bug à contourner : le catalogue est l'actif du produit.

`matches.status` : `new` (trouvée), `queued` (candidature en préparation),
`applied` (envoyée), `skipped` (écartée), `failed`.

Quand `status = 'skipped'`, `skipped_reason` dit pourquoi, et c'est une réponse
à afficher plutôt qu'à cacher :

| `skipped_reason` | Ce qui s'est passé |
|---|---|
| `served_higher_priority_client` | un autre client a été servi — écrit **après** l'envoi, jamais avant |
| `duplicate_of_your_other_search` | deux de vos recherches trouvaient le même bien ; la mieux notée l'a gardé |
| `daily_cap` | plafond quotidien du client atteint |
| `too_many_active` | trop de candidatures déjà ouvertes |
| `agency_cooldown` | 2 candidatures max chez la même agence sur 7 jours |

`duplicate_of_your_other_search` n'est pas un échec et ne doit pas être
présenté comme tel : le client a bien eu l'appartement, par son autre
recherche. Le bien apparaît une fois, pas deux.

`served_higher_priority_client` est désormais une affirmation vérifiable : elle
n'est écrite qu'une fois qu'une candidature est réellement partie pour ce
logement. Tant que personne n'a été servi, le match reste `new` et reste
éligible.

### Pourquoi cette annonce ?

`matches.score_breakdown` contient chaque composante du score :

```json
{ "budget": 0.72, "surface": 0.81, "rooms": 1, "freshness": 0.94,
  "features": 0.7, "energy": 0.67, "semantic": 0.63 }
```

Toutes dans `[0,1]`. `semantic` est `null` si le client n'a pas écrit de texte
libre — son poids est alors redistribué, donc **ne l'affichez pas comme un
zéro**.

### Mes candidatures

```ts
const { data } = await supabase
  .from('applications')
  .select('id, status, subject, sent_at, to_email, dead_letter, dead_letter_reason, listings(title, city, url)')
  .order('created_at', { ascending: false });
```

`status` : `pending` → `sent` → `replied` | `visit_booked` | `rejected`, ou
`failed`.

`applications` est publiée en Realtime : abonnez-vous pour voir une candidature
passer à `sent` sans rafraîchir.

### Les réponses des agences

```ts
const { data } = await supabase
  .from('application_replies')
  .select('id, received_at, from_address, subject, body, classified_as, applications(listing_id)')
  .order('received_at', { ascending: false });
```

`classified_as` : `visit_offered`, `refused`, `question`, `other`.

**Sur `question`** : l'événement `reply.question` porte un `suggested_reply`
rédigé par l'IA. Il n'est **jamais envoyé automatiquement**, et l'interface ne
doit pas le faire non plus. Un agent qui répond seul à une agence peut engager
quelqu'un sur une visite qu'il ne peut pas honorer — et le modèle se trompe :
lors des tests il a écrit « je vous transmets **vos** bulletins » au lieu de
« mes ». Affichez-le dans un champ éditable, avec un bouton d'envoi explicite.

### L'agenda

```ts
const { data } = await supabase
  .from('calendar_events')
  .select('id, title, location, starts_at, ends_at, google_event_id, listings(url, city)')
  .gte('starts_at', new Date().toISOString())
  .order('starts_at');
```

Publiée en Realtime. `google_event_id` non nul signifie que l'événement est
aussi dans le Google Calendar du client. **Toujours afficher depuis cette
table**, jamais depuis Google : notre calendrier est écrit en premier,
justement pour que l'interface fonctionne quand Google ne répond pas.

### Mes critères

```ts
const { data } = await supabase.from('searches').select('*').eq('active', true);
```

Modifiables par le client (`update` autorisé par la RLS). Un changement est pris
en compte au prochain passage du matcher, dans la minute.

Champs : `budget_min_eur`, `budget_max_eur`, `surface_min_m2`, `surface_max_m2`,
`rooms_min`, `rooms_max`, `property_types[]`, `furnished`, `zones[]`,
`dpe_max`, `must_have[]`, `free_text`, `move_in_date`, `move_in_asap`,
`min_score`, `max_applications_per_day`.

`zones` accepte un code postal (`75011`) ou un département sur deux caractères
(`75`).

`free_text` est vectorisé automatiquement : `prems-enrich` repère un texte dont
l'empreinte a changé et recalcule `free_text_embedding` dans les cinq minutes.
Le front n'a rien à faire — et surtout rien à calculer.

---

## Connecter la boîte mail du client

Rien ne peut partir sans. Le lien d'autorisation se génère côté serveur (jamais
depuis le navigateur : la clé Composio ne doit pas atteindre le front).

```ts
// Route serveur — POST /api/connect-gmail
const r = await fetch('https://backend.composio.dev/api/v3/connected_accounts/link', {
  method: 'POST',
  headers: { 'x-api-key': process.env.COMPOSIO_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ auth_config_id: 'ac_BDCvl8Std_Rq', user_id: userId }),
});
const { id, redirect_url } = await r.json();
// rediriger le client vers redirect_url, puis au retour :
await supabase.from('profiles').update({ gmail_account_id: id }).eq('id', userId);
```

Configurations existantes : **Gmail `ac_BDCvl8Std_Rq`**, **Google Calendar
`ac_H4AoPOZxFKAL`**. Pour l'agenda, même appel puis
`calendar_account_id`.

Tant que `profiles.gmail_account_id` est nul, le pipeline **n'engage rien** :
les matches restent `new` et attendent. C'est voulu — une version précédente
les consommait et perdait 103 appartements le jour de la connexion.

---

## Ce qu'il faut aussi montrer

Le dossier : `profiles.dossierfacile_url`. S'il est nul, les candidatures
partent sans dossier — c'est le plus gros levier d'acceptation, à mettre en
avant.

Le consentement : la table `consents` (`auto_apply`, `data_processing`,
`mailbox_access`). Candidater au nom de quelqu'un depuis sa boîte exige son
instruction explicite et prouvable. Insérez une ligne à l'acceptation ;
proposez la révocation.

---

## Ce que le front ne doit pas faire

- **Lire `listings` directement** — RLS renvoie zéro, passez par `matches`.
- **Envoyer une réponse d'agence automatiquement**, même « suggérée ».
- **Recalculer un score** — il est dans `score_breakdown`, avec ses poids.
- **Porter la clé `service_role` ou la clé Composio** — serveur uniquement.
- **Afficher `source_health`, `funnel`, `contactability`** — vues d'exploitant,
  révoquées pour `authenticated`, elles renverront une erreur.

---

## Pour tester sans attendre

```sql
-- Voir ce qu'un client verrait
select type, created_at, payload from public.events
where user_id = '<uuid>' order by created_at desc limit 20;

-- L'état global (service_role uniquement)
select * from public.funnel;
```

Le catalogue de démonstration (`demo_listings`, 1 100 annonces, 11 villes) reste
disponible et publiquement lisible : c'est lui qui alimente l'écran d'accroche
du parcours d'inscription, avant toute connexion.
