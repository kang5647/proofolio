# Masumi paid-job evidence — Cardano Preprod

Run: 6 Oct 2026, public deployment `https://13-250-105-188.sslip.io/`.

- Registered agent: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b101188b5ebcc01d59476fb9a31cee5fba19a9c2885ca498b4a681b45f9000000`
- Quote read from the on-chain V2 registry metadata: 1,000,000 atomic units (1 tUSDM) per check.
- Buyer created two independent purchases under a 2,000,000-atomic-unit spend cap.
- Shared escrow funds-lock transaction: [`e344d95967d73668c64f8eebc1f9e4a6a5c0d63f960315d176ede531987005c4`](https://preprod.cardanoscan.io/transaction/e344d95967d73668c64f8eebc1f9e4a6a5c0d63f960315d176ede531987005c4)
- Shared result-submission transaction: [`fdbde6a95f702fa3b8605bb4ac6e72629245db9e9d19755304687a764b2dad59`](https://preprod.cardanoscan.io/transaction/fdbde6a95f702fa3b8605bb4ac6e72629245db9e9d19755304687a764b2dad59)
- Finality check (Koios Preprod `tx_status`, 6 Oct 23:19 SGT): 68 and 39 confirmations; verifier reports `onChainState=ResultSubmitted` for both jobs.
- Payout: not yet withdrawn; escrow is timelocked until `unlockTime` 1791323523 (7 Oct 2026 05:52 SGT) for job A (job B shortly after).

| Candidate | ProofDesk job | Certificate digest | Buyer evidence | Decision |
|---|---|---|---|---|
| Bot A · Momentum-20 | `8bd61398-033e-4ea5-930e-16237e892769` | `0x18a99f033b72a562682dd34ee573be6b3a8e6d1b56d861edf75372fc9ad61f76` | VALID | SHORTLIST |
| Bot B · MeanRev-30 | `aba859d3-2c3a-42e9-96b8-d7efcb1b8640` | `0x14aa1f2862cbb2c8f1b5a95dad073f98b9401512b053efb557c050731d191b98` | VALID | DECLINE |

The Cardano transactions use Preprod test funds. The trading market is synthetic and the CRE execution/receipt path in this deployment is the explicitly labelled local simulation with `MockForwarder`; the receipt transactions are therefore local EVM evidence, not Sepolia/DON evidence.
