#!/usr/bin/env bash
# ============================================================================
# R4-2/3/4 本地武装（WAR / EVOLUTION / COMMUNITY 三旗）— 2026-09-23
# WAR：房屋托管存款路径激活（agent 零真实余额 → 诚实拒绝，零 gas；读路径/叙事全活）
# EVOLUTION：繁殖费收款 = ADMIN（0x1068…58B1），血统锚定走 facilitator gas
# COMMUNITY：MURMUR 门禁只读（零资金路径）
# 【回滚】scripts/disarm-dev-r41.sh 一并移除
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DEV_VARS=".dev.vars"
if grep -q '^# ==== R4-2/3/4 LOCAL ARM' "$DEV_VARS"; then
  echo "已武装过，跳过（幂等）"; exit 0
fi

cat >> "$DEV_VARS" <<'EOF'

# ==== R4-2/3/4 LOCAL ARM (2026-09-23) — WAR / EVOLUTION / COMMUNITY flags ====
WAR_ENABLED="true"
EVOLUTION_ENABLED="true"
EVOLUTION_TREASURY="0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1"
COMMUNITY_ENABLED="true"
EOF
echo "OK: 三旗已追加（WAR/EVOLUTION/COMMUNITY=true，EVOLUTION_TREASURY=ADMIN）"
