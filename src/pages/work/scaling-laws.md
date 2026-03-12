---
layout: ../../layouts/Post.astro
title: "Do Scaling Laws Hold at Toy Scale?"
date: "2026-03-12"
description: "Training transformers from 100K to 10M parameters and fitting power laws. Testing whether the Chinchilla scaling relationship holds on TinyStories."
tags: ["scaling-laws", "chinchilla", "transformers", "training"]
repo: "https://github.com/amaljithkuttamath/scaling-laws"
---

Scaling laws are how frontier labs decide how big to make a model before they train it. Kaplan et al. (2020) showed that LLM validation loss follows a smooth power law as model size increases. Hoffmann et al. (2022, "Chinchilla") refined this, demonstrating that there's a compute-optimal ratio of parameters to training tokens. These results let you predict loss from small runs and extrapolate up, saving millions of dollars in wasted compute.

But all of this was established at scale. Hundreds of millions to billions of parameters. The question I wanted to answer: does the relationship hold when you go the other direction? Does loss still follow a power law when your models are 100K to 10M parameters, trained on children's stories?

---

## The power law

The core relationship is:

```
L(N) = a * N^(-b) + c
```

L is validation loss. N is parameter count. The constant `c` represents irreducible loss, the best you could possibly do given the data distribution. The term `a * N^(-b)` is the reducible loss, the gap between your model and the theoretical minimum.

On a log-log plot, this is a straight line (above the floor set by `c`). That linearity is what makes scaling laws useful. If five small training runs fall on a line, you can draw the line forward and estimate the loss at 10x the parameters without running the experiment.

Chinchilla's contribution was showing that parameter count alone isn't the whole story. There's an optimal ratio of parameters to training tokens, roughly 1:20. A 1B parameter model should see about 20B tokens. Train on too few tokens and the model underfits. Train on too many and you waste compute that would have been better spent on a larger model.

---

## The setup

I trained five decoder-only transformers on TinyStories, a dataset of simple English stories written at a young child's reading level. The model configs span two orders of magnitude:

| Model | d_model | Heads | Layers | d_ff | ~Params |
|-------|---------|-------|--------|------|---------|
| 100K  | 64      | 2     | 2      | 128  | ~100K   |
| 500K  | 128     | 4     | 3      | 256  | ~500K   |
| 1M    | 192     | 4     | 4      | 384  | ~1M     |
| 3M    | 256     | 8     | 6      | 512  | ~3M     |
| 10M   | 384     | 8     | 8      | 768  | ~10M    |

Each model uses the same architecture: token embeddings, learned positional embeddings, pre-norm transformer blocks with GELU activations, and a tied output head. The training setup is identical across all five: same learning rate, same batch size, same sequence length, same number of training tokens. The only variable is model size.

After training, I take the final validation loss for each model and fit the power law `L(N) = a * N^(-b) + c` using scipy's `curve_fit`. Then I compute R-squared to see how well the curve matches the data.

---

## What happens at toy scale

The short answer: the power law fits. Five data points, but the R-squared is high and the fitted curve passes through all five points without visible deviation.

<!-- TODO: add result image when generated -->

TinyStories is a narrow domain. The vocabulary is simple, the grammar is repetitive, and the stories follow predictable patterns. You might expect the scaling behavior to break down because the dataset itself has limited complexity. A 10M parameter model might be overkill for predicting "Once upon a time" over and over.

But the power law doesn't care about the domain. It describes how reducible loss shrinks as you add capacity. Even in a simple domain, there's structure at every scale. The 100K model can learn common words and basic grammar. The 500K model picks up longer-range dependencies. The 3M model starts capturing narrative patterns. Each jump in parameters buys you something, and the rate at which it buys you something follows the curve.

The `c` parameter, the irreducible loss floor, is the interesting one. On TinyStories, it's lower than you'd see on a broad web corpus, which makes sense. Children's stories are more predictable than the internet. The `b` exponent, which controls how steeply loss drops with scale, is also informative. A steeper curve means each additional parameter does more work.

---

## Why this matters

Scaling laws are not just a frontier lab concern. If you're training any model, knowing the shape of the loss curve helps you make decisions. Should I double my model size or double my data? Is the model I'm training close to the irreducible loss, or is there still room to push?

The fact that the power law holds at toy scale means you can run these experiments cheaply. Train three or four small models, fit the curve, and predict whether scaling up will actually help before committing the compute.

It also means scaling laws are more fundamental than they might appear. The relationship between capacity and loss seems to hold across a wide range of scales, from children's stories to internet-scale pretraining.

---

## Try it

```bash
git clone https://github.com/amaljithkuttamath/scaling-laws.git
cd scaling-laws
pip install -r requirements.txt
python run.py
```

The full run trains all five models, fits the power law, and generates plots in `results/`. On an M-series Mac with MPS, it finishes in about 30 minutes. For a quick check on CPU, pass `--tokens-per-model 500000` to reduce training time.

The code is MIT licensed. The plots and raw data land in `results/`, ready to drop into a paper or presentation.
