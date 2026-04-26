#!/bin/bash
# ============================================================
# SN66 CANONICAL Evaluation Harness — v4 (commit 58b2835)
# DEFAULT TEST SCRIPT for all future SN66 miner versions
# ============================================================
# HOW TO RUN:
#   bash scripts/local_test_v74_correct.sh [rounds]
#   bash scripts/local_test_v74_correct.sh 10   # default
#   bash scripts/local_test_v74_correct.sh 30   # deeper test
#
# WHEN KING CHANGES (ONLY reason to edit this file):
#   1. Check live king: curl -s https://sn66.neuralinternet.ai/state | python3 -m json.tool | grep -A5 'king'
#   2. Update KING_AGENT below: "owner/repo@full_commit_sha"
#   3. Commit this change to tierra-final
#   4. DO NOT change WIN_MARGIN, MIN_DECISIVE_ROUNDS, or gate formula
#      unless the production validate.py defaults change
#
# NEVER use local_test_v39.sh — it is an older proxy-only script, retired.
#
# Production formula (validate.py):
#   k_lines = compare(baseline, king).matched_changed_lines
#   c_lines = compare(baseline, challenger).matched_changed_lines
#   winner  = c_lines > k_lines → challenger wins
#   threshold = duel_rounds // 2 + win_margin + 1
#   challenger timeout = min(baseline_elapsed * 2 + 1, 300s)
#   baseline = cursor agent + gemini-2.5-flash
# ============================================================

set -u

TAU_DIR=/root/tau
source "$TAU_DIR/.venv/bin/activate"

export GITHUB_TOKEN=$(grep "^GITHUB_PAT=" /root/.secrets/github_pat.env | cut -d= -f2 | tr -d '\r')
export OPENROUTER_API_KEY=$(grep "^OPENROUTER_API_KEY=" /root/.secrets/api_keys.env | cut -d= -f2 | tr -d '\r')

OUR_AGENT=/root/sn66-v7/agent
KING_AGENT="VladaWebDev/Mine016@b6a99c4296b01901f47b0dba2d95f68b9831a32d"
ROUNDS=${1:-10}
BASELINE_MODEL="${BASELINE_MODEL:-google/gemini-2.5-flash}"
SOLVER_MODEL="${SOLVER_MODEL:-google/gemini-2.5-flash}"
AGENT_TIMEOUT=300
MIN_PATCH_LINES=100

# Live duel config (from validate.py defaults)
WIN_MARGIN=5
MIN_DECISIVE_ROUNDS=10

LOG_FILE="/tmp/sn66-v74-correct-$(date +%Y%m%d-%H%M%S).log"
WORKSPACE=$(mktemp -d /tmp/sn66-v74-XXXXXX)
ERROR_LOG="$WORKSPACE/errors.log"
mkdir -p "$(dirname "$ERROR_LOG")"
touch "$ERROR_LOG"

WINS=0; LOSSES=0; TIES=0; ERRORS=0; SKIPPED=0
OUR_ZERO=0; VALID_ROUNDS=0
OUR_LINES_SUM=0; KING_LINES_SUM=0

tee_log() { echo "$1" | tee -a "$LOG_FILE"; }

# Parse matched lines from tau compare output using python (shell-safe)
parse_matched() {
    echo "$1" | python3 -c "
import sys, re
line = sys.stdin.read()
m = re.search(r'-> (\d+)/\d+ matching changed lines', line)
print(m.group(1) if m else '0')
"
}
parse_sim() {
    echo "$1" | python3 -c "
import sys, re
line = sys.stdin.read()
m = re.search(r'\(([0-9.]+)%\)', line)
print(m.group(1) if m else '0')
"
}

tee_log "=== SN66 v74 CORRECT Harness v4 | $(date -u) ==="
tee_log "Rounds=$ROUNDS | Baseline=docker-pi+$BASELINE_MODEL | Timeout=dynamic (baseline*2+1, max 300s)"
tee_log "King=$KING_AGENT"
tee_log "Scoring: compare(baseline,ours).matched_changed_lines vs compare(baseline,king).matched_changed_lines"
tee_log "Gate: wins > losses + $WIN_MARGIN AND decisive >= $MIN_DECISIVE_ROUNDS"
tee_log ""

