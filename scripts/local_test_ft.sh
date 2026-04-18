#!/bin/bash
# SN66 (Ninja) Local Testing Pipeline — test AGENTS.md vs king before submitting
# Usage: bash local_test.sh [N_rounds]  (default: 10 quick, use 100 for full)
# Win rate must be >=80% before submitting (1-week king target)
#
# Scoring: positional line-zip against reference.patch (validate.py confirmed)
#
# SERVER ROUTING (James directive 2026-04-13):
#   10-round  → Hetzner1 (fast, already set up)
#   30/68/100 → Server2 (428GB disk, idle CPU, no production interference)
#
# To run on Server2: ssh server2 "BENCHMARK_MODE=true bash /root/local_test_sn66.sh N"

# === FT MODEL CONFIGURATION ===
# FT model is used for HINT GENERATION only — injected into AGENTS.md before each solve.
# Real solver = google/gemini-2.5-flash (tool-call capable).
# DO NOT set SN66_SOLVER_MODEL=tgi — TGI doesn't support tool calls and produces zero diffs.
FT_ENDPOINT=$(grep "^SN66_FT_ENDPOINT=" /root/.secrets/api_keys.env 2>/dev/null | cut -d= -f2 | tr -d '\r')
FT_TOKEN=$(grep "^SN66_FT_TOKEN=" /root/.secrets/api_keys.env 2>/dev/null | cut -d= -f2 | tr -d '\r')
export SN66_FT_ENDPOINT="${FT_ENDPOINT}"
unset SN66_FT_UPSTREAM  # DO NOT route solver through FT endpoint
export SN66_FT_TOKEN="${FT_TOKEN}"
SOLVER_MODEL="${SOLVER_MODEL:-anthropic/claude-sonnet-4-20250514}"
echo "=== SN66 Tierra v3 Test (Gemini Flash + AGENTS_v3_final) ==="
echo "Solver: ${SOLVER_MODEL}"
echo "AGENTS.md: $(wc -c < $OUR_AGENT/AGENTS.md) chars"
# ============================
FT_INJECT_PY="/root/sn66-v7/scripts/ft_inject_hint.py"

ROUNDS=${1:-10}

# Auto-route: 10-round on Hetzner1, 30+ on Server2
# Server2 routing disabled — always run locally (hostname was T68BotHetzner1, not hetzner1)
# To run on Server2 manually: ssh server2 "BENCHMARK_MODE=true bash /root/local_test_sn66.sh $ROUNDS"
WORKSPACE=/tmp/sn66-local-$(date +%s)
TAU_DIR=/root/tau
OUR_AGENT=/root/sn66-v7/agent      # our agent with AGENTS.md
mkdir -p "$WORKSPACE"
ERROR_LOG="$WORKSPACE/errors.log"  # inside workspace so cleanup trap deletes it

# Fix 4: Cleanup trap — remove tmp workspace and prune containers on exit/interrupt
cleanup() {
    rm -rf "$WORKSPACE" 2>/dev/null
    docker container prune -f 2>/dev/null | grep -v '^$' || true
}
trap cleanup EXIT INT TERM

# L-LOCAL-TEST-BASELINE-1: Always fetch CURRENT actual king before running test
# (James directive 2026-04-13 — never use stale or wrong baseline)
# Fetch current king from dashboard (try S3 first, then ninja mirror)
KING_AGENT=$(
  (curl -sf 'https://s3.hippius.com/constantinople/sn66/dashboard.json' 2>/dev/null || \
   curl -sf 'https://ninja.arbos.life/dashboard.json' 2>/dev/null) | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('current_king',{}).get('repo_full_name','furyknight0/creep_v01'))" 2>/dev/null \
  || echo 'furyknight0/creep_v01'
)
echo "[baseline] Current king: $KING_AGENT"
RESULTS_DIR=/root/.openclaw/workspace/research/sn66-local-results

mkdir -p "$WORKSPACE" "$RESULTS_DIR"

# Load API keys (no set -e so missing keys don't crash)
OR_KEY=$(grep "^OPENROUTER_API_KEY" /root/.secrets/api_keys.env 2>/dev/null | cut -d= -f2 | tr -d '\r')
GH_KEY=$(grep "^GITHUB_PAT=" /root/.secrets/github_pat.env 2>/dev/null | cut -d= -f2 | tr -d '\r')

if [ -z "$OR_KEY" ]; then echo "❌ OPENROUTER_API_KEY missing"; exit 1; fi
if [ -z "$GH_KEY" ]; then echo "❌ GITHUB_PAT missing"; exit 1; fi

export OPENROUTER_API_KEY="$OR_KEY"
export GITHUB_TOKEN="$GH_KEY"

echo "=== SN66 Local Test | Rounds=$ROUNDS | $(date -u) ==="
echo "Our agent: $OUR_AGENT | Baseline: $KING_AGENT"
echo "Mode: Gemini Flash direct solver (SN66_FT_UPSTREAM unset)"
echo "Scoring: positional compare vs Cursor baseline (production-accurate)"
echo ""

source "$TAU_DIR/.venv/bin/activate"

WINS=0; LOSSES=0; TIES=0; ERRORS=0

