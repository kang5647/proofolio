# Fresh CRE simulation — 7 Oct 2026

Command:

```bash
npx tsx scripts/cre-local-e2e.ts acct-bot-a
```

Result: exit `0` using `workflows/trading-resume` target `local-settings`.

- Request: `0xe65dd260048a1177b018cb117bbcdd602b65e27ea6d42dde624471f4eaa8daa2`
- Scope: `run-bot-a-20261007082000`, `SIM-SOL/USDT`
- Private source records fetched in the CRE TEE handler: `90`
- Computed scoped net result: `-1522.12944114 USDT`
- Certificate digest: `0x713e409747b59806231e19c63c66c302cc0c02beca945d34be8aeb6e02e992b7`
- Receipt write: simulator dry run (`SUCCESS`, no broadcast tx)

The output explicitly reports `executionMode=local-simulation`: this is not a real TEE or DON consensus proof. Full raw simulator output is saved in `data/cre-local-acct-bot-a.json` locally.

## Captured CLI log excerpt

Extracted from the saved simulator stdout for the request above (not a new run). The word “enclave” is the handler's simulation log label, not evidence of hardware-attested execution.

```text
2026-10-07T16:28:34Z [USER LOG] scope read: request=0xe65dd260… buyer=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 interval=[2026-10-01T00:00:00.000Z, 2026-10-01T10:40:00.000Z)
2026-10-07T16:28:34Z [USER LOG] enclave verification complete: status=VERIFIED records=90 reasons=0
2026-10-07T16:28:34Z [USER LOG] receipt write: status=SUCCESS tx=dry-run digest=0x713e4097…
```