ATTEMPTS=0
CONSEC_FAIL=0
while [ "$VALID_ROUNDS" -lt "$ROUNDS" ] && [ "$ATTEMPTS" -lt $((ROUNDS * 15)) ]; do
    ATTEMPTS=$((ATTEMPTS+1))
    T="v74c-$(date +%s)-$ATTEMPTS"

    tee_log "[$((VALID_ROUNDS+1))/$ROUNDS] Generating task (attempt $ATTEMPTS)..."
    if ! timeout 90 tau generate --task "$T" --workspace-root "$WORKSPACE" --max-mining-attempts 8 2>>"$ERROR_LOG"; then
        CONSEC_FAIL=$((CONSEC_FAIL+1))
        if [ "$CONSEC_FAIL" -ge 25 ]; then
            tee_log "  API struggling (25 consecutive failures), waiting 60s..."
            sleep 60
            CONSEC_FAIL=0
        fi
        tee_log "  ERROR: generate failed"; ERRORS=$((ERRORS+1)); sleep 5; continue
    fi
    CONSEC_FAIL=0

    REF_PATCH="$WORKSPACE/workspace/tasks/$T/task/reference.patch"
    PATCH_LINES=$(wc -l < "$REF_PATCH" 2>/dev/null || echo "0")
    if [ "$PATCH_LINES" -lt "$MIN_PATCH_LINES" ]; then
        tee_log "  SKIP: patch $PATCH_LINES lines < $MIN_PATCH_LINES"
        SKIPPED=$((SKIPPED+1)); rm -rf "$WORKSPACE/workspace/tasks/$T" 2>/dev/null; continue
    fi

    TASK_TITLE=$(head -2 "$WORKSPACE/workspace/tasks/$T/task/description.md" 2>/dev/null | tr '\n' ' ' | cut -c1-55 || echo "?")
    tee_log "  Task: $TASK_TITLE | patch=$PATCH_LINES lines"

    # [1/3] Baseline solve with CURSOR agent (matches production)
    tee_log "  [1/3] Baseline solve (cursor+$BASELINE_MODEL)..."
    BASELINE_START=$(date +%s.%N)
    tau solve --task "$T" --solution baseline --agent "$OUR_AGENT" \
        --workspace-root "$WORKSPACE" \
        --solver-model "$BASELINE_MODEL" \
        --agent-timeout 300 \
        --docker-solver-memory "4g" 2>>"$ERROR_LOG" || true
    BASELINE_END=$(date +%s.%N)
    BASELINE_ELAPSED=$(python3 -c "print(int($BASELINE_END - $BASELINE_START))")
    
    # Dynamic challenger timeout: min(baseline_elapsed * 2 + 1, 300s) with 30s floor
    # Floor prevents unrealistically short timeouts when baseline fails fast
    CHALLENGER_TIMEOUT=$(python3 -c "print(max(30, min($BASELINE_ELAPSED * 2 + 1, 300)))")
    tee_log "  Baseline elapsed: ${BASELINE_ELAPSED}s → Challenger timeout: ${CHALLENGER_TIMEOUT}s (floor=30s)"

    # [2/3] Our agent solve (dynamic timeout)
    tee_log "  [2/3] Our agent solve (timeout=${CHALLENGER_TIMEOUT}s)..."
    tau solve --task "$T" --solution ours --agent "$OUR_AGENT" \
        --workspace-root "$WORKSPACE" \
        --solver-model "$SOLVER_MODEL" \
        --agent-timeout "$CHALLENGER_TIMEOUT" \
        --docker-solver-memory "4g" 2>>"$ERROR_LOG" || true

    # [3/3] King solve (fixed 300s timeout)
    tee_log "  [3/3] King solve (timeout=300s)..."
    tau solve --task "$T" --solution king --agent "$KING_AGENT" \
        --workspace-root "$WORKSPACE" \
        --solver-model "$SOLVER_MODEL" \
        --agent-timeout 300 \
        --docker-solver-memory "4g" 2>>"$ERROR_LOG" || true

    C_OUT=$(tau compare --task "$T" --solutions baseline ours \
        --workspace-root "$WORKSPACE" 2>>"$ERROR_LOG" || true)
    K_OUT=$(tau compare --task "$T" --solutions baseline king \
        --workspace-root "$WORKSPACE" 2>>"$ERROR_LOG" || true)

    C_LINES=$(parse_matched "$C_OUT"); C_LINES=${C_LINES:-0}
    K_LINES=$(parse_matched "$K_OUT"); K_LINES=${K_LINES:-0}
    C_SIM=$(parse_sim "$C_OUT")
    K_SIM=$(parse_sim "$K_OUT")

    VALID_ROUNDS=$((VALID_ROUNDS+1))
    OUR_LINES_SUM=$((OUR_LINES_SUM+C_LINES))
    KING_LINES_SUM=$((KING_LINES_SUM+K_LINES))
    [ "$C_LINES" = "0" ] && OUR_ZERO=$((OUR_ZERO+1))

    if   [ "$C_LINES" -gt "$K_LINES" ]; then WINS=$((WINS+1));     STATUS="WIN  ✅"
    elif [ "$C_LINES" -lt "$K_LINES" ]; then LOSSES=$((LOSSES+1)); STATUS="LOSS ❌"
    else                                      TIES=$((TIES+1));     STATUS="TIE  ➖"
    fi

    tee_log "  $STATUS | ours=$C_LINES (${C_SIM}%) vs king=$K_LINES (${K_SIM}%)"
    rm -rf "$WORKSPACE/workspace/tasks/$T" 2>/dev/null || true
