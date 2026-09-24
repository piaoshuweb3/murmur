#!/usr/bin/env bash
# ============================================================================
# murmur → Cloudflare 一键部署 + 逐旗开旗（flyx402 专属，2026-09-23）
# ============================================================================
# 前置（仅两行环境变量，不落盘）：
#   export CLOUDFLARE_API_TOKEN="<可编辑权限令牌>"    # 需 Account.Workers Scripts:Edit + Account.D1:Edit
#   export CLOUDFLARE_ACCOUNT_ID="6facaca88940309cadc971558fe0a166"
# 用法：bash scripts/cloud-deploy-flyx402.sh          # 幂等，可重复运行续跑
# ============================================================================
# 阶段（每阶段过检才进下一阶段，全部可回滚）：
#   C0 零钥冷启动: D1 创建 → id 注入 wrangler.toml → schema → deploy → 检查点
#   C1 管理面:     ADMIN_TOKEN secret（值自动生成并追加进 .env.local 本地留存）
#   C2 链上影子:   ECONOMY_MNEMONIC secret（从 .env.local 管道注入，零显示）
#                  → deploy(onchain+shadow) → POST /reset → 验证真实派生地址
#   R4-1 实盘:     deploy(REAL_SPEND=true, SHADOW=false) → /arena 开轮验证
#   R4-2/3/4:      WAR → EVOLUTION(+TREASURY) → COMMUNITY 逐旗 deploy+冒烟
# URL: https://murmur.piaoshuweb3.workers.dev （flyx402.xyz 绑定在 24-48h 观察后进行）
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="https://murmur.piaoshuweb3.workers.dev"
WR="wrangler.toml"
say(){ echo; echo "== $* =="; }
chk(){ if [ "$1" = "0" ]; then echo "   ✓ $2"; else echo "   ✗ FAIL $2"; exit 1; fi; }

say "0/8 预检"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "FATAL: 请先 export CLOUDFLARE_API_TOKEN（可编辑权限）"; exit 1; }
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "FATAL: 请先 export CLOUDFLARE_ACCOUNT_ID"; exit 1; }
npx wrangler whoami >/dev/null 2>&1; chk $? "wrangler 鉴权"
grep -q '^ECONOMY_MNEMONIC=' .env.local || { echo "FATAL: .env.local 无种子"; exit 1; }

say "1/8 C0: D1 数据库"
DBID=$(npx wrangler d1 list 2>/dev/null | awk '/murmur-db/{print $2}' | head -1 || true)
if [ -z "${DBID:-}" ]; then
  DBID=$(npx wrangler d1 create murmur-db 2>/dev/null | grep -o 'database_id *= *"[^"]*"' | head -1 | sed 's/.*"\(.*\)"/\1/')
  [ -n "$DBID" ] || { echo "FATAL: D1 创建失败（令牌缺 D1:Edit？）"; exit 1; }
fi
echo "   database_id: $DBID"
if ! grep -q "$DBID" "$WR"; then
  sed -i "s|database_id = \"REPLACE_WITH_YOUR_OWN_D1_DATABASE_ID\"|database_id = \"$DBID\"|" "$WR"
  grep -q "$DBID" "$WR" && echo "   ✓ wrangler.toml 已注入" || { echo "   ✗ id 注入失败"; exit 1; }
fi
npx wrangler d1 execute murmur-db --remote --file=./schema.sql >/dev/null 2>&1; chk $? "schema 应用（懒建表双保险）"

say "2/8 C0: 首次部署（全旗安全基线）"
npx wrangler deploy >/dev/null 2>&1; chk $? "wrangler deploy"
sleep 8
curl -sf "$BASE/health" | grep -q '"ok":true'; chk $? "C0-1 /health"
curl -sf "$BASE/state" | grep -q '"economyFacilitator":"simulated"'; chk $? "C0-2 keyless 模拟器（安全基线）"
curl -sf "$BASE/" | grep -qi '<html'; chk $? "C0-3 前端同源服务（/ 出 UI）"
curl -sf "$BASE/api/state" >/dev/null; chk $? "C0-4 同源 /api 前缀"

