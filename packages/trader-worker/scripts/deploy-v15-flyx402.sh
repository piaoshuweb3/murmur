#!/usr/bin/env bash
# =============================================================================
# deploy-v15-flyx402.sh — v1.5 单命令云端部署（用户在自己机器跑，令牌不进聊天）
# =============================================================================
# 做什么：
#   1. 把 v1.5 代码（P0 冻结治理/指数退避 + P1 五层全关旗 + 前端 v72：
#      公告条重现+14 天过期/编年史 D1 深档全量分页/遥测信任总页/诗卡/快讯工厂）
#      部署到 Cloudflare Worker「murmur」，flyx402.xyz 立即可见。
#   2. 逐字复刻 R4-4 生产 var 链 —— 漏掉任何一个 --var 都会掉回安全基线
#      （REAL_SPEND=false ⇒ 经济回模拟态），所以本脚本一次带全 7 个。
#   3. 部署后自动冒烟 6 项断言，全绿才算成功；任一失败打印回滚命令。
#
# 怎么跑：
#   export CLOUDFLARE_API_TOKEN="<新的可编辑权限令牌>"   # Account.Workers Scripts:Edit + D1:Edit
#   export CLOUDFLARE_ACCOUNT_ID="6facaca88940309cadc971558fe0a166"
#   bash packages/trader-worker/scripts/deploy-v15-flyx402.sh
#
# 铁律：本脚本绝不写入任何密钥/助记词；secrets（ECONOMY_MNEMONIC / ECONOMY_FACILITATOR_PK /
#       ADMIN_TOKEN）已在云端，deploy 不触碰。旧令牌已在聊天中暴露过 —— 必须用新令牌。
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1   # → packages/trader-worker

FAIL=0
chk() { if [ "$1" -eq 0 ]; then echo "  ✅ $2"; else echo "  ❌ $2"; FAIL=1; fi; }

echo "── 0. 凭据预检 ─────────────────────────────────────────────"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "FATAL: export CLOUDFLARE_API_TOKEN（新令牌，Workers Scripts:Edit + D1:Edit）"; exit 1; }
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "FATAL: export CLOUDFLARE_ACCOUNT_ID"; exit 1; }
CODE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts" 2>/dev/null)
[ "$CODE" = "200" ] || { echo "FATAL: 令牌无效（/accounts HTTP $CODE）——请用新的可编辑权限令牌"; exit 1; }
echo "  ✅ 令牌有效"

echo "── 1. 部署前 dry-run（TOML/绑定校验，零副作用）─────────────"
npx wrangler deploy --dry-run >/tmp/deploy-v15-dryrun.log 2>&1; chk $? "dry-run 校验"
grep -qi "error" /tmp/deploy-v15-dryrun.log && { echo "---- dry-run 日志尾部 ----"; tail -20 /tmp/deploy-v15-dryrun.log; exit 1; }

echo "── 2. 生产部署（R4-4 var 链 + 六 P1 旗全链复刻 + 全部 secrets 原样在云端）──"
npx wrangler deploy \
  --var ECONOMY_FACILITATOR:onchain \
  --var ECONOMY_REAL_SPEND:true \
  --var ECONOMY_SHADOW:false \
  --var WAR_ENABLED:true \
  --var EVOLUTION_ENABLED:true \
  --var EVOLUTION_TREASURY:0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1 \
  --var COMMUNITY_ENABLED:true \
  --var BOURSE_ENABLED:true \
  --var POET_ENABLED:true \
  --var TOKEN_STIMULUS_ENABLED:true \
  --var SOCIAL_STIMULUS_ENABLED:true \
  --var RELIGION_ENABLED:true \
  --var AGES_FAST_CLOCK:true \
  >/tmp/deploy-v15.log 2>&1; chk $? "wrangler deploy（7 var + 6 旗生产链）"
grep -E "Uploaded|Deployed|Current Version" /tmp/deploy-v15.log | tail -3 || true

