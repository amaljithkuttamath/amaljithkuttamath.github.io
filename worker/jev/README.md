# Public Jev classification API

Cloudflare Worker for the six named classification tasks and two opt-in Chitti tasks: `chitti_route` and `chitti_review`. All eight share the same hard quota. The existing GitHub Pages site remains static and connects through `PUBLIC_JEV_API_URL`. The Python Deep Agents runner remains local; this Worker does not implement agent execution.

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

## Chitti assist

Enable **Use Jev for dataset routing & evidence checks** in Chitti’s Connect → Model & databases before starting a full agent conversation. Chitti still requires the selected generative provider for planning, tool calls, code, and prose. Its deterministic direct lookups remain model-free.

The shared prompts are in `src/data/jev/chitti-tasks.json`. Routing reviews at most eight retrieved candidates and promotes only a supplied candidate with at least 80% selected-label probability; an abstention, invalid response, or outage preserves the original order. The source filter and fetch guards still apply. The lexical retrieval receipt remains distinct from Jev’s routing receipt.

Review replaces the second generative verifier with five independent Noul checks over the question, finding, chart, fetched rows, and citation metadata. Every check must reach 90%. Both thresholds are uncalibrated; a passed review is a model judgment, not proof. Missing evidence can trigger Chitti’s existing single retry. Oversized evidence is not truncated, and quota/provider failures report unavailable without retrying the agent. Public responses contain no key; UI receipts expose judgments and probabilities.

Each full-agent turn allows at most two routing attempts plus two reviews (the latter includes the existing single correction pass). Quotas remain 5/minute and 20/day per IP, 200/day total across Chitti and the Jev notebook. Review state is capped at 22,000 characters and the complete request at 32 KiB. Inputs and outputs are not stored by this Worker.
