"""
T68Bot PC Training API Server
Run on your RTX 5070 Ti PC — exposes a secure API for fine-tuning
Security: API key auth + localhost only + ngrok tunnel (no port forwarding needed)

Usage:
  python pc_training_server.py --api-key YOUR_SECRET_KEY

Then run ngrok:
  ngrok http 8765
"""

from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
import uvicorn, json, os, threading, time, secrets
from pathlib import Path

app = FastAPI(title="T68Bot Training API")

# ── Config ──────────────────────────────────────────────────────────
API_KEY = os.environ.get("T68_API_KEY", "change-me-before-running")
JOB_STATUS = {}  # job_id -> {status, progress, model_url, error}

# ── Models ──────────────────────────────────────────────────────────
class TrainRequest(BaseModel):
    hf_dataset: str          # e.g. "Kooltek68/sn66-ft-dataset-v11"
    base_model: str          # e.g. "Qwen/Qwen2.5-Coder-14B-Instruct"
    hf_output_repo: str      # e.g. "Kooltek68/sn66-ft-pc-v1"
    hf_token: str            # HuggingFace write token
    epochs: int = 3
    lora_rank: int = 16
    batch_size: int = 4
    max_seq_length: int = 2048
    field_instruction: str = "instruction"
    field_output: str = "output"

class StatusResponse(BaseModel):
    job_id: str
    status: str
    progress: str = ""
    model_url: str = ""
    error: str = ""

# ── Auth ────────────────────────────────────────────────────────────
def verify_key(x_api_key: str = Header(...)):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return x_api_key

# ── Training worker ─────────────────────────────────────────────────
def run_training(job_id: str, req: TrainRequest):
    try:
        JOB_STATUS[job_id] = {"status": "starting", "progress": "Loading model...", "model_url": "", "error": ""}

        from unsloth import FastLanguageModel
        from datasets import load_dataset
        from trl import SFTTrainer
        from transformers import TrainingArguments

        # Load model with 4-bit quantization
        JOB_STATUS[job_id]["progress"] = f"Loading {req.base_model}..."
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=req.base_model,
            max_seq_length=req.max_seq_length,
            load_in_4bit=True,
        )

        # Apply LoRA
        model = FastLanguageModel.get_peft_model(
            model,
            r=req.lora_rank,
            target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
            lora_alpha=req.lora_rank * 2,
            lora_dropout=0.05,
            bias="none",
            use_gradient_checkpointing="unsloth",
        )

        # Load dataset
        JOB_STATUS[job_id]["progress"] = f"Loading dataset {req.hf_dataset}..."
        ds = load_dataset(req.hf_dataset, split="train", token=req.hf_token)

        # Format as instruction→output
        def format_row(row):
            inst = row.get(req.field_instruction, "")
            out = row.get(req.field_output, "")
            return {"text": f"### Instruction:\n{inst}\n\n### Response:\n{out}"}

        ds = ds.map(format_row)

        # Train
        JOB_STATUS[job_id]["progress"] = "Training..."
        JOB_STATUS[job_id]["status"] = "training"

        trainer = SFTTrainer(
            model=model,
            tokenizer=tokenizer,
            train_dataset=ds,
            dataset_text_field="text",
            max_seq_length=req.max_seq_length,
            args=TrainingArguments(
                per_device_train_batch_size=req.batch_size,
                gradient_accumulation_steps=4,
                num_train_epochs=req.epochs,
                learning_rate=2e-4,
                fp16=True,
                logging_steps=10,
                output_dir=f"/tmp/sn66-train-{job_id}",
                save_strategy="no",
                warmup_ratio=0.05,
                lr_scheduler_type="cosine",
            ),
        )
        trainer.train()

        # Push to HF
        JOB_STATUS[job_id]["progress"] = f"Pushing to {req.hf_output_repo}..."
        model.push_to_hub(req.hf_output_repo, token=req.hf_token)
        tokenizer.push_to_hub(req.hf_output_repo, token=req.hf_token)

        model_url = f"https://huggingface.co/{req.hf_output_repo}"
        JOB_STATUS[job_id].update({
            "status": "success",
            "progress": "Done!",
            "model_url": model_url
        })

    except Exception as e:
        JOB_STATUS[job_id].update({"status": "error", "error": str(e)})

# ── Endpoints ───────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "gpu": _gpu_info()}

@app.post("/train")
def start_training(req: TrainRequest, x_api_key: str = Header(...)):
    verify_key(x_api_key)
    job_id = secrets.token_hex(8)
    JOB_STATUS[job_id] = {"status": "queued", "progress": "", "model_url": "", "error": ""}
    thread = threading.Thread(target=run_training, args=(job_id, req), daemon=True)
    thread.start()
    return {"job_id": job_id, "status": "queued"}

@app.get("/status/{job_id}")
def get_status(job_id: str, x_api_key: str = Header(...)):
    verify_key(x_api_key)
    if job_id not in JOB_STATUS:
        raise HTTPException(status_code=404, detail="Job not found")
    s = JOB_STATUS[job_id]
    return StatusResponse(job_id=job_id, **s)

@app.get("/jobs")
def list_jobs(x_api_key: str = Header(...)):
    verify_key(x_api_key)
    return {jid: s["status"] for jid, s in JOB_STATUS.items()}

def _gpu_info():
    try:
        import subprocess
        r = subprocess.run(["nvidia-smi","--query-gpu=name,memory.total,memory.free",
                           "--format=csv,noheader"], capture_output=True, text=True)
        return r.stdout.strip()
    except:
        return "unknown"

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-key", required=True, help="Secret API key")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    API_KEY = args.api_key  # set module-level var directly
    print(f"🚀 T68Bot Training API starting on port {args.port}")
    print(f"🔑 API Key: {args.api_key[:8]}...")
    print(f"🔗 After starting, run: ngrok http {args.port}")
    uvicorn.run(app, host="127.0.0.1", port=args.port)