say "3/8 C1: ADMIN_TOKEN"
if ! grep -q '^ADMIN_TOKEN=' .env.local; then
  echo "ADMIN_TOKEN=\"$(openssl rand -hex 32)\"" >> .env.local; echo "   ✓ 新生成（已存 .env.local）"
fi
ADMIN_TOKEN=$(grep '^ADMIN_TOKEN=' .env.local | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//')
printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN >/dev/null 2>&1; chk $? "secret 注入"

say "4/8 C2: 链上影子（onchain + shadow，不广播）"
grep '^ECONOMY_MNEMONIC=' .env.local | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//' | npx wrangler secret put ECONOMY_MNEMONIC >/dev/null 2>&1; chk $? "ECONOMY_MNEMONIC secret"
npx wrangler deploy --var ECONOMY_FACILITATOR:onchain >/dev/null 2>&1; chk $? "deploy(onchain)"
sleep 6
curl -sf -X POST -H "x-admin-token: $ADMIN_TOKEN" "$BASE/reset" >/dev/null; chk $? "POST /reset（重派生真实钱包）"
sleep 70   # 等 1-2 轮 cron
curl -sf "$BASE/economy" | grep -q '"mode":"onchain"'; chk $? "economy.mode=onchain"
NW=$(curl -sf "$BASE/economy" | python3 -c "import json,sys;d=json.load(sys.stdin);ws=d.get('agents',[]);print(sum(1 for a in ws if not str(a.get('address','')).startswith('sim-')))")
[ "${NW:-0}" -ge 24 ]; chk $? "24 个真实校验和地址（非 sim- 伪址）"

say "5/8 R4-1: 实盘开旗（REAL_SPEND + SHADOW=false）"
npx wrangler deploy --var ECONOMY_FACILITATOR:onchain --var ECONOMY_REAL_SPEND:true --var ECONOMY_SHADOW:false >/dev/null 2>&1; chk $? "deploy(real-spend)"
sleep 75   # 等 cron 驱动 driveArena 开当前时间桶
curl -sf "$BASE/arena" | grep -q '"armed":true'; chk $? "/arena armed"
curl -sf "$BASE/arena" | grep -q '"opened":true'; chk $? "当前时间桶轮次已在链上开轮"

say "6/8 R4-2: WAR"
npx wrangler deploy --var ECONOMY_FACILITATOR:onchain --var ECONOMY_REAL_SPEND:true --var ECONOMY_SHADOW:false --var WAR_ENABLED:true >/dev/null 2>&1
curl -sf "$BASE/war" | grep -q '"armed":true'; chk $? "/war armed（coffer=0x37a6…9f9C0）"

say "7/8 R4-3: EVOLUTION"
npx wrangler deploy --var ECONOMY_FACILITATOR:onchain --var ECONOMY_REAL_SPEND:true --var ECONOMY_SHADOW:false --var WAR_ENABLED:true --var EVOLUTION_ENABLED:true --var EVOLUTION_TREASURY:0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1 >/dev/null 2>&1
curl -sf "$BASE/lineage" | grep -q '"enabled":true'; chk $? "/lineage evolution（treasury=ADMIN）"

say "8/8 R4-4: COMMUNITY"
npx wrangler deploy --var ECONOMY_FACILITATOR:onchain --var ECONOMY_REAL_SPEND:true --var ECONOMY_SHADOW:false --var WAR_ENABLED:true --var EVOLUTION_ENABLED:true --var EVOLUTION_TREASURY:0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1 --var COMMUNITY_ENABLED:true >/dev/null 2>&1
curl -sf "$BASE/community" | grep -q 'enabled'; chk $? "/community（MURMUR 门禁只读）"

say "完成 — 交付清单"
echo "  UI+API 单地址: $BASE"
echo "  检查点: /health · /state · /arena · /war · /lineage · /community · /history?limit=3"
echo "  回滚: 每旗 --var KEY:false 重跑 deploy 即熄；REAL_SPEND=false 全局熄火"
echo "  gas 台账: facilitator 0x20c5…53f3 现余 ≈4.96 USDC；云上预估 回执0.7-1/天 + arena0.05/天"
echo "  域名绑定（观察 24-48h 后）: wrangler.toml 取消 routes 注释 → api.flyx402.xyz custom_domain"
