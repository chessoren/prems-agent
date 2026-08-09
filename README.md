# prems-landing-page

Clone auto-hébergé et éditable de **https://prems.framer.ai**, régénérable à la demande.

Pas de React, pas de Framer Motion, pas de bundle compilé : des pages Astro
composées de sections nommées, du CSS formaté avec des tokens lisibles, et
~2 ko de JavaScript maison.

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # dist/ — fichiers statiques, hébergeables partout
```

---

## Pourquoi un clone brut ne marche pas

Aspirer un site Framer avec `wget`, HTTrack ou un des outils « Framer to HTML »
donne un résultat qui *s'affiche* mais qui est illisible :

- le rendu est piloté par un bundle React + Framer Motion (~500 ko) découpé en
  ~30 chunks aux noms hachés, qui s'importent mutuellement par URL absolue ;
- le CSS arrive en un seul bloc minifié de ~270 ko ;
- les couleurs sont des variables nommées d'après des UUID internes
  (`--token-cecc2f3f-8752-4259-a9bd-b3a8dc815498`) ;
- les assets pointent vers `framerusercontent.com`.

On peut le servir, mais on ne peut pas le modifier. C'est le « code spaghetti »
que vous décriviez.

## L'observation qui change tout

**Le HTML livré par Framer est déjà le rendu final.** Framer fait du SSR : le
document contient la totalité du markup, avec ses vraies classes CSS, et le
bundle React ne fait que l'*hydrater*. Le JavaScript n'est pas nécessaire pour
afficher la page — il ne sert qu'aux animations et à quelques interactions.

Deux détails rendent l'extraction propre possible :

1. **Framer étiquette tout.** Chaque bloc porte un `data-framer-name` qui est le
   nom que vous lui avez donné dans l'éditeur : `Section-Hero`, `Section-Pricing`,
   `Section-Workflows`… Ce sont des lignes de découpe naturelles, alignées sur
   votre design plutôt que sur des morceaux arbitraires de markup.
2. **Les animations sont déclaratives.** Elles sont décrites en JSON dans un
   `<script type="framer/appear">` (état initial, état final, durée, easing,
   courbe de Bézier, par breakpoint). Cette description suffit à les rejouer en
   CSS — les 500 ko de moteur d'animation ne sont qu'un moyen de la lire.

Le pipeline ne réécrit donc jamais le design. Il **renomme, reformate et
range** — c'est précisément ce qui garantit la fidélité au pixel.

## Le pipeline

Cinq étapes indépendantes, relançables (`npm run clone:*`) :

| Étape | Script | Rôle |
|---|---|---|
| 1 | `clone:snapshot` | Lit `sitemap.xml`, met en cache le HTML SSR des 11 routes. |
| 2 | `clone:assets` | Miroir local de tous les assets (images, polices, vidéos, bundles) avec **suivi récursif** : Framer découpe son JS en chunks qui ne se référencent qu'entre eux, donc on suit le graphe jusqu'à fermeture. 466 fichiers, 65 Mo. |
| 3 | `clone:reference` | **Le point clé** — voir ci-dessous. |
| 4 | `clone:generate` | Produit le site propre : pages, composants, CSS, tokens. |
| 5 | `clone:verify` | Diff pixel du clone contre la référence, 33 vues. |
| 6 | `clone:faq` | Relit dans les bundles les réponses de FAQ que Framer ne rend pas. |

### L'étape 3 : se donner une vérité terrain

Une fois tous les assets en local (bundles React compris), on **rejoue le site
original entièrement hors ligne** sur un serveur local, dans un vrai Chromium.
L'original tourne alors avec son React, ses polices et ses images — mais depuis
le disque.

Ça donne une référence stable, reproductible et sans réseau, contre laquelle
differ le clone. C'est ce qui transforme « ça a l'air bon » en une mesure.

Un détail a demandé un correctif : hors ligne, Framer applique l'état *initial*
des animations d'apparition (`opacity: 0.001`) puis ne termine jamais le
transfert vers Framer Motion — les éléments restent invisibles. La référence
force donc chaque élément à son état final, lu dans le même JSON, c'est-à-dire
exactement ce que voit un visiteur réel une fois les animations jouées.

## Ce que produit l'étape 4

```
src/
├── layouts/Base.astro          # <head>, styles globaux, runtime
├── pages/                      # 1 fichier par route
│   ├── index.astro
│   ├── pricing.astro
│   ├── contact.astro
│   ├── policy/…  blogs/…
├── components/
│   ├── home/                   # Hero, Pricing, Workflows, Integration…
│   ├── pricing/  contact/  …
├── styles/
│   ├── tokens.css              # la palette, renommée
│   ├── fonts.css               # @font-face auto-hébergés
│   ├── base.css                # resets
│   └── <page>.css              # styles de la page, élagués
└── scripts/
    ├── appear.js               # animations d'apparition (~1 ko)
    └── interactions.js         # nav mobile, ancres
