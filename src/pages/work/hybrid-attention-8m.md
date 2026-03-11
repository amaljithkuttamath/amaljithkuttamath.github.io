---
layout: ../../layouts/Post.astro
title: "Hybrid Attention at 8M Params"
date: "2026-03-10"
updated: "2026-03-10"
description: "What happens when you shrink Qwen3.5's hybrid DeltaNet architecture to 8 million parameters and train it on a laptop."
tags: ["mlx", "attention", "training"]
repo: "https://github.com/amaljithkuttamath/autoresearch-mlx-qwen-3-5"
---

I wanted to understand how Qwen3.5's hybrid attention works. Not from the paper, from training it myself.

Qwen3.5 swaps most of its attention layers for [Gated DeltaNet](https://arxiv.org/abs/2412.06464), a linear attention variant with a recurrent state, and keeps a few full softmax layers in the mix. I wanted to see what happens when you shrink that down to 8 million parameters and train it on a laptop.

I took [Karpathy's autoresearch](https://github.com/karpathy/autoresearch), replaced the model with a Qwen3.5-style hybrid running on [MLX](https://github.com/ml-explore/mlx), and started running 5-minute experiments. An agent swaps the config, trains, logs the result, repeats. I read the diffs in the morning.

<figure>
  <img src="/images/hybrid-attention/agent-experiment.png" alt="The agent running an experiment: updating results.tsv, editing train.py, kicking off a training run" />
  <figcaption>The agent updating results.tsv, editing train.py, kicking off a run.</figcaption>
</figure>

---

## Results so far

Base config: 4 layers, 256 embedding dim, ~8.3M params. Trained on [ClimbMix](https://huggingface.co/datasets/karpathy/climbmix). Each run is exactly 5 minutes.

Each layer is either **L** (DeltaNet, linear attention with recurrent state) or **F** (full softmax attention). LLLF = 3 DeltaNet layers + 1 full attention layer. val_bpb is validation bits-per-byte, lower is better.

*March 10*

| What | val_bpb | Memory | Notes |
|------|---------|--------|-------|
| LLLF hybrid (3 DeltaNet + 1 full attn) | 1.756 | 3.0 GB | First stable run |
| LLLF + official Qwen3.5 init | 1.742 | 3.0 GB | dt_bias fix helped |
| **FFFF pure attention** | **1.653** | 2.6 GB | Baseline wins |
| LLLL pure DeltaNet | 1.769 | 3.4 GB | Worst of the three |
| FFFF, bigger (15.4M) | 1.746 | 3.4 GB | More params, worse |
| FFFF, deeper (8 layers) | 1.748 | 3.9 GB | More layers, worse |
| FFFF, 2x learning rate | 1.712 | 2.6 GB | LR matters more than architecture |
| FFFF, half batch size | 1.658 | 1.5 GB | 2x steps, nearly the best |
| FFFF, smaller total batch | 1.690 | 1.6 GB | Too few tokens per update |
| FFFFFF (6L, 320d, 14.8M) | 1.780 | 3.8 GB | Bigger and deeper, still worse |
| FFFF, no gated Q (8.0M) | 1.702 | 2.6 GB | Simpler attention, slightly worse |
| FFFF, warmup 5% + warmdown 30% | 1.654 | 2.6 GB | Schedule tuning, basically tied |
| **FFFF, mlp_expansion=4.0 (8.7M)** | **1.652** | 2.7 GB | New best, wider MLP helps |

Pure attention is winning, which I did not expect.

The first thing I tried was making the model bigger. More params, more layers, wider. It got worse every single time. This makes sense if you think about it: a bigger model takes longer per step, and with a fixed 5-minute budget, that means fewer gradient updates. At 8M params you're already undertrained. Making the model bigger just makes that worse. This is basically [Chinchilla](https://arxiv.org/abs/2203.15556) applied to wall clock instead of FLOPs.

Then I halved the batch size. Twice the optimizer steps, half the memory, nearly the best result. And doubling the learning rate beat every architectural change. The learning rate thing is [textbook](https://link.springer.com/chapter/10.1007/978-3-642-35289-8_26), the single most important hyperparameter, but it's easy to forget when you're busy swapping architectures.

So why is pure attention winning? There are a few things tangled together here. The hybrid gets half the optimizer steps in the same time, because DeltaNet's chunk recurrence (a Python for-loop) runs at ~345ms/step vs ~180ms for MLX's fused attention. I haven't tuned the hybrid's hyperparameters as carefully as the baseline. And I implemented the chunk-wise DeltaNet from scratch in MLX, not using [FLA's](https://github.com/fla-org/flash-linear-attention) optimized kernels. I already found three numerical bugs getting it to train at all. There could be subtler ones that don't produce NaN but quietly hurt quality.

There's also a more fundamental issue. Linear attention approximates the full attention matrix through a fixed-size recurrent state. At d=256 with 4 heads, that state is small. [Softmax is strictly more expressive](https://arxiv.org/abs/2507.23632) than linear attention in the recurrent formulation, and that gap is proportionally larger when the state is tiny. At seq_len=2048, quadratic attention is cheap anyway, so DeltaNet's efficiency advantage doesn't apply. I'm really testing whether the inductive bias of recurrence helps the model learn better, and right now the answer is buried under confounds I haven't controlled for yet.

---

## On the process

<figure>
  <img src="/images/hybrid-attention/wandb-dashboard.png" alt="Wandb dashboard from a training run: loss curves, learning rate schedule, grad norms, system metrics" />
  <figcaption>Loss curves, learning rate schedule, grad norms. Each run is 5 minutes.</figcaption>
</figure>

Each experiment takes 5 minutes. The agent runs them back to back. Concepts I'd been reading about in papers for weeks (chunked recurrence, decay clamping, batch size vs step count) clicked because I could see them succeed or fail in my own code. The loop from "what if" to "here's what happened" takes minutes instead of days. It's not rigorous, but you learn fast.

---

## What's next

- Make DeltaNet faster and see if hybrid catches up at equal step count
- Try more layers, give the architecture room to specialize
- Different ratios (the 3:1 is from Qwen3.5 at 30B, might be wrong here)
- Keep tuning pure attention, see how far it goes

---

*[autoresearch-mlx-qwen-3-5](https://github.com/amaljithkuttamath/autoresearch-mlx-qwen-3-5). Built on [Karpathy's autoresearch](https://github.com/karpathy/autoresearch) and [Apple's MLX](https://github.com/ml-explore/mlx).*
