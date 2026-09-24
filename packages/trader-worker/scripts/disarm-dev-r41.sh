#!/usr/bin/env bash
# ============================================================================
# R4-1 本地武装回滚 — 移除 .dev.vars 中的 R4-1 LOCAL ARM 块（含助记词行）
# 回滚后 worker 重启即回 keyless 影子模式（零链上写、零 gas）。
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DEV_VARS=".dev.vars"
[ -f "$DEV_VARS" ] || { echo "no $DEV_VARS"; exit 0; }

# 删除从武装块头标记到 ECONOMY_MNEMONIC 行（含）之间的全部内容
python3 - "$DEV_VARS" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
new = re.sub(r"\n# ==== R4-1 LOCAL ARM.*?^ECONOMY_MNEMONIC=.*\n", "\n", s, flags=re.S | re.M)
if new == s:
    print("未发现武装块（已回滚态）")
else:
    open(p, "w").write(new)
    print("OK: 武装块已移除（含助记词行）")
PY