public/assets/                  # images, polices, vidéos en local
```

Concrètement :

- **Tokens renommés.** `--token-cecc2f3f-…` devient `--color-surface`,
  `--color-accent`, `--color-ink`… Les 14 couleurs sont documentées dans
  `tokens.css`.
- **CSS élagué par page.** Chaque page ne garde que les règles dont les classes
  existent réellement dans son DOM : 261 ko → 212 ko sur l'accueil, 109 ko →
  80 ko sur les pages légales.
- **Composants nommés.** L'accueil est découpé en 14 composants qui portent vos
  noms Framer (`Hero.astro`, `Pricing.astro`, `Workflows.astro`…).
- **Zéro React.** Le bundle est remplacé par deux petits modules.

## Ce que le pipeline ne renomme pas, et pourquoi

Les classes restent des hachages Framer (`framer-1yj084j`). C'est délibéré :
elles constituent le contrat entre le markup et les ~200 ko de CSS. Les
renommer en masse est l'opération qui casse la fidélité au pixel, pour un gain
cosmétique. Les `data-framer-name` sont conservés dans le markup : ce sont eux
qui rendent le HTML lisible et permettent de se repérer.

De même, Framer rend **trois copies** de chaque bloc (une par breakpoint) et
masque les inactives en `display: none`. On la conserve : fusionner ces
variantes reviendrait à réécrire à la main tout le responsive.

## Le comportement, pas seulement l'apparence

Le diff pixel compare des captures statiques : il est aveugle au hover, aux
interactions, et une animation cassée finit sur la même image que la bonne. Cinq
défauts lui ont donc échappé — icônes, animations, carrousels, FAQ — et ont été
corrigés séparément.

- **Icônes** : Framer référence ses icônes par une *clé de cache* (`#3164290856`)
  que son runtime réécrit, et range les patrons SVG hors du layout root. Les deux
  sont résolus à la génération : 355 références, 0 cassée.
- **Animations** : rejouées depuis le JSON de Framer, déclenchées à l'entrée dans
  le viewport (les lancer toutes au chargement donne une page qui paraît figée).
- **FAQ** : les réponses repliées ne sont pas rendues côté serveur ; elles sont
  relues dans les bundles par `npm run clone:faq`, puis réinjectées.

Ce qui manque encore — bascule tarifaire Mensuel/Annuel, panneaux d'onglets
inactifs — est listé et chiffré dans
[`docs/INTERACTIVE.md`](docs/INTERACTIVE.md), avec la méthode pour le récupérer.

## Régénérer après une modif dans Framer

```bash
npm run clone:snapshot && npm run clone:assets
npm run clone:reference          # nouvelle vérité terrain
npm run clone:generate           # régénère src/
npm run build && npm run clone:verify
```

Tout `src/` est régénéré : à ce stade, faites vos modifications dans Framer,
ou basculez définitivement sur ce dépôt et arrêtez de régénérer.
