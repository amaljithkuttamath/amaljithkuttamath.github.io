# Public Jev classification API

Cloudflare Worker for the six named classification tasks. The existing GitHub Pages site remains static and connects through `PUBLIC_JEV_API_URL`. The Python Deep Agents runner remains local; this Worker does not implement agent execution.

## Limits and data handling

- One provider call per valid request; no automatic retries.
- 5 requests/minute and 20/day per Cloudflare-observed IP address; 200/day for the entire demo. Fixed UTC windows; all provider attempts, including failures, consume the budget.
- One Durable Object reserves the global and per-IP budgets in a storage transaction before calling TypeSafe. Quota failure rejects inference. The tiny shared counter is intentional for this capped demo, not a high-throughput service design.
- Only known task names and exact bounded string fields are accepted. Clients cannot select models, change prompts, or proxy arbitrary URLs.
- Stored usage contains counts and daily HMAC-derived IP identifiers, never raw IPs, prompts, responses, or credentials. The usage record is replaced on the first accepted request each new UTC day. It contains at most 200 client records.
- CORS permits only `https://amaljithkuttamath.github.io`. CORS is not authentication; the global cap is the spending protection even if callers spoof Origin or change IPs. These are request caps, not a dollar-denominated billing guarantee.
- `TYPESAFE_API_KEY` is a Worker secret. It is never in Pages build variables. Worker observability is disabled; provider data retention is governed separately by TypeSafe.

## Validate

From this directory:

```sh
npm ci
npm run check
```

`check` bundles without deployment, then tests the actual Durable Object with simultaneous requests. Root `npm test` covers request validation, provider failures, origin checks, frontend endpoint configuration, and quota policy.

## Deploy after account access and secret-storage authorization

Deployed API origin: `https://jev-public-classification.jev-public-classification.workers.dev`. The repository variable `PUBLIC_JEV_API_URL` points the Pages build at this service.

```sh
npx wrangler login --device --scopes account:read user:read workers_scripts:write --use-keyring
npm run deploy
npx wrangler secret put TYPESAFE_API_KEY
```

Enter the key at the private secret prompt, never as a CLI argument. A deployment without a secret fails closed. Once configured, verify health with an `Origin: https://amaljithkuttamath.github.io` header and perform one synthetic classification. Test 429 behavior with the local runtime rather than spending the production quota.

Set GitHub repository Actions **variable** `PUBLIC_JEV_API_URL` to the exact HTTPS origin printed by Wrangler (no path). Redeploy GitHub Pages. This non-secret URL is the only backend configuration exposed in the frontend. The existing GitHub Actions secret does not automatically become a Worker secret.

Verify a custom input from the published page, with `LIVE RESULT` and an updated result. Before publishing subsequent frontend changes, verify the service remains reachable. Device authorization avoids the short-lived localhost callback used by the default login flow.
