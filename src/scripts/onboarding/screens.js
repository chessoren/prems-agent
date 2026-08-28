/**
 * The thirteen screens.
 *
 * Each exports the same shape, so the controller in index.js stays dumb:
 *
 *   progress   percentage the bar moves to, or null to leave it alone
 *   back       whether the back control is offered
 *   full       true for screens that own the whole viewport (hook, celebration)
 *   build(ctx) returns { body, cta, hint, onNext }
 *
 * `onNext` returns the id of the next screen, which is how the conditional
 * guarantor branch is expressed without the controller knowing about it.
 */
import * as store from '../../lib/prems/store.js';
import * as geo from '../../lib/prems/geo.js';
import * as inventory from '../../lib/prems/listings.js';
import { upload, humanSize, validate } from '../../lib/prems/documents.js';
import { client, ensureSession, isConfigured } from '../../lib/prems/supabase.js';
import { scan as runScan, isAvailable as ocrAvailable } from '../../lib/prems/ocr.js';
import { PLANS, PAYMENTS_ENABLED, checkoutUrl, startCheckout } from '../../lib/prems/billing.js';
import * as mailbox from '../../lib/prems/mailbox.js';
import { track } from '../../lib/prems/analytics.js';
import {
  h,
  icon,
  ICONS,
  button,
  option,
  optionGroup,
  field,
  input,
  showError,
  shortcuts,
  note,
  euros,
  photoHue,
  withShortcutStatus,
  scanNote,
} from './ui.js';

/** True once Cloud Run is wired up; until then the shortcuts explain why not. */
const OCR_READY = ocrAvailable();
const OCR_PENDING_TITLE =
  "Le scan automatique arrive très bientôt — en attendant, la saisie manuelle juste au-dessus fait exactement le même travail.";

const SCAN_STATUS = {
  picking: 'Ouverture…',
  uploading: 'Envoi…',
  reading: 'Lecture…',
};

/**
 * Wire one camera shortcut.
 *
 * `apply` receives the fields and writes them into the inputs. It returns the
 * confirmation line, because only the screen knows which fields it managed to
 * fill - and saying "nom et date de naissance remplis" is what tells the person
 * exactly what to go and check.
 */
function scanShortcut({ kind, label, feedback, apply }) {
  return {
    icon: 'camera',
    label,
    disabled: !OCR_READY,
    title: OCR_READY ? '' : OCR_PENDING_TITLE,
    onClick: async (event) => {
      const button = event.currentTarget;
      feedback.clear();

      await withShortcutStatus(button, async (setLabel) => {
        const result = await runScan(kind, { onStatus: (step) => setLabel(SCAN_STATUS[step]) });

        if (result.cancelled) return;
        if (!result.ok) {
          feedback.show(result.error, 'error');
          return;
        }

        const filled = apply(result.fields);
        feedback.show(
          filled.length
            ? `${filled.join(', ')} — vérifie et corrige si besoin avant de valider.`
            : 'Document illisible. Saisis les champs à la main.',
          filled.length ? 'ok' : 'error',
        );
      });
    },
  };
}

/* =========================================================================
 * Screen 0 - the hook
 * ========================================================================= */

/** A stylised arrondissement mesh. Reacts to the pointer, needs no map vendor. */
function cityMap() {
  const cells = [];
  const cols = 5;
  const rows = 4;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Nudge each cell so the mesh reads as districts, not a spreadsheet.
      const jitterX = ((row * 7 + col * 13) % 5) - 2;
      const jitterY = ((row * 11 + col * 5) % 5) - 2;
      cells.push(
        h('rect', {
          class: 'ob-map__cell',
          x: 6 + col * 34 + jitterX,
          y: 6 + row * 34 + jitterY,
          width: 30,
          height: 30,
          rx: 7,
        }),
      );
    }
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ob-map');
  svg.setAttribute('viewBox', '0 0 180 150');
  svg.setAttribute('aria-hidden', 'true');

  // The hyperscript above builds HTML elements; re-create them in the SVG
  // namespace, which is the only way the browser will render them.
  for (const cell of cells) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const attr of cell.attributes) rect.setAttribute(attr.name, attr.value);
    svg.appendChild(rect);
  }

  const pin = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  pin.setAttribute('class', 'ob-map__pin');
  pin.innerHTML =
    '<circle cx="96" cy="70" r="13" fill="#ff7a00" opacity="0.22"/>' +
    '<circle cx="96" cy="70" r="6.5" fill="#ff7a00"/>' +
    '<circle cx="96" cy="70" r="2.4" fill="#fff"/>';
  svg.appendChild(pin);

  // Districts light up in a slow wander, and follow the pointer on desktop.
  const rects = [...svg.querySelectorAll('.ob-map__cell')];
  let timer = setInterval(() => {
    for (const r of rects) r.classList.remove('is-hot');
    const count = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      rects[Math.floor(Math.random() * rects.length)].classList.add('is-hot');
    }
  }, 1400);

  svg.addEventListener('pointermove', (event) => {
    const target = event.target;
    if (target instanceof SVGRectElement) target.classList.add('is-hot');
  });
  svg.addEventListener('ob:teardown', () => clearInterval(timer));

  return svg;
}

const hook = {
  hideHeader: true,
  hideFooter: true,
  bleed: true,
  progress: null,
  back: false,
  build(ctx) {
    const tiles = h(
      'div',
      { class: 'ob-hook__tiles' },
      Array.from({ length: 40 }, (_, i) =>
        h('div', {
          class: 'ob-hook__tile ob-art',
          style: {
            '--hue': String(photoHue(i * 3 + (i % 5))),
            animationDelay: `${(i % 6) * 0.5}s`,
          },
        }),
      ),
    );

    const cta = button('Trouve ton appart en 30 secondes', {
      arrow: true,
      onClick: () => ctx.go('city'),
    });

    return {
      body: h(
        'div',
        { class: 'ob-hook' },
        h('div', { class: 'ob-hook__bg' }, tiles, h('div', { class: 'ob-hook__scrim' })),
        h(
          'div',
          { class: 'ob-hook__content' },
          cityMap(),
          h(
            'h1',
            { class: 'ob-hook__title' },
            'Ton prochain appart est ',
            h('em', {}, 'déjà en ligne'),
            '.',
          ),
          h(
            'p',
            { class: 'ob-hook__sub' },
            'Quatre questions, aucun compte à créer. On te montre ce qui matche avant de te demander quoi que ce soit.',
          ),
          h('div', { class: 'ob-hook__cta' }, cta),
          h(
            'p',
            { class: 'ob-hook__trust' },
            icon('lock', 14),
            'Aucun document demandé à cette étape',
          ),
        ),
      ),
    };
  },
};

