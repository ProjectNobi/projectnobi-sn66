"""
T68Bot PC Training API Server
Run on your RTX 5070 Ti PC — exposes a secure API for fine-tuning
Security: API key auth + localhost only + Tailscale tunnel

Usage:
  python pc_training_server.py --api-key YOUR_SECRET_KEY
"""

import argparse, os, secrets, threading
import uvicorn
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel

# ── Parse args first, before anything else ──────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--api-key", required=True, help="Secret API key")
parser.add_argument("--port", type=int, default=8765)
_args = parser.parse_args()

CONFIGURED_API_KEY = _args.api_key
CONFIGURED_PORT = _args.port

app = FastAPI(title="T68Bot Training API")
JOB_STATUS = {}

# ── Request models ───────────────────────────────────────────────────
class TrainRequest(BaseModel):
    hf_dataset: str
    base_model: str
    hf_output_repo: str
    hf_token: str
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

# ── Auth ─────────────────────────────────────────────────────────────
def check_key(x_api_key: str = Header(...)):
    if x_api_key != CONFIGURED_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

# ── Training worker ──────────────────────────────────────────────────
def run_training(job_id: str, req: TrainRequest):
    try:
        JOB_STATUS[job_id] = {"status": "starting", "progress": "Loading model...", "model_url": "", "error": ""}

        from unsloth import FastLanguageModel
        from datasets import load_dataset
        from trl import SFTTrainer
        from transformers import TrainingArguments

        JOB_STATUS[job_id]["progress"] = f"Loading {req.base_model}..."
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=req.base_model,
            max_seq_length=req.max_seq_length,
            load_in_4bit=True,
        )

        model = FastLanguageModel.get_peft_model(
            model,
            r=req.lora_rank,
            target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
            lora_alpha=req.lora_rank * 2,
            lora_dropout=0.05,
            bias="none",
            use_gradient_checkpointing="unsloth",
        )

        JOB_STATUS[job_id]["progress"] = f"Loading dataset {req.hf_dataset}..."
        ds = load_dataset(req.hf_dataset, split="train", token=req.hf_token)

        def format_row(row):
            inst = row.get(req.field_instruction, "")
            out = row.get(req.field_output, "")
            return {"text": f"### Instruction:\n{inst}\n\n### Response:\n{out}"}

        ds = ds.map(format_row)

        JOB_STATUS[job_id]["status"] = "training"
        JOB_STATUS[job_id]["progress"] = "Training..."

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
                output_dir=f"C:\\t68bot\\train-{job_id}",
                save_strategy="no",
                warmup_ratio=0.05,
                lr_scheduler_type="cosine",
            ),
        )
        trainer.train()

        JOB_STATUS[job_id]["progress"] = f"Pushing to {req.hf_output_repo}..."
        model.push_to_hub(req.hf_output_repo, token=req.hf_token)
        tokenizer.push_to_hub(req.hf_output_repo, token=req.hf_token)

        JOB_STATUS[job_id].update({
            "status": "success",
            "progress": "Done!",
            "model_url": f"https://huggingface.co/{req.hf_output_repo}"
        })

    except Exception as e:
        JOB_STATUS[job_id].update({"status": "error", "error": str(e)})

# ── Endpoints ────────────────────────────────────────────────────────
@app.get("/health")
def health():
    try:
        import subprocess
        r = subprocess.run(["nvidia-smi","--query-gpu=name,memory.free","--format=csv,noheader"],
                          capture_output=True, text=True)
        gpu = r.stdout.strip()
    except:
        gpu = "unknown"
    return {"status": "ok", "gpu": gpu}

@app.post("/train")
def start_training(req: TrainRequest, x_api_key: str = Header(...)):
    check_key(x_api_key)
    job_id = secrets.token_hex(8)
    JOB_STATUS[job_id] = {"status": "queued", "progress": "", "model_url": "", "error": ""}
    threading.Thread(target=run_training, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id, "status": "queued"}

@app.get("/status/{job_id}")
def get_status(job_id: str, x_api_key: str = Header(...)):
    check_key(x_api_key)
    if job_id not in JOB_STATUS:
        raise HTTPException(status_code=404, detail="Job not found")
    s = JOB_STATUS[job_id]
    return StatusResponse(job_id=job_id, **s)

@app.get("/jobs")
def list_jobs(x_api_key: str = Header(...)):
    check_key(x_api_key)
    return {jid: s["status"] for jid, s in JOB_STATUS.items()}

# ── Start ────────────────────────────────────────────────────────────
print(f"T68Bot Training API starting on port {CONFIGURED_PORT}")
print(f"API Key: {CONFIGURED_API_KEY[:8]}...")
print(f"GPU: ", end="")
try:
    import subprocess
    r = subprocess.run(["nvidia-smi","--query-gpu=name","--format=csv,noheader"], capture_output=True, text=True)
    print(r.stdout.strip())
except:
    print("checking...")

uvicorn.run(app, host="127.0.0.1", port=CONFIGURED_PORT)
