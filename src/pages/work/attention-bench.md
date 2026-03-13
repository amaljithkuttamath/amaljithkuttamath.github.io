---
layout: ../../layouts/Post.astro
title: "Four Attention Variants, One Training Loop"
date: "2026-03-11"
description: "I implemented MHA, GQA, MQA, and Sliding Window attention from scratch and trained small transformers to compare them."
tags: ["attention", "transformers", "pytorch", "from-scratch"]
thread: "architecture"
type: "experiment"
repo: "https://github.com/amaljithkuttamath/attention-bench"
---

Attention variant papers rarely make the tradeoffs obvious. The clearest way to understand them: to implement each one from scratch and train the same model four times.

That's what attention-bench does. Four attention mechanisms, all in PyTorch, no `nn.MultiheadAttention`. Each one plugs into the same decoder-only transformer (6 layers, 256 dim, 8 heads), trains on TinyStories with the same hyperparameters, and gets measured on perplexity, throughput, and memory.

---

## The baseline: Multi-Head Attention

Standard MHA gives every head its own Q, K, and V projection. With `d_model=256` and `n_heads=8`, each head gets a 32-dimensional subspace. The projections are straightforward:

```python
self.q_proj = nn.Linear(d_model, d_model)  # 256 -> 256
self.k_proj = nn.Linear(d_model, d_model)  # 256 -> 256
self.v_proj = nn.Linear(d_model, d_model)  # 256 -> 256
```

This is the most expressive variant and uses the most parameters. Every head computes its own keys and values independently. For a model this small, the overhead is negligible. At Llama 3's scale (8B+), those KV projections start to matter.

---

## Grouped Query Attention: sharing KV heads

GQA is the insight behind Llama 2 70B, Llama 3, and Mistral. Instead of giving every head its own KV projection, you use fewer KV heads and share them across groups of query heads.

In my config, 8 query heads share 4 KV heads. So each pair of query heads shares one KV head. The K and V projections shrink:

```python
self.q_proj = nn.Linear(d_model, n_heads * head_dim)      # 256 -> 256
self.k_proj = nn.Linear(d_model, n_kv_heads * head_dim)   # 256 -> 128
self.v_proj = nn.Linear(d_model, n_kv_heads * head_dim)   # 256 -> 128
```

The key operation is `_repeat_kv`, which tiles the KV heads to match the query head count before computing attention:

```python
def _repeat_kv(self, x: torch.Tensor) -> torch.Tensor:
    """(B, n_kv_heads, T, head_dim) -> (B, n_heads, T, head_dim)"""
    if self.n_rep == 1:
        return x
    B, n_kv, T, D = x.shape
    return (
        x[:, :, None, :, :]
        .expand(B, n_kv, self.n_rep, T, D)
        .reshape(B, self.n_heads, T, D)
    )
```

This is a view operation, not a copy. The KV data is physically stored once and read multiple times. At inference time, this directly translates to a smaller KV cache. Llama 3 8B uses 8 KV heads for 32 query heads, cutting KV cache by 4x.

---

## Multi-Query Attention: one KV head for all

MQA is the extreme case. One KV head shared across all query heads. The implementation is trivially derived from GQA:

```python
class MultiQueryAttention(GroupedQueryAttention):
    def __init__(self, d_model, n_heads, dropout=0.0):
        super().__init__(d_model, n_heads, n_kv_heads=1, dropout=dropout)
```

That's the entire class. PaLM and Falcon use this. The KV projection goes from `d_model -> d_model` (MHA) to `d_model -> head_dim` (MQA). With 8 heads, that's an 8x reduction in KV parameters. The risk is quality degradation, since all query heads now share the same key-value representation. Whether that matters depends on model size. For large models, the quality gap is often small. For small models, it can be measurable.

---

## Sliding Window Attention: locality over global context

SWA takes a different approach. Instead of reducing KV heads, it limits how far each token can attend. Each position only sees the `W` nearest preceding tokens.

The implementation adds a window mask on top of the causal mask:

```python
def _make_window_mask(self, seq_len, device):
    rows = torch.arange(seq_len, device=device).unsqueeze(1)
    cols = torch.arange(seq_len, device=device).unsqueeze(0)
    causal = cols > rows
    too_far = cols < (rows - self.window_size + 1)
    return causal | too_far
```

Position `i` attends to positions `[max(0, i - W + 1), i]`. Everything else gets `-inf` before softmax. With `window_size=128` and `seq_len=256`, the attention matrix is roughly half-sparse. Memory scales linearly with sequence length instead of quadratically.

The tradeoff is receptive field. A single layer can only see 128 tokens back. But stacking 6 layers gives an effective receptive field of 768 tokens through indirect attention paths. Mistral uses this at 4096 window size with 32 layers.

---

## What the parameter counts tell you

The differences are concrete. For `d_model=256`, `n_heads=8`:

- **MHA**: Q, K, V projections are each 256x256. Total attention params: ~262K per layer.
- **GQA** (4 KV heads): K, V projections drop to 256x128. Saves ~65K params per layer.
- **MQA** (1 KV head): K, V projections drop to 256x32. Saves ~115K params per layer.
- **SWA**: Same parameter count as MHA. The savings come from compute and memory, not parameters.

These differences compound across layers. Over 6 layers, MQA saves roughly 690K parameters compared to MHA. At this model scale (~3M params total), that's significant. At billion-parameter scale, the KV cache savings during inference matter more than the parameter count.

---

## Running it yourself

```bash
git clone https://github.com/amaljithkuttamath/attention-bench.git
cd attention-bench
pip install -r requirements.txt
python run_bench.py
```

The bench trains all four variants sequentially, logs metrics to `results/`, and works on MPS (Apple Silicon) or CUDA. A full run on M3 Max takes about 15 minutes.

The code is structured to make the attention implementations readable. Each variant is one class in `src/attention.py`, with a shared interface: `forward(x, mask) -> (output, attn_weights)`. If you're trying to understand what these mechanisms actually do at the tensor level, reading 224 lines of Python is faster than reading four papers.