/* =========================================================================
 * Screen 1 - city
 * ========================================================================= */
const city = {
  progress: 15,
  back: true,
  eyebrow: 'Ta recherche',
  title: 'Tu cherches dans quelle ville ?',
  subtitle: 'Tape les premières lettres, on reconnaît toutes les communes françaises.',
  build(ctx) {
    const box = input({
      type: 'text',
      placeholder: 'Paris, Lyon, Bordeaux…',
      autocomplete: 'address-level2',
      inputmode: 'text',
      'aria-autocomplete': 'list',
      value: store.get().city || '',
    });

    const list = h('ul', { class: 'ob-autocomplete__list', hidden: true, role: 'listbox' });
    let results = [];
    let cursor = -1;
    let controller;

    const commit = (result) => {
      store.set({ city: result.name, citySlug: result.slug, postcode: result.postcode });
      box.value = result.name;
      list.hidden = true;
      ctx.setValid(true);
      // Choosing from the list is an unambiguous answer, so move on without
      // making the visitor also reach for the button.
      setTimeout(() => ctx.next(), 180);
    };

    const paint = () => {
      list.replaceChildren(
        ...results.map((result, index) =>
          h(
            'li',
            { role: 'option', 'aria-selected': String(index === cursor) },
            h(
              'button',
              {
                class: 'ob-autocomplete__item',
                type: 'button',
                'aria-selected': String(index === cursor),
                onClick: () => commit(result),
              },
              h('span', {
                class: 'ob-autocomplete__pin',
                html: ICONS.pin,
                style: { width: '16px', height: '16px', display: 'inline-flex' },
              }),
              h('span', {}, result.name),
              result.postcode ? h('span', { class: 'ob-autocomplete__meta' }, result.postcode) : null,
            ),
          ),
        ),
      );
      list.hidden = !results.length;
    };

    let debounce;
    box.addEventListener('input', () => {
      ctx.setValid(false);
      clearTimeout(debounce);
      controller?.abort();
      const term = box.value;
      if (term.trim().length < 2) {
        results = [];
        paint();
        return;
      }
      debounce = setTimeout(async () => {
        controller = new AbortController();
        results = await geo.search(term, { signal: controller.signal });
        cursor = -1;
        paint();
      }, 180);
    });

    box.addEventListener('keydown', (event) => {
      if (!results.length || list.hidden) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        cursor = (cursor + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        paint();
      } else if (event.key === 'Enter' && cursor >= 0) {
        event.preventDefault();
        commit(results[cursor]);
      } else if (event.key === 'Escape') {
        list.hidden = true;
      }
    });

    document.addEventListener('click', (event) => {
      if (!list.contains(event.target) && event.target !== box) list.hidden = true;
    });

    return {
      body: h(
        'div',
        {},
        h('div', { class: 'ob-autocomplete' }, field({ input: box }), list),
        note(
          'On surveille 350+ sites d’agences dans cette ville, en direct.',
          'shield',
        ),
      ),
      valid: Boolean(store.get().citySlug),
      focus: box,
      onNext() {
        if (!store.get().citySlug && box.value.trim().length > 1) {
          // Typed but never picked from the list: accept it rather than block.
          store.set({ city: box.value.trim(), citySlug: geo.slugify(box.value.trim()) });
        }
        return 'budget';
      },
    };
  },
};

/* =========================================================================
 * Screen 2 - budget
 * ========================================================================= */
const MIN_BUDGET = 400;
const MAX_BUDGET = 3000;

const budget = {
  progress: 21,
  back: true,
  eyebrow: 'Ta recherche',
  title: 'Quel est ton budget maximum ?',
  subtitle: 'Charges comprises. Tu pourras l’ajuster à tout moment.',
  build(ctx) {
    let value = store.get().budget || 1000;

    const amount = h('span', { class: 'ob-budget__value' }, String(value));
    const caption = h('p', { class: 'ob-budget__caption' });
    const fill = h('div', { class: 'ob-slider__fill' });
    const thumb = h('div', { class: 'ob-slider__thumb' });

    const range = h('input', {
      class: 'ob-slider__input',
      type: 'range',
      min: MIN_BUDGET,
      max: MAX_BUDGET,
      step: 25,
      value,
      'aria-label': 'Budget mensuel maximum en euros',
    });

    const slider = h(
      'div',
      { class: 'ob-slider' },
      h('div', { class: 'ob-slider__track' }, fill),
      range,
      thumb,
      h(
        'div',
        { class: 'ob-slider__scale' },
        h('span', {}, euros(MIN_BUDGET)),
        h('span', {}, `${euros(MAX_BUDGET)}+`),
      ),
    );

    /** Turn the number into something meaningful for the chosen city. */
    const RATE = { paris: 32, nice: 21, lyon: 17.5, bordeaux: 16.5, lille: 16, nantes: 15.5, montpellier: 15.5, marseille: 15, rennes: 15, strasbourg: 14.5, toulouse: 14.5 };
    const cityName = store.get().city || 'ta ville';

    const render = () => {
      const ratio = (value - MIN_BUDGET) / (MAX_BUDGET - MIN_BUDGET);
      amount.textContent = value.toLocaleString('fr-FR');
      fill.style.width = `${ratio * 100}%`;
      thumb.style.left = `${ratio * 100}%`;

      const rate = RATE[store.get().citySlug];
      caption.textContent = rate
        ? `Environ ${Math.round(value / rate)} m² à ${cityName}`
        : `À ${cityName}`;
    };

    range.addEventListener('input', () => {
      value = Number(range.value);
      store.set({ budget: value });
      render();
    });
    range.addEventListener('pointerdown', () => slider.classList.add('is-dragging'));
    for (const event of ['pointerup', 'pointercancel', 'blur']) {
      range.addEventListener(event, () => slider.classList.remove('is-dragging'));
    }

    const presets = h(
      'div',
      { class: 'ob-chips' },
      [700, 900, 1200, 1500, 2000].map((preset) =>
        h(
          'button',
          {
            class: 'ob-chip',
            type: 'button',
            'data-selected': String(preset === value),
            onClick: () => {
              value = preset;
              range.value = String(preset);
              store.set({ budget: preset });
              render();
              for (const chip of presets.querySelectorAll('.ob-chip')) {
                chip.dataset.selected = String(Number(chip.textContent.replace(/\D/g, '')) === preset);
              }
            },
          },
          euros(preset),
        ),
      ),
    );

    render();

    return {
      body: h(
        'div',
        {},
        h(
          'div',
          { class: 'ob-budget__amount' },
          amount,
          h('span', { class: 'ob-budget__unit' }, '€ / mois'),
        ),
        caption,
        slider,
        presets,
      ),
      valid: true,
      onNext: () => 'rooms',
    };
  },
};

