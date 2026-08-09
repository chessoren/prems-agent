/**
 * Appear animations - a drop-in replacement for Framer Motion's appear effects.
 *
 * The original site describes these animations declaratively and then needs
 * ~500kB of React + Framer Motion to play them. The description is all that is
 * actually required, so this reads the same payload and drives it with CSS
 * transitions instead. Roughly 1kB, no dependencies.
 *
 * Payload shape (emitted verbatim by the build):
 *   { animations: { "<id>": { "<bpHash>|default": { initial, animate } } },
 *     breakpoints: [{ hash, mediaQuery }] }
 */

/** Build a CSS transform string from a Framer transform record. */
function toTransform(v, template) {
  if (!v) return '';
  const parts = [];
  if (v.x) parts.push(`translateX(${v.x}px)`);
  if (v.y) parts.push(`translateY(${v.y}px)`);
  if (v.rotate) parts.push(`rotate(${v.rotate}deg)`);
  if (v.rotateX) parts.push(`rotateX(${v.rotateX}deg)`);
  if (v.rotateY) parts.push(`rotateY(${v.rotateY}deg)`);
  if (v.scale != null && v.scale !== 1) parts.push(`scale(${v.scale})`);
  if (v.skewX) parts.push(`skewX(${v.skewX}deg)`);
  if (v.skewY) parts.push(`skewY(${v.skewY}deg)`);
  const own = parts.join(' ');
  if (template) return template.replace('__Appear_Animation_Transform__', own).trim();
  return own || 'none';
}

const easing = (t) =>
  Array.isArray(t?.ease) ? `cubic-bezier(${t.ease.join(',')})` : 'cubic-bezier(.44,0,.56,1)';

export function initAppear(payload) {
  if (!payload || !payload.animations) return;
  const { animations, breakpoints = [] } = payload;

  const active = breakpoints.find((b) => window.matchMedia(b.mediaQuery).matches);
  const configFor = (id) => {
    const entry = animations[id];
    if (!entry) return null;
    return (active && entry[active.hash]) || entry.default || null;
  };

  const targets = [...document.querySelectorAll('[data-framer-appear-id]')]
    .map((el) => ({ el, cfg: configFor(el.getAttribute('data-framer-appear-id')) }))
    .filter((t) => t.cfg);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // With reduced motion (or no JS at all) elements simply stay at their final
  // state - which is how they are authored in the markup, so nothing to do.
  if (reduced) return;

  // 1. snap to the initial state before the first paint we control
  for (const { el, cfg } of targets) {
    const t = cfg.transformTemplate;
    el.style.willChange = 'opacity, transform';
    el.style.opacity = String(cfg.initial?.opacity ?? 0);
    el.style.transform = toTransform(cfg.initial, t);
  }

  // 2. next frame, transition to the animate state
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const { el, cfg } of targets) {
        const tr = cfg.animate?.transition || {};
        const dur = (tr.duration ?? 0.6) * 1000;
        const delay = (tr.delay ?? 0) * 1000;
        el.style.transition =
          `opacity ${dur}ms ${easing(tr)} ${delay}ms, ` +
          `transform ${dur}ms ${easing(tr)} ${delay}ms`;
        el.style.opacity = String(cfg.animate?.opacity ?? 1);
        el.style.transform = toTransform(cfg.animate, cfg.transformTemplate);

        const done = () => {
          el.style.willChange = '';
          el.style.transition = '';
        };
        setTimeout(done, dur + delay + 50);
      }
    });
  });
}
