---
layout: ../../layouts/Post.astro
title: "Comparing LLM Tokenizers Side by Side"
date: "2026-03-11"
description: "tokenizer-arena is a Rust CLI that shows how different LLM tokenizers encode the same text, revealing surprising differences in efficiency."
tags: ["rust", "tokenizers", "llm", "nlp", "open-source"]
thread: "tools"
type: "tool"
install:
  cargo: "cargo install tokenizer-arena"
repo: "https://github.com/amaljithkuttamath/tokenizer-arena"
---

OpenAI has shipped at least four different tokenizer vocabularies. Each one encodes the same text differently, affecting training efficiency, inference cost, multilingual coverage, and context window utilization. I wanted to understand how they actually differ, so I built a tool to compare them.

---

## What tokenizer-arena does

You give it text. It runs that text through four encodings and shows you the results side by side.

The four encodings:

- **cl100k_base** (GPT-4, Claude)
- **o200k_base** (GPT-4o)
- **p50k_base** (GPT-3, Codex)
- **r50k_base** (GPT-3 legacy)

For each one, you get the token count, bytes per token (compression ratio), and tokens per word. Higher bytes per token means the tokenizer is compressing more efficiently.

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

The `--show-tokens` flag reveals boundaries directly. It color-codes each token boundary in the original text, so you can see exactly where each tokenizer decides to split.

Older tokenizers split `fibonacci` into more pieces. Newer ones often keep common programming identifiers whole or split them into larger chunks. Punctuation handling differs too. Things like `(n-1)` might be three tokens or five, depending on the encoding.

Seeing why one encoding produces fewer tokens builds intuition about vocabulary design.

---

## Why these differences exist

Each encoding represents a different BPE (byte pair encoding) vocabulary trained on different data mixes with different vocabulary sizes.

r50k_base has 50,257 tokens. It was trained for GPT-3, mostly on English web text. p50k_base kept a similar size but was retrained with more code in the mix, which is why Codex used it. cl100k_base jumped to 100,256 tokens, trained on a broader multilingual and code-heavy corpus. o200k_base doubled again to 200,000 tokens for GPT-4o.

Larger vocabularies generally mean better compression. With more tokens available, the encoding can represent common sequences as single tokens instead of splitting them. The tradeoff is embedding table size, which affects model memory and training cost. Going from 50K to 200K tokens means the embedding matrix is 4x larger.

There are also targeted decisions. cl100k_base is notably better at whitespace and indentation, which matters for code. o200k_base improved multilingual coverage, encoding non-Latin scripts more efficiently. These aren't accidents. They reflect what the model builders wanted to optimize for.

---

## When this matters

Tokenizer efficiency directly affects two things: cost and context.

If a tokenizer is 25% more efficient on your workload, your API calls are 25% cheaper. Your context window effectively holds 25% more text. For long-document tasks or code generation, that difference is significant.

It also affects training. A more efficient tokenizer means the model sees more "content" per training step. The same compute budget covers more ground. This is one reason newer models feel better at code. It's not just more training data or better architectures. The tokenizer lets them see more code per token.

For multilingual text, the differences are even larger. Some languages that take 3-4x more tokens in older encodings are much closer to parity in newer ones. A Japanese sentence might need 40 tokens with r50k but only 15 with o200k. That changes whether the model can even fit a useful conversation in its context window.

---

## Try it

```bash
cargo install tokenizer-arena
tokenizer-arena "your text here"
tokenizer-arena --show-tokens "your text here"
tokenizer-arena --json "your text here" | jq .
```

It uses tiktoken-rs under the hood and works offline after install. The `--json` flag outputs structured data if you want to script comparisons across larger text samples.

---

## Observations

The trend in tokenizer design is clearly toward larger vocabularies with broader coverage. But there's a ceiling. At some point, adding more tokens to the vocabulary gives diminishing compression returns while making the embedding layer expensive. Where that ceiling is depends on the target workload.

The other interesting thing is that tokenizer choices are locked in at training time. You can't swap a tokenizer on a trained model. So every vocabulary design decision is a bet on what kind of text the model will encounter. The shift from r50k to o200k tells a story about how the intended use of language models changed: from English text generation to multilingual, multimodal, code-heavy workloads. The tokenizer is a fossil record of those priorities.