/* =========================================================================
 * Screen 3 - property type / rooms  (max four options, per the brief)
 * ========================================================================= */
const ROOM_CHOICES = [
  { value: '1', rooms: 1, type: 'studio', label: 'Studio / T1', hint: 'Une pièce principale', emoji: '🛏️' },
  { value: '2', rooms: 2, type: 'appartement', label: 'T2', hint: 'Une chambre séparée', emoji: '🚪' },
  { value: '3', rooms: 3, type: 'appartement', label: 'T3', hint: 'Deux chambres', emoji: '🛋️' },
  { value: '4', rooms: 4, type: 'indifferent', label: 'T4 et plus', hint: 'Grand appartement ou maison', emoji: '🏡' },
];

const rooms = {
  progress: 27,
  back: true,
  eyebrow: 'Ta recherche',
  title: 'Il te faut combien de pièces ?',
  subtitle: 'Choisis au plus proche, on te montrera aussi les options voisines.',
  build(ctx) {
    const current = store.get().rooms ? String(store.get().rooms) : null;

    const grid = h(
      'div',
      { class: 'ob-options ob-options--pair' },
      ROOM_CHOICES.map((choice) =>
        option({
          value: choice.value,
          label: choice.label,
          hint: choice.hint,
          emoji: choice.emoji,
          tall: true,
          selected: current === choice.value,
        }),
      ),
    );

    optionGroup(grid, (value) => {
      const choice = ROOM_CHOICES.find((c) => c.value === value);
      store.set({ rooms: choice.rooms, propertyType: choice.type });
      ctx.setValid(true);
      setTimeout(() => ctx.next(), 200);
    });

    return {
      body: grid,
      valid: Boolean(current),
      onNext: () => 'date',
    };
  },
};

/* =========================================================================
 * Screen 4 - move-in date
 * ========================================================================= */
const moveIn = {
  progress: 33,
  back: true,
  eyebrow: 'Ta recherche',
  title: 'Tu emménages quand ?',
  subtitle: 'Une date approximative suffit.',
  build(ctx) {
    const today = new Date().toISOString().slice(0, 10);
    const picker = input({
      type: 'date',
      min: today,
      value: store.get().moveInDate || '',
      'aria-label': "Date d'emménagement souhaitée",
    });

    const asap = option({
      value: 'asap',
      label: 'Dès que possible',
      hint: 'On te prévient pour tout ce qui se libère',
      emoji: '⚡',
      selected: store.get().moveInAsap,
    });

    asap.addEventListener('click', () => {
      const on = asap.dataset.selected !== 'true';
      asap.dataset.selected = String(on);
      asap.setAttribute('aria-pressed', String(on));
      store.set({ moveInAsap: on, moveInDate: on ? null : store.get().moveInDate });
      if (on) {
        picker.value = '';
        ctx.setValid(true);
        setTimeout(() => ctx.next(), 200);
      } else {
        ctx.setValid(Boolean(picker.value));
      }
    });

    picker.addEventListener('change', () => {
      store.set({ moveInDate: picker.value || null, moveInAsap: false });
      asap.dataset.selected = 'false';
      asap.setAttribute('aria-pressed', 'false');
      ctx.setValid(Boolean(picker.value));
    });

    return {
      body: h(
        'div',
        {},
        field({ label: 'Date d’emménagement souhaitée', input: picker }),
        h('div', { class: 'ob-date__divider' }, 'ou'),
        asap,
      ),
      valid: Boolean(store.get().moveInDate || store.get().moveInAsap),
      onNext: () => 'aha',
    };
  },
};

/* =========================================================================
 * The aha moment
 * ========================================================================= */
const aha = {
  progress: 33,
  back: true,
  build(ctx) {
    const grid = h('div', { class: 'ob-grid' });
    const headline = h('h1', { class: 'ob__title' }, 'On cherche…');
    const sub = h('p', { class: 'ob__subtitle' });
    const count = h('div', { class: 'ob-aha__count' }, '…');

    const draft = store.get();

    (async () => {
      const result = await inventory.match({
        citySlug: draft.citySlug,
        budget: draft.budget,
        rooms: draft.rooms || 2,
        propertyType: draft.propertyType,
        moveInDate: draft.moveInAsap ? null : draft.moveInDate,
      });

      const found = result.listings.length;
      store.set({ matchCount: found });

      count.textContent = String(found);
      headline.textContent = found
        ? `appartements matchent tes critères`
        : 'Aucun résultat pour ces critères';

      // Say plainly which constraints had to be stretched. Overstating the
      // match is the fastest way to lose the trust this screen just earned.
      const parts = result.relaxations.map((r) => `${r.count} ${r.note}`);
      sub.textContent = parts.length
        ? `À ${draft.city}, dont ${parts.join(', ')}.`
        : `À ${draft.city}, tous dans ton budget et disponibles à ta date.`;

      grid.replaceChildren(
        ...result.listings.map((listing, index) =>
          h(
            'article',
            {
              class: 'ob-listing ob-listing--locked',
              style: { animationDelay: `${index * 55}ms`, '--hue': String(photoHue(listing.hue)) },
            },
            h('div', { class: 'ob-listing__photo' }, h('div', { class: 'ob-art ob-listing__art' })),
            h('div', { class: 'ob-listing__lock', html: ICONS.lock }),
            h(
              'div',
              { class: 'ob-listing__body' },
              h('div', { class: 'ob-listing__price' }, inventory.formatRent(listing.rent_eur)),
              h(
                'div',
                { class: 'ob-listing__meta' },
                `${listing.rooms} pièce${listing.rooms > 1 ? 's' : ''} · ${listing.surface_m2} m²`,
                h('br'),
                listing.district,
              ),
            ),
          ),
        ),
      );
    })();

    return {
      body: h(
        'div',
        { class: 'ob-aha' },
        count,
        headline,
        sub,
        grid,
        h(
          'p',
          { class: 'ob__subtitle', style: { fontSize: '14px', marginTop: '22px' } },
          'Crée ton compte pour voir les adresses, les photos et postuler en un clic.',
        ),
      ),
      cta: { label: 'Débloquer ces appartements', variant: 'accent', arrow: true },
      onNext: () => 'account',
    };
  },
};

