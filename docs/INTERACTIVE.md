# Composants interactifs : ce qui marche, ce qui manque

Framer ne rend côté serveur que la variante **active** d'un composant à état.
Les variantes alternes n'existent que dans le bundle React. Un export statique
récupère donc le design complet, mais pas toujours la totalité des états.

Ce fichier liste précisément ce que ça implique ici — c'est la seule partie du
clone qui demande du travail à la main.

---

## Ce qui fonctionne dans le clone

| Comportement | Statut | Où |
|---|---|---|
| Animations d'apparition (fade / scale / slide) | ✅ rejouées à l'identique | `src/scripts/appear.js` |
| Respect de `prefers-reduced-motion` | ✅ | `appear.js` |
| Menu mobile (ouverture / fermeture) | ✅ les deux variantes sont rendues | `interactions.js` |
| Liens d'ancrage internes | ✅ | `interactions.js` |
| Navigation entre pages | ✅ pages statiques normales | — |
| Responsive 3 breakpoints | ✅ conservé tel quel | CSS |
| Hover, focus, transitions CSS | ✅ purement CSS, intacts | CSS |

## Ce qui manque

### 1. Les carrousels « Ticker » (témoignages, logos clients) — **non résolu**

C'est la seule différence visible entre le clone et l'original.

`Ticker` est un *code component* Framer : le markup de la liste est bien rendu
côté serveur, mais sa largeur, sa hauteur et la duplication des éléments sont
calculées en JavaScript au runtime. Sans ce runtime, le conteneur s'effondre à
0 × 0 et la bande apparaît vide.

- **Pages touchées** : `/contact`, `/pricing` (bande témoignages).
  L'accueil n'est pas affecté de manière visible.
- **Impact mesuré** : c'est ce qui explique les 5 vues au-dessus de 1 % dans
  `npm run clone:verify` (max 2,4 %). Les 28 autres vues sont à ~0 %.
- **Un shim est présent** dans `interactions.js` (`initTickers`) : il remet la
  bande à sa largeur naturelle, duplique les éléments et les anime en CSS. Il
  **ne suffit pas** en l'état — la bande reste vide sur `/contact`. Il est
  conservé comme point de départ, pas comme solution.
- **Correctif conseillé** : le contenu des cartes est présent dans le HTML.
  Le plus simple est de remplacer le ticker par une grille ou un carrousel
  CSS classique (`display:flex` + `overflow-x:auto`, ou `@keyframes` sur une
  bande dupliquée) dans le composant concerné. C'est ~20 lignes de CSS, et ça
  supprime définitivement la dépendance au runtime Framer.

### 2. Les états non rendus côté serveur

| Composant | Ce qui est dans le HTML | Ce qui manque |
|---|---|---|
| FAQ (accordéon) | les 20 questions ; **2 réponses** (les items ouverts) | les 18 autres réponses |
| Tarifs (bascule Mensuel / Annuel) | la variante **Mensuel** | la variante Annuel |
| Onglets « Workflows » | les libellés des onglets, panneau actif | les panneaux inactifs |

Ces contenus ne sont récupérables ni depuis le HTML ni depuis un rendu
headless : ils vivent dans les données du bundle. Deux options :

1. **Les ressaisir** dans les composants concernés (c'est du texte, une fois).
   Les réponses sont visibles sur le site publié — il suffit de les recopier
   dans `src/components/home/*.astro`, puis de câbler l'ouverture/fermeture
   comme le menu mobile dans `interactions.js`.
2. **Les extraire du bundle** : `.cache` conserve les chunks d'origine, et le
   contenu de la FAQ se trouve dans
   `public/assets/scripts/ZH9VkEhhA.*.mjs`. C'est faisable, mais lire une
   structure de données minifiée est plus long que retaper le texte.

> Une fois ces états écrits en dur, le site n'a plus aucune dépendance à
> Framer — et vous pouvez arrêter de régénérer.

## Ajouter un comportement

`src/scripts/interactions.js` est volontairement minuscule et sans dépendance.
Les blocs se repèrent par leur nom Framer, conservé dans le markup :

```js
document.querySelectorAll('[data-framer-name="Question"]');
```

C'est la raison pour laquelle les attributs `data-framer-name` n'ont pas été
supprimés à la génération : ils constituent la table des matières du markup.
