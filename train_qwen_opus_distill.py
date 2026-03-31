"""
Train Qwen3.5-27B with Claude Opus 4.6 Reasoning Distillation via Unsloth.

Uses all proven Opus 4.6 community datasets:
  1. Roman1111111/claude-opus-4.6-10000x         (~10,000 samples - math/logic core)
  2. nohurry/Opus-4.6-Reasoning-3000x-filtered    (~3,000 samples - Jackrong's proven baseline)
  3. TeichAI/Claude-Opus-4.6-Reasoning-887x       (~887 samples - tool-calling, edge cases)
  4. Crownelius/Opus-4.6-Reasoning-3300x          (~3,300 samples - creative/writing diversity)
  5. LEGENDQ/Claude-Opus-4.6-Reasoning-Dataset    (general reasoning)

Requirements:
  pip install unsloth datasets trl transformers

Hardware:
  - Minimum: 1x RTX 3090 (24GB) with 4-bit quantization
  - Recommended: 1x A100 (80GB) for faster training
"""

import os
import torch
from datasets import load_dataset, concatenate_datasets, DatasetDict
from unsloth import FastLanguageModel
from trl import SFTTrainer
from transformers import TrainingArguments
from unsloth import is_bfloat16_supported

# =============================================================================
# Configuration
# =============================================================================

MODEL_NAME = "unsloth/Qwen3.5-27B"         # Base model
MAX_SEQ_LENGTH = 16384                       # Longer than Jackrong's 8K
LOAD_IN_4BIT = True                          # QLoRA for memory efficiency

# LoRA config — rank 128 (2x Jackrong's rank 64)
LORA_R = 128
LORA_ALPHA = 256                             # 2 * r for stronger adaptation
LORA_DROPOUT = 0
USE_DORA = True                              # Weight-Decomposed LoRA

# Training hyperparameters
BATCH_SIZE = 2
GRADIENT_ACCUMULATION_STEPS = 8              # Effective batch size = 16
NUM_EPOCHS = 3
LEARNING_RATE = 2e-4
WARMUP_RATIO = 0.05
OUTPUT_DIR = "./qwen-opus-distilled"
LOGGING_STEPS = 10
SAVE_STEPS = 200

# Dataset config
SEED = 42
MAX_SAMPLES = None  # Set to an integer to cap total samples (for testing)


# =============================================================================
# 1. Load and merge all Opus 4.6 datasets
# =============================================================================

def load_opus_datasets():
    """Load all proven Opus 4.6 reasoning datasets from HuggingFace."""

    dataset_sources = {
        "roman_10k": "Roman1111111/claude-opus-4.6-10000x",
        "nohurry_3k": "nohurry/Opus-4.6-Reasoning-3000x-filtered",
        "teichai_887": "TeichAI/Claude-Opus-4.6-Reasoning-887x",
        "crownelius_3300": "Crownelius/Opus-4.6-Reasoning-3300x",
        "legendq": "LEGENDQ/Claude-Opus-4.6-Reasoning-Dataset",
    }

    loaded = {}
    for name, repo_id in dataset_sources.items():
        try:
            ds = load_dataset(repo_id, split="train")
            loaded[name] = ds
            print(f"  [OK] {repo_id}: {len(ds)} samples")
        except Exception as e:
            print(f"  [SKIP] {repo_id}: {e}")

    return loaded


def normalize_sample(sample, source_name):
    """
    Normalize all dataset formats to a unified schema:
      - system: system prompt (optional)
      - conversations: list of {"role": ..., "content": ...}

    All reasoning must be wrapped in <think>...</think> tags.
    """

    # -------------------------------------------------------------------------
    # Strategy: try common column patterns across community datasets
    # -------------------------------------------------------------------------

    # Pattern 1: "conversations" column (ShareGPT / OpenAI format)
    if "conversations" in sample and sample["conversations"]:
        convos = sample["conversations"]
        # Already in list-of-dict format
        if isinstance(convos, list) and len(convos) > 0:
            if isinstance(convos[0], dict):
                return {"conversations": convos, "source": source_name}

    # Pattern 2: "messages" column (OpenAI chat format)
    if "messages" in sample and sample["messages"]:
        return {"conversations": sample["messages"], "source": source_name}

    # Pattern 3: "instruction" / "input" / "output" (Alpaca format)
    if "instruction" in sample or "input" in sample or "output" in sample:
        instruction = sample.get("instruction", "") or ""
        inp = sample.get("input", "") or ""
        output = sample.get("output", "") or ""
        user_content = f"{instruction}\n{inp}".strip() if inp else instruction
        return {
            "conversations": [
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": output},
            ],
            "source": source_name,
        }

    # Pattern 4: "prompt" / "response" or "completion"
    if "prompt" in sample:
        response = sample.get("response", "") or sample.get("completion", "") or ""
        return {
            "conversations": [
                {"role": "user", "content": sample["prompt"]},
                {"role": "assistant", "content": response},
            ],
            "source": source_name,
        }

    # Pattern 5: "question" / "answer"
    if "question" in sample:
        return {
            "conversations": [
                {"role": "user", "content": sample["question"]},
                {"role": "assistant", "content": sample.get("answer", "")},
            ],
            "source": source_name,
        }

    # Pattern 6: "text" column (raw text — use as single assistant turn)
    if "text" in sample and sample["text"]:
        return {
            "conversations": [
                {"role": "assistant", "content": sample["text"]},
            ],
            "source": source_name,
        }

    # Fallback: skip
    return None


