---
layout: ../../layouts/Post.astro
title: "When an LLM Says 90%, Should You Believe It?"
date: "2026-03-12"
description: "Measuring LLM calibration by asking 102 factual questions and checking if stated confidence matches actual accuracy. The answer: models are overconfident."
tags: ["calibration", "llm-safety", "evaluation", "python"]
repo: "https://github.com/amaljithkuttamath/calibration-probe"
---

Ask an LLM a factual question and it will give you an answer. Force it to also state a confidence level, 0 to 100, and you get something more interesting: a claim about its own uncertainty. The question is whether that claim means anything.

I built [calibration-probe](https://github.com/amaljithkuttamath/calibration-probe) to find out. It sends 102 factual questions across five categories (geography, science, history, math, common knowledge) to an LLM, forces a numeric confidence alongside each answer, then checks whether stated confidence tracks actual accuracy. The results are clear: models are overconfident.

---

## Calibration is not accuracy

A model can be 85% accurate and still be poorly calibrated. Calibration measures something different: when the model says "I'm 90% confident," is it actually right 90% of the time? When it says 60%, is it right 60% of the time?

Perfect calibration means the confidence-accuracy curve is a straight diagonal. Every stated confidence level matches its observed accuracy. In practice, no model achieves this. The question is how far off it is, and in which direction.

Overconfident models say 90% and are right 80% of the time. Underconfident models say 60% and are right 75% of the time. Both are miscalibrated, but overconfidence is more dangerous. If you build a system that trusts high-confidence answers and defers low-confidence ones to humans, overconfidence means bad answers slip through the filter.

---

## What the numbers show

From the sample run against 102 questions:

- **Mean stated confidence: 89%.** The model is quite sure of itself.
- **Actual accuracy: 86%.** Not bad on its own, but the gap matters.
- **ECE (Expected Calibration Error): 0.107.** This compresses the full calibration curve into a single number. Lower is better. 0.0 is perfect. 0.107 means the model's confidence is off by about 11 percentage points on average across bins.

The overconfidence pattern is consistent. In the 90-100% confidence bin, the model is right around 88% of the time. It reports near-certainty for answers that are wrong roughly one in eight times.

---

## Category breakdown

Not all domains are equal.

**Geography is the worst.** The model reports high confidence on capitals but gets tripped up on the tricky ones: capitals that are not the largest city. It said "Sydney" for Australia (confidence: 72, wrong), "Lagos" for Nigeria (confidence: 58, wrong), "Istanbul" for Turkey (confidence: 60, wrong), "Dar es Salaam" for Tanzania (confidence: 55, wrong). The pattern is consistent: when the well-known city is not the capital, the model guesses the well-known city and hedges its confidence slightly, but not enough.

**Math has the best calibration.** High confidence, high accuracy. The model knows what it knows here. 19 out of 20 math questions correct, with confidence levels that closely track the difficulty. The one miss was a Fibonacci indexing question where it reported 65% confidence, a reasonable hedge.

**Science and history** fall in between. The model handles textbook facts well (chemical symbols, major dates) but stumbles on edge cases. It said "Silicon" for the most abundant element in Earth's crust (it is oxygen by mass), and confidently placed the Gutenberg press in 1450 instead of 1440.

**Common knowledge** is mostly clean, with two notable misses: China's time zones (the model guessed 5, the answer is 1) and Scotland's national animal (the model guessed lion, the answer is unicorn). Both had lower confidence, 45% and 55%, showing the model at least partially knew it was uncertain.

---

## Why this matters for safety

Calibration is a prerequisite for building reliable uncertainty-based guardrails. Consider a medical Q&A system that defers to a human when model confidence is below 70%. If the model is well-calibrated, that threshold works: low-confidence answers genuinely are less likely to be correct, and humans review the uncertain cases. If the model is overconfident, it reports 85% on answers it only gets right 70% of the time, and dangerous mistakes sail past the filter.

The same logic applies to model cascading (routing easy questions to a cheap model and hard ones to an expensive model), retrieval-augmented generation (deciding when to search for supporting evidence), and any system where confidence scores drive downstream behavior.

---

## Prompting strategy changes calibration

calibration-probe supports multiple prompting strategies: direct questioning, chain-of-thought, and explicit step-by-step reasoning. The `--strategy` flag lets you compare them. Chain-of-thought tends to improve calibration, not by making the model more accurate, but by making it better at recognizing when it is uncertain. Forcing the model to reason before committing to an answer and a confidence number gives the internal uncertainty signal more room to surface.

---

## Try it

```bash
git clone https://github.com/amaljithkuttamath/calibration-probe.git
cd calibration-probe
pip install -r requirements.txt

# With an API key
python probe.py

# Without (uses sample data)
python probe.py --dry-run
```

The dry run generates a reliability diagram from the included sample data. That plot is the core output: a calibration curve against the perfect diagonal, with bin sizes shown so you can see where the model had enough data to be statistically meaningful.

<figure>
<img src="https://raw.githubusercontent.com/amaljithkuttamath/calibration-probe/main/results/calibration_curve.png" alt="Reliability diagram showing model confidence vs actual accuracy, with the diagonal representing perfect calibration and bars showing the model's overconfidence gap" />
<figcaption>The reliability diagram. The diagonal is perfect calibration. The bars show actual accuracy per confidence bin. The gap between the bars and the diagonal is the overconfidence.</figcaption>
</figure>

The code is MIT licensed.
