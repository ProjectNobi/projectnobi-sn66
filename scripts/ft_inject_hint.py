#!/usr/bin/env python3
"""
Inject FT hint directly into AGENTS.md as the first section.
This puts the hint in the system prompt so Gemini WILL see it.
Usage: 
  python3 ft_inject_hint.py inject <task_file>  # inject hint into AGENTS.md
  python3 ft_inject_hint.py restore             # restore original AGENTS.md

The inject→solve→restore pattern ensures the hint is in the system prompt
without permanently modifying AGENTS.md.
"""
import os
import sys
import json
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from pathlib import Path

# OUR_AGENT dir — must match OUR_AGENT in local_test.sh
AGENT_DIR = "/root/sn66-v7"
AGENTS_MD = os.path.join(AGENT_DIR, "AGENTS.md")
AGENTS_MD_GOLDEN = os.path.join(AGENT_DIR, ".AGENTS.md.golden")  # immutable original
AGENTS_MD_BACKUP = os.path.join(AGENT_DIR, ".AGENTS.md.orig")   # per-round backup

HINT_HEADER = """# PRE-SOLVE REFERENCE HINT

A fine-tuned model trained on 9,122 real reference diffs predicted this target.

```diff
{hint_content}
```

**Rules:**
- The FILES: line lists which files the reference likely touches — search for them FIRST
- Match the change TYPE (add field, add route, remove component, etc.)
- If tech stack looks wrong, ignore the exact code but keep the file pattern
- Process files in alphabetical order

---

"""


def get_hint(task_path: str) -> str:
    """Call FT endpoint to get the predicted diff hint.
    Primary: 5060 Ti Ollama (100.101.61.83:11434) always-on.
    Fallback: HF inference endpoint (SN66_FT_ENDPOINT env var).
    """
    ollama_url = os.environ.get("SN66_OLLAMA_URL", "http://100.101.61.83:11434")
    ollama_model = os.environ.get("SN66_OLLAMA_MODEL", "qwen2.5-coder:7b")
    endpoint = os.environ.get("SN66_FT_ENDPOINT", "")
    token = os.environ.get("SN66_FT_TOKEN", "")

    # Try Ollama first (5060 Ti - always on, fast)
    try:
        with open(task_path, "r") as _f:
            _task = _f.read(800)
        if _task.strip():
            import urllib.request as _ur
            _payload = json.dumps({"model": ollama_model, "prompt": f"You are a code diff prediction assistant. Given a coding task, predict:\n1. Which files need to be changed (list them first)\n2. The git diff showing the changes\n\nOutput format:\nFILES: file1.ts, file2.ts, config.json\n\ndiff --git a/file1.ts b/file1.ts\n...\n\nTask:\n{_task}", "stream": False, "options": {"num_predict": 1500, "temperature": 0.05}}).encode()
            _req = _ur.Request(f"{ollama_url}/api/generate", data=_payload, headers={"Content-Type": "application/json"}, method="POST")
            with _ur.urlopen(_req, timeout=30) as _resp:
                _body = json.loads(_resp.read().decode())
            _hint = _body.get("response", "").strip()
            if _hint:
                return _hint
    except Exception as _ex:
        print(f"[ft-inject] Ollama hint failed: {type(_ex).__name__}: {_ex}", flush=True)

    if not endpoint:
        return ""

    try:
        with open(task_path, "r") as f:
            task_text = f.read(800)
        if not task_text.strip():
            return ""

        chat_url = endpoint.rstrip("/") + "/v1/chat/completions"
        payload = json.dumps({
            "model": "tgi",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a code editing assistant. Given a software engineering task, "
                        "predict the minimal git diff that would solve it. "
                        "Output ONLY the git diff — no explanation, no preamble."
                    )
                },
                {"role": "user", "content": task_text}
            ],
            "max_tokens": 1500,
            "temperature": 0.05,
        }).encode("utf-8")

        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        req = Request(chat_url, data=payload, headers=headers, method="POST")
        with urlopen(req, timeout=25) as resp:
            body = json.loads(resp.read().decode("utf-8"))

        choices = body.get("choices", [])
        if choices:
            raw = choices[0].get("message", {}).get("content", "").strip()
            # Strip outer markdown code fencing if present
            lines = raw.split('\n')
            if lines and lines[0].strip().startswith('```'):
                lines = lines[1:]
            if lines and lines[-1].strip() == '```':
                lines = lines[:-1]
            return '\n'.join(lines).strip()
    except Exception as ex:
        print(f"[ft-inject] hint generation failed: {type(ex).__name__}: {ex}", flush=True)

    return ""


def inject(task_path: str):
    """Get hint and inject into AGENTS.md."""
    # Get hint
    hint = get_hint(task_path)

    # Read current AGENTS.md
    with open(AGENTS_MD, "r") as f:
        original = f.read()

    # Backup original
    with open(AGENTS_MD_BACKUP, "w") as f:
        f.write(original)

    if hint:
        # Build new AGENTS.md with hint at top
        hint_section = HINT_HEADER.format(hint_content=hint)
        new_content = hint_section + original
        print(f"[ft-inject] Injected {len(hint)} char hint into AGENTS.md", flush=True)
    else:
        # No hint - restore backup (no change needed, but ensure backup exists)
        print("[ft-inject] No hint available, AGENTS.md unchanged", flush=True)
        new_content = original

    with open(AGENTS_MD, "w") as f:
        f.write(new_content)


def restore():
    """Restore original AGENTS.md after solve. Always restores from golden copy."""
    # Prefer golden copy (immutable original) over per-round backup
    golden = Path(AGENTS_MD_GOLDEN)
    backup = Path(AGENTS_MD_BACKUP)
    
    if golden.exists():
        # Restore from immutable golden copy
        with open(AGENTS_MD_GOLDEN, "r") as f:
            original = f.read()
        with open(AGENTS_MD, "w") as f:
            f.write(original)
        # Clean up per-round backup if exists
        if backup.exists():
            backup.unlink()
        print("[ft-inject] AGENTS.md restored from golden", flush=True)
    elif backup.exists():
        with open(AGENTS_MD_BACKUP, "r") as f:
            original = f.read()
        with open(AGENTS_MD, "w") as f:
            f.write(original)
        backup.unlink()
        print("[ft-inject] AGENTS.md restored from backup", flush=True)
    else:
        print("[ft-inject] WARNING: No golden or backup found", flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    
    if cmd == "inject" and len(sys.argv) > 2:
        inject(sys.argv[2])
    elif cmd == "restore":
        restore()
    else:
        print("Usage: python3 ft_inject_hint.py inject <task_file>")
        print("       python3 ft_inject_hint.py restore")
