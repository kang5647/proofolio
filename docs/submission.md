# Submission text (draft; fill links before submitting)

## One-liner
Proofolio is a paid AI coworker that verifies a trading bot's scoped results and hands the buyer a portable, on-chain-receipted certificate, without ever delivering the trade history.

## Problem
Agents and people hire trading bots on screenshots: a single big winning trade, a cherry-picked window, a self-reported PnL. The buyer cannot see the ledger, and the seller will not hand it over. Today the choice is "trust the screenshot" or "demand the raw data".

## Solution
A verification specialist that other agents hire per check through Masumi (Cardano Preprod escrow, tUSDM). The check runs in the Chainlink CRE local simulator using a confidential-workflow handler (not a live enclave): the workflow reads the immutable request scope from an EVM consumer contract, fetches the source credential and every ledger page inside the simulated TEE handler, runs deterministic FIFO accounting, and releases only a certificate summary plus a digest-bound receipt delivered through a local MockForwarder in the demo; the workflow also implements the Chainlink forwarder write path for Sepolia. The buyer validates digest, receipt, scope, expiry and provenance before deciding. Missing pages or non-flat boundaries return UNVERIFIABLE with no invented numbers, and that result is still a paid, delivered check.

## Technical approach
- TypeScript throughout; shared fixed-point accounting package bundled into both the Node services and the CRE workflow.
- Chainlink CRE: official `hello-confidential-workflows` template, `handlerInTee`, `runtime.getSecret` inside the enclave, `HTTPClient` with `TeeRuntime`, `usingTheDons()` for the report, `EVMClient.callContract` / `writeReport`; consumer uses the official `IReceiver` / `ReceiverTemplate` with forwarder and workflow-identity checks, nonce, expiry and replay protection.
- Masumi: MIP-003 `/availability`, `/input_schema`, `/start_job`, `/status`; Masumi Payment Service for payment requests, escrow state polling and result submission; persisted job journal (SQLite) with idempotent purchaser keys, restart safety and no automatic re-purchase.
- EVM: `ResumeReceipt.sol` request/receipt consumer (Sepolia-ready; the demo runs it on a local anvil chain).
- AWS: single EC2 Docker Compose deployment with persistent volumes and Caddy TLS.

## Honest labels
Simulated trading on a fixed-seed synthetic market; CRE local simulation (not a real TEE / DON) unless deployed; Cardano Preprod test funds. The operator runs the simulator and can inspect its ledger. No ROI, Sharpe or drawdown is computed.

## How it scales
Replace the simulated source with any authenticated read-only ledger API (exchange sub-account, prime broker, fund administrator); keep the same certificate schema, receipt contract and Masumi surface. Buyers (agents or desks) pay per scoped check; sellers never expose fills.

## Links (fill in)
- Repo: https://github.com/kang5647/proofolio
- Live demo: https://13-250-105-188.sslip.io/
- Demo video: …
- Slides: …
- Masumi agent identifier: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b101188b5ebcc01d59476fb9a31cee5fba19a9c2885ca498b4a681b45f9000000`
- Masumi funds-lock tx (2 × 1 tUSDM): `e344d95967d73668c64f8eebc1f9e4a6a5c0d63f960315d176ede531987005c4`
- Masumi result-submission tx: `fdbde6a95f702fa3b8605bb4ac6e72629245db9e9d19755304687a764b2dad59`; withdrawal was not recorded in this evidence.
- CRE workflow source: `workflows/trading-resume/workflow.ts`; CLI evidence: `docs/evidence/`
- Receipt contract: `ResumeReceipt` on the demo's local anvil chain via `MockForwarder` (labelled in the UI); source `contracts/src/ResumeReceipt.sol`
