/**
 * Fixed-seed, multi-regime synthetic price series for SIM-SOL/USDT.
 *
 * DEMONSTRATION PURPOSE (disclosed): the regimes and seed are chosen so that the
 * momentum bot posts one large winning trade in the opening trend and then loses
 * to whipsaws and fees, while the mean-reversion bot ends net positive. That makes
 * a cherry-picked claim and an honest claim diverge under verification.
 * The seed is committed in this file and in every run's metadata; the series is
 * entirely synthetic and is NOT an unbiased evaluation of either strategy.
 *
 * Prices are generated with 2 decimals and returned as 8-dp scaled bigints.
 */
import { gaussian, mulberry32, seedFromString } from './prng.ts'
import { SCALE } from '../../packages/accounting/src/fixed.ts'

export const COMMITTED_SEED = 'proofdesk-demo-series-2026-10-07-v125'
export const EVENT_INTERVAL_MS = 60_000 // one simulated minute per event
export const SERIES_START_ISO = '2026-10-01T00:00:00.000Z'

export interface Regime {
  name: string
  events: number
  /** per-event drift (fraction) */
  drift: number
  /** per-event volatility (fraction, std dev) */
  vol: number
  /** optional mean-reversion pull toward `anchor` (fraction of gap per event) */
  revert?: { anchor: number; k: number }
}

export const DEMO_REGIMES: Regime[] = [
  { name: 'trend-up', events: 120, drift: 0.0022, vol: 0.006 },
  { name: 'choppy', events: 200, drift: 0.0, vol: 0.012 },
  { name: 'mean-reverting', events: 320, drift: 0.0, vol: 0.013, revert: { anchor: 115, k: 0.06 } },
]

export interface MarketEvent {
  seq: number
  ts: string
  /** 8-dp scaled price */
  price: bigint
  regime: string
}

export function generateSeries(seed: string = COMMITTED_SEED, regimes: Regime[] = DEMO_REGIMES, startPrice = 100): MarketEvent[] {
  const rand = mulberry32(seedFromString(seed))
  const out: MarketEvent[] = []
  let p = startPrice
  let seq = 0
  const t0 = Date.parse(SERIES_START_ISO)
  for (const r of regimes) {
    for (let i = 0; i < r.events; i++) {
      let ret = r.drift + r.vol * gaussian(rand)
      if (r.revert) ret += r.revert.k * ((r.revert.anchor - p) / p)
      p = Math.max(1, p * (1 + ret))
      const cents = Math.round(p * 100)
      out.push({ seq, ts: new Date(t0 + seq * EVENT_INTERVAL_MS).toISOString(), price: (BigInt(cents) * SCALE) / 100n, regime: r.name })
      seq++
    }
  }
  return out
}
