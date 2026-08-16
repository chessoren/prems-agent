/**
 * Tab 4 - Profil / Mon dossier.
 *
 * Everything the onboarding collected, editable in place. The organising rule
 * is that changing something here has to have a visible consequence: editing a
 * criterion re-runs the matching on the spot rather than sending anyone back
 * through thirteen screens, and a document that has gone stale says so before
 * an agency has the chance to.
 *
 * Billing is the one thing deliberately not rebuilt. Stripe's portal already
 * holds the card, the invoices and the cancellation flow; reproducing it would
 * mean holding payment state we have no reason to hold, and doing it worse.
 */
import * as store from '../../lib/prems/store.js';
import * as agent from '../../lib/prems/agent.js';
import { PLANS, portalUrl, checkoutUrl, startCheckout } from '../../lib/prems/billing.js';
import * as mailbox from '../../lib/prems/mailbox.js';
import * as billing from '../../lib/prems/billing.js';
import {
  h,
  appIcon,
  button,
  field,
  input,
  accordion,
  sectionTitle,
  toast,
} from './ui.js';

const PROPERTY_TYPES = [
  { value: 'studio', label: 'Studio' },
  { value: 'appartement', label: 'Appartement' },
  { value: 'maison', label: 'Maison' },
  { value: 'colocation', label: 'Colocation' },
  { value: 'indifferent', label: 'Peu importe' },
];

const euros = (value) => `${Math.round(value).toLocaleString('fr-FR')} €`;

/** +33612345678 -> 06 12 34 56 78, the way it was typed on screen 5. */
const readablePhone = (phone) =>
  phone ? `0${phone.replace('+33', '')}`.replace(/(\d{2})(?=\d)/g, '$1 ').trim() : '';

/* -------------------------------------------------------------------------
 * 1. Criteria
 * ------------------------------------------------------------------------- */
function criteriaSection(ctx) {
  const draft = store.get();

  const city = input({ value: draft.city || '', placeholder: 'Ville', 'aria-label': 'Ville' });
  const budget = input({
    type: 'number',
    inputmode: 'numeric',
    min: '200',
    step: '50',
    value: String(draft.budget || 1000),
    'aria-label': 'Budget maximum en euros',
  });
  const rooms = input({
    type: 'number',
    inputmode: 'numeric',
    min: '1',
    max: '6',
    value: String(draft.rooms || 2),
    'aria-label': 'Nombre de pièces',
  });
  const moveIn = input({
    type: 'date',
    value: draft.moveInDate || '',
    'aria-label': 'Date d’emménagement souhaitée',
  });

  const type = h(
    'select',
    { class: 'ob-input pm-select', 'aria-label': 'Type de bien' },
    PROPERTY_TYPES.map((item) =>
      h(
        'option',
        { value: item.value, selected: (draft.propertyType || 'indifferent') === item.value },
        item.label,
      ),
    ),
  );

  const save = button('Enregistrer et relancer la recherche', { variant: 'accent' });

  save.addEventListener('click', async () => {
    store.set({
      city: city.value.trim() || draft.city,
      budget: Number(budget.value) || draft.budget,
      rooms: Number(rooms.value) || draft.rooms,
      propertyType: type.value,
      moveInDate: moveIn.value || null,
      moveInAsap: !moveIn.value,
    });

    // The draft is the source of truth for the matcher, so the catalogue has to
    // be re-queried before the feed can mean anything.
    agent.invalidate();
    await agent.load();
    store.sync().catch(() => {});

    toast('Critères mis à jour. La recherche repart avec les nouveaux.');
    ctx.refresh();
  });

  return h(
    'div',
    { class: 'pm-form' },
    field({ label: 'Ville', input: city }),
    h(
      'div',
      { class: 'ob-field__row' },
      field({ label: 'Budget maximum (€/mois)', input: budget }),
      field({ label: 'Pièces', input: rooms }),
    ),
    field({ label: 'Type de bien', input: type }),
    field({
      label: 'Emménagement souhaité',
      input: moveIn,
      hint: 'Laisse vide si tu peux emménager tout de suite.',
    }),
    save,
  );
}

/* -------------------------------------------------------------------------
 * 2. The rental file
 *
 * A proof of address older than three months is refused by most agencies, and
 * finding that out on the day the file is submitted is the expensive way to
 * learn it. The badge is therefore computed, not stored.
 * ------------------------------------------------------------------------- */
