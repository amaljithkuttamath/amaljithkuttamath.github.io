---
layout: ../../layouts/Post.astro
title: "How Large Language Models Actually Work"
date: "2025-03-07"
description: "A visual, from-scratch deep dive into the algorithm behind GPT, Qwen, Llama, and every other LLM."
---

> Based on Andrej Karpathy's [microgpt](https://gist.github.com/karpathy/8627fe009c40f57531cb18360106ce95) — 200 lines of pure Python containing **the entire algorithm**.
> Everything else — CUDA kernels, distributed training, trillion-token datasets — is just efficiency.
> The soul of the machine fits on a napkin.

## 1. The Core Idea

Every large language model — GPT-4, Claude, Llama, Qwen — runs the exact same algorithm:

```
THE ENTIRE ALGORITHM
====================

1. Read a LOT of text
2. For each word, try to predict the NEXT word
3. Measure how wrong you were
4. Adjust your parameters to be LESS wrong next time
5. Repeat billions of times
6. You now have ChatGPT
```

That's it. That's the tweet. Now let's go deep.

---

## 2. The Dataset — Fuel for the Machine

```python
docs = [line.strip() for line in open('input.txt') if line.strip()]
random.shuffle(docs)
```

The model loads 32,000 human names — "emma", "olivia", "liam", "noah" — each treated as a tiny document.

An LLM is a **statistical model of language**. It doesn't "understand" anything — it learns **patterns**. Feed it names and it learns what sequences of letters *look like* English names. Feed it the entire internet and it learns what sequences of words *look like* human knowledge.

The **exact same algorithm** works at both ends of the spectrum. The only difference is how much data you pour in and how many parameters you give the model to absorb it.

---

## 3. The Tokenizer — Teaching Machines to Read

```python
uchars = sorted(set(''.join(docs)))   # ['a', 'b', 'c', ..., 'z']
BOS = len(uchars)                      # 26 = special token
vocab_size = len(uchars) + 1           # 27 total tokens
```

Neural networks speak **numbers**, not text. We need a translator. Map every unique symbol to an integer.

**BOS** = Beginning of Sequence. It's a special token that means "a new document starts here." Every LLM uses these special tokens. ChatGPT has `<|im_start|>` and `<|im_end|>`. They're invisible to you, but they structure every conversation.

Production models like Qwen use **Byte Pair Encoding** — a smarter scheme that merges frequently occurring character pairs into single tokens. "understanding" becomes `[un, der, stand, ing]` — 4 tokens instead of 13 characters. Fewer tokens = faster processing.

---

## 4. The Autograd Engine — The Learning Algorithm

This is the **most important section**. If you understand this, you understand how every neural network on Earth learns.

Every calculation the model performs is secretly recorded in a graph. Why? Because of **backpropagation** — the algorithm that answers:

> "If I wiggle each input slightly, how does the final output change?"

This is a **gradient** — the direction and amount to adjust each parameter.

```python
child.grad += local_grad * v.grad
```

That single line is **the entire learning algorithm of deep learning**. The chain rule, applied recursively through a computation graph.

The autograd engine is a **tape recorder for math**. It records every calculation, then plays the tape backwards to figure out how to improve. PyTorch, TensorFlow, JAX — they all do exactly this.

---

## 5. The Transformer Architecture

This is the **core of the model** — from "Attention Is All You Need" (Vaswani et al., 2017).

### Attention — The Key Innovation

Imagine you're in a library. You have a **question** (Query). Every book has a **label** (Key) and **content** (Value). You compare your question to each label, then read mostly from the most relevant books.

```python
score(Q, K) = (Q · K) / sqrt(head_dim)
```

The dot product measures similarity. Divide by `sqrt(head_dim)` to keep values stable across dimensions.

### Multi-Head Attention

Multiple attention heads run in parallel, each learning to look for different patterns — one might track vowels, another tracks position, another tracks repetition.

### The MLP — Where Knowledge Lives

```
Attention lets tokens TALK TO EACH OTHER.
The MLP lets each token THINK BY ITSELF.
```

The MLP expands the representation 4x, applies a non-linearity (ReLU), then compresses back. Research suggests this is where factual knowledge is stored.

### Residual Connections — The Skip Highway

Without residuals, gradients vanish after ~10 layers. With them, 80+ layer networks train successfully. The model learns what to **add** to the input, not what to replace it with.

---

## 6. Training — Going to School

```python
for step in range(num_steps):
    # Forward: predict next token
    # Loss: -log(prob of correct answer)
    # Backward: compute all gradients
    # Update: nudge parameters with Adam
```

The loss function is cross-entropy: "how surprised was the model by the truth?" If the model assigns 80% probability to the correct next token, loss is low. If only 1%, loss is high.

**Adam optimizer** adds momentum (consistent direction = bigger steps) and adaptive rates (noisy gradient = smaller steps). Learning rate decays from large (explore broadly) to tiny (fine-tune carefully).

---

## 7. Inference — The Model Speaks

```python
probs = softmax([l / temperature for l in logits])
token_id = random.choices(range(vocab_size), weights=probs)[0]
```

The model generates one token at a time, feeding each output back as input. **Temperature** controls randomness: low = deterministic and safe, high = creative and unpredictable. This is the same slider you see in ChatGPT and Claude.

**KV Cache** makes this fast — instead of recomputing all past tokens every step, we cache their Key and Value vectors. This is why LLM inference is O(n) not O(n²) per new token.

---

## 8. From microGPT to Frontier Models

Same algorithm. Same architecture. Just more of everything:

| Component | microgpt | Qwen 3.5 |
|-----------|----------|-----------|
| Layers | 1 | 80+ |
| Embedding dim | 16 | 8,192 |
| Context length | 16 | 128,000+ |
| Parameters | 4,192 | 72 Billion |

Key upgrades: **RoPE** (rotary position embeddings generalize to any sequence length), **GQA** (grouped query attention reduces KV cache 3-4x), **SwiGLU** (smoother activation, no dead neurons).

What makes models good at reasoning isn't the architecture — it's **scale**, training on **reasoning examples**, **RLHF alignment**, and **reinforcement learning on correct answers**.

---

## The Entire Algorithm on One Page

```
DATA:   text → tokenize → sequences of integers
MODEL:  token → embed → { attention + MLP } × N → logits
LOSS:   -log(prob of correct next token)
LEARN:  loss.backward() → Adam updates all params
INFER:  BOS → model → sample → feed back → repeat

That's it. Everything else is engineering.
```

---

*Based on Andrej Karpathy's [microgpt](https://gist.github.com/karpathy/8627fe009c40f57531cb18360106ce95) and [Zero to Hero](https://karpathy.ai/zero-to-hero.html) series.*