done

tee_log ""
tee_log "=== RESULTS ==="
tee_log "Valid=$VALID_ROUNDS | Skipped=$SKIPPED | Errors=$ERRORS | Wins=$WINS | Losses=$LOSSES | Ties=$TIES"

python3 - <<PYEOF | tee -a "$LOG_FILE"
wins=$WINS; losses=$LOSSES; ties=$TIES; valid=$VALID_ROUNDS; zeros=$OUR_ZERO
our_sum=$OUR_LINES_SUM; king_sum=$KING_LINES_SUM
win_margin=$WIN_MARGIN
min_decisive=$MIN_DECISIVE_ROUNDS

decisive = wins + losses
wr  = wins/decisive if decisive > 0 else 0
zr  = zeros/valid   if valid    > 0 else 0
avg_our  = our_sum/valid  if valid > 0 else 0
avg_king = king_sum/valid if valid > 0 else 0

# Live gate formula: wins > losses + win_margin AND decisive >= min_decisive
gate_passed = decisive >= min_decisive and wins > losses + win_margin

print(f"Win rate:    {wr:.1%} ({wins}W {losses}L {ties}T, decisive={decisive})")
print(f"Gate check:  wins({wins}) > losses({losses}) + margin({win_margin}) = {wins > losses + win_margin}")
print(f"             decisive({decisive}) >= min({min_decisive}) = {decisive >= min_decisive}")
print(f"Gate result: {'PASS ✅' if gate_passed else 'FAIL ❌'} (live formula)")
print(f"")
print(f"Zero-output: {zr:.1%} ({'PASS ✅' if zr<=0.20 else 'FAIL ❌'} — need <=20%)")
print(f"Avg lines:   ours={avg_our:.1f}  king={avg_king:.1f}")
print(f"")
if gate_passed and zr <= 0.20:
    print("OVERALL: PASS ✅ — ready for James approval")
else:
    print("OVERALL: FAIL ❌ — do NOT submit")
PYEOF

tee_log "Log: $LOG_FILE"
rm -rf "$WORKSPACE"
