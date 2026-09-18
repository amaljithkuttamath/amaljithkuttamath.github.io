# Jev + Deep Agents showcase runtime

This is a bounded support-desk agent. Jev makes every semantic tool/argument decision. `create_deep_agent` executes the actual Python tools and feeds their results back. No generative model is used: final prose is a code template, and the workspace contains invented orders. Preparing a resolution changes only this run's in-memory draft.

The adapter follows TypeSafe's [function-calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling): closed-set tool/argument Choices, Noul flags, an explicit optional-argument presence question, and consumption of only the selected tool's answers. The demo's 0.5 flag threshold is illustrative, not a calibrated deployment policy. This is not a general provider adapter for arbitrary Deep Agents filesystem, free-text, or code-generation tools. Those tools and the general-purpose subagent are disabled by the harness profile.

## Local development

```sh
python3.13 -m venv .venv-jev
.venv-jev/bin/pip install -r agent/requirements.txt
# Supply TYPESAFE_API_KEY in the server environment, or use --credentials with a local env file.
.venv-jev/bin/python agent/jev_demo/server.py
# In another terminal:
npm run dev
```

Open `/apps/jev`. Astro's development-only proxy connects `/api/jev/*` to the loopback server on port 8765. The browser never receives the TypeSafe key. The live runner streams decisions and tool results as newline-delimited JSON; cancellation closes the stream and stops after any in-flight API call. One run executes at a time, with at most eight Jev decisions and a 25-second per-request timeout.

The static GitHub Pages site replays recorded agent runs. **It does not run a live backend.** TypeSafe did not allow CORS from the site origin when inspected on September 17, 2026. A hosted live version needs an authenticated backend with quotas; this development server intentionally listens only on loopback and is not a deployment service. No credentials belong in the repository or public build.

## Reproduce and test

```sh
.venv-jev/bin/python -m unittest discover -s agent/jev_demo -p 'test_*.py'
.venv-jev/bin/python agent/jev_demo/record.py --credentials /path/to/local.env --out src/data/jev/agent
npm test
npm run build
```

The recording command makes paid TypeSafe requests for three demo scenarios. It writes the exact state, questions, returned probabilities, real tool outputs, and final workspace. It retains errors rather than manufacturing a successful run. These handcrafted examples are not a benchmark. The out-of-stock recording includes an initially rejected tool call followed by recovery.

The eight single-call prompt recordings in `src/data/jev/recordings.json` came from the earlier live prompt trials, including the unsuccessful code repair-location refinement. No source response was edited to improve an answer.

On Node 25, run tests with `NODE_OPTIONS=--no-experimental-webstorage npm test`; CI uses Node 22. This avoids Node 25's added global localStorage changing an existing Chitti test's environment.

## Classification lab

The default page now offers six dedicated tasks: sentiment and sarcasm (including aspect opinions), support triage, content moderation, lead qualification, document routing, and claim/source evidence checking. The shared task definitions live in `src/data/jev/labs.json`; the browser and Python backend use the same questions. Fifteen examples have actual saved responses in `lab-recordings.json`. Editing input hides old answers. The review slider uses the selected-label probability; its threshold is illustrative and does not alter the model output. The lead composite uses declared, normalized rubric weights, not a probability of purchase.

`POST /api/jev/classify` accepts only a named task and its required input fields. It makes one TypeSafe call and validates the response before returning it. It shares the loopback/origin restrictions and single-run limit with the agent endpoint. The UI supports fresh local inference, request copying, and result JSON downloads. Public Pages remains recorded mode; storing the API key in an Actions secret does not create a public runtime or expose it to the static build.

To regenerate the examples (15 paid API requests):

```sh
.venv-jev/bin/python agent/jev_demo/record_labs.py --credentials /path/to/local.env
```

The prompts adapt TypeSafe's intent-routing, guardrail, citation-checking, and composite-scoring patterns, linked within each lab. No model-generated prose, automatic moderation actions, real sales decisions, or external document mutations are involved.
