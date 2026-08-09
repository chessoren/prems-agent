/**
 * Stage 6 - Recover collapsed FAQ answers.
 *
 * Framer server-renders only the accordion items that happen to be open, so an
 * export keeps every question but loses most answers. Driving the offline
 * original does not help either: the accordion is a code component and its
 * click handling does not survive without Framer's runtime.
 *
 * The content itself is still there though - it is compiled into the page's JS
 * chunk as component props. This reads those props back out.
 *
 * The prop names are hashed per site, so rather than hard-coding them we find
 * the key whose values match the questions already visible in the markup, then
 * take the key that pairs with it.
 *
 * Output: .cache/faq.json -> [{ question, answer }]
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { CACHE_DIR, VENDOR_DIR } from './lib/config.mjs';

const PROP_RE = /([A-Za-z_$][\w$]*)\s*:\s*`((?:[^`\\]|\\.)*)`/g;

/** Questions as they appear in the shipped markup. */
async function questionsFromMarkup() {
  const html = await readFile(join(CACHE_DIR, 'raw', 'index.html'), 'utf8');
  const $ = cheerio.load(html, { decodeEntities: false });
  const seen = new Set();
  $('[data-framer-name="Question"]').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) seen.add(text);
  });
  return seen;
}

const unescape = (s) =>
  s.replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');

async function main() {
  const questions = await questionsFromMarkup();
  console.log(`${questions.size} questions in the markup`);

  const files = (await readdir(VENDOR_DIR + '/scripts')).filter((f) => f.endsWith('.mjs'));
  let best = null;

  for (const file of files) {
    const src = await readFile(join(VENDOR_DIR, 'scripts', file), 'utf8');

    // key -> ordered list of literal values
    const byKey = new Map();
    for (const m of src.matchAll(PROP_RE)) {
      const [, key, value] = m;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ value: unescape(value), at: m.index });
    }

    // The question key is the one whose values are the questions we know.
    let questionKey = null;
    for (const [key, entries] of byKey) {
      const hits = entries.filter((e) => questions.has(e.value.replace(/\s+/g, ' ').trim())).length;
      if (hits >= Math.min(3, questions.size) && hits >= entries.length / 2) {
        questionKey = key;
        break;
      }
    }
    if (!questionKey) continue;

    const qEntries = byKey.get(questionKey);

    // The answer key occurs the same number of times and carries longer prose.
    let answerKey = null;
    let bestLen = 0;
    for (const [key, entries] of byKey) {
      if (key === questionKey || entries.length !== qEntries.length) continue;
      const avg = entries.reduce((s, e) => s + e.value.length, 0) / entries.length;
      const distinct = new Set(entries.map((e) => e.value)).size;
      if (avg > bestLen && avg > 40 && distinct === entries.length) {
        bestLen = avg;
        answerKey = key;
      }
    }
    if (!answerKey) continue;

    // Pair each question with the answer literal nearest to it in the source.
    const aEntries = byKey.get(answerKey);
    const pairs = qEntries.map((q) => {
      const nearest = aEntries.reduce((acc, a) =>
        Math.abs(a.at - q.at) < Math.abs(acc.at - q.at) ? a : acc,
      );
      return { question: q.value.trim(), answer: nearest.value.trim() };
    });

    console.log(`  ${file}: keys ${questionKey}/${answerKey}, ${pairs.length} pairs`);
    best = pairs;
    break;
  }

  if (!best) {
    console.error('could not locate the FAQ props in any bundle');
    process.exit(1);
  }

  const distinct = new Set(best.map((p) => p.answer)).size;
  console.log(`\n${best.length} questions, ${distinct} distinct answers`);
  for (const p of best) {
    console.log(`  ${String(p.answer.length).padStart(4)} chars  ${p.question.slice(0, 58)}`);
  }
  if (distinct !== best.length) console.log('WARNING: answers are not all distinct');

  await writeFile(join(CACHE_DIR, 'faq.json'), JSON.stringify(best, null, 2));
  console.log(`\nsaved -> ${join(CACHE_DIR, 'faq.json')}`);
}

await main();