echo "── 3. 冒烟（flyx402.xyz 主域）──────────────────────────────"
sleep 8
H=$(curl -sS --max-time 20 "https://flyx402.xyz/health" 2>/dev/null)
echo "$H" | grep -q '"version":"1.5.0"'; chk $? "/health v1.5.0"
echo "$H" | grep -q '"agent-economy-x402"'; chk $? "/health 特性面完整"
S=$(curl -sS --max-time 20 "https://flyx402.xyz/state" 2>/dev/null)
echo "$S" | grep -q '"mode":"onchain"'; chk $? "/state economy.mode=onchain（var 链未掉基线）"
HTML=$(curl -sS --max-time 20 "https://flyx402.xyz/" 2>/dev/null)
echo "$HTML" | grep -q 'app.js?v=74'; chk $? "首页资产已升级 v74（canary 公告版）"
echo "$HTML" | grep -q 'netting-chip'; chk $? "netting 芯片已上首页"
echo "$HTML" | grep -q 'redditTitle'; chk $? "Reddit seat 已上首页"
P=$(curl -sS --max-time 20 "https://flyx402.xyz/proofs" 2>/dev/null)
echo "$P" | grep -q '"enabled":true'; chk $? "/proofs 净账证明链在线"
B=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 "https://flyx402.xyz/bourse" 2>/dev/null)
[ "$B" = "200" ]; chk $? "/bourse 开旗 200（六旗生产链）"
T=$(curl -sS --max-time 20 "https://flyx402.xyz/telemetry" 2>/dev/null)
echo "$T" | grep -q '"enabled":true'; chk $? "/telemetry 六指标遥测在线"
BR=$(curl -sS --max-time 20 "https://flyx402.xyz/briefing?lang=zh" 2>/dev/null)
echo "$BR" | grep -q 'flyx402 蝇群每日快讯'; chk $? "/briefing 中文快讯工厂在线"
C=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 "https://flyx402.xyz/canary" 2>/dev/null)
[ "$C" = "200" ]; chk $? "/canary 独立实时页 200（v1.5.2 静态命中）"
CAN=$(curl -sS --max-time 20 "https://flyx402.xyz/canary" 2>/dev/null)
echo "$CAN" | grep -q '结算可靠性'; chk $? "/canary 七板块内容命中（01 结算可靠性）"
echo "$CAN" | grep -q 'settleLatencies\|latency'; chk $? "/canary 页面就绪（无需后端字段预埋）"
TL=$(curl -sS --max-time 20 "https://flyx402.xyz/telemetry" 2>/dev/null)
echo "$TL" | grep -q '"latency"'; chk $? "/telemetry 已含 latency p50/p95（canary 后端增强）"
PC=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 "https://flyx402.xyz/poem-card" 2>/dev/null)
[ "$PC" = "200" ]; chk $? "/poem-card 诗分享卡在线"
TP=$(curl -sS --max-time 20 "https://flyx402.xyz/transparency" 2>/dev/null)
echo "$TP" | grep -q 'tel-grid'; chk $? "transparency 遥测区块已上线"
AR=$(curl -sS --max-time 20 "https://flyx402.xyz/annals/archive?before=50&limit=10" 2>/dev/null)
echo "$AR" | grep -q '"archive":true'; chk $? "/annals/archive D1 深档分页在线"
echo "$AR" | grep -q '"total":[0-9]'; chk $? "/annals/archive 全量计数返回"
AN=$(curl -sS --max-time 20 "https://flyx402.xyz/announcements.json" 2>/dev/null)
echo "$AN" | grep -q 'v152-canary-live'; chk $? "公告新条目 v152-canary-live 已上线（新 id 强制上台）"

echo "── 4. 冒烟（www + workers.dev 三路由）─────────────────────"
C1=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 "https://www.flyx402.xyz/health" 2>/dev/null)
[ "$C1" = "200" ]; chk $? "www.flyx402.xyz 200"
WD=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 "https://murmur.piaoshuweb3.workers.dev/health" 2>/dev/null)
[ "$WD" = "200" ]; chk $? "workers.dev 200（观察窗共存）"

echo "────────────────────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  echo "🎉 v1.5 部署全绿 —— flyx402.xyz 已呈现改进界面（公告条/CA 芯片/Reddit/netting 芯片/两段式编年史/透明度页）。"
  echo "   下一步：W1 注资（node scripts/funding-addresses.mjs 出清单）→ 按 docs/murmur-开旗放行顺序与云端部署-runbook.md 逐旗放行 P1。"
  echo "   netting 芯片将在第一笔真实并账结算上链后自动点亮（N 笔交易 → 1 笔结算 ↗ explorer）。"
else
  echo "⚠ 冒烟有失败项。回滚："
  echo "   界面回滚 = git checkout 上一 tag 后重跑本脚本；旗位回滚 = 对应 --var KEY:false 重部署；"
  echo "   全局熄火 = --var ECONOMY_REAL_SPEND:false --var ECONOMY_SHADOW:true 重部署（经济回模拟态，零资金风险）。"
  exit 1
fi
