---
layout: ../../layouts/Post.astro
title: "Why I'm Building Trust Bench"
date: "2026-03-08"
description: "Evaluation tools score LLM outputs. They don't tell you why models fail. Trust Bench connects profiling, diagnosis, and repair into a single open-source tool."
tags: ["trust-bench", "llm-safety", "evaluation", "interpretability"]
thread: "trust"
type: "deep-dive"
featured: true
repo: "https://github.com/amaljithkuttamath/trust-bench"
---

Every LLM evaluation tool today works the same way. You run a set of prompts through a model, score the outputs against some criteria, and get a number. Truthfulness: 72%. Safety: 85%. Calibration: 34%.

These numbers are useful. They tell you *what* a model gets wrong. But they don't tell you *why*.

I've spent the last few years working on hallucination detection in production AI systems. The pattern I keep seeing: we catch bad outputs, but we treat the model as a black box. We know it fails, we don't know where the failure originates inside the model.

---

## The gap in the landscape

I spent time surveying what exists.

On the evaluation side, there are solid tools. DeepEval, TrustLLM (which established 6 evaluation dimensions across 30+ peer-reviewed datasets), lm-eval-harness, RAGAS. They do output-level scoring well.

On the safety training side, there's serious research. Anthropic's Constitutional AI. Representation Engineering (RepE). Shanghai AI Lab's SafeLadder and SafeWork-R1. These techniques can actually improve model safety.

But here's the thing: nobody has packaged the closed loop. Profile a model's trust. Understand why it fails. Apply a targeted fix. Verify the fix worked. AI labs do this internally (Anthropic's entire Constitutional AI process is essentially this loop). It doesn't exist as open-source infrastructure that anyone can use.

---

## Why Qwen3.5, and why from scratch?

I'm starting with Sebastian Raschka's from-scratch implementation of Qwen3.5 (0.8B parameters). Three reasons.

First, it's small enough to run and retrain locally. You can actually iterate.

Second, the architecture is genuinely novel. Qwen3.5 alternates between linear attention (Gated DeltaNet) and full attention (Grouped Query Attention) in a 3:1 pattern. Nobody has studied how trust signals, things like confidence calibration, attention entropy, layer activation patterns, differ across these two attention types. This is a real research question with no published answer.

Third, from-scratch code means full visibility. I can add hooks at any layer, extract any signal, without fighting framework abstractions.

---

## What I'm building

Trust Bench is a single tool with three stages:

1. **Extract**: Pull trust signals from models. Not just logprobs, but entropy, layer activations, attention patterns, separated by attention type.
2. **Evaluate**: Score across established dimensions (TrustLLM's truthfulness, safety, fairness, robustness, privacy, machine ethics) using peer-reviewed datasets.
3. **Improve**: Apply targeted techniques (post-hoc calibration, RepE activation steering, Constitutional AI loops) and re-evaluate.

The value is connecting extraction to evaluation to improvement in a single tool. Profile before. Fix. Profile after. Did it work?

---

## What's next

Phase 1 is extraction and evaluation. Get Qwen3.5 running, pull trust signals from both attention types, score against TrustLLM datasets.

The first technical post will cover what I find inside Qwen3.5's hybrid attention layers. Real findings from real model internals.

---

*[trust-bench](https://github.com/amaljithkuttamath/trust-bench)*
