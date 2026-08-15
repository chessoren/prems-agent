/**
 * A client must not lose an apartment to themselves.
 *
 * Pinned by what the running system actually produced: of 147 matches marked
 * `served_higher_priority_client`, 86 were one client's second search losing to
 * their own first. `skipped_reason` is shown to the client, so that was a false
 * statement rendered in the interface.
 */
import { describe, expect, it } from 'vitest';
import { collapsePerClient } from '../src/match.js';

const row = (user_id: string, score: number, search_id = `${user_id}-${score}`) => ({
  c: { user_id, search_id },
  score,
});

describe('collapsePerClient', () => {
  it('keeps one row per client, the best-scoring one', () => {
    const { served, alsoRan } = collapsePerClient([
      row('alice', 0.61, 'alice-a'),
      row('alice', 0.83, 'alice-b'),
    ]);

    expect(served).toHaveLength(1);
    expect(served[0]!.c.search_id).toBe('alice-b');
    expect(alsoRan).toHaveLength(1);
    expect(alsoRan[0]!.c.search_id).toBe('alice-a');
  });

  it('preserves priority order across clients', () => {
    // `eligible_clients` returns rows already ordered by priority, and that
    // ordering is the whole fairness guarantee - collapsing must not reorder it
    // by score.
    const { served } = collapsePerClient([
      row('first', 0.55),
      row('second', 0.99),
      row('third', 0.72),
    ]);

    expect(served.map((s) => s.c.user_id)).toEqual(['first', 'second', 'third']);
  });

  it('does not let one client with two searches occupy two slots', () => {
    // The latent bug behind the visible one: at applications_per_listing = 2,
    // the old slice took two adjacent rows - both of them alice's - and bob,
    // who had waited longer than anyone, got nothing.
    const { served } = collapsePerClient([
      row('alice', 0.9, 'alice-a'),
      row('alice', 0.8, 'alice-b'),
      row('bob', 0.7),
    ]);

    expect(served.map((s) => s.c.user_id)).toEqual(['alice', 'bob']);
    expect(served.slice(0, 2).map((s) => s.c.user_id)).toEqual(['alice', 'bob']);
  });

  it('leaves a single row per client untouched', () => {
    const { served, alsoRan } = collapsePerClient([row('alice', 0.9), row('bob', 0.4)]);
    expect(served).toHaveLength(2);
    expect(alsoRan).toHaveLength(0);
  });

  it('handles an empty candidate list', () => {
    expect(collapsePerClient([])).toEqual({ served: [], alsoRan: [] });
  });
});
