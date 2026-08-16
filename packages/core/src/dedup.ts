/**
 * Cross-source identity.
 *
 * The same apartment posted by one agency to four portals must become one
 * apartment to the client - otherwise the "8 matches" that make the product
 * feel alive are two apartments seen four times each, and we apply to the same
 * agent four times, which is the fastest way to burn a client's credibility.
 *
 * The hash is deliberately coarse. Prices get rounded to the nearest 10 euros
 * and surfaces to the nearest square metre because portals disagree by small
 * amounts on both - one includes a cellar in the surface, another rounds the
 * rent up. Two listings that differ only inside that tolerance are the same
 * flat; anything coarser starts merging genuinely different apartments in the
 * same building, which is the more expensive mistake.
 */

import { createHash } from 'node:crypto';

/**
 * Normalise a French street address enough to compare it.
 *
 * Accents, case, punctuation and the usual abbreviations all vary between
 * sites for the same street. What survives is the part that does not.
 */
export function normaliseAddress(raw: string): string {
  let text = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const abbreviations: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bav(e|enue)?\b/g, 'avenue'],
    [/\bbd|boul(evard)?\b/g, 'boulevard'],
    [/\br(ue)?\b/g, 'rue'],
    [/\bpl(ace)?\b/g, 'place'],
    [/\bimp(asse)?\b/g, 'impasse'],
    [/\bst\b/g, 'saint'],
    [/\bste\b/g, 'sainte'],
  ];
  for (const [pattern, replacement] of abbreviations) text = text.replace(pattern, replacement);

  // Filler words carry no discriminating power and are written inconsistently.
  return text.replace(/\b(de|du|des|la|le|les|l|d)\b/g, '').replace(/\s+/g, ' ').trim();
}

export interface DedupInput {
  readonly postcode: string | null;
  readonly street: string | null;
  readonly surfaceM2: number | null;
  readonly totalRentEur: number;
  readonly rooms: number | null;
}

/**
 * A stable key for "the same apartment".
 *
 * Returns null when there is not enough to identify anything. A hash built from
 * mostly-missing fields would collide across unrelated listings, and a false
 * merge loses an apartment the client could have had - strictly worse than
 * carrying a duplicate.
 */
export function dedupHash(input: DedupInput): string | null {
  if (!input.postcode || !input.street || input.surfaceM2 === null) return null;

  const parts = [
    input.postcode.trim(),
    normaliseAddress(input.street),
    String(Math.round(input.surfaceM2)),
    String(Math.round(input.totalRentEur / 10) * 10),
    input.rooms === null ? '?' : String(input.rooms),
  ];

  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/** Cosine similarity, for comparing two embeddings of the same dimension. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}
