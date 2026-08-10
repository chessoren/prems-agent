import { defineConfig } from 'astro/config';

// Static output: the whole point of the export is a site that can be hosted
// anywhere as plain files.
export default defineConfig({
  // The deployed origin. Overridden by PUBLIC_SITE_URL so a preview deployment
  // does not have to claim the production domain.
  site: process.env.PUBLIC_SITE_URL || 'https://prems.getmira.run',
  output: 'static',
  build: { format: 'directory', inlineStylesheets: 'never' },
  devToolbar: { enabled: false },
});
