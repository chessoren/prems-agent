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

---

# Joignabilité : les trois voies testées, et leurs plafonds

La joignabilité — pouvoir écrire à l'agence — est le plafond du produit. Détecter
une annonce sans pouvoir y candidater ne vaut rien. Trois voies ont été testées
en conditions réelles. Aucune ne débloque la majorité du catalogue.

## 1. Le formulaire du portail — **fermé**

`POST /api/contactRequests` sur Bien'ici : **401 sans compte connecté**.

Piège de méthode à retenir : une charge vide reçoit un **400** nommant les champs
manquants, ce qui ressemble à un endpoint ouvert. C'est une erreur de *schéma* —
la validation de forme s'exécute avant le contrôle d'identité. **Un 400 ne prouve
jamais l'absence d'authentification.** La vérification correcte est de rendre la
charge structurellement valide et de regarder ce qui répond ensuite.

## 2. Les formulaires des sites d'agence — **fermés par captcha**

Les CMS identifiés dans le corpus Bien'ici : Immo-Facile (101 annonces),
Century 21 (73), Hektor/la-boite-immo (52), Laforêt (49), Netty (49),
Apimo (37), l'Adresse (24), Citya (18).

Trois sites sondés (la-boite-immo, deux WordPress) : **le POST anonyme est
accepté — HTTP 200 — mais les trois portent un reCAPTCHA**. La structure des
champs est connue (`data[Contact][email]`, `data[Contact][message]`… en
CakePHP), donc ce n'est pas un problème de rétro-ingénierie : c'est le captcha.

## 3. L'e-mail de l'agence — **la seule voie ouverte, et elle plafonne**

C'est le canal retenu, et il satisfait seul les trois besoins : aucun compte
portail, envoi depuis la boîte du client, réponse qui revient dans cette boîte.

| Étape | Joignabilité |
|---|---|
| E-mails fuités dans le payload Bien'ici | 10,2 % |
| + résolution depuis le site de l'agence (`agencyFeeUrl`) | **15,7 %** |
| Plafond estimé de cette approche | ~25 % |

**Pourquoi ça plafonne :** 199 agences sur 317 n'exposent aucun domaine
exploitable. Bien'ici publie un téléphone et retient l'adresse — le formulaire
derrière un compte *est* son produit.

### L'annuaire officiel des entreprises — **testé, ne résout pas le contact**

`recherche-entreprises.api.gouv.fr` (gratuit, sans clé) retrouve bien l'agence
par sa raison sociale, avec le bon code NAF (68.31Z) et le bon code postal. Mais
**il n'expose ni site web ni e-mail**. Utile pour identifier ou dédoublonner une
agence ; inutile pour la contacter.

Deviner un domaine depuis la raison sociale a été écarté : envoyer la candidature
d'un client à un domaine deviné est exactement la classe d'erreur que les filtres
du résolveur existent pour empêcher.

## La décision qui reste

Trois options, et c'est un arbitrage produit, pas technique :

1. **D'autres sources** qui publient l'adresse — le vivier « API cachée + envoi
   simple » est étroit, voir le tableau plus haut.
2. **Accepter un compte Bien'ici authentifié** — débloque 100 % de leur
   catalogue, au prix de l'envoi depuis la boîte du client, donc de la manière
   dont on intercepte les réponses.
3. **Une source d'adresses tierce payante** — les annuaires ouverts ne suffisent
   pas, mesuré ci-dessus.