/* =========================================================================
 * Screen 5 - minimal account
 * ========================================================================= */
const FR_PHONE = /^[67]\d{8}$/;

const account = {
  progress: 38,
  back: true,
  eyebrow: 'Presque à toi',
  title: 'Où doit-on t’envoyer les visites ?',
  subtitle: 'Ton numéro sert uniquement à te prévenir quand une visite est réservée.',
  build(ctx) {
    const phone = input({
      type: 'tel',
      inputmode: 'numeric',
      autocomplete: 'tel-national',
      placeholder: '6 12 34 56 78',
      value: (store.get().phone || '').replace(/^\+33/, ''),
      'aria-label': 'Numéro de téléphone mobile',
    });

    const normalise = () => phone.value.replace(/[^\d]/g, '').replace(/^0/, '').slice(0, 9);

    phone.addEventListener('input', () => {
      const digits = normalise();
      // Group as 6 12 34 56 78 while typing.
      phone.value = digits.replace(/(\d)(?=(\d{2})+$)/g, '$1 ').trim();
      showError(phone, null);
      ctx.setValid(FR_PHONE.test(digits));
    });

    const googleBtn = h(
      'button',
      {
        class: 'ob-btn ob-btn--light',
        type: 'button',
        onClick: async () => {
          const supabase = client();
          if (!supabase) return;
          // The return target travels as a query parameter, never as a
          // fragment. Supabase appends `?code=` to redirectTo on the way back,
          // and a redirectTo that already carried `#employment` produced
          // `#employment?code=...` - a fragment matching no screen, which
          // dropped the visitor back on the first screen with no error shown.
          // The trailing slash matches Astro's directory build and avoids a
          // redirect hop before the code is read.
          const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: `${location.origin}/onboarding/?next=employment` },
          });
          if (error) {
            showError(
              phone,
              'La connexion Google n’est pas encore active. Ton numéro suffit pour continuer.',
            );
          }
        },
      },
      h(
        'span',
        { class: 'ob-btn__inner' },
        h('span', { html: ICONS.google, style: { display: 'inline-flex' } }),
        'Continuer avec Google',
      ),
    );

    return {
      body: h(
        'div',
        {},
        field({
          label: 'Numéro de mobile',
          input: h(
            'span',
            { class: 'ob-affix' },
            h('span', { class: 'ob-affix__prefix' }, '+33'),
            phone,
          ),
        }),
        h('div', { class: 'ob-date__divider' }, 'ou'),
        googleBtn,
        note(
          'Pas de mot de passe, pas d’e-mail de vérification. On ne partage jamais ton numéro avec les agences.',
          'lock',
        ),
      ),
      valid: FR_PHONE.test(normalise()),
      focus: phone,
      onNext() {
        const digits = normalise();
        if (!FR_PHONE.test(digits)) {
          showError(phone, 'Entre un numéro de mobile français à 9 chiffres.');
          return false;
        }
        store.set({ phone: `+33${digits}` });

        // Creates the real, RLS-scoped account. No SMS is sent: the number is
        // recorded now and verified the day the SMS provider is connected.
        //
        // Deliberately not awaited. The draft is already safe on the device, so
        // making someone watch a spinner while a round-trip completes buys
        // nothing - and on a bad connection it would strand them mid-flow.
        ensureSession()
          .then(() => store.sync())
          .catch(() => {});

        return 'employment';
      },
    };
  },
};

/* =========================================================================
 * Screen 6 - employment
 * ========================================================================= */
const EMPLOYMENT = [
  { value: 'cdi', label: 'CDI', hint: 'Ou fonctionnaire titulaire', emoji: '💼' },
  { value: 'independant', label: 'Indépendant', hint: 'Freelance, gérant, profession libérale', emoji: '🚀' },
  { value: 'etudiant', label: 'Étudiant', hint: 'Ou en alternance', emoji: '🎓' },
  { value: 'retraite', label: 'Retraité', hint: 'Pension ou rente', emoji: '🌤️' },
  { value: 'sans_emploi', label: 'En recherche', hint: 'Entre deux contrats', emoji: '🧭' },
];

const employment = {
  progress: 48,
  back: true,
  eyebrow: 'Ton dossier',
  title: 'Quelle est ta situation ?',
  subtitle: 'Ça détermine les pièces que les agences vont demander — on ne te demandera que celles-là.',
  build(ctx) {
    const current = store.get().employment;
    const list = h(
      'div',
      { class: 'ob-options' },
      EMPLOYMENT.map((item) =>
        option({ ...item, selected: current === item.value }),
      ),
    );

    optionGroup(list, (value) => {
      store.set({ employment: value });
      ctx.setValid(true);
      setTimeout(() => ctx.next(), 200);
    });

    return { body: list, valid: Boolean(current), onNext: () => 'income' };
  },
};

/* =========================================================================
 * Screen 7 - income, manual first
 * ========================================================================= */
