import { defineConfig } from 'astro/config';

// Static output: the whole point of the export is a site that can be hosted
// anywhere as plain files.
export default defineConfig({
  site: 'https://prems.framer.ai',
  output: 'static',
  build: { format: 'directory', inlineStylesheets: 'never' },
  devToolbar: { enabled: false },
});
