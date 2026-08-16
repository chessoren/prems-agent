# L'espace client

`/app` — quatre onglets, écrits à la main comme le parcours d'inscription, sans
framework. Le parcours s'arrête désormais sur un écran de tarifs ; l'espace
client est ce qui vient après.

```
src/pages/app.astro              la page (coquille + <script>)
public/styles/app.css            ce que l'app ajoute au design system
src/scripts/app/
  index.js                       coquille : onglets, badges, horloge
  matches.js                     onglet 1 — Accueil / Mes matchs
  visits.js                      onglet 2 — Visites
  messages.js                    onglet 3 — Messages
  profile.js                     onglet 4 — Profil / Mon dossier
  ui.js                          ce que l'app ajoute aux atomes du parcours
src/lib/prems/
  agent.js                       le modèle : matchs, cycle de vie, fils, logs
  billing.js                     les offres et le passage en caisse Stripe
```

`app.css` est chargé **après** `onboarding.css`, qui n'est pas un reliquat :
c'est le design system. Les pilules de 100 px et leur ombre à cinq couches, les
cartes d'option, les champs, le spinner viennent de là. Quelqu'un qui arrive ici
depuis le dernier écran du parcours ne doit pas pouvoir dire où l'un s'arrête et
où l'autre commence.

## Les trois décisions structurantes

**L'agent ne démarre pas sans disponibilités.** Tant que la grille de créneaux
n'est pas remplie, l'accueil n'affiche pas une liste vide : il affiche l'unique
action à faire, l'explique — un agent qui décroche une visite à laquelle
personne ne peut aller brûle la seule chose qu'il ne sait pas reconstruire, la
disponibilité de l'agence à répondre — et montre le journal de l'agent en
attente. La première session a une tâche, pas une attente.

**L'onglet Visites est une file avant d'être un calendrier.** Ce qui est
confirmé peut attendre d'être regardé ; ce qui demande une réponse, non. Les
créneaux proposés par les agences sont donc un bloc au-dessus du calendrier, pas
une couleur parmi d'autres dans une grille. Un calendrier montre du temps. Une
file montre du travail.

**L'auteur d'un message n'est jamais flou.** Ce que l'IA a écrit au nom de
quelqu'un porte une signature explicite, une forme et une couleur différentes de
tout ce que la personne a écrit elle-même. La raison est pratique plus
qu'éthique : au moment de reprendre la main, il faut savoir exactement ce qui a
déjà été dit en son nom, sinon le premier message contredit le dernier.

## Ce qui est branché, et ce qui ne l'est pas

Le produit côté serveur — les collecteurs d'annonces, l'agent qui écrit aux
agences, l'interception des réponses — n'existe pas encore : le schéma Supabase
couvre l'inscription, et `prems-api` lit des documents. Il n'y a pas de tables
`matches`, `visits` ni `messages`.

`agent.js` sépare donc nettement deux choses :

| | État | Où il vit |
|---|---|---|
| Ce que **la personne** fait — écarter un match, choisir un créneau, reprendre un fil, préférences, disponibilités | réel, persistant | `localStorage`, repris tel quel par une synchro serveur |
| Ce que **l'agent** fait — détection, prise de contact, réponse d'agence | projeté | calculé depuis le catalogue réel et une horloge déterministe |

La projection n'est pas une décoration : c'est le contrat que le backend devra
remplir — ces statuts, dans cet ordre, avec ces délais. Chaque horaire dérive de
l'identifiant de l'annonce, donc un même appartement est toujours trouvé à la
même minute et reçoit toujours la même réponse ; un tirage aléatoire déplacerait
tout le flux à chaque rechargement, ce qui se lit comme un bug bien avant de se
lire comme de la vie. Le jour où le flux d'événements arrive, `derive()` lit des
lignes au lieu de les calculer, et rien au-dessus ne change.

Le catalogue vient du même moteur que l'écran « aha » du parcours : les
appartements de l'app sont ceux qu'on a montrés avant l'inscription.

## Les tarifs

Le parcours se termine sur `#pricing` : l'offre standard telle quelle depuis la
landing page, et **en grand** à la place des deux offres supérieures, l'offre
fondateur — 100 € une fois, accès à l'offre standard jusqu'à la signature du
bail.

L'asymétrie est le dessin. Deux cartes de même poids se lisent comme une
comparaison à faire, et une comparaison est la mauvaise tâche dix secondes après
une récompense.

Le passage en caisse utilise des **Stripe Payment Links** plutôt qu'une session
Checkout créée côté serveur : le site est statique et le seul serveur qu'on
possède existe pour porter des secrets de lecture documentaire. Un lien de
paiement ne demande aucune clé dans le navigateur ni endpoint à nous, et c'est
la même page Checkout hébergée — carte, Apple Pay, Google Pay, Link, 3-D Secure
compris.

| Produit | Prix | Lien |
|---|---|---|
| Le Soldat | 29 €/semaine | `price_1U59DyKcbSyRnuPk47TymKZ3` |
| Le Commando | 99 €/semaine | `price_1U59E7KcbSyRnuPkov1DiFvo` |
| L'Investisseur | 149 €/semaine | `price_1U59EBKcbSyRnuPkcvToMW2Q` |
| Offre Fondateur | 100 € une fois | `price_1U59ENKcbSyRnuPk9CNDYWff` |

Les quatre sont en **live mode** sur le compte Stripe, avec la TVA automatique
et le code produit `txcd_10103000` (SaaS, usage personnel) exigé par Managed
Payments. Chaque lien renvoie sur `/app?checkout=<offre>` : l'app enregistre
l'offre localement pour arrêter de la proposer, en attendant que le webhook
`checkout.session.completed` ait une table où écrire.

**Ce qui reste à faire côté Stripe :** activer la page de connexion du portail
client (Réglages → Facturation → Portail client) et reporter son URL dans
`PUBLIC_STRIPE_PORTAL_URL`. L'API ne permet pas de créer cette configuration ;
tant qu'elle est absente, la section Abonnement le dit au lieu de pointer vers
une page d'erreur.

## Vérification

Il n'y a pas d'original Framer, donc pas de diff pixel. Le contrôle équivalent
est un parcours scripté dans un vrai Chromium, aux deux points de rupture, qui
échoue à la moindre erreur console ou requête en 4xx :

```bash
npm run build && npm run preview
npm run shots:app          # 14 états x 2 breakpoints -> .cache/app/
npm run shots:onboarding   # le parcours, jusqu'à l'écran de tarifs
```

Le cycle de vie étant piloté par le temps, le script ne l'attend pas : il recule
l'horodatage enregistré à la validation des disponibilités, ce qui met tout le
flux dans ses états intermédiaires en un rechargement.