def has_think_tags(text):
    """Check if text contains <think>...</think> reasoning."""
    return "<think>" in text and "</think>" in text


def validate_sample(sample):
    """Ensure sample has valid reasoning structure."""
    if not sample or "conversations" not in sample:
        return False

    convos = sample["conversations"]
    if not convos or len(convos) == 0:
        return False

    # At least one assistant turn should have <think> tags
    for turn in convos:
        if isinstance(turn, dict) and turn.get("role") == "assistant":
            content = turn.get("content", "")
            if has_think_tags(content):
                return True

    return False


def build_merged_dataset():
    """Load, normalize, validate, deduplicate, and merge all datasets."""

    print("Loading Opus 4.6 datasets...")
    raw_datasets = load_opus_datasets()

    print("\nNormalizing and validating...")
    all_samples = []
    stats = {}

    for name, ds in raw_datasets.items():
        valid = 0
        skipped = 0
        for sample in ds:
            normalized = normalize_sample(sample, name)
            if normalized and validate_sample(normalized):
                all_samples.append(normalized)
                valid += 1
            else:
                skipped += 1
        stats[name] = {"valid": valid, "skipped": skipped}
        print(f"  {name}: {valid} valid, {skipped} skipped")

    # Deduplicate by hashing the first user message
    print("\nDeduplicating...")
    seen = set()
    unique_samples = []
    for s in all_samples:
        user_msgs = [
            t.get("content", "")[:200]
            for t in s["conversations"]
            if t.get("role") == "user"
        ]
        key = hash(tuple(user_msgs))
        if key not in seen:
            seen.add(key)
            unique_samples.append(s)

    duplicates_removed = len(all_samples) - len(unique_samples)
    print(f"  Removed {duplicates_removed} duplicates")
    print(f"  Final dataset: {len(unique_samples)} samples")

    if MAX_SAMPLES:
        unique_samples = unique_samples[:MAX_SAMPLES]
        print(f"  Capped to: {MAX_SAMPLES} samples")

    # Shuffle
    import random
    random.seed(SEED)
    random.shuffle(unique_samples)

    return unique_samples, stats


# =============================================================================
# 2. Format for Unsloth SFT
# =============================================================================

SYSTEM_PROMPT = (
    "You are a highly capable reasoning assistant. "
    "When solving problems, always think step-by-step inside <think>...</think> tags "
    "before providing your final answer."
)


def format_for_training(samples):
    """Convert normalized samples to Unsloth chat format."""
    formatted = []
    for s in samples:
        convos = s["conversations"]

        # Prepend system prompt if not present
        if not convos or convos[0].get("role") != "system":
            convos = [{"role": "system", "content": SYSTEM_PROMPT}] + convos

        formatted.append({"conversations": convos})

    # Convert to HuggingFace Dataset
    from datasets import Dataset
    return Dataset.from_list(formatted)


# =============================================================================
# 3. Model setup
# =============================================================================

def setup_model():
    """Load base model and apply LoRA/DoRA via Unsloth."""

    print(f"\nLoading {MODEL_NAME}...")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=MODEL_NAME,
        max_seq_length=MAX_SEQ_LENGTH,
        load_in_4bit=LOAD_IN_4BIT,
        dtype=None,  # Auto-detect
    )

    print("Applying LoRA...")
    model = FastLanguageModel.get_peft_model(
        model,
        r=LORA_R,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        lora_alpha=LORA_ALPHA,
        lora_dropout=LORA_DROPOUT,
        use_gradient_checkpointing="unsloth",
        use_dora=USE_DORA,
        random_state=SEED,
    )

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f"  Trainable: {trainable:,} / {total:,} ({100*trainable/total:.2f}%)")

    return model, tokenizer