const MONTH = 30 * 86_400_000;

function docRow({ label, detail, ok, stale }) {
  return h(
    'div',
    { class: 'pm-doc' },
    h('span', { class: 'pm-doc__icon' }, appIcon('file', 17)),
    h(
      'span',
      { class: 'pm-doc__text' },
      h('span', { class: 'pm-doc__label' }, label),
      h('span', { class: 'pm-doc__detail' }, detail),
    ),
    h(
      'span',
      { class: `pm-doc__badge pm-doc__badge--${ok && !stale ? 'ok' : stale ? 'warn' : 'todo'}` },
      ok && !stale ? '✅ conforme' : stale ? 'à mettre à jour' : 'manquant',
    ),
  );
}

function dossierSection() {
  const draft = store.get();
  const uploadedAt = draft.completedAt ? new Date(draft.completedAt).getTime() : null;
  const addressStale = Boolean(uploadedAt && Date.now() - uploadedAt > 3 * MONTH);

  const rows = [
    {
      label: 'Pièce d’identité',
      detail: draft.idType
        ? `${draft.idType === 'cni' ? 'Carte nationale d’identité' : draft.idType === 'passeport' ? 'Passeport' : 'Titre de séjour'}${
            draft.idNumber ? ` · ${draft.idNumber}` : ''
          }`
        : 'Aucun document enregistré',
      ok: Boolean(draft.idType),
      stale: false,
    },
    {
      label: 'Justificatifs de revenus',
      detail: draft.incomeCents
        ? `${euros(draft.incomeCents / 100)} nets par mois · ${draft.employment || 'situation renseignée'}`
        : 'Revenus non renseignés',
      ok: Boolean(draft.incomeCents),
      stale: false,
    },
    {
      label: 'Justificatif de domicile',
      detail: draft.addressProofName
        ? `${draft.addressProofName}${uploadedAt ? ` · déposé ${agent.ago(uploadedAt)}` : ''}`
        : 'Aucun document enregistré',
      ok: Boolean(draft.addressProofName),
      stale: addressStale,
    },
    {
      label: 'Garant',
      detail: draft.needsGuarantor
        ? `${draft.guarantorName || 'Garant renseigné'}${
            draft.guarantorIncomeCents ? ` · ${euros(draft.guarantorIncomeCents / 100)} nets` : ''
          }`
        : 'Pas de garant — ton dossier tient sans',
      ok: draft.needsGuarantor ? Boolean(draft.guarantorName) : true,
      stale: false,
    },
  ];

  return h(
    'div',
    {},
    h('div', { class: 'pm-docs' }, rows.map(docRow)),
    addressStale
      ? h(
          'p',
          { class: 'pm-warn' },
          'Ton justificatif de domicile a plus de trois mois. La plupart des agences le ' +
            'refuseront — remplace-le avant la prochaine candidature.',
        )
      : null,
    h(
      'a',
      { class: 'ob-btn ob-btn--light', href: '/onboarding#identity' },
      h('span', { class: 'ob-btn__inner' }, 'Mettre à jour mes pièces'),
    ),
  );
}

/* -------------------------------------------------------------------------
 * 3. Solvency
 *
 * Stated as a multiple of the rent someone is actually looking at, not as an
 * abstract score: "3,2 fois le loyer moyen de tes recherches" is a number the
 * person can check against the flats in their own feed.
 * ------------------------------------------------------------------------- */
