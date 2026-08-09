/**
 * Appear animations - a drop-in replacement for Framer Motion's appear effects.
 *
 * The original site describes these animations declaratively and then needs
 * ~500kB of React + Framer Motion to play them. The description is all that is
 * actually required, so this reads the same payload and drives it with CSS
 * transitions instead. Roughly 1.5kB, no dependencies.
 *
 * Elements animate when they scroll into view, not all at page load. Framer
 * behaves the same way, and it matters: firing everything at load means that by
 * the time you reach a section it has already faded in, so the page reads as
 * having no animation at all.
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

  // Without JS - or with reduced motion - elements stay at the final state the
  // markup already carries, so there is nothing to undo.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const active = breakpoints.find((b) => window.matchMedia(b.mediaQuery).matches);
  const configFor = (id) => {
    const entry = animations[id];
    if (!entry) return null;
    return (active && entry[active.hash]) || entry.default || null;
  };

  const targets = [...document.querySelectorAll('[data-framer-appear-id]')]
    .map((el) => ({ el, cfg: configFor(el.getAttribute('data-framer-appear-id')) }))
    .filter((t) => t.cfg);
  if (!targets.length) return;

  // 1. snap every target to its initial state before the next paint
  for (const { el, cfg } of targets) {
    el.style.willChange = 'opacity, transform';
    el.style.opacity = String(cfg.initial?.opacity ?? 0);
    el.style.transform = toTransform(cfg.initial, cfg.transformTemplate);
  }

  const play = ({ el, cfg }) => {
    const tr = cfg.animate?.transition || {};
    const dur = (tr.duration ?? 0.6) * 1000;
    const delay = (tr.delay ?? 0) * 1000;
    el.style.transition =
      `opacity ${dur}ms ${easing(tr)} ${delay}ms, transform ${dur}ms ${easing(tr)} ${delay}ms`;
    el.style.opacity = String(cfg.animate?.opacity ?? 1);
    el.style.transform = toTransform(cfg.animate, cfg.transformTemplate);
    setTimeout(() => {
      el.style.willChange = '';
      el.style.transition = '';
    }, dur + delay + 50);
  };

  // 2. play each one as it enters the viewport. rootMargin starts the animation
  //    slightly before the element is actually visible so it is already moving
  //    by the time it appears.
  const byElement = new Map(targets.map((t) => [t.el, t]));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = byElement.get(entry.target);
        if (!target) continue;
        observer.unobserve(entry.target);
        byElement.delete(entry.target);
        play(target);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.01 },
  );

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const { el } of targets) observer.observe(el);
    });
  });
}
