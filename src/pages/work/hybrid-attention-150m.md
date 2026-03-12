---
layout: ../../layouts/Post.astro
title: "Hybrid Attention at 8M Params (and What Broke at 150M)"
date: "2026-03-10"
description: "I trained Qwen3.5's hybrid DeltaNet+attention architecture from scratch on a MacBook. Pure attention won at 8M. Scaling to 150M hit a math bug that looked like a hyperparameter problem."
tags: ["mlx", "attention", "deltanet", "training", "apple-silicon"]
repo: "https://github.com/amaljithkuttamath/autoresearch-mlx-qwen-3-5"
---

I wanted to understand how Qwen3.5's hybrid attention works. Not from the paper, from training it myself.

Qwen3.5 swaps most of its attention layers for [Gated DeltaNet](https://arxiv.org/abs/2412.06464), a linear attention variant with a recurrent state, and keeps a few full softmax layers in the mix. I wanted to see what happens when you shrink that down to 8 million parameters and train it on a laptop.

I took [Karpathy's autoresearch](https://github.com/karpathy/autoresearch), replaced the model with a Qwen3.5-style hybrid running on [MLX](https://github.com/ml-explore/mlx), and started running 5-minute experiments. An agent swaps the config, trains, logs the result, repeats. I read the diffs in the morning.

---

## Results so far

Base config: 4 layers, 256 embedding dim, ~8.3M params. Trained on [ClimbMix](https://huggingface.co/datasets/karpathy/climbmix). Each run is exactly 5 minutes.

Each layer is either **L** (DeltaNet, linear attention with recurrent state) or **F** (full softmax attention). LLLF = 3 DeltaNet layers + 1 full attention layer. val_bpb is validation bits-per-byte, lower is better.

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

So why is pure attention winning? There are a few things tangled together here. The hybrid gets half the optimizer steps in the same time, because DeltaNet's chunk recurrence (a Python for-loop) runs at ~345ms/step vs ~180ms for MLX's fused attention. I haven't tuned the hybrid's hyperparameters as carefully as the baseline. And I implemented the chunk-wise DeltaNet from scratch in MLX, not using FLA's optimized kernels. I already found three numerical bugs getting it to train at all. There could be subtler ones that don't produce NaN but quietly hurt quality.

There's also a more fundamental issue. Linear attention approximates the full attention matrix through a fixed-size recurrent state. At d=256 with 4 heads, that state is small. [Softmax is strictly more expressive](https://arxiv.org/abs/2507.23632) than linear attention in the recurrent formulation, and that gap is proportionally larger when the state is tiny. At seq_len=2048, quadratic attention is cheap anyway, so DeltaNet's efficiency advantage doesn't apply. I'm really testing whether the inductive bias of recurrence helps the model learn better, and right now the answer is buried under confounds I haven't controlled for yet.

---

## Scaling to 150M: where things broke

The 8M experiments were stable. So I scaled up: 768 embedding dim, 12 layers, LLLF pattern (9 DeltaNet + 3 full attention), 122.6M parameters. M4 Pro, 24GB.

First run: NaN by step 190. But I didn't know that for 25 minutes.

The training loop displays a smoothed loss (exponential moving average). When the actual loss goes NaN, the EMA stops updating and just holds its last value. So the terminal showed `loss: 5.587242` for 400 steps while the model was completely dead. The gradients were NaN, the parameters were frozen, and the loop kept running, burning electricity for nothing.

That's the kind of thing you only learn by doing.

### The bug that looked like a hyperparameter problem

I tried lowering learning rates. MATRIX_LR from 0.02 to 0.005. DECAY_LR from 0.02 to 0.001. Longer warmup. Tighter A_log clamping. The model went NaN at step 14 instead of step 190. Worse, not better.

So I went back to first principles and compared my code against the [FLA reference implementation](https://github.com/fla-org/flash-linear-attention) line by line. The chunk recurrence matched. The gating matched. The state update matched. But the triangular solve didn't.

DeltaNet's chunk algorithm needs to solve `(I - A)^{-1}` where A is a strictly lower triangular matrix. The reference does it row by row, 63 iterations for a chunk size of 64. That's slow in MLX (each iteration is a Python call that builds a graph node), so I'd "optimized" it with repeated squaring:

```python
# What I wrote (WRONG):
power = A
for _ in range(log2(C)):       # 6 iterations instead of 63
    power = (power @ power) * tri_mask
    attn_solved = attn_solved + power
```

This computes `I + A + A^2 + A^4 + A^8 + A^16 + A^32`. The correct [Neumann series](https://en.wikipedia.org/wiki/Neumann_series) is `I + A + A^2 + A^3 + A^4 + ... + A^63`. I was skipping most of the terms.

Verified with a numerical test:

```python
correct_result @ (I - A) = Identity      # row-by-row: correct
broken_result  @ (I - A) = [[1,0,0,0],   # repeated squaring: error of -0.03
                             [0,1,0,0],
                             [0,0,1,0],
                             [-0.03,0,0,1]]
```

An error of 0.03 per chunk, compounded across 9 DeltaNet layers, 32 chunks per sequence, every training step. The gradients never had a chance.

### What MLX is missing

I went looking for built-in alternatives. MLX has `mx.linalg.tri_inv` which inverts triangular matrices, and it's 4x faster than the Python loop. But it has no VJP (gradient) implementation, so you can't use it in training. `mx.linalg.solve_triangular` exists but only runs on CPU. There's no `mx.scan` or `mx.associative_scan`.

So the correct code is the slow code: 63 Python loop iterations per DeltaNet layer per forward pass. At 150M scale that means ~4.5s/step instead of the ~3.1s with the broken optimization. Correct and slow beats fast and wrong.

| What | val_bpb | Memory | Notes |
|------|---------|--------|-------|
| 150M LLLF (9 DeltaNet + 3 attn), 30min | 2.036 | 10.5 GB | Correct triangular solve |
| 150M LLLF, broken tri solve | NaN | 10.5 GB | Dead by step 190 |
| 150M LLLF, broken tri solve + lower LR | NaN | 10.5 GB | Dead by step 14 |

BPB 2.036 means "broken sentences, some patterns." The model learned English words and basic grammar but can't stay on topic. It saw 3.2M tokens in 30 minutes. GPT-2 small (124M params, similar size) trained on 10B tokens. We'd need hours of Mac time, or minutes on a cloud GPU.

---

## On the process

Each experiment takes 5 minutes at 8M, 30 minutes at 150M. The agent runs them back to back. Concepts I'd been reading about in papers for weeks (chunked recurrence, decay clamping, batch size vs step count, Neumann series convergence) clicked because I could see them succeed or fail in my own code. The loop from "what if" to "here's what happened" takes minutes instead of days. It's not rigorous, but you learn fast.

Here's the thing, though. I did most of this manually. An agent helped write code and debug, but I was the one deciding what to try next, reading the loss curves, spotting the NaN pattern, choosing to compare against the FLA reference. That's slow. And it's exactly the kind of work that could be automated.

---

## What this becomes: agent teams

The full loop I ran today looks like this:

1. Pick a config change (scale to 150M)
2. Train, watch the loss curve
3. Detect failure (NaN, plateau, divergence)
4. Debug (compare against reference, write numerical tests)
5. Fix and retrain
6. Evaluate (generate text, measure BPB)
7. Decide next step
8. Write about what happened

Steps 1 through 7 can be agent-automated. An experimenter agent sweeps configs and kicks off runs. A monitor watches loss curves and kills bad runs early. A reviewer generates text and scores quality. A debugger inspects gradients when training fails. Each agent does one thing, runs independently, reports back.

Step 8 is where it gets interesting. The writer agent takes the experiment diffs, the loss curves, the failure logs, and drafts blog updates. The results table grows, the observations update, the "what's next" section changes as questions get answered.

But who checks the agents? Who catches a "repeated squaring optimization" that looks fast but computes the wrong answer?

That's the human. I'm not doing the experiments. I'm auditing them. I read the diffs each morning, not the full output. The compression from "read paper, implement, debug, wait, interpret" to "read the diff" is the point. Understanding follows from doing, and the agents do the doing. I make the judgment calls.

This is also, not coincidentally, the core question behind [Trust Bench](https://github.com/amaljithkuttamath/trust-bench): how do you know when AI output is trustworthy? I'm living that question every time I review what the agents produced overnight. The audit layer is the human in the loop.

---

## What's next

- Move 150M training to cloud GPU (minutes instead of hours)
- Contribute to MLX: VJP for `tri_inv`, or `associative_scan` primitive
- Build the agent team: experimenter, monitor, reviewer, debugger, writer
- Keep the human in the loop as the audit layer

---

*[autoresearch-mlx-qwen-3-5](https://github.com/amaljithkuttamath/autoresearch-mlx-qwen-3-5). Built on [autoresearch](https://github.com/karpathy/autoresearch) and [MLX](https://github.com/ml-explore/mlx).*
