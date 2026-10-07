# Demo video script (target 2:30–3:00; confirm the official limit before recording)

Opening line (0:00–0:12): *"Agents should hire based on evidence, not screenshots. Proofolio is a paid coworker that checks scoped trading results and gives the buyer a portable certificate, without delivering the trade history. Everything you'll see uses real bots in a synthetic market, a local CRE confidential simulation, and Cardano Preprod test payments."*

1. **Run both bots** (0:12–0:35). Click *Run both bots*. Feed shows seed, 640 events, Bot A 88 fills / 44 round-trips, Bot B 30 fills / 15 round-trips. Say: same market, same fees, deterministic; the simulator owns the fills.
2. **Selective claim** (0:35–0:55). Point at Bot A's profile: "Best trade: +894.36 USDT gross". Say: that is one trade, gross of fees, chosen by the seller. Bot B self-reports +783.78 USDT net. Neither is verified.
3. **Verify before hiring** (0:55–1:35). Click it. Feed: specialist discovered, quote read from the payment service, **two jobs + two Masumi purchases** (not a bundle), escrow `FundsLocked` on Preprod, request committed on local Anvil, CRE runs the confidential handler in simulation. Show the terminal with `cre workflow simulate` output: `[USER LOG] scope read…`, `enclave verification complete: status=VERIFIED records=90`, `receipt write … dry-run`. Say: local simulation, not a real TEE or DON; live confidential deployment still requires access and validation.
4. **Compare and decide** (1:35–2:10). Certificate table: Bot A gross −1,171.30, fees 350.83, **net −1,522.13** versus the advertised 894.36 winner. Bot B net +783.78 verified. Buyer validation checks (digest, receipt on-chain, scope, expiry, provenance) all green. Decisions: DECLINE, SHORTLIST. Say: evidence status is separate from financial outcome; synthetic data cannot qualify anyone.
5. **Tamper** (2:10–2:30). Click *Tamper test: change an amount*: INVALID — receipt digest mismatch, net≠gross−fees. Click the date one: INVALID — scope.interval.
6. **Delivery and payout** (2:30–2:55). Links panel: Masumi payment tx (FundsLocked, ResultSubmitted), receipt tx (local chain, labelled), request id. If a previously started purchase has unlocked, show the `Withdrawn` tx with matching job id; otherwise say the unlock window is still open and show the deadlines (time cut, labelled).

Close (2:55–3:00): *"Two bots, two paid checks, one certificate each, verifiable by anyone with the receipt."*

Backup: record the full flow locally in mock mode as well, in case Preprod is slow during the final take.
