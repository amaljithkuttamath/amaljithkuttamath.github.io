import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import sitemap from '@astrojs/sitemap';

// Read .env (incl. non-PUBLIC vars) at config time. LANGSMITH_API_KEY is used
// ONLY here, in the Node dev server — it is never referenced from client code,
// so it can't be inlined into the public bundle. See src/lib/chitti/tracing.ts.
const env = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '');

// Dev-only relay for Chitti's optional LangSmith tracing: the browser POSTs to
// same-origin /langsmith/* (no key, no CORS); the dev server forwards to
// LangSmith and injects the key. Only wired up when a key is present, so `npm
// run dev` without one behaves exactly as before. There is no such relay in the
// static build — to trace the DEPLOYED site, point PUBLIC_LANGSMITH_INGEST_URL
// at a serverless relay that holds the key instead.
const langsmithProxy = env.LANGSMITH_API_KEY
  ? {
      '/langsmith': {
        target: 'https://api.smith.langchain.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/langsmith/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('x-api-key', env.LANGSMITH_API_KEY);
          });
        },
      },
    }
  : {};

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
  vite: {
    server: { proxy: langsmithProxy },
  },
});
