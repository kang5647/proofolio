#!/usr/bin/env bash
# Local stack: anvil + contracts, source (4100), verifier (4200), buyer+demo (4300).
# Reads .env (copy from .env.example). Logs in data/*.log. Stop with scripts/dev-down.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
export SOURCE_ADMIN_TOKEN="${SOURCE_ADMIN_TOKEN:-dev-admin-$(openssl rand -hex 8)}"
export SOURCE_DEV_TOKEN="${SOURCE_DEV_TOKEN:-dev-view-$(openssl rand -hex 8)}"
export PAYMENT_MODE="${PAYMENT_MODE:-mock}"
export EXECUTION_ENGINE="${EXECUTION_ENGINE:-cre-simulate}"
mkdir -p data
./scripts/local-chain-up.sh
pkill -f "services/source/src/server.ts" 2>/dev/null || true
pkill -f "services/verifier/src/server.ts" 2>/dev/null || true
pkill -f "agents/buyer/src/server.ts" 2>/dev/null || true
nohup npx tsx services/source/src/server.ts > data/source.log 2>&1 &
sleep 2
# Provision CRE simulator secrets + key from the source credentials (local only)
node -e '
const fs=require("fs");const c=JSON.parse(fs.readFileSync("data/source-credentials.json","utf8"));
let env=fs.existsSync("workflows/.env")?fs.readFileSync("workflows/.env","utf8"):"";
const set=(k,v)=>{env=env.split("\n").filter(l=>!l.startsWith(k+"=")).join("\n").replace(/\n*$/,"\n")+k+"="+v+"\n"};
for(const x of c) set(x.accountId==="acct-bot-a"?"SECRET_SOURCE_CRED_A":"SECRET_SOURCE_CRED_B", x.token);
set("CRE_ETH_PRIVATE_KEY","ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
fs.writeFileSync("workflows/.env",env,{mode:0o600});
const cfgP="workflows/trading-resume/config.local.json";const cfg=JSON.parse(fs.readFileSync(cfgP,"utf8"));
cfg.receiptAddress=JSON.parse(fs.readFileSync("data/local-chain.json","utf8")).resumeReceipt;fs.writeFileSync(cfgP,JSON.stringify(cfg,null,2)+"\n");'
nohup npx tsx services/verifier/src/server.ts > data/verifier.log 2>&1 &
nohup npx tsx agents/buyer/src/server.ts > data/buyer.log 2>&1 &
sleep 3
curl -s localhost:4100/health >/dev/null && curl -s localhost:4200/health && echo && curl -s -o /dev/null -w "buyer %{http_code}\n" localhost:4300/
echo "demo: http://127.0.0.1:4300  (PAYMENT_MODE=$PAYMENT_MODE, EXECUTION_ENGINE=$EXECUTION_ENGINE)"
