import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://amaljithkuttamath.github.io',
  output: 'static',
  // Retired sections (/playground, /blog, /work, /trust-bench) still ship as
  // static redirect stubs so old inbound links keep working, but they must not
  // be submitted for indexing: a sitemap entry asks a crawler to index a page
  // whose only content is a redirect, and competes with the real destination.
  integrations: [
    sitemap({
      filter: (page) =>
        !/\/(playground|blog|work|trust-bench)(\/|$)/.test(new URL(page).pathname),
    }),
  ],
});
