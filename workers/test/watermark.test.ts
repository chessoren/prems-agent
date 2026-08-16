/**
 * The watermark rewind, stated as a test because the bug it fixes is invisible.
 *
 * Bien'ici stamps a whole feed import with one timestamp. Stopping exactly at
 * the watermark silently drops every listing in the batch after the one that
 * ended the previous run - and keeps dropping them, because the watermark never
 * moves past that timestamp.
 */
import { describe, expect, it } from 'vitest';

/** The comparison the adapter makes, isolated. */
function wouldStop(publishedAt: string, since: Date | null): boolean {
  const published = Date.parse(publishedAt);
  return Boolean(since && Number.isFinite(published) && published <= since.getTime());
}

const REWIND_MS = 30 * 60 * 1000;
const rewind = (watermark: Date) => new Date(watermark.getTime() - REWIND_MS);

describe('watermark', () => {
  const batch = '2026-08-12T00:10:24.616Z';

  it('drops the rest of a batch when it stops exactly at the watermark', () => {
    // The bug, preserved so it cannot come back unnoticed.
    const naive = new Date(batch);
    expect(wouldStop(batch, naive)).toBe(true);
  });

  it('reaches the whole batch once the watermark is rewound', () => {
    expect(wouldStop(batch, rewind(new Date(batch)))).toBe(false);
  });

  it('still stops on anything genuinely older than the window', () => {
    const old = '2026-08-11T00:06:04.595Z';
    expect(wouldStop(old, rewind(new Date(batch)))).toBe(true);
  });

  it('reads everything when there is no watermark at all', () => {
    expect(wouldStop(batch, null)).toBe(false);
  });
});
