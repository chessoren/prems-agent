/**
 * The address filter, pinned by the things it has already let through.
 *
 * The first production run of the resolver stored three retina image filenames
 * as agency email addresses. Applications would have gone to them.
 */
import { describe, expect, it } from 'vitest';
import { pickForTest } from '../src/agency.js';

describe('agency address selection', () => {
  it('rejects retina image filenames, which really did get through', () => {
    expect(pickForTest(['mobile-century21_hero-6@2x.webp'], 'century21.fr')).toBeNull();
    expect(pickForTest(['logo@3x.png', 'sprite@2x.svg'], 'agence.fr')).toBeNull();
  });

  it('rejects mailboxes that exist for another purpose', () => {
    expect(pickForTest(['rgpd@citya.com'], 'citya.com')).toBeNull();
    expect(pickForTest(['dpo@agence.fr', 'recrutement@agence.fr'], 'agence.fr')).toBeNull();
  });

  it('rejects form placeholders, which the second run really did store', () => {
    // `placeholder="exemple@domaine.fr"` sits in the HTML looking exactly like
    // the thing we came for, and bounces silently.
    expect(pickForTest(['exemple@domaine.fr'], 'agence.fr')).toBeNull();
    expect(pickForTest(['adresse@fournisseur.com'], 'agence.fr')).toBeNull();
    expect(pickForTest(['votre@email.com', 'john.doe@example.com'], 'agence.fr')).toBeNull();
  });

  it('keeps a real address that merely resembles a placeholder', () => {
    // "contact@" is the most common genuine agency mailbox; the filter must not
    // reach it while removing "email@domaine.fr".
    expect(pickForTest(['contact@agence-du-port.fr'], 'agence-du-port.fr'))
      .toBe('contact@agence-du-port.fr');
  });

  it('rejects the CMS vendor, which appears on every site it powers', () => {
    expect(pickForTest(['support@immo-facile.com'], 'agence.fr')).toBeNull();
  });

  it('prefers a business mailbox on the agency own domain', () => {
    expect(pickForTest(['jean.dupont@agence.fr', 'contact@agence.fr'], 'agence.fr'))
      .toBe('contact@agence.fr');
  });

  it('prefers the agency domain over a stray address', () => {
    expect(pickForTest(['someone@autre.com', 'accueil@agence.fr'], 'www.agence.fr'))
      .toBe('accueil@agence.fr');
  });

  it('accepts a personal mailbox when it is all there is', () => {
    // Plenty of small agencies genuinely run on one gmail address.
    expect(pickForTest(['agenceduport75@gmail.com'], 'agence.fr'))
      .toBe('agenceduport75@gmail.com');
  });

  it('returns null rather than a guess when nothing qualifies', () => {
    expect(pickForTest([], 'agence.fr')).toBeNull();
    expect(pickForTest(['noreply@agence.fr'], 'agence.fr')).toBeNull();
  });
});

describe('dead-lettering', () => {
  // Not a unit test of the worker - a statement of the rule the worker broke.
  //
  // The first version dead-lettered "no Gmail connected", which is permanent,
  // for a condition the client fixes by connecting their mailbox. It consumed
  // 103 matches in twenty minutes.
  it('separates what cannot succeed from what cannot succeed yet', () => {
    const permanent = ['adresse refusée par le fournisseur', 'message malformé'];
    const recoverable = ['aucune boîte Gmail connectée', 'quota temporairement dépassé'];

    const isPermanent = (reason: string) =>
      !/gmail|connect|quota|temporaire|réseau/i.test(reason);

    for (const r of permanent) expect(isPermanent(r)).toBe(true);
    for (const r of recoverable) expect(isPermanent(r)).toBe(false);
  });
});
