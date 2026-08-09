/**
 * Framer "appear" animations.
 *
 * Framer describes them declaratively in a JSON script block keyed by
 * `data-framer-appear-id`, with one entry per breakpoint hash:
 *
 *   { "<id>": { "default": { initial: {...}, animate: {...} },
 *               "<bpHash>": { ... } } }
 *
 * That is everything needed both to (a) settle the reference render to the
 * state a real visitor ends up in, and (b) re-implement the animations in the
 * clone without Framer Motion.
 */

/** Serialisable browser function: force every appear element to its end state. */
export const FINALISE_APPEAR = () => {
  const read = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  };

  const data = read('__framer__appearAnimationsContent');
  const breakpoints = read('__framer__breakpoints') || [];
  if (!data) return 0;

  const active = breakpoints.find((b) => window.matchMedia(b.mediaQuery).matches);
  let n = 0;

  for (const el of document.querySelectorAll('[data-framer-appear-id]')) {
    const entry = data[el.getAttribute('data-framer-appear-id')];
    if (!entry) continue;
    const cfg = (active && entry[active.hash]) || entry.default;
    if (!cfg) continue;

    // The end state is always the `animate` block; with x/y/scale/rotate all at
    // their identity values it reduces to "no transform", optionally wrapped in
    // the component's transformTemplate (e.g. a centring translateX(-50%)).
    const tpl = cfg.transformTemplate;
    el.style.opacity = String(cfg.animate?.opacity ?? 1);
    el.style.transform = tpl ? tpl.replace('__Appear_Animation_Transform__', '').trim() : 'none';
    n++;
  }
  return n;
};