const income = {
  progress: 58,
  back: true,
  eyebrow: 'Ton dossier',
  title: 'Ton revenu net mensuel ?',
  subtitle: 'Un seul chiffre. C’est ce que les agences regardent en premier.',
  build(ctx) {
    const existing = store.incomeEuros();
    const amount = input({
      type: 'text',
      inputmode: 'numeric',
      placeholder: '2 400',
      value: existing ? existing.toLocaleString('fr-FR') : '',
      'aria-label': 'Revenu net mensuel en euros',
    });

    const verdict = h('div', { hidden: true });

    /** The 3x rule, phrased as guidance rather than a verdict on the person. */
    const assess = () => {
      const value = Number(amount.value.replace(/[^\d]/g, ''));
      const rent = store.get().budget;
      if (!value) {
        verdict.hidden = true;
        return;
      }

      const strong = value >= rent * 3;
      store.set({ incomeCents: value * 100, needsGuarantor: !strong });

      verdict.hidden = false;
      verdict.className = `ob-verdict ob-verdict--${strong ? 'strong' : 'guarantor'}`;
      verdict.replaceChildren(
        h('span', { class: 'ob-verdict__icon' }, strong ? '✅' : '🤝'),
        h(
          'div',
          {},
          h(
            'div',
            { class: 'ob-verdict__title' },
            strong ? 'Profil solide' : 'On va te trouver un garant',
          ),
          h(
            'div',
            { class: 'ob-verdict__text' },
            strong
              ? `Avec ${euros(value)} pour un loyer de ${euros(rent)}, tu passes la règle des 3× sans difficulté. Ton dossier partira en tête.`
              : `Pour ${euros(rent)} de loyer, les agences demandent ${euros(rent * 3)} de revenus. Un garant comble l’écart — c’est le cas de la majorité des dossiers acceptés, et ça se règle à l’écran suivant.`,
          ),
        ),
      );
    };

    amount.addEventListener('input', () => {
      const digits = amount.value.replace(/[^\d]/g, '').slice(0, 7);
      amount.value = digits ? Number(digits).toLocaleString('fr-FR') : '';
      ctx.setValid(Number(digits) > 0);
      assess();
    });

    if (existing) assess();

    const feedback = scanNote();

    const payslipShortcut = scanShortcut({
      kind: 'revenus',
      label: 'Photographier mon bulletin de salaire',
      feedback,
      apply(fields) {
        if (!fields.netMonthlyEuros) return [];
        amount.value = fields.netMonthlyEuros.toLocaleString('fr-FR');
        ctx.setValid(true);
        assess();
        return ['Revenu net rempli'];
      },
    });

    return {
      body: h(
        'div',
        {},
        field({
          label: 'Revenu net mensuel',
          input: h(
            'span',
            { class: 'ob-affix' },
            h('span', { class: 'ob-affix__prefix' }, '€'),
            amount,
          ),
          hint: 'Salaire, pension, bourse, revenus d’activité — après impôts.',
        }),
        verdict,
        shortcuts('Aller plus vite', [
          payslipShortcut,
          {
            icon: 'bank',
            label: 'Connecter ma banque',
            disabled: true,
            title:
              'La connexion bancaire arrive une fois l’agrément DSP2 obtenu. La saisie manuelle reste la voie normale.',
          },
        ]),
        feedback,
      ),
      valid: Boolean(existing),
      focus: amount,
      onNext() {
        const value = Number(amount.value.replace(/[^\d]/g, ''));
        if (!value) {
          showError(amount, 'Entre ton revenu net mensuel.');
          return false;
        }
        store.set({ incomeCents: value * 100, needsGuarantor: value < store.get().budget * 3 });
        // The conditional branch lives here, not in the controller.
        return store.get().needsGuarantor ? 'guarantor' : 'identity';
      },
    };
  },
};

/* =========================================================================
 * Screen 8 - guarantor (conditional)
 * ========================================================================= */
const RELATIONS = [
  { value: 'parent', label: 'Un parent', emoji: '👨‍👩‍👧' },
  { value: 'proche', label: 'Un proche', emoji: '🫱' },
  { value: 'visale', label: 'Garantie Visale', hint: 'Gratuite, garantie par l’État', emoji: '🇫🇷' },
];

const guarantor = {
  progress: 68,
  back: true,
  eyebrow: 'Ton dossier',
  title: 'Qui se porte garant ?',
  subtitle: 'Tu peux compléter ses informations plus tard — on garde ta place dans la file.',
  build(ctx) {
    const draft = store.get();

    const name = input({
      type: 'text',
      placeholder: 'Prénom et nom',
      autocomplete: 'off',
      value: draft.guarantorName || '',
      'aria-label': 'Nom du garant',
    });

    const guarantorIncome = input({
      type: 'text',
      inputmode: 'numeric',
      placeholder: '3 600',
      value: draft.guarantorIncomeCents ? String(draft.guarantorIncomeCents / 100) : '',
      'aria-label': 'Revenu net mensuel du garant',
    });

    const relations = h(
      'div',
      { class: 'ob-options' },
      RELATIONS.map((item) => option({ ...item, selected: draft.guarantorRelation === item.value })),
    );

    optionGroup(relations, (value) => {
      store.set({ guarantorRelation: value });
      // Visale replaces a person entirely, so the identity fields go away.
      const isVisale = value === 'visale';
      personal.hidden = isVisale;
      ctx.setValid(isVisale || name.value.trim().length > 1);
    });

    const guarantorFeedback = scanNote();

    const personal = h(
      'div',
      { hidden: draft.guarantorRelation === 'visale' },
      field({ label: 'Nom du garant', input: name }),
      field({
        label: 'Son revenu net mensuel',
        optional: true,
        input: h(
          'span',
          { class: 'ob-affix' },
          h('span', { class: 'ob-affix__prefix' }, '€'),
          guarantorIncome,
        ),
      }),
      shortcuts('Aller plus vite', [
        scanShortcut({
          kind: 'garant',
          label: 'Photographier son bulletin de salaire',
          feedback: guarantorFeedback,
          apply(fields) {
            if (!fields.netMonthlyEuros) return [];
            guarantorIncome.value = fields.netMonthlyEuros.toLocaleString('fr-FR');
            return ['Revenu du garant rempli'];
          },
        }),
      ]),
      guarantorFeedback,
    );

    name.addEventListener('input', () => ctx.setValid(name.value.trim().length > 1));
    guarantorIncome.addEventListener('input', () => {
      const digits = guarantorIncome.value.replace(/[^\d]/g, '').slice(0, 7);
      guarantorIncome.value = digits ? Number(digits).toLocaleString('fr-FR') : '';
    });

    return {
      body: h('div', {}, relations, h('div', { style: { height: '20px' } }), personal),
      valid: draft.guarantorRelation === 'visale' || Boolean(draft.guarantorName),
      hint: 'Un dossier avec garant passe devant un dossier incomplet.',
      onNext() {
        const relation = store.get().guarantorRelation;
        if (!relation) return false;
        if (relation !== 'visale') {
          const digits = Number(guarantorIncome.value.replace(/[^\d]/g, ''));
          store.set({
            guarantorName: name.value.trim() || null,
            guarantorIncomeCents: digits ? digits * 100 : null,
          });
        }
        return 'identity';
      },
    };
  },
};

/* =========================================================================
 * Screen 9 - identity, manual first
 * ========================================================================= */
