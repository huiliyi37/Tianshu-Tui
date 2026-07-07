#!/bin/bash
# swebench-eval.sh — SWE-bench evaluation runner for Tianshu predictions
#
# Prerequisites:
#   colima start --vm-type vz --vz-rosetta  (Apple Silicon)
#   /tmp/swebench-venv with swebench installed
#   /tmp/swebench-predictions.jsonl
#
# Usage:
#   bash scripts/swebench-eval.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="/tmp/swebench-venv"
PREDICTIONS="/tmp/swebench-predictions.jsonl"
RUN_ID="${1:-tianshu-v5}"
TIMEOUT="${2:-600}"

# ── Docker setup ──────────────────────────────────────────────
export DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/docker-cfg}"
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"

mkdir -p "$DOCKER_CONFIG"
if [ ! -f "$DOCKER_CONFIG/config.json" ]; then
  echo '{"auths":{}}' > "$DOCKER_CONFIG/config.json"
fi

# ── Docker check ──────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker not accessible. Start colima: colima start --vm-type vz --vz-rosetta"
  exit 1
fi
echo "✓ Docker ready"

# ── Venv check ────────────────────────────────────────────────
if [ ! -f "$VENV_DIR/bin/python" ]; then
  echo "❌ Venv not found at $VENV_DIR. Run: python3.12 -m venv $VENV_DIR && $VENV_DIR/bin/pip install swebench"
  exit 1
fi

# ── Predictions check ─────────────────────────────────────────
if [ ! -f "$PREDICTIONS" ]; then
  echo "❌ Predictions not found at $PREDICTIONS"
  exit 1
fi
echo "✓ Predictions: $(wc -l < "$PREDICTIONS") instances"

# ── Run evaluation ────────────────────────────────────────────
cd "$PROJECT_DIR"
echo ""
echo "🚀 Running evaluation (run_id=$RUN_ID, timeout=${TIMEOUT}s)..."
echo ""

"$VENV_DIR/bin/python" -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path "$PREDICTIONS" \
  --max_workers 1 \
  --run_id "$RUN_ID" \
  --timeout "$TIMEOUT"

# ── Show results ──────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Results"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

RESOLVED=0
TOTAL=0
LOG_DIR="logs/run_evaluation/$RUN_ID/tianshu-agent-v1"

if [ -d "$LOG_DIR" ]; then
  for log in "$LOG_DIR"/*/run_instance.log; do
    inst=$(basename "$(dirname "$log")")
    result=$(grep "Result for" "$log" 2>/dev/null | grep -o "resolved: [A-Za-z]*" | cut -d' ' -f2)
    TOTAL=$((TOTAL + 1))
    if [ "$result" = "True" ]; then
      RESOLVED=$((RESOLVED + 1))
      echo "  ✅ $inst"
    elif [ -n "$result" ]; then
      echo "  ❌ $inst"
    else
      echo "  ⏳ $inst (no result yet)"
    fi
  done
fi

echo ""
echo "Resolved: $RESOLVED / $TOTAL"