function solvencySection(model) {
  const draft = store.get();
  const income = draft.incomeCents ? draft.incomeCents / 100 : 0;
  const guarantor = draft.guarantorIncomeCents ? draft.guarantorIncomeCents / 100 : 0;

  const rents = model.matches.map((m) => m.listing.rent_eur);
  const averageRent = rents.length
    ? Math.round(rents.reduce((a, b) => a + b, 0) / rents.length)
    : draft.budget || 0;

  if (!income || !averageRent) {
    return h(
      'p',
      { class: 'pm-solvency__none' },
      'Renseigne tes revenus pour voir comment ton dossier se situe face aux loyers que tu vises.',
    );
  }

  const ratio = income / averageRent;
  const withGuarantor = (income + guarantor) / averageRent;
  const strong = ratio >= 3;
  const percent = Math.max(6, Math.min(100, (ratio / 4) * 100));

  return h(
    'div',
    { class: 'pm-solvency' },
    h(
      'p',
      { class: 'pm-solvency__headline' },
      h('span', { class: 'pm-solvency__ratio' }, ratio.toFixed(1).replace('.', ',')),
      h('span', {}, `fois le loyer moyen de tes recherches (${euros(averageRent)})`),
    ),
    h(
      'div',
      { class: 'pm-solvency__bar' },
      h('span', {
        class: `pm-solvency__fill${strong ? ' is-strong' : ''}`,
        style: { width: `${percent}%` },
      }),
      h('span', { class: 'pm-solvency__mark', style: { left: '75%' } }),
    ),
    h('p', { class: 'pm-solvency__scale' }, 'Le seuil habituel des agences est de 3 fois le loyer.'),
    strong
      ? h(
          'p',
          { class: 'pm-solvency__verdict pm-solvency__verdict--ok' },
          'Ton dossier passe le seuil sans garant. L’agent le présente tel quel.',
        )
      : h(
          'div',
          { class: 'pm-solvency__verdict pm-solvency__verdict--warn' },
          h(
            'p',
            {},
            guarantor
              ? `Avec ton garant, tu montes à ${withGuarantor
                  .toFixed(1)
                  .replace('.', ',')} fois le loyer — au-dessus du seuil.`
              : 'Tu es juste sous le seuil habituel. Ajouter un garant est ce qui change le ' +
                'plus tes chances, bien avant de baisser ton budget.',
          ),
          guarantor
            ? null
            : h(
                'a',
                { class: 'ob-btn ob-btn--light', href: '/onboarding#guarantor' },
                h('span', { class: 'ob-btn__inner' }, 'Ajouter un garant'),
              ),
        ),
  );
}

/* -------------------------------------------------------------------------
 * 4. Notifications
 * ------------------------------------------------------------------------- */
const FREQUENCIES = [
  { value: 'instant', label: 'À chaque match', hint: 'Recommandé — la vitesse est tout' },
  { value: 'daily', label: 'Un résumé par jour', hint: 'À 19 h' },
  { value: 'action', label: 'Seulement si une action est requise', hint: 'Créneau à choisir' },
];

function toggle(label, hint, checked, onChange) {
  const box = h('input', { type: 'checkbox', class: 'pm-switch__input', checked });
  box.addEventListener('change', () => onChange(box.checked));

  return h(
    'label',
    { class: 'pm-switch' },
    h(
      'span',
      { class: 'pm-switch__text' },
      h('span', { class: 'pm-switch__label' }, label),
      hint ? h('span', { class: 'pm-switch__hint' }, hint) : null,
    ),
    box,
    h('span', { class: 'pm-switch__track', 'aria-hidden': 'true' }),
  );
}