# =============================================================================
# 4. Training
# =============================================================================

def train(model, tokenizer, dataset):
    """Run SFT with train_on_responses_only."""

    training_args = TrainingArguments(
        output_dir=OUTPUT_DIR,
        per_device_train_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=GRADIENT_ACCUMULATION_STEPS,
        num_train_epochs=NUM_EPOCHS,
        learning_rate=LEARNING_RATE,
        warmup_ratio=WARMUP_RATIO,
        lr_scheduler_type="cosine",
        fp16=not is_bfloat16_supported(),
        bf16=is_bfloat16_supported(),
        logging_steps=LOGGING_STEPS,
        save_steps=SAVE_STEPS,
        save_total_limit=3,
        optim="adamw_8bit",
        seed=SEED,
        report_to="none",
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        max_seq_length=MAX_SEQ_LENGTH,
        args=training_args,
        dataset_text_field=None,  # Using conversations format
    )

    # Train on responses only — key technique from Jackrong's approach
    # Loss is computed only on <think> reasoning + final answer, not instructions
    from unsloth import train_on_responses_only
    trainer = train_on_responses_only(
        trainer,
        instruction_part="<|im_start|>user\n",
        response_part="<|im_start|>assistant\n",
    )

    print("\nStarting training...")
    print(f"  Samples: {len(dataset)}")
    print(f"  Epochs: {NUM_EPOCHS}")
    print(f"  Effective batch size: {BATCH_SIZE * GRADIENT_ACCUMULATION_STEPS}")
    print(f"  Max seq length: {MAX_SEQ_LENGTH}")
    print(f"  LoRA rank: {LORA_R} (DoRA: {USE_DORA})")

    trainer.train()

    return trainer


# =============================================================================
# 5. Save and export
# =============================================================================

def save_model(model, tokenizer, trainer):
    """Save LoRA adapters and optionally export to GGUF."""

    # Save LoRA adapters
    lora_dir = os.path.join(OUTPUT_DIR, "lora")
    print(f"\nSaving LoRA adapters to {lora_dir}...")
    model.save_pretrained(lora_dir)
    tokenizer.save_pretrained(lora_dir)

    # Save merged model (16-bit)
    merged_dir = os.path.join(OUTPUT_DIR, "merged-16bit")
    print(f"Saving merged 16-bit model to {merged_dir}...")
    model.save_pretrained_merged(merged_dir, tokenizer, save_method="merged_16bit")

    # Export GGUF (multiple quantizations)
    for quant in ["q4_k_m", "q5_k_m", "q8_0"]:
        gguf_dir = os.path.join(OUTPUT_DIR, f"gguf-{quant}")
        print(f"Exporting GGUF ({quant}) to {gguf_dir}...")
        try:
            model.save_pretrained_gguf(gguf_dir, tokenizer, quantization_method=quant)
        except Exception as e:
            print(f"  [WARN] GGUF export ({quant}) failed: {e}")

    print("\nDone! Model saved to:", OUTPUT_DIR)


# =============================================================================
# Main
# =============================================================================

def main():
    print("=" * 70)
    print("Qwen3.5-27B + Claude Opus 4.6 Reasoning Distillation")
    print("=" * 70)

    # Step 1: Build dataset
    samples, stats = build_merged_dataset()

    # Step 2: Format for training
    dataset = format_for_training(samples)

    # Step 3: Setup model
    model, tokenizer = setup_model()

    # Step 4: Train
    trainer = train(model, tokenizer, dataset)

    # Step 5: Save
    save_model(model, tokenizer, trainer)

    # Summary
    print("\n" + "=" * 70)
    print("Training complete!")
    print("=" * 70)
    print("\nDataset sources:")
    for name, s in stats.items():
        print(f"  {name}: {s['valid']} samples used")
    print(f"\nModel saved to: {OUTPUT_DIR}")
    print(f"  - LoRA adapters: {OUTPUT_DIR}/lora")
    print(f"  - Merged 16-bit: {OUTPUT_DIR}/merged-16bit")
    print(f"  - GGUF exports:  {OUTPUT_DIR}/gguf-*")


if __name__ == "__main__":
    main()
