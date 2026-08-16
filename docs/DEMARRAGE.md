# Mettre Prems en service — la démarche complète

De l'état actuel à un produit qui candidate vraiment. Quatre étapes, dont deux
seulement sont bloquantes.

---

## Étape 1 — Le bouton de connexion dans l'interface *(bloquant, session front end)*

Rien ne peut partir sans. Tant que `profiles.gmail_account_id` est nul, le
pipeline détecte et matche mais **n'engage rien** : les matches restent `new` et
attendent, délibérément.

**C'est chaque utilisateur de Prems qui connecte sa propre boîte, depuis
l'interface.** Jamais un compte d'exploitant, jamais une boîte partagée. Le
produit envoie *depuis la boîte du client* et reçoit les réponses *dans sa
boîte* — c'est ce qui fait qu'une agence reçoit un message d'une personne et
non d'un robot, et c'est aussi ce qui rend l'interception des réponses possible
sans rien intercepter chez personne d'autre.

Le backend est prêt et attend seulement le bouton : `profiles.gmail_account_id`
et `calendar_account_id` sont lus par le worker d'envoi et par le lecteur de
boîte, par utilisateur, à chaque passage.

Le câblage exact du bouton — route serveur, `auth_config_id`, écriture au
retour — est dans `FRONTEND.md`, section « Connecter la boîte mail du client ».
La clé Composio ne doit jamais atteindre le navigateur : le lien se génère
côté serveur.

Deux choses à demander en même temps que la boîte :

- `profiles.dossierfacile_url` — le plus gros levier d'acceptation d'une
  candidature, envoyé en lien dans chaque message ;
- une ligne dans `consents` (`auto_apply`, `mailbox_access`) — candidater au
  nom de quelqu'un depuis sa boîte exige son instruction explicite et
  prouvable.

### Vérifier que ça part, une fois un premier client connecté

Dans les deux minutes qui suivent (le job tourne toutes les 2 min) :

```sql
select status, to_email, subject, sent_at from public.applications
order by created_at desc limit 5;

select type, payload from public.events
where type like 'application%' order by id desc limit 5;
```

Une ligne `sent` avec un `sent_at` : la chaîne complète fonctionne.

---

## Étape 2 — Trancher le canal Bien'ici *(bloquant pour la couverture, 2 min)*

La joignabilité est à **17,1 %** : on ne peut écrire qu'aux agences dont on a
retrouvé l'adresse. Le formulaire de contact de Bien'ici couvrirait 100 %.

Mes quatre tentatives anonymes échouent toutes en 401, et l'objet `contact`
refuse `firstName`, `email`, `phone`. **Je n'ai pas pu observer la requête du
navigateur** : la sortie réseau de Chromium est bloquée dans l'environnement de
développement, avec ou sans proxy — et je n'ai pas de moyen de piloter votre
Chrome depuis ici.

### Ce que vous seul pouvez faire

1. Ouvrir une annonce de location sur bienici.com.
2. Outils de développement → onglet **Réseau** → filtre `contact`.
3. Remplir et envoyer le formulaire — **sur une annonce qui vous intéresse
   réellement**, la demande part vraiment chez un agent.
4. Clic droit sur la requête → *Copier comme cURL*, et me l'envoyer.

**Si aucun en-tête d'authentification n'apparaît**, l'envoi anonyme est
possible : la joignabilité passe à 100 %, et il ne reste qu'à câbler la forme
exacte du corps. `sources.contact_channel = 'form_post'` et le worker sont déjà
prévus pour ça.

**S'il y a un jeton ou un cookie de session**, il faut un compte Bien'ici — ce
qui change qui envoie la candidature, et donc où arrivent les réponses. C'est
alors un arbitrage produit, pas une tâche technique.

---

## Étape 3 — Faire tourner les secrets *(avant tout vrai utilisateur)*

Six secrets ont transité par une conversation : PAT Supabase, clé
`service_role`, clé secrète Supabase, clé privée du compte de service GCP, et
les deux clés Composio. La clé `service_role` contourne **toutes** les policies
RLS.

Détail des opérations dans `RUNBOOK.md`, section 1. Après rotation, mettre à
jour les versions dans Secret Manager (`supabase-service-role-key`,
`composio-api-key`) — les jobs prennent la nouvelle version au run suivant, sans
redéploiement.

---

## Étape 4 — Répondre aux sept questions de priorité *(non bloquant)*

Elles ne bloquent rien : chaque valeur vit dans `settings` et se change par
`UPDATE`. Les défauts actuels sont des recommandations documentées avec ce que
coûte l'erreur.

```sql
select * from public.settings;

-- exemple : servir deux clients par annonce au lieu d'un
update public.settings set applications_per_listing = 2 where id = 1;
```

| Paramètre | Défaut | Question correspondante |
|---|---|---|
| `applications_per_listing` | 1 | Q2 — une annonce sert combien de clients ? |
| `priority_half_life_hours` | 12 | Q1 — vitesse de rotation |
| `max_active_applications` | 5 | Q5 — plafond de candidatures ouvertes |
| `active_application_days` | 7 | Q5 — ce que « active » veut dire |
| `new_client_starts_at_top` | true | Q7 — où démarre un nouvel inscrit |
| `notify_unserved_matches` | true | Q3 — les non-servis sont-ils prévenus |

Q4 (priorité contre pertinence) est déjà tranchée dans le code : le filtre sur
`min_score` s'applique **avant** la découpe par priorité, donc un match médiocre
ne peut jamais prendre l'appartement parfait de quelqu'un d'autre.

---

## Ce qui tourne pendant ce temps

```
815 annonces      139 joignables (17,1 %)     1 083 matches
1 440 runs/24 h   0 échec                     0 en DLQ
```

Six jobs Cloud Run en `europe-west9`, une seule image, alerting en base.
Voir `STATUS.md` pour le détail et `ARCHITECTURE.md` pour le pourquoi.