function notificationsSection() {
  const prefs = agent.get().notifications;
  const update = (patch) =>
    agent.set({ notifications: { ...agent.get().notifications, ...patch } });

  return h(
    'div',
    { class: 'pm-prefs' },
    toggle('Notifications push', 'Le canal le plus rapide', prefs.push, async (on) => {
      update({ push: on });
      if (on && 'Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
    }),
    toggle('SMS', 'Pour les créneaux à confirmer', prefs.sms, (on) => update({ sms: on })),
    toggle('E-mail', 'Le récapitulatif et les factures', prefs.email, (on) => update({ email: on })),
    h('p', { class: 'pm-prefs__label' }, 'Fréquence'),
    h(
      'div',
      { class: 'ob-options' },
      FREQUENCIES.map((item) => {
        const selected = prefs.frequency === item.value;
        const card = h(
          'button',
          {
            class: 'ob-option',
            type: 'button',
            'data-selected': String(selected),
            'aria-pressed': String(selected),
            onClick: () => {
              update({ frequency: item.value });
              for (const other of card.parentElement.children) {
                other.dataset.selected = String(other === card);
                other.setAttribute('aria-pressed', String(other === card));
              }
            },
          },
          h(
            'span',
            { class: 'ob-option__text' },
            h('span', { class: 'ob-option__label' }, item.label),
            h('span', { class: 'ob-option__hint' }, item.hint),
          ),
          h('span', { class: 'ob-option__check', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' }),
        );
        return card;
      }),
    ),
  );
}

/* -------------------------------------------------------------------------
 * 5. Subscription
 * ------------------------------------------------------------------------- */
/**
 * What this person is entitled to, according to the database.
 *
 * It used to read `agent.get().plan` - a localStorage value written by the
 * `?checkout=` parameter on the Stripe redirect, which anyone could set by
 * typing the URL and which a real payer lost the moment they cleared their
 * browser. The row written by the Stripe webhook is the only thing that can
 * prove a payment, so it is the only thing this reads.
 */
function subscriptionSection() {
  const wrap = h('div', { class: 'pm-sub-wrap' });
  wrap.replaceChildren(h('p', { class: 'pm-sub__pending' }, 'Vérification de ton abonnement…'));

  billing
    .current()
    .then((subscription) => wrap.replaceChildren(subscriptionBody(subscription)))
    .catch(() => wrap.replaceChildren(subscriptionBody({ isActive: false, plan: null })));

  return wrap;
}

function subscriptionBody(subscription) {
  const draft = store.get();
  const plan = subscription.isActive && subscription.plan ? PLANS[subscription.plan] : null;
  const portal = portalUrl();

  const manage = portal
    ? h(
        'a',
        { class: 'ob-btn ob-btn--light', href: portal, target: '_blank', rel: 'noopener' },
        h('span', { class: 'ob-btn__inner' }, appIcon('card', 17), 'Gérer ma facturation'),
      )
    : h(
        'p',
        { class: 'pm-sub__pending' },
        'Le portail de facturation Stripe s’ouvrira ici dès qu’il sera activé sur le compte. ' +
          'En attendant, écris-nous et on s’en occupe le jour même.',
      );

  if (!plan) {
    return h(
      'div',
      { class: 'pm-sub' },
      h('p', { class: 'pm-sub__status pm-sub__status--none' }, 'Aucune formule active'),
      h(
        'p',
        { class: 'pm-sub__text' },
        'Ton agent tourne en découverte. Les offres sont les mêmes que celles vues à ' +
          'l’inscription — et l’offre fondateur reste disponible tant qu’il reste des places.',
      ),
      h(
        'a',
        {
          class: 'ob-btn ob-btn--accent',
          href: checkoutUrl('fondateur') || '/pricing',
          onClick: (event) => startCheckout('fondateur', event),
        },
        h('span', { class: 'ob-btn__inner' }, 'Offre fondateur — 100 € à vie'),
      ),
      h(
        'a',
        {
          class: 'ob-btn ob-btn--light',
          href: checkoutUrl('soldat') || '/pricing',
          onClick: (event) => startCheckout('soldat', event),
        },
        h('span', { class: 'ob-btn__inner' }, 'Le Soldat — 29 € / semaine'),
      ),
    );
  }

  return h(
    'div',
    { class: 'pm-sub' },
    h('p', { class: 'pm-sub__status' }, `${plan.name} · actif`),
    h(
      'p',
      { class: 'pm-sub__text' },
      plan.id === 'fondateur'
        ? 'Paiement unique encaissé. Ton accès court jusqu’à la signature de ton bail — il n’y ' +
          'a rien à renouveler et rien à résilier.'
        : `${plan.price} ${plan.period}. Sans engagement : tu arrêtes dès que tu as signé.`,
    ),
    state.planSince
      ? h(
          'p',
          { class: 'pm-sub__since' },
          `Depuis le ${new Date(state.planSince).toLocaleDateString('fr-FR', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}`,
        )
      : null,
    manage,
  );
}

/* -------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */

/**
 * The mailbox, which is what turns the agent on.
 *
 * Prems writes to agencies from the client's own address and reads the answers
 * there. Until this is connected the pipeline detects and matches but sends
 * nothing - by design, and the copy says so plainly rather than letting someone
 * believe applications are going out.
 */
function mailboxSection(ctx) {
  const wrap = h('div', { class: 'pm-card' });

  const render = (state) => {
    const connected = state.gmail;

    const action = h(
      'button',
      {
        class: `ob-btn ${connected ? 'ob-btn--light' : 'ob-btn--accent'}`,
        type: 'button',
        onClick: async () => {
          action.disabled = true;
          action.replaceChildren(h('span', { class: 'ob-btn__inner' }, 'Ouverture de Google…'));
          try {
            await mailbox.connect('gmail');
            action.replaceChildren(
              h('span', { class: 'ob-btn__inner' }, 'En attente de ton autorisation…'),
            );
            const ok = await mailbox.waitForConnection('gmail');
            if (ok) {
              ctx.toast('Boîte connectée. Ton agent peut candidater.');
              // The calendar rides along: a confirmed visit has to land
              // somewhere, and asking twice a week later is asking twice.
              mailbox.connect('googlecalendar')
                .then(() => mailbox.waitForConnection('googlecalendar'))
                .catch(() => {});
              render(await mailbox.status());
              ctx.refresh();
              return;
            }
            ctx.toast('Autorisation non terminée. Tu peux réessayer.');
          } catch {
            ctx.toast('Connexion impossible pour l’instant.');
          }
          action.disabled = false;
          render(state);
        },
      },
      h('span', { class: 'ob-btn__inner' }, connected ? 'Reconnecter ma boîte' : 'Connecter ma boîte mail'),
    );

    wrap.replaceChildren(
      h('h2', { class: 'pm-card__title' }, 'Boîte mail'),
      h(
        'p',
        { class: 'pm-card__hint' },
        connected
          ? 'Connectée. Les candidatures partent de ton adresse et les réponses des agences arrivent chez toi — c’est là que l’agent les lit.'
          : 'Tant que ta boîte n’est pas connectée, l’agent trouve les appartements mais n’envoie rien. Les candidatures partent de ton adresse, jamais de la nôtre.',
      ),
      action,
    );
  };

  render({ gmail: false, calendar: false });
  mailbox.status().then(render).catch(() => {});
  return wrap;
}

export default function renderProfile(ctx) {
  const draft = store.get();
  const model = ctx.model;
  const name = [draft.firstName, draft.lastName].filter(Boolean).join(' ');

  const uploadedAt = draft.completedAt ? new Date(draft.completedAt).getTime() : null;
  const addressStale = Boolean(uploadedAt && Date.now() - uploadedAt > 3 * MONTH);

  return h(
    'div',
    { class: 'pm-page' },
    h(
      'section',
      { class: 'pm-identity' },
      h('span', { class: 'pm-identity__avatar' }, (name || 'P').slice(0, 1).toUpperCase()),
      h(
        'div',
        {},
        h('p', { class: 'pm-identity__name' }, name || 'Ton dossier'),
        h(
          'p',
          { class: 'pm-identity__sub' },
          draft.phone ? readablePhone(draft.phone) : 'Compte Prems',
        ),
      ),
    ),

    sectionTitle('Mon dossier'),

    accordion([
      {
        icon: 'radar',
        label: 'Mes critères',
        hint: draft.city
          ? `${draft.city} · ${euros(draft.budget)} · ${draft.rooms || '—'} pièces`
          : 'Non renseignés',
        open: true,
        body: () => criteriaSection(ctx),
      },
      {
        icon: 'file',
        label: 'Mon dossier locatif',
        hint: addressStale ? 'Une pièce à mettre à jour' : 'Pièces conformes au décret Alur',
        flag: addressStale ? h('span', { class: 'pm-acc__flag' }, '1') : null,
        body: () => dossierSection(),
      },
      {
        icon: 'sparkle',
        label: 'Score de solvabilité',
        hint: 'Ton profil face aux loyers que tu vises',
        body: () => solvencySection(model),
      },
      {
        icon: 'chat',
        label: 'Boîte mail',
        hint: 'Ce qui autorise l’agent à candidater pour toi',
        body: () => mailboxSection(ctx),
      },
      {
        icon: 'bell',
        label: 'Notifications',
        hint: 'Canaux et fréquence',
        body: () => notificationsSection(),
      },
      {
        icon: 'card',
        label: 'Abonnement',
        hint: 'Formule et facturation',
        body: () => subscriptionSection(),
      },
    ]),

    h(
      'p',
      { class: 'pm-foot-note' },
      'Tes documents sont chiffrés, dans un espace privé auquel toi seul as accès, et ' +
        'supprimés automatiquement au bout de 90 jours.',
    ),
  );
}
