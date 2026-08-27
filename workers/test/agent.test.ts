/**
 * The one piece of the runtime that can be tested without a model.
 *
 * A fenced answer used to become a parse error, and a parse error becomes the
 * flat fallback template - a silent downgrade nobody would notice until they
 * read forty identical applications.
 */
import { describe, expect, it } from 'vitest';
import { stripFence } from '../src/agent.js';

describe('stripFence', () => {
  it('leaves bare JSON alone', () => {
    expect(stripFence('{"a":1}')).toBe('{"a":1}');
  });

  it('unwraps a fence, labelled or not', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
});
