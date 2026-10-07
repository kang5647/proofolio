# Status: what is live, what is simulated, what is blocked

Historical integration record: 6–7 October 2026. For the current scenario, validated test counts and demo boundaries, see the [root README](../README.md). Payment status below describes the recorded run, not a fresh chain query.

| Item | State | Evidence |
|---|---|---|
| Two bots on the same simulated market | working | `npm run bots:run`; tests/simulator.test.ts |
| Fixed-point FIFO accounting, reconciliation, UNVERIFIABLE paths | working, tested | tests/accounting.test.ts (10 tests) |
| Private source with auth, pagination, duplicate + missing-page modes | working | services/source; smoke-tested 401/403/404 |
| ResumeReceipt.sol (official IReceiver/ReceiverTemplate) | working, tested | `forge test` (7 tests) |
| CRE confidential workflow, `cre workflow simulate` (CLI v1.37.0, SDK 1.18.0) | **actual CLI runs** against local anvil-as-sepolia + local source | data/cre-local-acct-bot-a.json (stdout captured), docs/evidence/ |
| CRE `--broadcast` to Sepolia | not used, by decision (7 Oct): the workflow reads at the finalized block, ~15 min per check on Sepolia; the demo uses the local receipt path | `ResumeReceipt` deployed at `0xEac88c3F148A782AC814257004DB19AF5a79adA3` (tx `0x3b555aa5…56d233`), no receipt written through it |
| CRE deploy / Confidential Workflows access | not enabled for the org; request pending (`cre account access`) | — |
| Masumi MIP-003 surface (/availability, /input_schema, /start_job, /status) | working | services/verifier |
| Masumi Payment Service (Preprod), real paid job + result submission | **working live**: 2 × 1 tUSDM escrows, two VALID certificates; payout remains timelocked | funds-lock `e344d959…7005c4`; result `fdbde6a9…2dad59` |
| Sokosumi shared test-organisation discovery | external admin approval/listing needed; not a Masumi protocol blocker | agent is already registered and directly hireable through MIP-003/MPS |
| Mock payment mode | working, labelled everywhere | demo feed shows "MOCK payment — no funds moved" |
| Buyer validation: tamper / expiry / scope / receipt | working | /api/tamper demo; agents/buyer/src/verify-certificate.ts |
| Restart persistence (SQLite journal) | verified: verifier restarted mid-demo, delivered jobs intact | data/verifier.db |
| Docker Compose + TLS (Caddy) | working end-to-end | https://13-250-105-188.sslip.io/ |
| AWS EC2 | running (`i-0f2af0a3ee6c1e688`, Singapore) | infra/ec2-up.sh |
| Demo video, slides | no final artifacts in this repository | docs/demo-script.md |

## Known limitations

- The CRE simulator is not a TEE; `executionMode=local-simulation` is stamped in every certificate and shown in the UI.
- In local mode the receipt is relayed through `MockForwarder` (no DON signature). On Sepolia the real forwarder path is used by `--broadcast`.
- The operator runs the simulator and holds the demo source credentials; disclosed in certificate limitations.
- Masumi result hash binds delivered bytes, not financial truth; an UNVERIFIABLE result is a paid, successful check.
- Mock payment mode never reaches `paid_out` (no payout to animate).
- In-process fallback engine exists for development only (`EXECUTION_ENGINE=in-process-fallback`).
