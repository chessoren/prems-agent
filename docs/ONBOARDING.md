# Le parcours d'inscription

Treize écrans, une question par écran, sur `/onboarding`. Aucune dépendance de
rendu : pas de React, pas de routeur, ~14 ko de JavaScript au-dessus du runtime
de 2 ko déjà présent sur le site.

```
src/pages/onboarding.astro          la page (coquille + <script>)
public/styles/onboarding.css        le design system du parcours
src/scripts/onboarding/
  index.js                          contrôleur : chrome, navigation, progression
  screens.js                        les 13 écrans
  ui.js                             hyperscript, boutons, cartes, champs
src/lib/prems/
  supabase.js                       client, session anonyme
  store.js                          brouillon local + synchronisation
  listings.js                       moteur de correspondance
  geo.js                            autocomplétion des communes
  documents.js                      envoi de pièces
  analytics.js                      entonnoir
supabase/migrations/0001_*.sql      schéma, RLS, buckets
tools/supabase/                     provisionnement et catalogue de démo
```

## Les trois décisions structurantes

**Rien ne bloque sur le réseau.** Les écrans 1 à 4 sont répondus avant qu'un
compte existe : le brouillon vit dans `localStorage` et n'est poussé vers
Supabase qu'à l'écran 5. Ensuite, toutes les écritures sont opportunistes —
`store.sync()` n'est jamais attendu, et chaque appel sortant a une échéance
(1,2 s pour la recherche de commune, 2 s pour les annonces, 12 s pour un envoi
de fichier). Une connexion instable fait perdre une synchronisation, jamais une
inscription.

**Le manuel d'abord, structurellement.** Sur les écrans 7, 9 et 10, les champs
de saisie sont en haut et le raccourci photo en bas, sous un séparateur, rendu
en bouton pointillé et jamais en pilule. Ce n'est pas une préférence de mise en
page : c'est la hiérarchie qui transforme « l'app veut une photo de mes papiers »
en « l'app me propose un raccourci ».

**Le moment « aha » ne peut pas échouer.** `listings.js` élargit la requête par
paliers — date, puis budget +10 %, puis ±1 pièce, puis type de bien — jusqu'à
obtenir huit résultats, et **dit lesquels** ont été élargis (« dont 2 légèrement
au-dessus de ton budget »). Une correspondance surévaluée détruirait la
confiance que cet écran vient de gagner. En dernier recours, un instantané du
catalogue est servi depuis `public/data/listings.json`.

## Ce qui est branché

| Élément | État |
|---|---|
| Base Supabase (`eu-west-1`), RLS sur toutes les tables | ✅ |
| Buckets privés, isolation par `auth.uid()` | ✅ |
| Compte réel sans SMS (session anonyme + numéro stocké) | ✅ |
| Catalogue de 1 100 annonces sur 11 villes | ✅ |
| Autocomplétion des communes (`geo.api.gouv.fr`) | ✅ |
| Entonnoir mesuré écran par écran | ✅ |
| Envoi du justificatif de domicile | ✅ |
| Google OAuth | bouton présent, s'active dès les identifiants fournis |
| OTP par SMS | volontairement désactivé |
| OCR pièce / bulletin | raccourcis visibles et désactivés, en attente de Cloud Run |
| Connexion bancaire | volontairement désactivée (agrément DSP2) |

## Commandes

```bash
npm run db:provision   # config auth + migrations (idempotent)
npm run db:seed        # régénère le catalogue et public/data/listings.json
npm run build
npm run preview
node tools/onboarding-shots.mjs   # parcours scripté + captures, 2 breakpoints
```

Le parcours n'a pas d'original Framer, donc le diff pixel ne s'y applique pas.
Le contrôle équivalent est `onboarding-shots.mjs` : il joue les treize écrans
dans un vrai Chromium, en mobile et en desktop, et échoue à la moindre erreur
console.

## Variables d'environnement

Seules les variables `PUBLIC_*` atteignent le navigateur. La clé *publishable*
est publique par conception — c'est la RLS qui protège les données, jamais le
secret de la clé.

```
PUBLIC_SUPABASE_URL
PUBLIC_SUPABASE_ANON_KEY
PUBLIC_PREMS_API_URL     # vide = raccourcis OCR désactivés
SUPABASE_ACCESS_TOKEN    # provisionnement uniquement
SUPABASE_SERVICE_ROLE_KEY
```

## Ce qui reste à brancher

Voir [`CLOUD-RUN.md`](CLOUD-RUN.md) pour le service qui portera l'OCR, le
moteur de correspondance réel et la vérification Alur.

Pour activer l'OTP par SMS le jour venu : renseigner Twilio dans Supabase, puis
appeler `updateUser({ phone })` sur la session anonyme existante. Le compte est
mis à niveau sur place — personne ne recommence, et rien de ce qui a déjà été
envoyé n'est orphelin.
