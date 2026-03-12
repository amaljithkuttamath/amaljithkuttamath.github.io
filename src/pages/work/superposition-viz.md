---
layout: ../../layouts/Post.astro
title: "Watching Superposition Emerge in a Toy Model"
date: "2026-03-12"
description: "Reproducing the key finding from Anthropic's Toy Models of Superposition paper. A 30-line model shows how neural networks pack more features than they have dimensions."
tags: ["superposition", "interpretability", "anthropic", "pytorch"]
repo: "https://github.com/amaljithkuttamath/superposition-viz"
---

The paper [Toy Models of Superposition](https://transformer-circuits.pub/2022/toy_model/index.html) by Elhage et al. at Anthropic answers a question that blocks almost everything else in mechanistic interpretability: why can't you just read features off individual neurons?

The answer is superposition. Neural networks learn to represent more features than they have dimensions. A layer with 5 neurons doesn't store 5 features. It might store 10, overlapping them in ways that only work because most features are rarely active at the same time. This means no single neuron maps to a single concept. It's the core reason interpretability is hard.

I reproduced the key results from the paper in about 30 lines of PyTorch. The code trains a toy model and generates four plots that make superposition visible.

---

## The model

The setup is minimal. A linear encoder W (m x n dimensions) compresses n input features through an m-dimensional bottleneck, then a tied-weight decoder W^T reconstructs the original. A ReLU sits between encoder and decoder. Training minimizes importance-weighted MSE loss, where feature importance decays as 0.7^i. Feature 0 matters the most. Feature 9 matters the least.

The interesting variable is **sparsity**. At sparsity 0.0, all features are active in every input. At sparsity 0.9, each feature is active only 10% of the time. The model trains separately at each sparsity level, and you watch what changes.

---

## The phase diagram

This is the central result. 10 features compressed through 5 hidden dimensions. The x-axis is feature index (decreasing importance), y-axis is sparsity level, and color encodes reconstruction quality (feature benefit = 1 - MSE/variance).

At **sparsity 0.0**, only the top 4 features are well-represented. They show up bright in the heatmap. Features 4 through 9 are dark, essentially discarded. The model has 5 dimensions but can only faithfully store about 4 features. One dimension is wasted on interference.

At **sparsity 0.9**, the picture changes. Features 0 through 4 are bright, and feature 5 starts appearing. The boundary between "represented" and "not represented" shifts to the right. The model is now storing more features than it has dimensions.

This is superposition. The model packs extra features into shared dimensions, tolerating the interference because sparse features rarely collide in the same input. The math works out: if two features are each active 10% of the time, they co-activate only 1% of the time. The occasional reconstruction error is worth the extra capacity.

---

## The phase transition is sharp

The dimensionality plot tracks how many features cross a benefit threshold of 0.5 (well-represented) as sparsity increases. At low sparsity, the count sits at 4. Around **sparsity 0.7**, it jumps to 5. This isn't a gradual improvement. It's a phase transition: a critical sparsity where the model suddenly discovers it can fit another feature.

This matters because it suggests superposition isn't a smooth tradeoff. There's a threshold below which the model doesn't bother, and above which it commits. The paper discusses this in terms of geometric constraints, how features arrange themselves to minimize interference given a capacity budget.

---

## Feature geometry

5 features projected into a 2D bottleneck, visualized as arrows from the origin. At **sparsity 0.0**, only 2 features get strong arrows pointing in distinct directions. The remaining 3 collapse to near-zero length. The model has 2 dimensions and uses them for the 2 most important features. Everything else is sacrificed.

At **sparsity 0.9 to 0.99**, all 5 features fan out across the 2D plane. They overlap, but the model doesn't care. Features rarely co-activate, so the shared directions cause minimal reconstruction error in practice.
---

## Interference structure

The gram matrix W^T W reveals how features interact. Diagonal entries show self-reconstruction strength. Off-diagonal entries show interference between features.

At **sparsity 0.0**, the top features have strong diagonals, but the off-diagonal is messy. Features are competing for the same dimensions and interfering with each other.

At **sparsity 0.99**, the diagonal is clean for the top 3 to 4 features, and the rest is near zero. Less interference overall, because the model has arranged features to avoid collision in the dimensions they share.

---

## Why this matters for interpretability

Anthropic's ongoing work on sparse autoencoders and dictionary learning is specifically about extracting features from superposition. If a production model stores 50,000 features in a 4,096-dimensional layer, you need a method to decompose those overlapping representations back into individual concepts. You can't just look at neuron activations and label them.

The toy model makes the problem concrete. 10 features, 5 dimensions, one ReLU. You can see exactly when and why the model decides to overlap features. In a real transformer, the same dynamics play out at a scale where visualization is impossible. But the mechanism is the same.

---

## Try it

```bash
git clone https://github.com/amaljithkuttamath/superposition-viz.git
cd superposition-viz
pip install -r requirements.txt
python superposition.py
```

It generates four PNG plots in a few seconds. The code is short enough to read in one sitting. If you want to build intuition for why interpretability is hard, training this model and watching the phase diagram fill in is a good place to start.
