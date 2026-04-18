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

# Save locally first (avoids stuck push_to_hub)
SAVE_PATH = r"C:\t68bot\sn66-ft-pc-v1-merged"
print(f"Saving merged model locally to {SAVE_PATH}...")
model.save_pretrained(SAVE_PATH, max_shard_size="2GB")
tokenizer.save_pretrained(SAVE_PATH)
print("Local save complete!")

# Upload using chunked upload_folder (handles large files better)
from huggingface_hub import HfApi, create_repo
api = HfApi()
try:
    create_repo(OUTPUT_REPO, token=HF_TOKEN, exist_ok=True)
except: pass
print(f"Uploading to {OUTPUT_REPO}...")
api.upload_folder(
    folder_path=SAVE_PATH,
    repo_id=OUTPUT_REPO,
    token=HF_TOKEN,
    repo_type="model",
)
print("DONE! Merged model at:", f"https://huggingface.co/{OUTPUT_REPO}")
