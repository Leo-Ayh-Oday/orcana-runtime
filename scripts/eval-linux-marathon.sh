#!/usr/bin/env bash
# orcana eval:linux 连跑驱动 —— 崩溃根因是炸弹孤儿进程累积致 WSL 过载，
# 本脚本在每轮后强制扫描炸弹形态进程并树杀归零（安全网，不依赖 eval 自身清理）。
# 用法: bash scripts/eval-linux-marathon.sh [轮数=18]
set -u

N=${1:-18}
LOG=/tmp/orcana-eval-18x.log
: > "$LOG"

bomb_scan() {
  /bin/ps -eo pid,args 2>/dev/null | grep -E "while true|/dev/zero|tr .0. x|head -c 1073741824" | grep -v grep || true
}
bomb_count() {
  local c; c=$(bomb_scan | grep -c . || true); echo "${c:-0}"
}
kill_bombs() {
  local pids; pids=$(bomb_scan | awk '{print $1}')
  [ -z "$pids" ] && return 0
  for p in $pids; do
    pkill -9 -P "$p" 2>/dev/null || true   # 先杀子进程
    kill -9 "$p" 2>/dev/null || true
  done
  sleep 1
  echo "  [NET] killed bomb orphans: $(echo $pids | tr '\n' ' ')" >> "$LOG"
}

echo "=== orcana eval:linux ${N}-run marathon start $(date '+%F %T') ===" >> "$LOG"
echo "=== orcana eval:linux ${N}-run marathon start $(date '+%F %T') ==="
total_fail=0; leaks_swept=0; aborted=0

for i in $(seq 1 "$N"); do
  pre=$(bomb_count)
  if [ "$pre" -gt 0 ]; then
    echo "  [pre-$i] residual bombs=$pre — sweeping before run" >> "$LOG"
    kill_bombs; leaks_swept=$((leaks_swept + 1))
  fi
  echo "=== RUN $i/$N start $(date '+%T') ===" >> "$LOG"
  timeout 600 bun run evals/linux-sandbox-eval.ts >> "$LOG" 2>&1
  code=$?
  echo "  [run-$i] exit=$code $(date '+%T')" >> "$LOG"

  leaks=$(bomb_count)
  if [ "$leaks" -gt 0 ]; then
    echo "  [LEAK-$i] $leaks bomb processes escaped — sweeping" >> "$LOG"
    kill_bombs; leaks_swept=$((leaks_swept + 1))
  fi
  if [ "$leaks" -gt 20 ]; then
    echo "  [ABORT] runaway process explosion (>20) — marathon aborted" >> "$LOG"
    aborted=1; break
  fi
  [ "$code" -ne 0 ] && total_fail=$((total_fail + 1))
done

echo "=== MARATHON SUMMARY $(date '+%F %T') ===" >> "$LOG"
echo "runs=$N completed=$((i - aborted)) failed_runs=$total_fail leaks_swept=$leaks_swept aborted=$aborted" >> "$LOG"
echo "--- per-run summaries ---" >> "$LOG"
SUM=$(grep -E "LNXF Linux Sandbox Eval" "$LOG" || true)   # GNU grep 拒绝同文件读写，先存变量
echo "$SUM" >> "$LOG"
echo "--- FAIL scenarios (dedup) ---" >> "$LOG"
grep -E "\[x\]" "$LOG" | sort -u >> "$LOG"
echo "=== END $(date '+%F %T') ===" >> "$LOG"
echo "MARATHON_DONE failed_runs=$total_fail leaks_swept=$leaks_swept"
