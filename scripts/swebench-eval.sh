#!/bin/bash
# Usage: bash scripts/swebench-eval.sh [predictions-file]
# If no file given, rebuilds from /tmp/swebench-full-progress.jsonl
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV="/tmp/swebench-venv"
DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/docker-cfg}"
TIMEOUT="${TIMEOUT:-600}"

# ── Docker setup ──
mkdir -p "$DOCKER_CONFIG"
[ -f "$DOCKER_CONFIG/config.json" ] || echo '{"auths":{}}' > "$DOCKER_CONFIG/config.json"

if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker down. Run: colima start --vm-type vz --vz-rosetta --disk 100"
  exit 1
fi

# ── Build predictions if needed ──
PREDICTIONS="${1:-}"
if [ -z "$PREDICTIONS" ]; then
  PROGRESS="/tmp/swebench-full-progress.jsonl"
  PREDICTIONS="/tmp/swebench-eval-predictions.jsonl"
  echo "📦 Building predictions from $PROGRESS..."
  python3 -c "
import json
ps = []
with open('$PROGRESS') as f:
    for l in f:
        r = json.loads(l)
        if r['status'] == 'completed' and r.get('patch'):
            ps.append({'instance_id': r['instance_id'], 'model_name_or_path': 'tianshu-agent-v1', 'model_patch': r['patch']})
with open('$PREDICTIONS', 'w') as out:
    for p in ps: out.write(json.dumps(p) + '\n')
print(f'{len(ps)} predictions written')
"
fi

echo "📊 Evaluating $(wc -l < "$PREDICTIONS") predictions..."
RUN_ID="${RUN_ID:-tianshu-eval}"

cd "$PROJECT_DIR"
rm -rf "logs/run_evaluation/$RUN_ID"

DOCKER_CONFIG="$DOCKER_CONFIG" DOCKER_HOST="$DOCKER_HOST" \
"$VENV/bin/python" -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path "$PREDICTIONS" \
  --max_workers 1 \
  --run_id "$RUN_ID" \
  --timeout "$TIMEOUT"

# ── Results ──
echo ""
cd "$PROJECT_DIR"
LOG_DIR="logs/run_evaluation/$RUN_ID/tianshu-agent-v1"
if [ -d "$LOG_DIR" ]; then
  total=$(find "$LOG_DIR" -name "run_instance.log" | wc -l | tr -d ' ')
  resolved=$(grep -r "resolved: True" "$LOG_DIR" 2>/dev/null | wc -l | tr -d ' ')
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Resolved: $resolved / $total"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi
