---
layout: ../../layouts/Post.astro
title: "I Built a Terminal Dashboard to See Where My Tokens Go"
date: "2026-03-11"
description: "crux is a TUI that reads Claude Code session logs and shows you real-time context growth, cache efficiency, cost breakdowns, and session health grades."
tags: ["rust", "tui", "claude-code", "tooling", "open-source"]
repo: "https://github.com/amaljithkuttamath/crux"
---

I use Claude Code for everything. Writing code, debugging, planning, reviewing. After a few weeks of daily use, I realized I had no idea where my tokens were going.

The Claude Code session logs are there, JSONL files in `~/.claude/projects/`. Each API call has token counts: input, output, cache reads, cache writes. The data exists. Nobody was looking at it.

---

## What I wanted to know

Simple questions first. How much did I spend today? This week? Which project eats the most tokens?

Then harder ones. Is my context window growing out of control? Am I getting good cache hit rates or paying for the same tokens over and over? When should I restart a session instead of pushing through?

These questions matter because Claude Code sessions have a lifecycle. A fresh session starts small. As you work, context grows. Cache fills up, sometimes efficiently, sometimes not. At some point, you're paying for a 150K context window where 80% is stale conversation history.
---

## What crux does

crux reads those JSONL logs and renders a live terminal dashboard. Six views, each answering different questions.

**The main dashboard** shows active sessions with context window fill bars, cache hit rates, efficiency grades (A through F), and compaction detection. You can drill into any session and see its context timeline: how the window grew over time, where cost spikes happened, when compactions fired.

**Insights** gives you the aggregate view. Cache hit ratio across all sessions. Output efficiency (how much useful output per token of context). A 24-hour activity heatmap. The heaviest sessions ranked by depth.

**Trends** and **daily** show token volume over time with model breakdowns. **Sessions** lets you browse and replay conversations.

There's also an **MCP server** that exposes five analysis tools, so Claude itself can check its own session health, cost breakdown, and whether it should recommend restarting.

---

## Context growth is the metric that matters

In a typical Claude Code session, you start with a few thousand tokens of context. After 10 messages, you might be at 50K. After 30, you could be at 120K. Each message is more expensive than the last because you're re-sending all the previous context.

crux tracks this as "context growth factor." A session with 3.0x growth means the context tripled from first message to current. Healthy sessions stay under 5x. Sessions above 8x are burning money.

It also detects compactions, moments where Claude Code automatically compresses the conversation to free up context space. A compaction means you hit the limit. crux shows how many compactions happened and how many messages since the last one.

The "context growth premium" metric tells you the extra cost you paid because context grew. It compares your actual cost to what you would have paid if context stayed at its initial size.
---

## The grading system

Each session gets an A through F grade based on a simple scoring model:

- Context growth above 8x costs you 30 points
- Low output efficiency (the model is processing a lot but producing little) costs 30 points
- High cost per 1K output tokens costs 20 points
- Compactions actually add 5 points, because they mean the system is managing context

An A session is one where you got useful output without the context window spiraling. An F session is one where you probably should have restarted 20 messages ago.

Some F sessions are the ones where I got the most done. Useful signal, not a judgment.

---

## Building it

Rust with ratatui for the TUI, crossterm for input handling, and rmcp for the MCP server. The whole thing parses JSONL on startup, builds an in-memory store, and renders at 30fps.

The tricky part was session metadata. Claude Code's JSONL files have API-level records (token counts per call) but also conversation-level records (user messages, assistant responses, tool calls). crux parses both: lightweight metadata scanning for the session list, full conversation parsing only when you drill into a specific session.

Cache analysis required understanding how Claude Code's prompt caching works. When the system prompt and conversation prefix haven't changed between calls, the API returns `cache_read_input_tokens` instead of billing full input. crux uses `cache_read / (cache_read + input)` as the cache hit rate. High hit rates mean you're paying less per turn. Low hit rates mean something is forcing cache invalidation.

---

## What surprised me

Most of my sessions are grade B or C. Not because I'm inefficient, but because real work involves long conversations with lots of context. Short sessions with quick answers get A grades. Deep debugging sessions that actually solve problems get C or D.

Cache hit rates vary wildly between projects. Projects where I work in a consistent directory with stable CLAUDE.md files get 80%+ cache hits. Projects where I jump around the filesystem or frequently change instructions get 40%.

The 24-hour activity heatmap confirmed what I already suspected: my evening sessions (7pm to 10pm) use 3x the tokens of any other time slot. Those are my deep work hours.

---

## Try it

```bash
git clone https://github.com/amaljithkuttamath/crux.git
cd crux
cargo build --release
./target/release/crux
```

Or as an MCP server:

```json
{
  "mcpServers": {
    "crux": {
      "command": "crux",
      "args": ["serve"]
    }
  }
}
```

The code is MIT licensed.
