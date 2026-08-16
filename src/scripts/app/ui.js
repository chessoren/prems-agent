/**
 * App-specific building blocks.
 *
 * The atoms - hyperscript, buttons, option cards, fields, icons - are imported
 * from the onboarding kit rather than rewritten, because they are the design
 * system: the same 100px pills, the same five-layer shadow, the same accent.
 * Someone arriving here straight from screen thirteen should not be able to
 * tell where the onboarding stopped and the app started.
 *
 * Only what the app genuinely adds lives here: status badges, the sheet, the
 * toast, and the accordion.
 */
import { h, ICONS, icon, button, option, optionGroup, field, input, note } from '../onboarding/ui.js';
import { STATUS } from '../../lib/prems/agent.js';

export { h, ICONS, icon, button, option, optionGroup, field, input, note };

/* -------------------------------------------------------------------------
 * Icons the app needs and the flow did not
 * ------------------------------------------------------------------------- */
const svg = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;

export const APP_ICONS = {
  home: svg('<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  calendar: svg(
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  ),
  chat: svg('<path d="M21 12a8 8 0 01-8 8H7l-4 3V12a8 8 0 018-8h2a8 8 0 018 8z"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0114 0v1"/>'),
  sparkle: svg('<path d="M12 3l2 5.5L19.5 10 14 12l-2 5.5L10 12 4.5 10 10 8.5z"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  phone: svg(
    '<path d="M6 3h3l2 5-2.5 1.5a12 12 0 006 6L16 13l5 2v3a2 2 0 01-2.2 2A16 16 0 014 5.2 2 2 0 016 3z"/>',
  ),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
  chevron: svg('<path d="M6 9l6 6 6-6"/>'),
  thumbUp: svg('<path d="M7 21V10l5-7 1.5 1a2 2 0 01.6 2.2L13 10h5.5a2 2 0 012 2.5l-1.6 6A2 2 0 0117 20H7z"/><path d="M7 10H4v11h3"/>'),
  thumbDown: svg('<path d="M17 3v11l-5 7-1.5-1a2 2 0 01-.6-2.2L11 14H5.5a2 2 0 01-2-2.5l1.6-6A2 2 0 017 4h10z"/><path d="M17 14h3V3h-3"/>'),
  edit: svg('<path d="M4 20h4L20 8l-4-4L4 16z"/>'),
  radar: svg(
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l6-4"/>',
  ),
  card: svg('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/>'),
  file: svg('<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>'),
};

export const appIcon = (name, size = 20) =>
  h('span', {
    class: 'pm-i',
    html: APP_ICONS[name] || ICONS[name],
    style: { display: 'inline-flex', width: `${size}px`, height: `${size}px` },
  });

/* -------------------------------------------------------------------------
 * Status badge
 *
 * One vocabulary for the seven lifecycle states, used identically on a match
 * card, in a visit sheet and at the head of a thread. The tone carries the
 * meaning: orange is always "you have something to do", green is always
 * "settled", grey is always "we are working on it".
 * ------------------------------------------------------------------------- */
export function statusBadge(statusId, { onPhoto = false } = {}) {
  const status = STATUS[statusId] || STATUS.nouveau;
  return h(
    'span',
    {
      class: `pm-status pm-status--${status.tone}${onPhoto ? ' pm-status--float' : ''}`,
      title: status.detail,
    },
    status.label,
  );
}

/* -------------------------------------------------------------------------
 * Numeric badge - the Zeigarnik dot
 *
 * Kept as a live node rather than re-rendered with its tab, so a match landing
 * while the person is reading a thread updates the count under their thumb.
 * ------------------------------------------------------------------------- */
export function countBadge(value = 0) {
  const node = h('span', { class: 'pm-badge', hidden: value === 0 }, String(value));
  node.setCount = (next) => {
    node.textContent = String(next);
    node.hidden = next === 0;
  };
  return node;
}

/* -------------------------------------------------------------------------
 * Procedural artwork
 *
 * The same two gradients and skyline the onboarding uses for its listing grid:
 * no stock photography is shipped, and a grey rectangle where a flat should be
 * would undo the moment the card is trying to create.
 * ------------------------------------------------------------------------- */
export const artwork = (hue, extraClass = '') =>
  h('div', { class: `ob-art ${extraClass}`.trim(), style: { '--hue': String(hue) } });

