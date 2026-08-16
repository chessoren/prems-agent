/**
 * Every adapter, keyed by the slug used in `sources.slug` and in SOURCE_SLUG.
 *
 * Adding a source is: an adapter file, a line here, a row in `sources`, and a
 * Cloud Scheduler job. No new image, no new deployment.
 */
import type { SourceAdapter } from './types.js';
import { bienici } from './bienici.js';

export const ADAPTERS: Readonly<Record<string, SourceAdapter>> = {
  [bienici.slug]: bienici,
};
