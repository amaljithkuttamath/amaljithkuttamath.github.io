---
layout: ../../layouts/Post.astro
title: "The Medical AI Evaluation Problem"
date: "2026-03-30"
description: "A systematic review of 70 studies found that 69 assessed accuracy, 3 evaluated safety, and 2 addressed privacy. Each layer of medical AI evaluation has problems."
tags: ["evaluation", "medical-ai", "llm-safety", "trust"]
thread: "trust"
type: "research"
project: "trust-bench"
---

A [systematic review of 70 studies](https://pmc.ncbi.nlm.nih.gov/articles/PMC12157099/) on retrieval-augmented generation in healthcare found that 69 of 70 assessed accuracy. Three evaluated safety. Two addressed privacy. Medical AI evaluation has three layers, and each one has problems.

---

## The automated tools

RAGAS is an open-source evaluation framework for retrieval-augmented systems. In [benchmarking by Cleanlab](https://cleanlab.ai/blog/benchmarking-hallucination-detection-methods/), it failed on 83.5% of numerical answers.

The failure mode: RAGAS converts answers to embeddings and measures cosine similarity. Two sentences with different numbers but identical structure score as matching. A lab value off by a factor of ten gets marked as faithful.

TLM (Trustworthy Language Model) outperforms RAGAS, DeepEval, G-Eval, and self-evaluation across every benchmark tested, including PubMedQA. It also costs significantly more per evaluation.

| Framework | Numerical accuracy | Cost | Source |
|-----------|-------------------|------|--------|
| RAGAS | Fails on 83.5% | Low | Cleanlab benchmarking |
| DeepEval | Mid-range | Low | Cleanlab benchmarking |
| G-Eval | Mid-range | Low | Cleanlab benchmarking |
| Self-eval | Systematic leniency bias | Low | Cleanlab benchmarking |
| TLM | Best across all benchmarks | High | Cleanlab benchmarking |

## The human judges

Even when you bring in human experts, the evaluation does not converge. Inter-rater reliability among physicians using the AHRQ harm scale sits at kappa 0.37. That is "fair agreement" on the standard scale.

The QUEST framework tries to fix this:

- 17 evaluation dimensions
- 6-7 specialty-matched physicians
- 130+ evaluation samples
- Cyclical adjudication until Cohen's kappa reaches 0.7
- Minimum 2 hours of evaluator training

That is rigorous. It is also expensive.

## The production layer

A scoping review of 39 sources on clinical AI monitoring found that only 23% examined real deployments. The rest were opinion papers and simulations. Alert thresholds for production systems are, in the authors' words, "essentially undocumented in published literature."

The review found no documented thresholds for when to escalate to a human.

Meanwhile, medical disclaimer rates in generative AI models dropped from 26.3% in 2022 to 0.97% in 2025. OpenAI's HealthBench found that reasoning models like o1 now rationalize incorrect answers with plausible clinical explanations. Google DeepMind's Med-Gemini team wrote that "evaluation is still in its infancy for open-ended clinical tasks."

## The gap

These three layers, automated metrics, human evaluation, and production monitoring, exist independently. MedRGB tests adversarial robustness. RAGAS tests faithfulness. QUEST tests clinical quality. The gap is running them together on the same system.

This is what I'm working on with [Trust Bench](https://github.com/amaljithkuttamath/trust-bench), an open evaluation harness that combines safety, faithfulness, robustness, and clinical utility evaluation in one place.