const ID_TYPES = [
  { value: 'cni', label: "Carte d'identité", emoji: '🪪' },
  { value: 'passeport', label: 'Passeport', emoji: '📘' },
  { value: 'titre_sejour', label: 'Titre de séjour', emoji: '🗂️' },
];

const identity = {
  progress: 78,
  back: true,
  eyebrow: 'Ton dossier',
  title: 'Ton identité',
  subtitle: 'Les agences vérifient que le dossier correspond bien à la personne qui visite.',
  build(ctx) {
    const draft = store.get();

    const first = input({ type: 'text', autocomplete: 'given-name', placeholder: 'Camille', value: draft.firstName || '' });
    const last = input({ type: 'text', autocomplete: 'family-name', placeholder: 'Durand', value: draft.lastName || '' });
    const birth = input({ type: 'date', max: new Date().toISOString().slice(0, 10), value: draft.birthDate || '' });
    const number = input({ type: 'text', placeholder: '12AB34567', value: draft.idNumber || '' });

    const types = h(
      'div',
      { class: 'ob-options' },
      ID_TYPES.map((item) => option({ ...item, selected: draft.idType === item.value })),
    );

    const check = () =>
      ctx.setValid(
        first.value.trim().length > 1 &&
          last.value.trim().length > 1 &&
          Boolean(birth.value) &&
          Boolean(store.get().idType) &&
          number.value.trim().length > 3,
      );

    optionGroup(types, (value) => {
      store.set({ idType: value });
      check();
    });
    for (const el of [first, last, birth, number]) el.addEventListener('input', check);

    const feedback = scanNote();

    /** Write what the scan read into the inputs, and say what was filled. */
    const applyScan = (fields) => {
      const filled = [];

      if (fields.firstName) {
        first.value = fields.firstName;
        filled.push('Prénom');
      }
      if (fields.lastName) {
        last.value = fields.lastName;
        filled.push('Nom');
      }
      if (fields.birthDate) {
        birth.value = fields.birthDate;
        filled.push('Date de naissance');
      }
      if (fields.documentNumber) {
        number.value = fields.documentNumber;
        filled.push('Numéro');
      }
      if (fields.documentType) {
        store.set({ idType: fields.documentType });
        for (const card of types.querySelectorAll('.ob-option')) {
          const selected = card.dataset.value === fields.documentType;
          card.dataset.selected = String(selected);
          card.setAttribute('aria-pressed', String(selected));
        }
        filled.push('Type de pièce');
      }

      check();
      return filled;
    };

    return {
      body: h(
        'div',
        {},
        h(
          'div',
          { class: 'ob-field__row' },
          field({ label: 'Prénom', input: first }),
          field({ label: 'Nom', input: last }),
        ),
        field({ label: 'Date de naissance', input: birth }),
        h('p', { class: 'ob-field__label', style: { marginBottom: '10px' } }, 'Type de pièce'),
        types,
        h('div', { style: { height: '16px' } }),
        field({ label: 'Numéro du document', input: number }),
        shortcuts('Aller plus vite', [
          scanShortcut({
            kind: 'identite',
            label: 'Scanner ma pièce avec l’appareil photo',
            feedback,
            apply: applyScan,
          }),
        ]),
        feedback,
        note(
          'Le scan pré-remplit les champs : tu gardes la main pour vérifier et corriger avant de valider.',
          'shield',
        ),
      ),
      valid: Boolean(draft.firstName && draft.lastName && draft.birthDate && draft.idType && draft.idNumber),
      focus: first,
      onNext() {
        store.set({
          firstName: first.value.trim(),
          lastName: last.value.trim(),
          birthDate: birth.value || null,
          idNumber: number.value.trim(),
        });
        return 'address';
      },
    };
  },
};

/* =========================================================================
 * Screen 10 - proof of current address
 * ========================================================================= */
const PROOF_TYPES = [
  { value: 'quittances', label: 'Quittances de loyer', hint: 'Les trois dernières', emoji: '🧾' },
  { value: 'attestation_bailleur', label: 'Attestation du bailleur', hint: 'Signée par ton propriétaire', emoji: '✍️' },
  { value: 'attestation_hebergement', label: "Attestation d'hébergement", hint: 'Si tu es hébergé', emoji: '🏠' },
];

