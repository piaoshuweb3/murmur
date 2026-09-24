#!/usr/bin/env bash
# ============================================================================
# R4-1 本地武装（竞技场写路径）— 2026-09-23
# 把经济层从 keyless 影子切到 onchain 实结算：ARENA openRound/resolve 由
# facilitator（m/44'/60'/2000000'/0/0 = 0x20c5…53f3）真实上链。
# 效果：下一个 cron/tick 即开当前时间桶轮次（roundId = now/60min），gas ≈0.05/天。
# 24 个 agent 无真实 USDC 余额 → 内部结算诚实拒绝（F-1 设计），零额外 gas。
# 【回滚】运行 scripts/disarm-dev-r41.sh（删除本块 + 重启 worker 即回影子模式）
# 安全：ECONOMY_MNEMONIC 只从 .env.local 管道追加，本脚本零显示任何密钥值。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DEV_VARS=".dev.vars"
ENV_LOCAL=".env.local"

[ -f "$ENV_LOCAL" ] || { echo "FATAL: $ENV_LOCAL 不存在（种子丢失）"; exit 1; }
grep -q '^ECONOMY_MNEMONIC=' "$ENV_LOCAL" || { echo "FATAL: $ENV_LOCAL 无 ECONOMY_MNEMONIC"; exit 1; }

if grep -q '^# ==== R4-1 LOCAL ARM' "$DEV_VARS"; then
  echo "已武装过，跳过（幂等）"; exit 0
fi

cat >> "$DEV_VARS" <<'EOF'

# ==== R4-1 LOCAL ARM (2026-09-23) — arena write path armed locally until cloud creds ====
# Rollback = run scripts/disarm-dev-r41.sh then restart the worker (back to keyless shadow).
ECONOMY_FACILITATOR="onchain"
ECONOMY_SHADOW="false"
ECONOMY_REAL_SPEND="true"
EOF

# 助记词行从 .env.local 原样管道追加（值永不进入终端/日志）
grep '^ECONOMY_MNEMONIC=' "$ENV_LOCAL" >> "$DEV_VARS"

echo "OK: .dev.vars 已追加 R4-1 武装块（五项：onchain / shadow=false / real_spend=true / mnemonic）"
echo "下一步：重启 worker → POST /reset → 等 ticker 下一 tick → /arena 应出现真实轮次"
