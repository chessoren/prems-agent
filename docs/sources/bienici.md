# Bien'ici

| | |
|---|---|
| Adaptateur | `workers/src/adapters/bienici.ts` |
| Endpoint | `GET https://www.bienici.com/realEstateAds.json?filters=<JSON>` |
| Authentification | **aucune** |
| Tri par date | **oui** — `sortBy: publicationDate`, `sortOrder: desc` |
| Pagination | `from` / `size`, 100 par page |
| Anti-bot | aucun depuis une IP datacenter américaine |
| Volume | ~925 000 annonces de location |
| Canal de candidature | `POST /api/contactRequests` — **endpoint vérifié, non authentifié** |

## Ce qui a été établi en sondant l'API, pas supposé

**Les filtres de zone sont ignorés en silence.** Passer `postalCodes: ["75011","75010"]`
renvoie le même total national et des résultats hors de la liste (92500, 92000).
Aucune erreur : le filtre ne fait simplement rien. Le filtrage par zone se fait
donc **après** le fetch, dans l'adaptateur. Un code qui aurait fait confiance au
filtre aurait scrapé le mauvais pays sans jamais le signaler.

**Le tri par date fonctionne, lui.** C'est ce qui transforme « trouver les
nouveautés » en « lire le haut de la liste jusqu'à ce qu'on reconnaisse ce qu'on
a déjà », soit le crawl incrémental le moins cher possible. Mesuré : 1 requête et
1,4 s pour un run incrémental.

**Le corpus est constitué de flux de CMS d'agences.** Les identifiants ont la
forme `immo-facile-61331072` et `netty-company39587uxo-appt-3768` : Bien'ici
agrège Immo-Facile, Netty et d'autres. Une seule source atteint donc des
centaines d'agences — et le nom du CMS est conservé dans `external_id`, ce qui
servira à retrouver le site propre de chaque agence.

## Les dates de publication arrivent par lots — et ça a coûté des annonces

Mesuré sur 720 annonces réelles : seulement **438 horodatages distincts**, et
jusqu'à **28 annonces partageant une date à la milliseconde près**. Bien'ici
importe les flux d'agences par paquets et stampe tout le paquet à l'identique.

Le watermark initial s'arrêtait à `published_at <= since`. Dès qu'un run se
terminait pile sur un horodatage de lot, **tout le reste du lot était sauté —
définitivement**, puisque le watermark du run suivant valait ce même horodatage.
Symptôme visible : une latence de détection médiane de **41 minutes** contre un
polling à 60 secondes, et des runs qui voyaient systématiquement 0 annonce.

Le watermark est désormais **reculé de 30 minutes** avant d'être utilisé. Le
recouvrement coûte quelques relectures par run — une annonce déjà connue matche
sur `content_hash` et devient un simple `UPDATE` de `last_seen_at`, ~600 ms — et
la contrainte d'unicité rend tout doublon impossible.

## Réconciliation du prix

`price` est tantôt le loyer charges comprises, tantôt hors charges, et
`rentWithoutCharges` / `charges` sont présents de façon inconstante.
L'adaptateur privilégie la paire explicite et retombe sur `price` en
soustrayant les charges connues. Le budget du client porte toujours sur le
total, et `total_rent_eur` est une colonne générée.

## Position géographique

La plupart des annonces ne donnent qu'un disque flou (`blurInfo.type = "disk"`),
pas un point. Enregistrer ça comme une position exacte permettrait de matcher un
client qui a demandé une rue précise avec un bien situé 500 m plus loin. La
précision est donc conservée dans `geo_precision`, et le géocodage BAN affine
l'adresse tout en fournissant le code INSEE — que les coordonnées seules
n'auraient pas donné.

## Mesures réelles

| Run | Annonces | Requêtes | Durée |
|---|---|---|---|
| À froid, géocodage séquentiel | 204 nouvelles | 10 | 144 s |
| À froid, géocodage parallélisé (8) | 204 nouvelles | 10 | **21,7 s** |
| Incrémental (watermark) | 0 | 1 | **1,4 s** |

Qualité sur les 204 premières annonces d'Île-de-France : 204/204 géocodées,
200/204 avec code INSEE, 204/204 avec surface, pièces et date de publication,
189/204 avec DPE. Loyers moyens cohérents par département (Paris 2 316 €,
Seine-Saint-Denis 894 €).

## Le canal de candidature

Trouvé dans `commonModern.js`, pas deviné : les cinq chemins essayés au hasard
renvoyaient tous 404.

```
POST https://www.bienici.com/api/contactRequests
Content-Type: application/json
Referer: https://www.bienici.com/
```

Non authentifié. Une charge vide reçoit un **400** avec un schéma de validation
qui nomme les champs manquants :

```
OBJECT_MISSING_REQUIRED_PROPERTY : realEstateAdIds
OBJECT_MISSING_REQUIRED_PROPERTY : contact
```

`realEstateAdIds` est un tableau — le même endpoint contacte donc plusieurs
annonces en une requête.

**Bien'ici satisfait les deux critères du MVP** : lecture par API JSON cachée,
et envoi par POST HTTP simple. Pas de navigateur, pas de captcha sur ce chemin.

### Ce qui n'a délibérément pas été fait

Aucune candidature n'a été envoyée. Compléter ce POST délivre un vrai message à
une vraie agence, au nom d'une personne — le faire pour tester reviendrait à
envoyer du spam à un professionnel sous une fausse identité. Le contrat de
l'API est établi ; le premier envoi réel appartient à la Phase 6, avec le
consentement d'un client, son dossier, et une annonce qu'il veut réellement.