const address = {
  progress: 89,
  back: true,
  eyebrow: 'Dernière pièce',
  title: 'Ton justificatif de domicile',
  subtitle: 'La dernière pièce du dossier. Ensuite, l’agent IA prend le relais.',
  build(ctx) {
    const draft = store.get();
    let chosen = null;

    const types = h(
      'div',
      { class: 'ob-options' },
      PROOF_TYPES.map((item) => option({ ...item, selected: draft.addressProofType === item.value })),
    );

    const picker = h('input', {
      type: 'file',
      accept: 'application/pdf,image/jpeg,image/png,image/heic',
      class: 'ob-sr',
    });

    // Distinct from the file picker: `capture` opens the camera directly, which
    // is the actual shortcut on a phone.
    const camera = h('input', {
      type: 'file',
      accept: 'image/*',
      capture: 'environment',
      class: 'ob-sr',
    });

    const fileSlot = h('div', {});

    const accept = async (file) => {
      if (!file) return;
      const problem = validate(file);
      if (problem) {
        fileSlot.replaceChildren(h('p', { class: 'ob-field__error' }, problem));
        return;
      }

      fileSlot.replaceChildren(
        h(
          'div',
          { class: 'ob-file' },
          h('span', { class: 'ob-spinner', style: { borderTopColor: '#1a1a1a', borderColor: '#e0e0e0' } }),
          h('span', { class: 'ob-file__name' }, file.name),
        ),
      );

      const result = await upload(file, 'domicile', store.get().addressProofType);
      if (!result.ok) {
        fileSlot.replaceChildren(h('p', { class: 'ob-field__error' }, result.error));
        return;
      }

      store.set({ addressProofName: file.name });
      chosen = file;
      fileSlot.replaceChildren(
        h(
          'div',
          { class: 'ob-file' },
          h('span', {}, '📄'),
          h('span', { class: 'ob-file__name' }, file.name),
          h('span', { class: 'ob-file__size' }, humanSize(file.size)),
          h('button', {
            class: 'ob-file__remove',
            type: 'button',
            'aria-label': 'Retirer le fichier',
            html: ICONS.close,
            onClick: () => {
              chosen = null;
              store.set({ addressProofName: null });
              fileSlot.replaceChildren();
              ctx.setValid(false);
            },
          }),
        ),
      );
      ctx.setValid(true);
    };

    picker.addEventListener('change', () => accept(picker.files?.[0]));
    camera.addEventListener('change', () => accept(camera.files?.[0]));

    const drop = h(
      'div',
      {
        class: 'ob-drop',
        role: 'button',
        tabindex: '0',
        onClick: () => picker.click(),
        onKeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            picker.click();
          }
        },
      },
      h('span', { class: 'ob-drop__icon', html: ICONS.upload, style: { width: '26px', height: '26px', display: 'inline-flex' } }),
      h('span', { class: 'ob-drop__title' }, 'Choisir un fichier'),
      h('span', { class: 'ob-drop__hint' }, 'PDF, JPG ou PNG — 10 Mo maximum'),
    );

    for (const [event, handler] of [
      ['dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); }],
      ['dragleave', () => drop.classList.remove('is-over')],
      ['drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); accept(e.dataTransfer?.files?.[0]); }],
    ]) {
      drop.addEventListener(event, handler);
    }

    optionGroup(types, (value) => {
      store.set({ addressProofType: value });
      ctx.setValid(Boolean(chosen || store.get().addressProofName));
    });

    return {
      body: h(
        'div',
        {},
        types,
        h('div', { style: { height: '20px' } }),
        drop,
        picker,
        camera,
        fileSlot,
        shortcuts('Aller plus vite', [
          {
            icon: 'camera',
            label: 'Prendre une photo',
            onClick: () => camera.click(),
          },
        ]),
        note(
          'Stocké chiffré, dans un espace privé auquel toi seul as accès. Supprimé automatiquement au bout de 90 jours.',
          'lock',
        ),
      ),
      valid: Boolean(draft.addressProofName && draft.addressProofType),
      cta: { label: 'Terminer mon dossier', variant: 'accent', arrow: true },
      onNext() {
        if (!store.get().addressProofType) return false;
        store.set({ completedAt: new Date().toISOString() });
        // Same reasoning as screen 5: the celebration is owed to the visitor
        // immediately, and the final sync catches up behind it.
        store.sync().catch(() => {});
        return 'done';
      },
    };
  },
};

/* =========================================================================
 * Final screen
 * ========================================================================= */
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = h('div', { class: 'ob-confetti', 'aria-hidden': 'true' });
  const colours = ['#ff7a00', '#ffa14d', '#1a1a1a', '#ffffff', '#ffcf9e'];
  for (let i = 0; i < 70; i++) {
    layer.appendChild(
      h('i', {
        style: {
          left: `${Math.random() * 100}%`,
          background: colours[i % colours.length],
          animationDuration: `${2.2 + Math.random() * 1.9}s`,
          animationDelay: `${Math.random() * 0.7}s`,
        },
      }),
    );
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 5200);
}

const done = {
  progress: 100,
  back: false,
  // Header stays: watching the bar land on 100% is the reward this screen owes.
  build(ctx) {
    const draft = store.get();

    const pushBtn = button('Me prévenir dès qu’une visite est réservée', {
      variant: 'accent',
      onClick: async () => {
        // Asked here and only here: at the moment the notification is obviously
        // for the visitor's benefit, not on screen 1 where it reads as a tax.
        if (!('Notification' in window)) return;
        const permission = await Notification.requestPermission();
        pushBtn.querySelector('.ob-btn__inner').textContent =
          permission === 'granted' ? 'Notifications activées ✓' : 'Tu peux les activer plus tard';
        pushBtn.disabled = true;
      },
    });

    setTimeout(confetti, 260);

    const items = [
      `Recherche active à ${draft.city || 'ta ville'}`,
      `${draft.matchCount || 8} appartements déjà identifiés`,
      'Pièces conformes au décret Alur',
      'Candidature automatique activée',
    ];

    return {
      body: h(
        'div',
        {},
        h(
          'div',
          { class: 'ob-done' },
          h('div', { class: 'ob-done__seal', html: ICONS.check }),
          h('h1', { class: 'ob__title' }, 'Ton dossier est complet.'),
          h(
            'p',
            { class: 'ob__subtitle' },
            'Notre agent IA se met au travail dès maintenant. Il postule à ta place, en moins de 60 secondes après chaque nouvelle annonce.',
          ),
          h(
            'ul',
            { class: 'ob-checklist' },
            items.map((label, index) =>
              h(
                'li',
                { style: { animationDelay: `${300 + index * 110}ms` } },
                h('span', { 'aria-hidden': 'true' }, '✓'),
                label,
              ),
            ),
          ),
          h('div', { style: { height: '28px' } }),
          pushBtn,
        ),
      ),
      cta: { label: 'Activer mon agent', arrow: true },
      hint: 'Encore deux réglages — 30 secondes.',
      onNext: () => 'connect',
    };
  },
};


/* =========================================================================
 * Screen 14 - connecting the mailbox and the calendar
 *
 * This is where the product stops being a promise. Prems writes to agencies
 * *from the client's own address* and reads the answers *in their inbox* -
 * that is what makes an agent receive a message from a person rather than from
 * a robot, and it is the only reason a reply can ever be intercepted. Without
 * it the pipeline detects and matches and sends nothing, deliberately.
 *
 * It sits before the price rather than after because it is the last thing that
 * can be honestly described as setting up the agent. Asking someone to
 * authorise their inbox immediately *after* taking their money reads as a
 * condition that was withheld.
 *
 * The calendar is asked for at the same time and not a week later: a confirmed
 * visit has to land somewhere, and coming back to ask again is asking twice.
 * ========================================================================= */
