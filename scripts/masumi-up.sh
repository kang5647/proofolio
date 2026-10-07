#!/usr/bin/env bash
# Start the Masumi Payment Service (Postgres + MPS) locally via Docker Compose profile `masumi`.
# Requires vendor/masumi.env with BLOCKFROST_API_KEY_PREPROD, ENCRYPTION_KEY, ADMIN_KEY set.
# Then: migrate + seed (creates Preprod payment source + hot wallets), print wallet addresses to fund.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f vendor/masumi.env ] || { echo "vendor/masumi.env missing (see infra/masumi.env.example)"; exit 1; }
grep -q '^BLOCKFROST_API_KEY_PREPROD=.\+' vendor/masumi.env || { echo "BLOCKFROST_API_KEY_PREPROD not set in vendor/masumi.env"; exit 1; }
if ! grep -q '^ENCRYPTION_KEY=.\+' vendor/masumi.env; then echo "ENCRYPTION_KEY=$(openssl rand -hex 16)" >> vendor/masumi.env; fi
if ! grep -q '^ADMIN_KEY=.\+' vendor/masumi.env; then echo "ADMIN_KEY=$(openssl rand -hex 24)" >> vendor/masumi.env; fi
touch .env
docker compose -f infra/docker-compose.yml --profile masumi up -d masumi-db
sleep 4
docker compose -f infra/docker-compose.yml --profile masumi run --rm masumi-payment sh -c "pnpm run prisma:migrate && pnpm run prisma:seed" 2>&1 | tail -15
docker compose -f infra/docker-compose.yml --profile masumi up -d masumi-payment
sleep 8
ADMIN_KEY=$(grep '^ADMIN_KEY=' vendor/masumi.env | cut -d= -f2)
echo "--- payment sources (fund the Selling wallet with test ADA; Purchasing wallet with tADA + tUSDM):"
curl -s -H "token: $ADMIN_KEY" "http://127.0.0.1:3001/api/v1/payment-source/?take=5" | python3 -c '
import sys,json
d=json.load(sys.stdin).get("data",{})
for s in d.get("PaymentSources",[]):
    print("network",s.get("network"),"contract",s.get("smartContractAddress"))
    for w in s.get("HotWallets",[]): print("  ",w.get("type"),w.get("walletAddress"),"vkey",w.get("walletVkey"))'
echo "admin UI: http://127.0.0.1:3001/admin (local only)"
