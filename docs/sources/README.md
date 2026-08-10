# Les sources : ce que les données disent

## La distribution réelle, mesurée

Les identifiants Bien'ici encodent le CMS d'origine de chaque annonce. Sur les
204 premières annonces d'Île-de-France réellement collectées :

| Préfixe | Annonces | Agences distinctes |
|---|---|---|
| `immo-facile` | 36 | 10 |
| `netty` | 20 | 8 |
| `laforet` | 15 | 10 |
| `century` | 13 | 10 |
| `apimo` | 13 | 2 |
| `hektor` | 8 | 3 |
| `guy`, `citya`, `ladresse`, `iad`, `nestenn`, `megagence`, `dauchez`… | 1–7 chacun | |
| `agXXXXXX` (comptes directs Bien'ici) | ~70 au total | |

## Ce que ça change — une correction

J'ai recommandé plus tôt d'écrire des scrapers par CMS (Immo-Facile, Netty,
Apimo, Hektor) en avançant que « 6 scrapers couvrent des centaines d'agences ».

**Les données montrent que Bien'ici les agrège déjà tous.** Écrire un scraper
Immo-Facile récupérerait en grande partie les mêmes annonces que celles qui
arrivent déjà par Bien'ici. L'argument de couverture, tel que je l'ai formulé,
était faux.

L'argument qui tient encore est différent, et plus étroit : **l'avance
temporelle**. Une agence publie sur son propre site avant que le flux ne soit
syndiqué vers le portail. C'est exactement la promesse « 4 h avant SeLoger » de
la landing page. Mais c'est une hypothèse à mesurer, pas un acquis : il faut
comparer la date de publication d'une même annonce sur un site d'agence et sur
Bien'ici avant d'investir dans six adaptateurs.

**Protocole pour trancher** : prendre 20 annonces `netty-*` déjà en base,
retrouver le site de l'agence, relever la date de mise en ligne côté agence, et
comparer à `published_at`. Si l'écart médian est inférieur à quelques minutes,
les scrapers CMS ne valent pas leur coût de maintenance et il vaut mieux
augmenter la fréquence de polling de Bien'ici.

## État des sources sondées

| Site | API cachée | POST candidature | Verdict |
|---|---|---|---|
| **Bien'ici** | ✅ `realEstateAds.json` | ✅ `POST /api/contactRequests` | **retenu, implémenté** |
| Orpi | ❌ rendu serveur | non testé | parsing HTML requis |
| ParuVendu | ❌ rendu serveur | non testé | parsing HTML requis |
| Century 21 | 410 sur la liste | non testé | à re-sonder |
| Nexity, Figaro Immo | 404 sur les URL essayées | non testé | à re-sonder |
| LeBonCoin, SeLoger, PAP | ⛔ DataDome / Cloudflare | — | hors périmètre (pas de proxy) |

Le vivier « API JSON cachée **et** POST simple » est donc plus étroit qu'espéré.
Bien'ici est peut-être la meilleure source française sur ces deux critères à la
fois — et comme elle agrège les CMS, elle porte déjà l'essentiel du marché des
agences.