/* -------------------------------------------------------------------------
 * Section heading
 * ------------------------------------------------------------------------- */
export const sectionTitle = (text, aside = null) =>
  h(
    'div',
    { class: 'pm-section' },
    h('h2', { class: 'pm-section__title' }, text),
    aside ? h('span', { class: 'pm-section__aside' }, aside) : null,
  );

/* -------------------------------------------------------------------------
 * Accordion - the profile's organising principle
 *
 * A rental file is five unrelated things. Five open panels is a wall; five
 * closed ones is a table of contents you can scan in a second.
 * ------------------------------------------------------------------------- */
export function accordion(sections) {
  return h(
    'div',
    { class: 'pm-accordion' },
    sections.map((section, index) => {
      const body = h('div', { class: 'pm-acc__body' }, section.body());
      const panel = h('div', { class: 'pm-acc__panel', hidden: !section.open }, body);

      const head = h(
        'button',
        {
          class: 'pm-acc__head',
          type: 'button',
          'aria-expanded': String(Boolean(section.open)),
          'aria-controls': `pm-acc-${index}`,
          onClick: () => {
            const open = panel.hidden;
            panel.hidden = !open;
            head.setAttribute('aria-expanded', String(open));
          },
        },
        h('span', { class: 'pm-acc__icon' }, appIcon(section.icon, 18)),
        h(
          'span',
          { class: 'pm-acc__text' },
          h('span', { class: 'pm-acc__label' }, section.label),
          section.hint ? h('span', { class: 'pm-acc__hint' }, section.hint) : null,
        ),
        section.flag || null,
        h('span', { class: 'pm-acc__chevron', html: APP_ICONS.chevron }),
      );

      panel.id = `pm-acc-${index}`;
      return h('section', { class: 'pm-acc' }, head, panel);
    }),
  );
}

/* -------------------------------------------------------------------------
 * Sheet - a bottom sheet on a phone, a centred dialog on a desktop
 * ------------------------------------------------------------------------- */
export function sheet({ title, body, onClose }) {
  const close = () => {
    root.classList.add('is-closing');
    setTimeout(() => {
      root.remove();
      document.body.style.overflow = '';
      onClose?.();
    }, 200);
  };

  const root = h(
    'div',
    {
      class: 'pm-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      onClick: (event) => {
        if (event.target === root) close();
      },
    },
    h(
      'div',
      { class: 'pm-sheet__panel' },
      h(
        'div',
        { class: 'pm-sheet__head' },
        h('h2', { class: 'pm-sheet__title' }, title),
        h('button', {
          class: 'pm-sheet__close',
          type: 'button',
          'aria-label': 'Fermer',
          html: ICONS.close,
          onClick: close,
        }),
      ),
      h('div', { class: 'pm-sheet__body' }, body(close)),
    ),
  );

  document.body.style.overflow = 'hidden';
  document.body.appendChild(root);
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') close();
    },
    { once: true },
  );

  return { close };
}

/* -------------------------------------------------------------------------
 * Toast
 *
 * Used for the one thing that genuinely needs confirming without interrupting:
 * a dismissal, which is destructive from the person's point of view and so
 * ships with an undo rather than a confirmation dialog.
 * ------------------------------------------------------------------------- */
let currentToast = null;

export function toast(message, { action, onAction, duration = 5200 } = {}) {
  currentToast?.remove();

  const node = h(
    'div',
    { class: 'pm-toast', role: 'status' },
    h('span', { class: 'pm-toast__text' }, message),
    action
      ? h(
          'button',
          {
            class: 'pm-toast__action',
            type: 'button',
            onClick: () => {
              onAction?.();
              node.remove();
            },
          },
          action,
        )
      : null,
  );

  currentToast = node;
  document.body.appendChild(node);
  setTimeout(() => {
    if (node.isConnected) {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 260);
    }
  }, duration);
}

/* -------------------------------------------------------------------------
 * Empty state
 * ------------------------------------------------------------------------- */
export const empty = ({ icon: iconName = 'radar', title, text, action = null }) =>
  h(
    'div',
    { class: 'pm-empty' },
    h('span', { class: 'pm-empty__icon' }, appIcon(iconName, 26)),
    h('h3', { class: 'pm-empty__title' }, title),
    text ? h('p', { class: 'pm-empty__text' }, text) : null,
    action,
  );
