# Composants interactifs : ce qui marche, ce qui manque

Framer ne rend côté serveur que la variante **active** d'un composant à état, et
son runtime React fait plusieurs choses invisibles dans le markup. Ce fichier
liste ce que le clone restitue, et comment.

---

## Ce qui fonctionne

| Comportement | Comment c'est restitué |
|---|---|
| **Icônes** (355 références) | Voir « Icônes » ci-dessous — résolu à la génération, 0 cassée |
| **Animations d'apparition** | `src/scripts/appear.js`, rejouées depuis le JSON de Framer, déclenchées à l'entrée dans le viewport |
| **Carrousels défilants** (logos, témoignages) | `initTickers` dans `interactions.js` |
| **FAQ (accordéon)** | Réponses récupérées par `npm run clone:faq`, repliage dans `interactions.js` |
| **Menu mobile** | `initMobileNav` — les deux variantes sont dans le markup |
| **Liens d'ancrage** | `initAnchors` |
| `prefers-reduced-motion` | Respecté par les animations et les carrousels |
| Hover, focus, transitions CSS | Purement CSS, intacts (50 règles `:hover` conservées) |

### Icônes

Deux mécanismes se cumulaient, et cassaient **toutes** les icônes :

1. Framer range 35 patrons `<svg>` dans un `<div id="svg-templates">` en fin de
   `<body>` — **hors** du layout root que l'extracteur découpait. Les 308 `<use>`
   pointaient donc dans le vide.
2. Framer écrit `<use href="#3164290856">`, où le nombre est une **clé de cache**,
   pas un id d'élément. Au runtime, `shared-lib.mjs` enregistre le patron et
   réécrit la référence vers le vrai id interne (`#o4RpECsKY`).

`tools/lib/icons.mjs` reconstitue cette correspondance statiquement en appariant
chaque clé avec son patron dans le bundle. Résultat : les icônes s'affichent sans
aucun runtime.

### Animations

Elles fonctionnaient déjà, mais se déclenchaient **toutes au chargement** : le
temps d'arriver sur une section, tout avait fini de fondre et la page paraissait
figée. Elles jouent maintenant à l'entrée dans le viewport, comme chez Framer.

### Carrousels (bande logos, bande témoignages)

Deux causes distinctes, trouvées dans cet ordre :

1. **Invisibles.** Framer rend chaque bande dans un `<section>` portant
   `opacity: 0` **en inline**. Le contenu est complet — images, cartes, étoiles —
   mais c'est le runtime du composant qui bascule l'opacité à 1 après s'être
   mesuré. Sans runtime, la bande reste un rectangle vide.
   `tools/lib/tickers.mjs` corrige l'opacité à la génération, donc ça marche
   aussi sans JavaScript.
2. **Immobiles.** Le défilement lui-même vivait dans le runtime. `initTickers`
   duplique la rangée en **position absolue** (une copie dans le flux élargit la
   liste et décale toute la bande) et translate la liste.

Leçon utile : le markup exporté est **déjà correct**. Une première version du
shim redimensionnait la bande « pour aider » et l'effondrait.

> Ces deux bandes étaient vides **dans l'original hors ligne aussi**. C'est
> précisément pour ça que la comparaison avec la référence ne pouvait pas les
> signaler — voir « Le point aveugle » plus bas.

### FAQ

Les réponses des items repliés ne sont pas rendues côté serveur, et piloter
l'original hors ligne ne suffit pas : l'accordéon est lui-même un *code
component* dont le clic ne fonctionne pas sans le runtime Framer.

Elles sont en revanche compilées dans le chunk JS de la page, sous forme de props
de composant. `npm run clone:faq` les relit en repérant la clé de prop dont les
valeurs correspondent aux questions présentes dans le markup — plutôt que de
coder en dur un nom de prop haché, qui change à chaque publication.

La génération les réinjecte et annote chaque item avec ses deux variantes Framer
(classe `framer-v-*` + style inline du conteneur), pour que l'ouverture soit
visuellement identique à l'originale. Sans JavaScript, les items ouverts restent
ouverts et les réponses repliées sont simplement masquées.

## Ce qui manque encore

| Composant | État |
|---|---|
| **Tarifs — bascule Mensuel / Annuel** | Seule la variante *Mensuel* est rendue ; la variante *Annuel* n'existe que dans le bundle. |
| **Onglets « Workflows »** | Les libellés et le panneau actif sont présents ; les panneaux inactifs non. |
| **Hover piloté par variantes** | Les hovers CSS sont intacts. Ceux que Framer implémente comme changement de variante React (état JS, pas CSS) ne sont pas transposables depuis le markup. |

Pour les deux premiers, la même technique que la FAQ s'applique : le contenu est
dans les bundles (`.cache/vendor/scripts/`), et `tools/6-faq.mjs` sert de modèle —
il repère une clé de prop par correspondance avec le markup plutôt que par un nom
codé en dur.

## Ajouter un comportement

`src/scripts/interactions.js` est sans dépendance. Les blocs se repèrent par leur
nom Framer, conservé dans le markup :

```js
document.querySelectorAll('[data-framer-name="Question"]');
```

C'est pour ça que les attributs `data-framer-name` n'ont pas été supprimés à la
génération : ils constituent la table des matières du markup.

## Le point aveugle du test pixel

`npm run clone:verify` compare des captures **statiques**. Il ne voit donc pas :

- le hover et les interactions (aucun clic, aucun survol) ;
- une animation cassée — l'élément finit sur la même image finale dans les deux
  cas, donc l'écart reste nul.

Les défauts corrigés ici lui étaient tous invisibles, alors qu'il affichait
0,277 % d'écart moyen. Un écart faible prouve que la **mise en page** est
fidèle, rien de plus.

Pire : la référence est un rendu **hors ligne** de l'original, où le runtime
Framer ne s'exécute pas complètement. Tout ce que ce runtime produit — icônes,
opacité des carrousels — manque donc **des deux côtés**, et l'écart reste nul.
Sur ces points le clone est aujourd'hui *meilleur* que la référence, ce qui fait
légèrement monter l'écart mesuré (0,31 %). C'est attendu, pas une régression.
