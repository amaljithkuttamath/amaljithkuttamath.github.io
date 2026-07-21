// budgets.ts — the hard, code-enforced budgets for one user turn: the tool-call
// cap, the recursive-llm() caps + data-size limit, and the depth-1 delegation
// bounds. Centralized so the prompt text (which quotes these numbers to the
// model) and the loop enforcement can never drift apart.
export const MAX_TOOL_CALLS = 12;

// RLM (Recursive Language Model) bounds for the llm() primitive exposed inside
// execute_js. Hard caps, enforced in code: a run can make at most
// MAX_LLM_PER_RUN calls, and a whole user turn at most MAX_LLM_PER_TURN across
// every execute_js run in it (shared counter). Serialized `data` is refused
// past LLM_DATA_CAP bytes so a single call can't smuggle the whole context
// back into the model — the code must slice smaller. Exceeding any of these
// rejects with a clear, catchable error the model's code can handle.
export const MAX_LLM_PER_RUN = 4;
export const MAX_LLM_PER_TURN = 8;
export const LLM_DATA_CAP = 20_000;

// Depth-1 delegation bounds (delegate_source). A turn may spawn at most
// MAX_DELEGATIONS_PER_TURN per-source sub-agents (shared counter, same pattern
// as turnLlmCalls), and each sub-agent may make at most MAX_SUBAGENT_CALLS tool
// calls before it must return_findings or is stopped. Sub-agent llm() calls
// draw from the SAME per-turn llm budget (MAX_LLM_PER_TURN) as the main loop.
export const MAX_DELEGATIONS_PER_TURN = 3;
export const MAX_SUBAGENT_CALLS = 6;
