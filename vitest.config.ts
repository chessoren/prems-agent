import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The Astro site has no unit tests - it is verified by pixel diff and by
    // the scripted browser run. Only the backend packages are covered here.
    include: ['packages/*/test/**/*.test.ts'],
  },
});
