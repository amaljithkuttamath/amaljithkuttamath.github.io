# Chat-first workspace and chart contract

Approved direction: conversation is primary. Charts, data and sources belong to
assistant messages. One composer provides follow-ups and model selection; the
sidebar opens recent chats, recorded examples and saved charts.

Acceptance:
- C1: Follow-ups append visible turns and retain earlier evidence. Undo/redo and
  branching preserve the exact selected parent. New chat starts empty.
- C2: One composer supports send/stop, direct queries and provider/model selection.
  A locked model requires a new chat to switch. Credentials remain private.
- C3: A bounded chart contract carries stable series identity/colors, units,
  source bindings, point annotations and highlighting.
- C4: Invalid numbers are omitted rather than coerced to zero. Mismatched units,
  nonexistent declared citations and false observed bindings reject a new
  model-rendered chart. Legacy specs may omit bindings. Derived series describe the
  method; this is provenance, not proof of mathematical or causal correctness.
- C5: Focus, time-range, chart-type and highlight edits retain evidence/colors,
  discard obsolete verdicts, and work without model calls.
- C6: Old links/demos work. New fields survive share/dashboard whitelists. Never
  accept arbitrary CSS, HTML, callbacks or chart-library options from the model.

Checks: chart-contract/renderer regressions (C3–C6), workspace/protocol tests
(C1–C2/C5), full npm test, production build, desktop/mobile browser inspection.
Production is published through the repository's CI and GitHub Pages workflows.

Implemented and checked on 2026-11-02:
- 918 tests pass across 55 files, including branch context, model restoration,
  streamed chart replacement, source bindings, colors, units and local edits.
- Production build passes (23 pages); import-cycle guard passes in the suite.
- Browser checks cover desktop and 390px mobile, recorded multiseries charts,
  highlighting, year filtering, grouped bars, sources, new chat and model menu.
  No browser console errors were reported. Provider requests use mocks in tests;
  no live paid-model request was made for verification.
- On this Node 25 host, tests run with
  `NODE_OPTIONS=--no-experimental-webstorage npm test` to avoid Node's global
  localStorage shadowing the suite's browser-storage setup.
- `tsc --noEmit` still reports the existing core catalogue cast, provider-test
  tuple and missing jsdom declaration errors; new files introduce no diagnostics.

