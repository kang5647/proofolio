#!/usr/bin/env bash
# Start a local anvil chain (chain id 31337) and deploy MockForwarder + ResumeReceipt.
# Writes the addresses to data/local-chain.json. LOCAL SIMULATION ONLY.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil account 0 (public test key)
if ! curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 >/dev/null 2>&1; then
  nohup anvil --silent --block-time 1 --chain-id 11155111 --slots-in-an-epoch 1 > data/anvil.log 2>&1 &
  sleep 2
fi
OUT=$(cd contracts && forge script script/Deploy.s.sol:DeployLocal --rpc-url http://127.0.0.1:8545 --broadcast --private-key "$ANVIL_KEY" 2>&1)
FWD=$(echo "$OUT" | grep -o 'MOCK_FORWARDER=0x[0-9a-fA-F]*' | cut -d= -f2)
RR=$(echo "$OUT" | grep -o 'RESUME_RECEIPT=0x[0-9a-fA-F]*' | cut -d= -f2)
[ -n "$RR" ] || { echo "$OUT" | tail -20; exit 1; }
cat > data/local-chain.json <<EOF
{ "chain": "anvil-as-sepolia", "chainId": 11155111, "rpcUrl": "http://127.0.0.1:8545", "mockForwarder": "$FWD", "resumeReceipt": "$RR", "operator": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "note": "LOCAL SIMULATION ONLY" }
EOF
echo "anvil up; MockForwarder=$FWD ResumeReceipt=$RR (data/local-chain.json)"
