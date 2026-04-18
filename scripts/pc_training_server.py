"""
T68Bot PC Training API Server - v2 (no Unsloth, standard transformers+PEFT)
Works with any CUDA version including 13.x
"""

import argparse, os, secrets, threading
import uvicorn
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel

parser = argparse.ArgumentParser()
parser.add_argument("--api-key", required=True)
parser.add_argument("--port", type=int, default=8765)
_args = parser.parse_args()

CONFIGURED_API_KEY = _args.api_key
CONFIGURED_PORT = _args.port

app = FastAPI(title="T68Bot Training API v2")
JOB_STATUS = {}

class TrainRequest(BaseModel):
    hf_dataset: str
    base_model: str
    hf_output_repo: str
    hf_token: str
    epochs: int = 3
    lora_rank: int = 32
    batch_size: int = 2
    max_seq_length: int = 2048
    field_instruction: str = "instruction"
    field_output: str = "output"

def check_key(x_api_key: str = Header(...)):
    if x_api_key != CONFIGURED_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

def run_training(job_id: str, req: TrainRequest):
    try:
        import torch
        JOB_STATUS[job_id] = {"status": "starting", "progress": f"CUDA: {torch.cuda.is_available()}, GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none'}", "model_url": "", "error": ""}

        if not torch.cuda.is_available():
            raise RuntimeError(f"CUDA not available. torch version: {torch.__version__}, cuda compiled: {torch.version.cuda}")

        from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
        from peft import LoraConfig, get_peft_model, TaskType
        from trl import SFTTrainer
        from datasets import load_dataset

        JOB_STATUS[job_id]["progress"] = f"Loading {req.base_model}..."
        tokenizer = AutoTokenizer.from_pretrained(req.base_model, token=req.hf_token)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token

        model = AutoModelForCausalLM.from_pretrained(
            req.base_model,
            torch_dtype=torch.float16,
            device_map="auto",
            token=req.hf_token,
        )

        lora_config = LoraConfig(
            r=req.lora_rank,
            lora_alpha=req.lora_rank * 2,
            target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"],
            lora_dropout=0.05,
            bias="none",
            task_type=TaskType.CAUSAL_LM,
        )
        model = get_peft_model(model, lora_config)
        model.print_trainable_parameters()

        JOB_STATUS[job_id]["progress"] = f"Loading dataset {req.hf_dataset}..."
        ds = load_dataset(req.hf_dataset, split="train", token=req.hf_token)

        def format_row(row):
            inst = row.get(req.field_instruction, "")
            out = row.get(req.field_output, "")
            return {"text": f"### Instruction:\n{inst}\n\n### Response:\n{out}"}

        ds = ds.map(format_row, remove_columns=ds.column_names, num_proc=1)

        JOB_STATUS[job_id]["status"] = "training"
        JOB_STATUS[job_id]["progress"] = "Training..."

        trainer = SFTTrainer(
            model=model,
            tokenizer=tokenizer,
            train_dataset=ds,
            dataset_text_field="text",
            max_seq_length=req.max_seq_length,
            args=TrainingArguments(
                output_dir=f"C:\\t68bot\\train-{job_id}",
                per_device_train_batch_size=req.batch_size,
                gradient_accumulation_steps=4,
                num_train_epochs=req.epochs,
                learning_rate=2e-4,
                fp16=True,
                logging_steps=10,
                save_strategy="no",
                warmup_ratio=0.05,
                lr_scheduler_type="cosine",
                report_to="none",
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
        import traceback
        JOB_STATUS[job_id].update({"status": "error", "error": f"{str(e)}\n{traceback.format_exc()[-500:]}"})

@app.get("/health")
def health():
    try:
        import torch
        gpu = f"{torch.cuda.get_device_name(0)}, CUDA={torch.cuda.is_available()}, torch={torch.__version__}"
    except Exception as e:
        gpu = str(e)
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
    return {"job_id": job_id, **JOB_STATUS[job_id]}

@app.get("/jobs")
def list_jobs(x_api_key: str = Header(...)):
    check_key(x_api_key)
    return {jid: s["status"] for jid, s in JOB_STATUS.items()}

if __name__ == "__main__":
    print(f"T68Bot Training API v2 (transformers+PEFT) starting on port {CONFIGURED_PORT}")
    print(f"API Key: {CONFIGURED_API_KEY[:8]}...")
    try:
        import torch
        print(f"torch: {torch.__version__}, CUDA: {torch.cuda.is_available()}")
        if torch.cuda.is_available():
            print(f"GPU: {torch.cuda.get_device_name(0)}")
    except Exception as e:
        print(f"torch check: {e}")

    print(f"Starting uvicorn on 0.0.0.0:{CONFIGURED_PORT}...")
    uvicorn.run(app, host="0.0.0.0", port=CONFIGURED_PORT, log_level="info")