const connect = {
  progress: 96,
  back: true,
  build() {
    const card = (service, title, detail) => {
      const state = { connected: false };

      const btn = button('Connecter', {
        variant: 'accent',
        onClick: async () => {
          const label = btn.querySelector('.ob-btn__inner');
          btn.disabled = true;
          label.textContent = 'Ouverture de Google…';
          try {
            await mailbox.connect(service);
            label.textContent = 'En attente de ton autorisation…';
            const ok = await mailbox.waitForConnection(service);
            state.connected = ok;
            label.textContent = ok ? 'Connecté ✓' : 'Réessayer';
            btn.disabled = ok;
            if (ok) btn.classList.replace('ob-btn--accent', 'ob-btn--light');
          } catch {
            label.textContent = 'Réessayer';
            btn.disabled = false;
          }
        },
      });

      return h(
        'div',
        { class: 'ob-connect__card' },
        // Both are Google connections, so both carry the Google mark: the
        // person is about to see Google's own consent screen, and matching the
        // button to what opens is what stops that screen looking like a
        // redirect they did not ask for.
        h('div', { class: 'ob-connect__icon', html: ICONS.google }),
        h('h2', { class: 'ob-connect__title' }, title),
        h('p', { class: 'ob-connect__detail' }, detail),
        btn,
      );
    };

    return {
      body: h(
        'div',
        { class: 'ob-connect' },
        h('span', { class: 'ob__eyebrow' }, 'Dernier réglage'),
        h('h1', { class: 'ob__title' }, 'Connecte ton agent à ta boîte.'),
        h(
          'p',
          { class: 'ob__subtitle' },
          'Les candidatures partent de ton adresse, jamais de la nôtre — c’est ce qui fait qu’une agence répond à une personne. Et les réponses arrivent chez toi, où l’agent les lit pour toi.',
        ),
        h(
          'div',
          { class: 'ob-connect__grid' },
          card('gmail', 'Ta boîte mail', 'Pour écrire aux agences en ton nom et lire leurs réponses.'),
          card('googlecalendar', 'Ton agenda', 'Pour poser la visite dès qu’une agence la confirme.'),
        ),
        h(
          'p',
          { class: 'ob-connect__trust' },
          'Prems ne lit que les échanges liés à ta recherche. Tu peux révoquer l’accès à tout moment depuis ton compte Google.',
        ),
      ),
      cta: { label: 'Continuer', arrow: true },
      hint: 'Tu pourras aussi le faire plus tard depuis ton profil.',
      onNext: () => 'pricing',
    };
  },
};

/* =========================================================================
 * Screen 15 - pricing
 *
 * The flow used to end on the celebration, which meant it ended by asking
 * nothing. A completed file is the highest-intent moment this product will
 * ever get: the person has just watched their own dossier come together and
 * been told an agent is about to work on it. That is where the price belongs.
 *
 * The offers are the landing page's, unchanged - being quoted a different
 * number after signing up than before is the fastest way to lose the trust the
 * previous thirteen screens just built.
 *
 * Only two of the three are here. The upper tiers are a comparison exercise,
 * and comparison is the enemy of a decision taken in the ten seconds after a
 * reward. The standard plan stays as the honest baseline, and the founder
 * offer takes the space the other two used to occupy - one payment, capped by
 * an event the person actually wants (signing a lease) rather than by a date.
 * ========================================================================= */
function planCard(plan, { hero = false } = {}) {
  const draft = store.get();

  return h(
    'article',
    { class: `ob-plan${hero ? ' ob-plan--hero' : ''}` },
    plan.eyebrow ? h('span', { class: 'ob-plan__flag' }, plan.eyebrow) : null,
    h('h2', { class: 'ob-plan__name' }, plan.name),
    h(
      'p',
      { class: 'ob-plan__price' },
      h('span', { class: 'ob-plan__amount' }, plan.price),
      h('span', { class: 'ob-plan__period' }, plan.period),
    ),
    h('p', { class: 'ob-plan__tagline' }, plan.tagline),
    h(
      'ul',
      { class: 'ob-plan__list' },
      plan.features.map((feature) =>
        h(
          'li',
          {},
          h('span', { class: 'ob-plan__tick', html: ICONS.check, 'aria-hidden': 'true' }),
          feature,
        ),
      ),
    ),
    h(
      'a',
      {
        class: `ob-btn${hero ? ' ob-btn--accent' : ' ob-btn--light'} ob-plan__cta`,
        href:
          // Ties the payment back to the account that made it: Stripe echoes
          // client_reference_id on the session and on the webhook, so the plan
          // lands on the right user without anyone retyping an email. The
          // account id is carried by the billing module - see warm().
          //
          // Encaissement coupé : `checkoutUrl` rend null et le repli devient
          // l'application. C'est aussi ce que suivent un clic milieu ou un
          // « ouvrir dans un nouvel onglet », qui ne passent pas par onClick.
          checkoutUrl(plan.id) || (PAYMENTS_ENABLED ? '/contact' : '/app'),
        onClick: (event) => {
          track('pricing', 'complete');
          startCheckout(plan.id, event);
          // Le clic ouvre l'accès sur place : il faut donc conduire quelque
          // part, puisque plus aucune redirection Stripe ne le fera.
          if (!PAYMENTS_ENABLED) location.href = '/app';
        },
      },
      h('span', { class: 'ob-btn__inner' }, plan.cta),
    ),
    plan.note ? h('p', { class: 'ob-plan__note' }, plan.note) : null,
  );
}

const pricing = {
  progress: 100,
  back: true,
  hideFooter: true,
  build() {
    return {
      body: h(
        'div',
        { class: 'ob-pricing' },
        h('span', { class: 'ob__eyebrow' }, 'Nos tarifs'),
        h('h1', { class: 'ob__title' }, 'Ton agent est prêt. Choisis ta formule.'),
        h(
          'p',
          { class: 'ob__subtitle' },
          'Une offre simple, sans engagement. Tu arrêtes dès que tu as signé.',
        ),
        h(
          'div',
          { class: 'ob-plans' },
          planCard(PLANS.soldat),
          planCard(PLANS.fondateur, { hero: true }),
        ),
        h(
          'p',
          { class: 'ob-pricing__trust' },
          'Sans engagement · Pas de frais cachés · Paiement sécurisé par Stripe',
        ),
        // No way past this screen without choosing.
        //
        // There used to be a "plus tard — voir mon espace" link here. It sent
        // people to an app whose whole point - an agent applying on their
        // behalf - is gated on an active subscription, so it delivered them to
        // a product that could only show them apartments it would never act on.
      ),
    };
  },
};

export const SCREENS = {
  hook,
  city,
  budget,
  rooms,
  date: moveIn,
  aha,
  account,
  employment,
  income,
  guarantor,
  identity,
  address,
  done,
  connect,
  pricing,
};

export const ORDER = [
  'hook',
  'city',
  'budget',
  'rooms',
  'date',
  'aha',
  'account',
  'employment',
  'income',
  'guarantor',
  'identity',
  'address',
  'done',
  'connect',
  'pricing',
];

export { isConfigured };
