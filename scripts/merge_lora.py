"""
Merge LoRA adapter with base model and push to HF.
Run on the 5070 Ti PC.
"""
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

BASE_MODEL = "Qwen/Qwen2.5-Coder-7B-Instruct"
ADAPTER_REPO = "Kooltek68/sn66-ft-pc-v1"
OUTPUT_REPO = "Kooltek68/sn66-ft-pc-v1-merged"
import os
HF_TOKEN = os.environ.get("HF_TOKEN", "")

print("Loading base model...")
model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    torch_dtype=torch.float16,
    device_map="cpu",  # CPU for merge (avoids VRAM limit)
    token=HF_TOKEN,
)
tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, token=HF_TOKEN)

print("Loading LoRA adapter...")
model = PeftModel.from_pretrained(model, ADAPTER_REPO, token=HF_TOKEN)

print("Merging adapter into base model...")
model = model.merge_and_unload()

print(f"Pushing merged model to {OUTPUT_REPO}...")
model.push_to_hub(OUTPUT_REPO, token=HF_TOKEN, max_shard_size="2GB")
tokenizer.push_to_hub(OUTPUT_REPO, token=HF_TOKEN)

print("DONE! Merged model at:", f"https://huggingface.co/{OUTPUT_REPO}")
