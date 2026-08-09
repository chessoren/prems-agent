/**
 * Point the call-to-action buttons at the onboarding flow.
 *
 *   node tools/retarget-ctas.mjs [--dry]
 *
 * Every "Join Waitlist" / "S'inscrire" style button linked to the external app.
 * They now open /onboarding. "Se Connecter" is deliberately left alone: it is a
 * sign-in entry point, not a signup, and no /login page exists yet - sending
 * returning users into a signup flow would be worse than the current link.
 *
 * The markup is generated Framer output, one very long line per section, so
 * this walks anchors rather than running a blind find-and-replace.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const EXTERNAL = 'https://prems-ai.vercel.app';
const TARGET = '/onboarding';

/** Anchors whose visible text matches this keep their existing destination. */
const KEEP_EXTERNAL = /se\s+connecter/i;

const dry = process.argv.includes('--dry');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (extname(path) === '.astro') out.push(path);
  }
  return out;
}

/** Plain text of an anchor, for deciding whether it is a sign-in link. */
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

let changed = 0;
let kept = 0;
const touched = [];

for (const file of walk('src')) {
  const original = readFileSync(file, 'utf8');
  let source = original;
  let index = 0;
  let fileChanges = 0;

  while ((index = source.indexOf(EXTERNAL, index)) !== -1) {
    const start = source.lastIndexOf('<a ', index);
    const end = source.indexOf('</a>', index);

    if (start === -1 || end === -1) {
      index += EXTERNAL.length;
      continue;
    }

    const anchor = source.slice(start, end + 4);
    if (KEEP_EXTERNAL.test(textOf(anchor))) {
      kept++;
      index += EXTERNAL.length;
      continue;
    }

    source = source.slice(0, index) + TARGET + source.slice(index + EXTERNAL.length);
    index += TARGET.length;
    fileChanges++;
    changed++;
  }

  if (fileChanges && !dry) writeFileSync(file, source);
  if (fileChanges) touched.push(`${file} (${fileChanges})`);
}

console.log(touched.join('\n'));
console.log(`\n${changed} CTA redirigés vers ${TARGET}`);
console.log(`${kept} liens « Se Connecter » laissés inchangés`);
if (dry) console.log('(dry run — aucun fichier écrit)');