for i in $(seq 1 $ROUNDS); do
    T="lt-$(date +%s)-$i"
    WS="$WORKSPACE/$T"
    mkdir -p "$WS"

    # 1. Generate task
    if ! tau generate --task "$T" --workspace-root "$WS" 2>/dev/null; then
        echo "  [$i/$ROUNDS] ⚠️ generate failed"
        ((ERRORS++))
        continue
    fi

    # 2. Inject FT hint into AGENTS.md before solving (FT model predicts minimal diff)
    TASK_FILE="$WS/workspace/tasks/$T/task/task.txt"
    if [ -f "$TASK_FILE" ] && [ -n "$FT_ENDPOINT" ]; then
        python3 "$FT_INJECT_PY" inject "$TASK_FILE" 2>>"$ERROR_LOG" || true
    fi

    # 3. Solve with OUR agent (Gemini solver + FT-injected hint in AGENTS.md)
    tau solve \
        --task "$T" \
        --solution ours \
        --agent "$OUR_AGENT" \
        --workspace-root "$WS" \
        --solver-model "$SOLVER_MODEL" \
        --docker-solver-memory "4g" \
        2>>"$ERROR_LOG" || true

    # Restore AGENTS.md after solve
    python3 "$FT_INJECT_PY" restore 2>>"$ERROR_LOG" || true

    # 4. Solve with KING baseline (no hint injection — pure king behavior)
    tau solve \
        --task "$T" \
        --solution king \
        --agent "$KING_AGENT" \
        --workspace-root "$WS" \
        --solver-model "$SOLVER_MODEL" \
        --docker-solver-memory "4g" \
        2>>"$ERROR_LOG" || true

    # 5. Solve Cursor BASELINE (production scoring compares each vs Cursor baseline)
    tau solve \
        --task "$T" \
        --solution baseline \
        --agent claude \
        --solver-model "anthropic/claude-sonnet-4-20250514" \
        --workspace-root "$WS" \
        2>>"$ERROR_LOG" || true

    # 6. Positional compare — DIRECT ours vs king comparison
    # (Production: winner = more matched_changed_lines vs Cursor baseline)
    # (Local proxy: compare ours vs king directly — tau compare writes to comparisons/ours--vs--king/)
    tau compare \
        --task "$T" \
        --solutions ours king \
        --workspace-root "$WS" \
        2>>"$ERROR_LOG" || true

    # Read direct comparison result: ours--vs--king
    # If ours has more total_changed_lines_a AND reasonable similarity → ours wins
    # Actually use: total_changed_lines_a > 0 = ours made changes; compare vs king changes
    OURS_CHANGES=$(python3 -c "
import json
f='$WS/workspace/tasks/$T/comparisons/ours--vs--king/compare.json'
try:
    d=json.load(open(f))
    print(d['result'].get('total_changed_lines_a',0))
except: print(0)
" 2>/dev/null || echo 0)
    KING_CHANGES=$(python3 -c "
import json
f='$WS/workspace/tasks/$T/comparisons/ours--vs--king/compare.json'
try:
    d=json.load(open(f))
    print(d['result'].get('total_changed_lines_b',0))
except: print(0)
" 2>/dev/null || echo 0)
    # Note: direct compare doesn't tell us who wins vs baseline
    # Use LLM eval as authoritative (but note ours/king file coverage)

    # Use LLM eval as judge (production-proxy — tau compare gives file coverage but not vs-baseline wins)
    RESULT=""
    tau eval --task "$T" --solutions ours king --workspace-root "$WS" 2>>"$ERROR_LOG" || true
    EVAL_JSON="$WS/workspace/tasks/$T/evals/ours--king/eval.json"
    if [ -f "$EVAL_JSON" ]; then
        RESULT=$(python3 -c "
import json
d = json.load(open('$EVAL_JSON'))
comps = d.get('comparisons', [])
if comps:
    winner = comps[0].get('upstream_winner', '')
    if winner == 'ours': print('ours')
    elif winner == 'king': print('king')
    else: print('tie')
else:
    print('tie')
" 2>/dev/null)
    fi

    case "$RESULT" in
        ours) ((WINS++));  echo "  [$i/$ROUNDS] WE WIN  (W=$WINS L=$LOSSES T=$TIES)" ;;
        king) ((LOSSES++)); echo "  [$i/$ROUNDS] KING WINS (W=$WINS L=$LOSSES T=$TIES)" ;;
        tie)  ((TIES++));   echo "  [$i/$ROUNDS] TIE (W=$WINS L=$LOSSES T=$TIES)" ;;
        *)    ((ERRORS++)); echo "  [$i/$ROUNDS] ⚠️ eval failed" ;;
    esac
done

TOTAL=$((WINS+LOSSES+TIES))
RATE=$(python3 -c "print(f'{$WINS/$TOTAL*100:.1f}' if $TOTAL>0 else '0.0')")
PASS=$(python3 -c "print('✅ SUBMIT' if float('$RATE')>=80 else '❌ ITERATE — need 80%+')")

echo ""
echo "=== RESULTS: W=$WINS L=$LOSSES T=$TIES E=$ERRORS | Win=$RATE% | $PASS ==="
echo "Target: 80%+ to hold throne 1 week"

# Save results
FNAME="$RESULTS_DIR/test-$(date +%Y%m%d-%H%M).json"
python3 -c "
import json,datetime
result={'timestamp':datetime.datetime.utcnow().isoformat()+'Z',
        'rounds':$ROUNDS,'wins':$WINS,'losses':$LOSSES,'ties':$TIES,'errors':$ERRORS,
        'win_rate':float('$RATE'),'verdict':'$PASS','agent':'$OUR_AGENT','baseline':'$KING_AGENT',
        'scoring':'tau_eval_llm_judged'}
json.dump(result,open('$FNAME','w'),indent=2)
print(f'Results saved: $FNAME')
"

rm -rf "$WORKSPACE"
