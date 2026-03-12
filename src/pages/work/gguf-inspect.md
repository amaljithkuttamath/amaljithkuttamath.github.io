---
layout: ../../layouts/Post.astro
title: "What's Actually Inside a GGUF File?"
date: "2026-03-11"
description: "I parsed a Llama 3.2 model file byte by byte. Here's what the format reveals about quantization, architecture, and how inference engines load models."
tags: ["gguf", "llama", "quantization", "rust", "model-internals"]
repo: "https://github.com/amaljithkuttamath/gguf-inspect"
---

I wanted to understand what llama.cpp actually reads when it loads a model. Not the documentation. The bytes. So I wrote a parser from scratch in Rust, pointed it at a Llama 3.2 3B Instruct GGUF file, and printed everything it found.

The format is simpler than I expected.

---

## The header

GGUF files start with a magic number (`GGUF`), a version, and two counts: how many tensors and how many key-value metadata pairs follow. That's the entire header. No compression, no chunking, no nested structures. Just a flat binary layout.

Here's what `gguf-inspect` prints for Llama 3.2 3B Instruct:

```
GGUF Model Summary
==================================================
  Model name:       Llama 3.2 3B Instruct
  Architecture:     llama
  GGUF version:     3
  Tensor count:     255
  Parameters:       3.21B
  Context length:   131072
  Embedding size:   3072
  Layers:           28
  Attention heads:  24
  KV heads:         8
  Vocab size:       128256
  Quantization:     Q4_K_M
  File size:        1.88 GB
  Tensor data size: 1.87 GB
  Est. memory:      2.06 GB (tensors + ~10% overhead)
```

Every one of these values comes from metadata baked into the file. The architecture name, the number of layers, the context length, the vocabulary size. This is how llama.cpp knows how to run any model without a separate config file. The GGUF format is self-describing.

---

## Quantization is not uniform

The summary says Q4_K_M, which is the dominant quantization type. But individual tensors tell a different story.

The embedding table:

```
token_embd.weight: 3072 x 128256, Q6_K, 308 MB
```

That's Q6_K, not Q4_K. The embedding table maps token IDs to vectors. It's the first thing the model touches on every forward pass, and errors here propagate through every layer. The quantizer keeps it at higher precision.

The attention weights:

```
blk.0.attn_q.weight: 3072 x 3072, Q4_K
blk.0.attn_k.weight: 3072 x 1024, Q4_K
blk.0.attn_v.weight: 3072 x 1024, Q4_K
```

These are aggressively quantized to Q4_K. There are 28 layers of these, so even small per-tensor savings compound.

And then there are the values that never get quantized at all:

```
rope_freqs.weight: 64, F32
```

Rotary position encoding frequencies are 64 floats. Full FP32. Quantizing them would save a few hundred bytes and risk breaking position awareness entirely. Not worth it.

This mixed-precision strategy is the key insight of modern quantization. It's not "make everything 4-bit." It's "make everything 4-bit except the parts that break when you do."

---

## Grouped query attention, visible in the shapes

Look at the attention tensor dimensions again. The query projection is 3072 x 3072, producing vectors for 24 attention heads (3072 / 24 = 128 dimensions per head). But the key and value projections are 3072 x 1024, producing vectors for only 8 heads (1024 / 8 = 128 dimensions per head).

This is grouped query attention (GQA). Every 3 query heads share one key-value head. The model stores fewer KV parameters per layer, and at inference time, the KV cache is 3x smaller than it would be with standard multi-head attention. That's how you serve long context windows without running out of memory.

The metadata confirms it: 24 attention heads, 8 KV heads. You can read GQA ratios directly from the file without opening a config.json.

---

## The numbers

3.21 billion parameters in 1.88 GB. That works out to 0.59 bytes per parameter. At FP32, each parameter is 4 bytes. Q4_K_M achieves roughly 6.7x compression.

The tensor data alone is 1.87 GB. The remaining ~10 MB is metadata and alignment padding. Almost the entire file is weights.

The estimated memory of 2.06 GB adds a 10% overhead for runtime buffers, the KV cache, and scratch space. In practice, you can run this model on any machine with 4 GB of RAM. A 3-billion-parameter language model running on a laptop, because quantization turned 12 GB of weights into less than 2.

Context length is another number worth staring at. 131072 tokens. That's baked into the metadata as `llama.context_length`, not a runtime configuration. The model was trained (or fine-tuned with RoPE scaling) to handle 128K context. Whether your inference engine actually allocates a KV cache that large is a separate question, but the model was built for it.

---

## Why parse it yourself

There are GGUF reading libraries. I didn't use them. Writing the parser from scratch forced me to understand every decision in the format.

The binary layout is almost trivial: magic bytes, version, counts, then a sequence of key-value pairs (each with a type tag and length prefix), then tensor descriptors (name, dimensions, quantization type, offset), then a blob of tensor data at the offsets described. No indirection. No index tables. A single sequential read can parse the entire file.

This simplicity is deliberate. llama.cpp needs to memory-map these files and start inference immediately. Complex formats with compression or random-access indices would add startup latency. GGUF optimizes for "open the file and go."

---

## Try it

```bash
git clone https://github.com/amaljithkuttamath/gguf-inspect.git
cd gguf-inspect
cargo build --release
./target/release/gguf-inspect your-model.gguf
```

Point it at any GGUF file. It prints the summary, the metadata, and the full tensor manifest. The code is MIT licensed and has zero dependencies beyond the Rust standard library.

If you work with quantized models, understanding the container format changes how you think about them. They're not black boxes. They're flat files with a header that tells you everything.
