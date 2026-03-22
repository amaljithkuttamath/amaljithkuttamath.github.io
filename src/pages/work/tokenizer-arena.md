---
layout: ../../layouts/Post.astro
title: "Comparing LLM Tokenizers Side by Side"
date: "2026-03-20"
description: "tokenizer-arena is a Rust CLI that shows how different LLM tokenizers encode the same text, revealing surprising differences in efficiency."
tags: ["rust", "tokenizers", "llm", "nlp", "open-source"]
thread: "tools"
type: "tool"
install:
  cargo: "cargo install tokenizer-arena"
repo: "https://github.com/amaljithkuttamath/tokenizer-arena"
---

I was debugging a context window issue in Claude Code. A session that should have fit comfortably was hitting limits. The culprit turned out to be a code-heavy prompt where the tokenizer was splitting common identifiers into 4-5 pieces each. I realized I had no intuition for how different tokenizers handle the same text, and no quick way to compare them.

So I built [tokenizer-arena](https://github.com/amaljithkuttamath/tokenizer-arena). Give it text, it runs it through four encodings side by side.

---

## What it shows

The four encodings:

- **cl100k_base** (GPT-4, Claude)
- **o200k_base** (GPT-4o)
- **p50k_base** (GPT-3, Codex)
- **r50k_base** (GPT-3 legacy)

```
$ tokenizer-arena "def fibonacci(n): return n if n <= 1 else fibonacci(n-1) + fibonacci(n-2)"

╭──────────────┬────────┬─────────────┬──────────────╮
│ Encoding     │ Tokens │ Bytes/Token │ Tokens/Word  │
├──────────────┼────────┼─────────────┼──────────────┤
│ cl100k_base  │     23 │        3.17 │         2.30 │
│ o200k_base   │     22 │        3.32 │         2.20 │
│ p50k_base    │     31 │        2.35 │         3.10 │
│ r50k_base    │     31 │        2.35 │         3.10 │
╰──────────────┴────────┴─────────────┴──────────────╯
```

That Fibonacci one-liner takes 23 tokens with cl100k but 31 with p50k. The newer tokenizers are roughly 25% more efficient on code. Same text, same meaning, fewer tokens. That gap compounds across an entire training corpus or a long conversation.

---

## Seeing the boundaries

The `--show-tokens` flag color-codes each token boundary in the original text. You can see exactly where each tokenizer decides to split.

Older tokenizers split `fibonacci` into more pieces. Newer ones often keep common programming identifiers whole or split them into larger chunks. Punctuation handling differs too. `(n-1)` might be three tokens or five, depending on the encoding.

---

## Why these differences exist

Each encoding is a different BPE vocabulary trained on different data mixes.

r50k_base has 50,257 tokens, trained for GPT-3 on mostly English web text. p50k_base was retrained with more code for Codex. cl100k_base jumped to 100,256 tokens on a broader multilingual and code-heavy corpus. o200k_base doubled again to 200,000 tokens for GPT-4o.

Larger vocabularies mean better compression. More tokens available, more common sequences get single-token representations. The tradeoff is embedding table size: going from 50K to 200K tokens means a 4x larger embedding matrix.

There are also targeted decisions. cl100k_base is notably better at whitespace and indentation. o200k_base improved multilingual coverage, encoding non-Latin scripts more efficiently. These reflect what the model builders wanted to optimize for.

---

## What surprised me

For multilingual text, the differences are dramatic. A Japanese sentence might need 40 tokens with r50k but only 15 with o200k. That's not a 25% improvement, it's a 2.5x improvement. It changes whether the model can even fit a useful conversation in its context window.

The other thing: tokenizer choices are locked in at training time. You can't swap a tokenizer on a trained model. Every vocabulary design decision is a bet on what kind of text the model will encounter. The shift from r50k to o200k tells a story about how the intended use of language models changed: from English text generation to multilingual, multimodal, code-heavy workloads. The tokenizer is a fossil record of those priorities.

---

## Try it

```bash
cargo install tokenizer-arena
tokenizer-arena "your text here"
tokenizer-arena --show-tokens "your text here"
tokenizer-arena --json "your text here" | jq .
```

Uses tiktoken-rs under the hood. Works offline after install.
