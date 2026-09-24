#!/usr/bin/env bash
# ============================================================================
# murmur C0 冷启动一键部署（零密钥 · 安全基线）—— 在你自己的电脑上运行
# ----------------------------------------------------------------------------
# 对应《docs/murmur-上云部署手册-CLOUD-DEPLOY-RUNBOOK.md》§3 全流程：
#   登录核验 → ② D1 创建 → database_id 写回 wrangler.toml → schema 应用
#   → deploy（v1.4 安全基线）→ 检查点 C0-1 / C0-2 / C0-4 / C0-3 自动验收
#
# 用法:
#   bash scripts/cloud-deploy-c0.sh                             # 全自动（workers.dev 域名）
#   bash scripts/cloud-deploy-c0.sh https://api.your-domain.com # 已绑自定义域时传入
#
# 幂等：任何一步 FAIL 修复后重跑即可；database_id 只在占位符存在时写回一次。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."          # → packages/trader-worker

G='\033[1;32m'; R='\033[1;31m'; C='\033[1;36m'; Y='\033[1;33m'; N='\033[0m'
say(){ printf "\n${C}==> %s${N}\n" "$*"; }
ok(){ printf "  ${G}[PASS]${N} %s\n" "$*"; }
bad(){ printf "  ${R}[FAIL]${N} %s\n" "$*"; exit 1; }
warn(){ printf "  ${Y}[....]${N} %s\n" "$*"; }

say "0/5 登录态核验"
npx wrangler whoami >/dev/null 2>&1 \
  || bad "wrangler 未登录 —— 先运行: npx wrangler login（或 export CLOUDFLARE_API_TOKEN=…）"
ok "wrangler 已登录"

say "1/5 ② 创建你自己的 D1 数据库（安全审计 F-2：绝不用上游库）"
DB_ID="$(npx wrangler d1 create murmur-db 2>&1 | grep -oE 'database_id[^0-9a-f]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
[ -n "$DB_ID" ] || bad "未拿到 database_id —— 手动运行: npx wrangler d1 create murmur-db，并把 id 填入 wrangler.toml 的 ② 占位"
ok "database_id = $DB_ID"
if grep -q 'REPLACE_WITH_YOUR_OWN_D1_DATABASE_ID' wrangler.toml; then
  sed -i.bak "s/REPLACE_WITH_YOUR_OWN_D1_DATABASE_ID/$DB_ID/" wrangler.toml && rm -f wrangler.toml.bak
  ok "wrangler.toml 已写回 database_id（② 完成）"
else
  warn "wrangler.toml 已含自定义 database_id —— 跳过写回（如需换库请手工修改）"
fi

say "2/5 应用表结构 schema.sql（远程 D1）"
npx wrangler d1 execute murmur-db --remote -y --file=./schema.sql >/dev/null 2>&1 \
  || bad "schema 应用失败 —— 核对 database_id 与账户权限（D1:Edit）"
ok "schema.sql 已应用（FlyStateDO 另有懒建表双保险）"

say "3/5 部署 Worker（v1.4 安全基线：simulated + 零密钥，绝不真金）"
DEPLOY_OUT="$(npx wrangler deploy 2>&1)" || { printf '%s\n' "$DEPLOY_OUT" | tail -20; bad "deploy 失败"; }
printf '%s\n' "$DEPLOY_OUT" | tail -6
WORKER_URL="${1:-$(printf '%s' "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]*workers\.dev' | head -1 || true)}"
[ -n "$WORKER_URL" ] || { read -r -p "  未自动识别 Worker URL，请输入（如 https://murmur.xxx.workers.dev）: " WORKER_URL; }
ok "Worker URL = $WORKER_URL"

say "4/5 检查点 C0-1 / C0-2 / C0-4"
sleep 5
curl -s "$WORKER_URL/health" | grep -q '"version":"1.4.0"' \
  && ok "C0-1 /health ok + version 1.4.0" || bad "C0-1 /health 异常 —— 等 30s 重跑本脚本"
curl -s "$WORKER_URL/state" | grep -q '"economyFacilitator":"simulated"' \
  && ok "C0-2 经济层 = simulated（keyless 安全默认，一分钱动不了）" || bad "C0-2 经济层不是 simulated —— wrangler.toml 被改过？恢复 ECONOMY_FACILITATOR=\"simulated\" 再 deploy"
curl -s "$WORKER_URL/history?limit=3" | grep -q '"enabled":true' \
  && ok "C0-4 D1 归档 enabled（历史曲线开始落库）" || bad "C0-4 /history 未启用 —— 检查 [[d1_databases]] 绑定"

say "5/5 检查点 C0-3（等 75s 让平台 cron 自主推进 —— 本脚本唯一等待）"
T1="$( (curl -s "$WORKER_URL/state" || true) | grep -oE '"tickIndex":[0-9]+' | grep -oE '[0-9]+' | head -1 || true)"
sleep 75
T2="$( (curl -s "$WORKER_URL/state" || true) | grep -oE '"tickIndex":[0-9]+' | grep -oE '[0-9]+' | head -1 || true)"
if [ -n "$T2" ] && [ -n "$T1" ] && [ "$T2" -gt "$T1" ]; then
  ok "C0-3 cron 自主推进（tick $T1 → $T2）"
else
  bad "C0-3 tick 未推进 —— Dashboard → Workers → murmur → Triggers 确认 cron 存在；npx wrangler tail 看报错"
fi

printf "\n${G}C0 冷启动验收通过。${N}接下来的手动步骤（本脚本不代做）：\n"
printf "  ${Y}C0-5${N} 新终端运行 npx wrangler tail --format pretty 观察 2 分钟（无红字异常即可）\n"
printf "  ${Y}阶段二${N} 管理面加固: npx wrangler secret put ADMIN_TOKEN → 手册 §4 检查点 C1\n"
printf "  ${Y}阶段三${N} 经济层点亮: 先离线生成专用种子 → node scripts/offline-seed-gen.mjs → 手册 §5\n"
