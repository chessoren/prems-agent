/**
 * The offers, and how someone pays for one.
 *
 * A single source of truth shared by the end-of-onboarding pricing screen and
 * the subscription section of the app, so the two can never quote different
 * prices at the same person.
 *
 * Checkout runs on Stripe Payment Links rather than a Checkout Session created
 * server-side. That is a deliberate constraint of this codebase: the site is
 * static, and the only server we own (`prems-api` on Cloud Run) exists to hold
 * secrets for document reading. A payment link needs no secret key in the
 * browser and no endpoint of our own, and it is the same hosted Checkout page
 * either way - card, Apple Pay, Google Pay, Link, and 3-D Secure included.
 *
 * The URLs are live-mode links on the Prems Stripe account. They are public by
 * design - a payment link is meant to be handed out - so hardcoding them here
 * leaks nothing. The env overrides exist so a fork or a sandbox can point the
 * same UI at its own account without touching this file.
 */

const env = (name, fallback) => import.meta.env?.[name] || fallback;

/**
 * The two offers shown at the end of the flow.
 *
 * `soldat` is the standard subscription, copied word for word from the pricing
 * section of the landing page - the price someone was shown before signing up
 * has to be the price they are asked for afterwards.
 *
 * `fondateur` is the early-adopter offer: one payment, no renewal, and it
 * carries the standard plan until the lease is signed. It replaces the two
 * upper tiers on this screen rather than sitting beside them, because the
 * moment right after a completed file is not the moment to compare four
 * columns - it is the moment to take the obvious deal.
 */
export const PLANS = {
  soldat: {
    id: 'soldat',
    name: 'Le Soldat',
    price: '29€',
    period: '/par semaine',
    tagline: 'La solution complète pour trouver vite.',
    note: 'Sans engagement — arrête dès que tu as signé.',
    features: [
      '1 zone de recherche',
      'Candidatures IA automatiques',
      'Envoi du dossier locatif',
      'Détection agences (standard)',
    ],
    cta: 'Envoyer mon soldat',
    url: env('PUBLIC_STRIPE_LINK_SOLDAT', 'https://buy.stripe.com/4gM00k5FSaku5qddno48004'),
  },

  fondateur: {
    id: 'fondateur',
    name: 'Offre Fondateur',
    price: '100€',
    period: 'une seule fois',
    eyebrow: 'Réservé aux 100 premiers inscrits',
    tagline: 'Tout ce qu’il y a dans Le Soldat, jusqu’à la signature de ton bail.',
    note: 'Paiement unique. Aucun abonnement, aucun prélèvement automatique.',
    features: [
      'Accès à l’offre standard, sans limite de durée',
      'Valable jusqu’à la signature de ton bail',
      'Candidatures IA automatiques',
      'Envoi du dossier locatif',
      'Détection agences (standard)',
    ],
    cta: 'Devenir fondateur — 100 €',
    url: env('PUBLIC_STRIPE_LINK_FONDATEUR', 'https://buy.stripe.com/8x26oIc4geAK9Gtabc48003'),
  },

  /* Kept for the landing page's three-column grid; not shown at the end of the
   * onboarding, where the choice is deliberately narrowed to two. */
  commando: {
    id: 'commando',
    name: 'Le Commando',
    price: '99€',
    period: '/par semaine',
    tagline: 'Pour ceux qui cherchent sur la durée ou zones multiples.',
    features: [
      'Tout ce qu’il y a dans Soldat',
      '3 zones de recherche simultanées',
      'Vitesse prioritaire (Turbo)',
      'Accès aux biens off-market',
    ],
    cta: 'Envoyer mon Commando',
    url: env('PUBLIC_STRIPE_LINK_COMMANDO', 'https://buy.stripe.com/14AbJ29W83W67yl6Z048005'),
  },

  investisseur: {
    id: 'investisseur',
    name: 'L’Investisseur',
    price: '149€',
    period: '/par semaine',
    tagline: 'Pour les recherches multiples et les profils investisseurs.',
    features: [
      'Tout ce qu’il y a dans le Commando',
      'Zones illimitées',
      'Multi-comptes locataires (couples, colocs)',
      'Analyse de rentabilité par l’IA',
      'Rapport de visite pré-rempli',
    ],
    cta: 'Envoyer mon investisseur',
    url: env('PUBLIC_STRIPE_LINK_INVESTISSEUR', 'https://buy.stripe.com/8x27sM1pC8cmf0N4QS48006'),
  },
};

/**
 * Stripe's hosted billing portal.
 *
 * Rebuilding an invoice history and a card-update form would mean holding card
 * state we have no reason to hold. The portal's login page is enabled from the
 * Stripe dashboard and needs no session created by us: the customer enters the
 * email they paid with and Stripe emails them a link.
 *
 * Empty until that page is switched on, and the UI says so rather than
 * offering a link that lands on an error.
 */
export const portalUrl = () => env('PUBLIC_STRIPE_PORTAL_URL', '');

/**
 * Send someone to Checkout.
 *
 * `client_reference_id` is what lets a completed payment be tied back to the
 * account that made it: Stripe echoes it on the checkout session and on the
 * webhook, so the plan can be applied to the right user without asking them to
 * type an email that matches. Prefilling the email skips a field they have
 * already given us.
 */
export function checkoutUrl(planId, { reference, email } = {}) {
  const plan = PLANS[planId];
  if (!plan?.url) return null;

  const url = new URL(plan.url);
  if (reference) url.searchParams.set('client_reference_id', reference);
  if (email) url.searchParams.set('prefilled_email', email);
  return url.toString();
}
