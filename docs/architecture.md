# Proofolio architecture

```mermaid
flowchart LR
  subgraph SIM["Simulated market (synthetic, fixed seed)"]
    S[Simulator<br/>owns fills, fees, balances] --> LA[(Ledger A)]
    S --> LB[(Ledger B)]
    BA[Bot A · Momentum-20] -- orders --> S
    BB[Bot B · MeanRev-30] -- orders --> S
  end
  SRC[Source API :4100<br/>public profiles · private paged ledgers (bearer) · dev view] --- LA
  SRC --- LB

  BUY[Buyer agent :4300<br/>discover · start_job · purchase · poll · validate · decide] -- MIP-003 --> VER[Verification coworker :4200<br/>SQLite job journal]
  BUY -- purchase --> MPSb[Masumi Payment Service<br/>buyer wallet · Cardano Preprod]
  VER -- payment request / submit-result --> MPSs[Masumi Payment Service<br/>seller wallet · Cardano Preprod]
  MPSb <-- escrow (tUSDM) --> MPSs

  VER -- commitRequest --> RR[ResumeReceipt.sol<br/>Anvil demo / Sepolia path]
  VER -- http payload --> CRE[CRE workflow trading-resume<br/>handlerInTee]
  CRE -- read scope --> RR
  CRE -- getSecret + GET pages (in TEE) --> SRC
  CRE -- writeReport (dry-run in demo) --> RR
  VER -- demo receipt via MockForwarder --> RR
  CRE -- certificate (summary only) --> VER
  VER -- certificate --> BUY
  BUY -- verifyReceipt(digest) --> RR
```

## Roles

| Role | Implementation | LLM? |
|---|---|---|
| Bot A / Bot B | deterministic strategies (`bots/`) run by the simulator (`simulator/`) | no |
| Source | Fastify service with per-account random demo tokens, pagination, fault modes | no |
| Verification coworker | MIP-003 API + persisted job state machine + Masumi client + CRE runner (`services/verifier/`) | no |
| CRE workflow | HTTP trigger → EVM read → TEE: secret, fetch, accounting → DON: report, writeReport (`workflows/trading-resume/`) | no |
| Buyer agent | deterministic tools + optional Claude prose for the explanation only (`agents/buyer/`) | optional, explanation only |

## Trust boundaries (what is and is not confidential)

- The handler returns the certificate summary and receipt metadata; raw fills, balances and the source token are not included. Simulation logs also expose scope and verification counts. Remove or gate handler logs before a production confidential deployment.
- Local simulation: the CRE simulator is not a TEE and has no DON consensus. Certificates carry `executionMode=local-simulation`, `executionEngine=cre-simulate`.
- The service operator runs the simulator and can inspect its ledger (`/dev/ledger/:runId` with a dev token). This is disclosed in every certificate's `limitations`.
- Masumi payment proves that a check was bought and delivered; its result hash binds the delivered bytes, not financial truth.

## Certificate and digest

- Canonical JSON: sorted keys, no whitespace, decimal strings for money (`packages/accounting/src/canonical.ts`).
- `certDigest = sha256(canonical(certificate))`. The receipt stores `(requestId → certDigest, status)`; the buyer recomputes the digest and calls `verifyReceipt`.
- Masumi `submitResultHash = sha256(canonical certificate bytes)` as a 64-char hex (what the MIP-003 `/status.result` returns). This is Masumi's result hash, distinct from the EVM receipt digest only by encoding (0x prefix).

## Accounting method (proofdesk-accounting/1.0.0)

FIFO lot matching; fees attributed per fill and summed separately; gross − fees = net; round-trip = flat → non-flat → flat; largest gross winning round-trip = max gross over winning round-trips; forced close at the last event under the same fee schedule; funding not applicable; reconciliation `ending − starting == net` with both boundaries flat. Fixed-point 8 dp bigint; the only rounding is the fee (round-half-up to 8 dp). See `packages/accounting/src/accounting.ts`.

## Live-versus-simulated matrix

| Component | Local Docker / dev | Hosted demo | Notes |
|---|---|---|---|
| Trading bots + market | real code, synthetic data | same | never exchange execution |
| Source credentials | random demo tokens | same | prove access to the demo source only |
| CRE workflow | `cre workflow simulate` (real CLI, real HTTP + RPC) | same | not a real TEE / DON; deploy is private beta |
| Receipt chain | anvil impersonating Sepolia + MockForwarder | local Anvil + MockForwarder (no DON signature) | Sepolia broadcast path exists separately; not the recorded demo receipt path |
| Payments | mock provider (labelled) | Masumi Payment Service on Cardano Preprod, tUSDM | real escrow, test funds |
| Buyer explanation | template | template or Claude (if key) | never computes money |
