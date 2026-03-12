---
layout: ../../layouts/Post.astro
title: "How Large Language Models Actually Work"
date: "2025-03-07"
description: "A visual, from-scratch deep dive into the algorithm behind GPT, Qwen, Llama, and every other LLM."
tags: ["transformers", "from-scratch", "deep-dive"]
repo: "https://github.com/amaljithkuttamath/autoresearch-mlx-qwen-3-5"
---

> Based on Andrej Karpathy's [microgpt](https://gist.github.com/karpathy/8627fe009c40f57531cb18360106ce95). 200 lines of pure Python containing the core algorithm behind every modern LLM. The CUDA kernels, distributed training, and trillion-token datasets are engineering challenges on top of this foundation. But the mechanism itself fits on a napkin.

> **Want to see it live?** [Open the interactive playground](/playground) and watch a tiny GPT learn to write names in your browser.

## 1. The Core Idea

Every large language model (GPT-4, Claude, Llama, Qwen) runs the same core loop:

```
1. Read a lot of text
2. For each token, predict the next one
3. Measure how wrong you were
4. Adjust parameters to be less wrong
5. Repeat billions of times
```

Simple to state. The depth is in the details.

---

## 2. The Dataset

```python
docs = [line.strip() for line in open('input.txt') if line.strip()]
random.shuffle(docs)
```

The model loads 32,000 human names ("emma", "olivia", "liam", "noah"), each treated as a tiny document.

At its core, an LLM is a statistical model of language. It learns patterns: feed it names and it learns what sequences of letters *look like* English names. Feed it the entire internet and it learns what sequences of words *look like* human knowledge. Whether that constitutes "understanding" is an open question. What's clear is that the same algorithm works at both ends of the spectrum. The only difference is how much data and how many parameters you give it.

---

## 3. The Tokenizer

```python
uchars = sorted(set(''.join(docs)))   # ['a', 'b', 'c', ..., 'z']
BOS = len(uchars)                      # 26 = special token
vocab_size = len(uchars) + 1           # 27 total tokens
```

Neural networks speak numbers, not text. So we need a mapping from every unique symbol to an integer.

**BOS** (Beginning of Sequence) is a special token meaning "a new document starts here." Every LLM uses these structural tokens. ChatGPT has `<|im_start|>` and `<|im_end|>`. They're invisible to users, but they frame every conversation.
Production models like Qwen use **Byte Pair Encoding**, a smarter scheme that merges frequently occurring character pairs into single tokens. "understanding" becomes `[un, der, stand, ing]`: 4 tokens instead of 13 characters. Fewer tokens = faster processing.

---

## 4. The Autograd Engine

*The learning algorithm*

If you understand autograd, you understand how every neural network learns.

Every calculation the model performs is recorded in a computation graph. Why? Because of **backpropagation**, the algorithm that answers:

> "If I wiggle each input slightly, how does the final output change?"

This is a **gradient**: the direction and amount to adjust each parameter.

```python
child.grad += local_grad * v.grad
```

That single line is the chain rule, applied recursively through a computation graph. It's the foundation of all gradient-based learning.

PyTorch, TensorFlow, JAX all implement variations of this. The elegance here is that no matter how complex your model gets, learning reduces to this same backward pass.

---

## 5. The Transformer Architecture

This is the core of the model, from "Attention Is All You Need" (Vaswani et al., 2017).

### Attention

Imagine you're in a library. You have a **question** (Query). Every book has a **label** (Key) and **content** (Value). You compare your question to each label, then read mostly from the most relevant books.

```python
score(Q, K) = (Q · K) / sqrt(head_dim)
```

The dot product measures similarity. Divide by `sqrt(head_dim)` to keep values stable across dimensions.

*Watch attention patterns form in real time in the [playground](/playground).*

### Multi-Head Attention

Multiple attention heads run in parallel, each learning to look for different patterns. One might track vowels, another tracks position, another tracks repetition. In the playground, you can see heads specialize within the first few hundred steps.

### The MLP

Attention lets tokens communicate with each other. The MLP lets each token process information independently. The MLP expands the representation 4x, applies a non-linearity (ReLU), then compresses back. There's evidence suggesting this is where factual knowledge gets stored (Meng et al., 2022), though the picture is more nuanced than "MLPs = memory." This remains an open question in mechanistic interpretability.

### Residual Connections

Without residual connections, gradients vanish after roughly 10 layers. With them, 80+ layer networks train successfully. The model learns what to **add** to the existing representation, not what to replace it with. This framing matters for interpretability, because it means each layer's contribution can be studied independently.

---

## 6. Training

```python
for step in range(num_steps):
    # Forward: predict next token
    # Loss: -log(prob of correct answer)
    # Backward: compute all gradients
    # Update: nudge parameters with Adam
```

The loss function is cross-entropy: "how surprised was the model by the truth?" If the model assigns 80% probability to the correct next token, loss is low. If only 1%, loss is high.

**Adam optimizer** adds momentum (consistent direction = bigger steps) and adaptive rates (noisy gradient = smaller steps). Learning rate decays from large (explore broadly) to tiny (fine-tune carefully).

*The [playground](/playground) shows the loss curve dropping as the model learns.*

---

## 7. Inference

```python
probs = softmax([l / temperature for l in logits])
token_id = random.choices(range(vocab_size), weights=probs)[0]
```

The model generates one token at a time, feeding each output back as input. **Temperature** controls randomness: low values make the model deterministic and safe, high values make it creative and unpredictable. This is the same slider you see in ChatGPT and Claude.

**KV Cache** makes this practical. Without it, generating each new token requires recomputing keys and values for every previous token. With caching, we store those vectors and only compute the new token's attention over them. The speedup is significant, especially for long sequences.

*Try generating names yourself in the [playground](/playground).*

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

What makes models good at reasoning isn't the architecture alone. It's scale, training on reasoning examples, RLHF alignment, and reinforcement learning on correct answers. The architecture provides the capacity. Everything else determines what fills it.

---

## The Entire Algorithm on One Page

```
DATA:   text → tokenize → sequences of integers
MODEL:  token → embed → { attention + MLP } × N → logits
LOSS:   -log(prob of correct next token)
LEARN:  loss.backward() → Adam updates all params
INFER:  BOS → model → sample → feed back → repeat
```

The algorithm is simple. Making it work reliably at scale, understanding *why* it works, and figuring out when to trust its outputs are where the hard problems live.
---

*Based on Andrej Karpathy's [microgpt](https://gist.github.com/karpathy/8627fe009c40f57531cb18360106ce95) and [Zero to Hero](https://karpathy.ai/zero-to-hero.html) series, and Sebastian Raschka's [Build a Large Language Model From Scratch](https://github.com/rasbt/LLMs-from-scratch) ([book](https://www.manning.com/books/build-a-large-language-model-from-scratch)).*
