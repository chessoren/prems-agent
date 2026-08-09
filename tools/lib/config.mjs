import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(here, '../..');
export const CACHE_DIR = resolve(ROOT, '.cache');
export const SRC_DIR = resolve(ROOT, 'src');
export const PUBLIC_DIR = resolve(ROOT, 'public');
/**
 * Mirrored Framer JS bundles live here, not in public/: they are inputs to the
 * reference render only. The generated site never loads them, so shipping them
 * in dist/ would be dead weight.
 */
export const VENDOR_DIR = resolve(CACHE_DIR, 'vendor');

export const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://prems.framer.ai';

/** Hosts whose assets we mirror locally. */
export const ASSET_HOSTS = [
  'framerusercontent.com',
  'fonts.gstatic.com',
  'app.framerstatic.com',
];

export const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** The three breakpoints Framer generated for this site. */
export const BREAKPOINTS = [
  { name: 'desktop', width: 1440 },
  { name: 'tablet', width: 900 },
  { name: 'phone', width: 390 },
];
