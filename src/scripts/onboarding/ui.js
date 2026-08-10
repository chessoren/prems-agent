/**
 * Building blocks shared by every screen.
 *
 * No framework: the flow is a dozen screens with one question each, and a tiny
 * hyperscript keeps it lighter and faster than any runtime would. The whole
 * onboarding ships in a few kB on top of the existing 2 kB site runtime.
 */

/** Minimal hyperscript. Children may be nodes, strings, or nested arrays. */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') applyStyle(node, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  append(node, children);
  return node;
}

/**
 * Custom properties have to go through setProperty - assigning them onto
 * `style` silently does nothing, which is exactly the kind of failure that
 * shows up as an element rendering with no colour at all.
 */
function applyStyle(node, styles) {
  for (const [property, value] of Object.entries(styles)) {
    if (property.startsWith('--')) node.style.setProperty(property, String(value));
    else node.style[property] = value;
  }
}

/**
 * Hues that read as a photograph of somewhere people live.
 *
 * The seed stores an arbitrary 0-360 hue per listing, and used raw it produces
 * a rainbow - lilac and mint tiles that look like nothing in an estate agent's
 * window. Snapping to this set keeps the grid varied but plausible: warm wood,
 * sand, terracotta, brick, and the cool cast of daylight through a window.
 */
const PHOTO_HUES = [28, 38, 18, 12, 45, 200, 210, 150];

export const photoHue = (seed) => PHOTO_HUES[Math.abs(Math.round(seed)) % PHOTO_HUES.length];

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
};

/* -------------------------------------------------------------------------
 * Icons - traced to match the stroke weight of the ones on the landing page.
 * ------------------------------------------------------------------------- */
const svg = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;

