---
layout: ../../layouts/Post.astro
title: "Claude Code Treats Its System Prompt Like Infrastructure"
date: "2026-04-01"
description: "I read Claude Code's source looking for prompt engineering. I found cost engineering. Cache boundaries, sticky latches, circuit breakers, and the 77% number."
tags: ["agents", "claude-code", "prompt-engineering", "cost-engineering"]
thread: "agents"
type: "deep-dive"
featured: true
---

I read Claude Code's source. I was looking for how they handle the system prompt, because that's the part of any agent system that quietly determines whether it works at scale or just works in demos.

I expected clever prompting. What I found was cost engineering.

## The function named DANGEROUS

In `systemPromptSections.ts`, there are two ways to define a section of the system prompt. The safe way:

```typescript
function systemPromptSection(name: string, compute: ComputeFn): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}
```

And the dangerous way:

```typescript
function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}
```

The `_reason` parameter does nothing at runtime. It's documentation. You want a section that recomputes every turn? You have to explain why. And the function name screams at you in every diff.

The system prompt isn't a string. It's a registry of named sections, each one a function that computes its content from session state. Safe sections are cached until `/clear` or compaction. Dangerous ones recompute every turn and break the prompt cache when their output changes.

The naming convention is doing real work here. Not technically. Culturally. It makes the cost of volatility visible at the point where someone introduces it.

## Where the money splits

Anthropic's API caches prompt prefixes. Same prefix, lower cost on repeat calls. Claude Code exploits this by splitting the prompt at an explicit boundary marker:

```
[stable instructions, security rules, tool docs]  → cacheScope: 'global'
__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__
[user memory, language prefs, MCP config]          → cacheScope: null
```

Stable content before the boundary, cached globally across all users. Dynamic content after, not cached. The `splitSysPromptPrefix()` function walks the prompt array, finds the marker, and routes blocks to the right tier:

```typescript
if (i < boundaryIndex) {
  staticBlocks.push(block)    // → 'global'
} else {
  dynamicBlocks.push(block)   // → null
}
```

When MCP tools are present, the system abandons global caching entirely and falls back to org-level scope. Tool discovery is dynamic, so tool schemas can't be globally cached. The code tracks this as a strategy: `'tool_based' | 'system_prompt' | 'none'`.

That strategy tracking is interesting. It's not just "cache or don't cache." It's "know which caching regime you're in and why it changed."

## The 77% number

The cache break detection system hashes the system prompt, tool schemas, model name, beta headers, and effort value before every API call. After the call, it checks `cache_read_input_tokens`. If reads drop more than 5% AND more than 2,000 tokens, it flags a break, writes a diff to `/tmp/cache-break-XXXX.diff`, and logs an analytics event.

One comment in the type definitions caught me:

```typescript
// Per-tool schema hash. Diffed to name which tool's description changed
// when toolSchemasChanged but added=removed=0 (77% of tool breaks per
// BQ 2026-03-22). AgentTool/SkillTool embed dynamic agent/command lists.
perToolHashes: Record<string, number>
```

A BigQuery analysis from nine days before the leak. 77% of tool-related cache breaks came from tool descriptions changing, not tools being added or removed. The `AgentTool` and `SkillTool` embed dynamic lists of available agents and commands in their descriptions. Every time an MCP server connects or a permission changes, the list updates, the description changes, the hash changes, cache breaks.

Their fix: move the volatile content out of tool descriptions and into "attachment messages," meta user-role messages wrapped in `<system-reminder>` tags. The tool description stays frozen. The volatile data flows through the message stream instead.

The interesting thing isn't the fix. It's that they had the instrumentation to find the problem. Without per-tool schema hashing and cache break logging, you'd never isolate "tool descriptions are silently costing us money" from all the other reasons a cache might miss.

## Sticky latches

Feature flags toggle. Beta headers change. Each change can invalidate the prompt cache. Claude Code uses one-way latches: once a beta header is sent in a session, it stays on, even if the flag flips back.

The type definition tells the story through its comments:

```typescript
autoModeActive: boolean      // "should NOT break cache anymore (sticky-on latched)"
cachedMCEnabled: boolean     // "should NOT break cache anymore (sticky-on latched)"
isUsingOverage: boolean      // "should NOT break cache anymore (eligibility is latched)"
```

Each "should NOT break cache anymore" is a scar. A flag oscillated, cache broke repeatedly, someone added a latch, the tracking field stayed as verification that the fix holds.

There's something honest about these comments. They don't explain the architecture. They explain the pain that shaped it.

## Compaction with re-injection

When context fills up, Claude Code runs a pipeline:

1. Strip images from messages (they waste tokens in the summary call and can trigger prompt-too-long)
2. Strip attachment types that get re-injected anyway (skill listings, discovery results)
3. Summarize older messages via a separate API call
4. Re-inject critical context the summary lost

Step 4 is the one worth paying attention to. After summarizing, the system re-injects up to 5 recently-modified files and up to 25,000 tokens of active skill content. Then it clears the entire system prompt section cache, forcing every section to recompute on the next turn.

A summary captures the fact that you edited a file. Re-injection puts the file content back. The model needs the content, not the fact.

There's a circuit breaker on the compaction loop. After 3 consecutive failures, it stops. A source comment explains why:

> 1,279 sessions had 50+ consecutive failures (up to 3,272) in a single session, wasting ~250K API calls/day globally.

250,000 wasted API calls per day. From a retry loop without a circuit breaker. That's the kind of number that makes you go look at your own retry loops.

## What's worth taking

Not all of this transfers to every agent system. If you're making 5 API calls per task, the cache boundary and sticky latches are overkill. But if you're building agents that run dozens or hundreds of calls per session, these patterns are the difference between viable costs and runaway spend.

The ones that generalize:

**Name your volatility.** If a section of your prompt changes between turns, know which one, and make the cost visible at the call site.

**Split at a boundary.** Stable content first, dynamic content after. Different cache scopes on each side.

**Instrument cache performance.** Hash before, compare after. If you're not measuring cache breaks, you don't know what your API calls actually cost.

**Latch session settings.** If toggling a feature changes the API request shape, make it a one-way door within the session.

**Re-inject after compaction.** Summarization loses specifics. Put the load-bearing specifics back.

Claude Code treats the system prompt as a hot path with a cost model. That framing is worth more than any individual pattern in the code.