export const ICONS = {
  arrowLeft: svg('<path d="M15 18l-6-6 6-6"/>'),
  arrowRight: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  check: svg('<path d="M20 6L9 17l-5-5"/>'),
  pin: svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0116 0z"/><circle cx="12" cy="10" r="3"/>'),
  camera: svg(
    '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>',
  ),
  bank: svg('<path d="M3 21h18M3 10h18M5 6l7-3 7 3M6 10v11M18 10v11M10 10v11M14 10v11"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
  lock: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>'),
  shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  bell: svg('<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  google:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="#4285F4" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.2a5.3 5.3 0 01-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.6z"/>' +
    '<path fill="#34A853" d="M12 24c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.8v3A11.5 11.5 0 0012 24z"/>' +
    '<path fill="#FBBC05" d="M5.6 14.7a6.9 6.9 0 010-4.4v-3H1.8a11.5 11.5 0 000 10.4l3.8-3z"/>' +
    '<path fill="#EA4335" d="M12 4.8c1.7 0 3.2.6 4.4 1.7l3.3-3.3A11.5 11.5 0 001.8 7.3l3.8 3C6.5 7.6 9 4.8 12 4.8z"/></svg>',
};

const icon = (name, size = 18) =>
  h('span', {
    class: 'ob-i',
    html: ICONS[name],
    style: { display: 'inline-flex', width: `${size}px`, height: `${size}px` },
  });

export { icon };

/* -------------------------------------------------------------------------
 * Buttons
 * ------------------------------------------------------------------------- */
export function button(label, { variant = '', arrow = false, onClick, disabled = false, type = 'button' } = {}) {
  const inner = h(
    'span',
    { class: 'ob-btn__inner' },
    label,
    arrow ? h('span', { class: 'ob-btn__arrow', html: ICONS.arrowRight, style: { width: '17px', height: '17px', display: 'inline-flex' } }) : null,
  );

  return h(
    'button',
    {
      class: `ob-btn${variant ? ` ob-btn--${variant}` : ''}`,
      type,
      disabled,
      onClick,
    },
    inner,
  );
}

/** Swap a button into a loading state without changing its width. */
export function setLoading(btn, loading, label) {
  const inner = btn.querySelector('.ob-btn__inner');
  if (!inner) return;
  btn.disabled = loading;
  if (loading) {
    btn.dataset.label = inner.textContent;
    inner.replaceChildren(h('span', { class: 'ob-spinner' }), label || '');
  } else {
    inner.replaceChildren(btn.dataset.label || label || '');
  }
}

/* -------------------------------------------------------------------------
 * Option cards
 * ------------------------------------------------------------------------- */
export function option({ value, label, hint, emoji, tall = false, selected = false, onSelect }) {
  const card = h(
    'button',
    {
      class: `ob-option${tall ? ' ob-option--tall' : ''}`,
      type: 'button',
      'data-value': value,
      'data-selected': String(selected),
      'aria-pressed': String(selected),
    },
    emoji ? h('span', { class: 'ob-option__icon' }, emoji) : null,
    h(
      'span',
      { class: 'ob-option__text' },
      h('span', { class: 'ob-option__label' }, label),
      hint ? h('span', { class: 'ob-option__hint' }, hint) : null,
    ),
    h('span', { class: 'ob-option__check', html: ICONS.check }),
  );

  card.addEventListener('click', () => onSelect?.(value, card));
  return card;
}

/** Wire a group of option cards so exactly one is selected at a time. */
export function optionGroup(container, onChange) {
  container.addEventListener('click', (event) => {
    const card = event.target.closest('.ob-option');
    if (!card || !container.contains(card)) return;
    for (const other of container.querySelectorAll('.ob-option')) {
      const isTarget = other === card;
      other.dataset.selected = String(isTarget);
      other.setAttribute('aria-pressed', String(isTarget));
    }
    onChange(card.dataset.value, card);
  });
}

/* -------------------------------------------------------------------------
 * Fields
 * ------------------------------------------------------------------------- */
export function field({ label, optional = false, input, error, hint }) {
  return h(
    'label',
    { class: 'ob-field' },
    label
      ? h(
          'span',
          { class: 'ob-field__label' },
          label,
          optional ? h('span', { class: 'ob-field__optional' }, ' — facultatif') : null,
        )
      : null,
    input,
    hint ? h('span', { class: 'ob-option__hint' }, hint) : null,
    h('span', { class: 'ob-field__error', hidden: !error }, error || ''),
  );
}

export function input(props = {}) {
  return h('input', { class: 'ob-input', autocomplete: 'off', ...props });
}

export function showError(inputEl, message) {
  const wrapper = inputEl.closest('.ob-field');
  const slot = wrapper?.querySelector('.ob-field__error');
  inputEl.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (slot) {
    slot.textContent = message || '';
    slot.hidden = !message;
  }
}

/* -------------------------------------------------------------------------
 * The manual-first shortcut block.
 *
 * Rendered by the three sensitive screens, always after the fields, always as
 * dashed text buttons rather than pills. The hierarchy is the product decision:
 * the camera is an offer the visitor may take, not the path they are put on.
 * ------------------------------------------------------------------------- */
export function shortcuts(label, actions) {
  return h(
    'div',
    { class: 'ob-shortcut' },
    h('p', { class: 'ob-shortcut__label' }, label),
    h(
      'div',
      { class: 'ob-shortcut__actions' },
      actions.map((action) =>
        h(
          'button',
          {
            class: 'ob-shortcut__btn',
            type: 'button',
            disabled: action.disabled,
            title: action.title,
            onClick: action.onClick,
          },
          icon(action.icon, 16),
          action.label,
        ),
      ),
    ),
  );
}

/**
 * Run a shortcut, narrating what it is doing on the button itself.
 *
 * "Ouverture… / Envoi… / Lecture…" tells the person which of three steps they
 * are waiting on. A bare spinner on a task that can take fifteen seconds reads
 * as a hang, and a hung shortcut is worse than no shortcut.
 */
export async function withShortcutStatus(button, run) {
  const original = button.innerHTML;
  const setLabel = (text) => {
    button.replaceChildren(h('span', { class: 'ob-spinner ob-spinner--dark' }), text);
  };

  button.disabled = true;
  try {
    return await run(setLabel);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

/** Feedback line under a shortcut: what was read, or why it failed. */
export function scanNote() {
  const node = h('p', { class: 'ob-scan-note', hidden: true });
  node.show = (message, tone = 'ok') => {
    node.hidden = false;
    node.className = `ob-scan-note ob-scan-note--${tone}`;
    node.textContent = message;
  };
  node.clear = () => {
    node.hidden = true;
  };
  return node;
}

export const note = (text, iconName = 'shield') =>
  h(
    'p',
    { class: 'ob-note' },
    h('span', { class: 'ob-note__icon', html: ICONS[iconName], style: { width: '16px', height: '16px', display: 'inline-flex' } }),
    text,
  );

export const euros = (value) => `${Math.round(value).toLocaleString('fr-FR')} €`;
