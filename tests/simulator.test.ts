import { describe, expect, it } from 'vitest'
import { MomentumStrategy, MeanReversionStrategy, type MarketView, type OrderIntent, type Strategy } from '../bots/src/index.ts'
import { COMMITTED_SEED, generateSeries, runBot } from '../simulator/src/index.ts'
import { computeAccounting, formatFixed, parseFixed, SCALE } from '../packages/accounting/src/index.ts'

const series = generateSeries(COMMITTED_SEED)
const opts = (runId: string) => ({ runId, accountId: `acct-${runId}`, seed: COMMITTED_SEED })

describe('simulated market + bots', () => {
  it('series is deterministic for the committed seed', () => {
    const again = generateSeries(COMMITTED_SEED)
    expect(again.map((e) => e.price.toString())).toEqual(series.map((e) => e.price.toString()))
    expect(series.length).toBe(640)
  })

  it('both bots execute and produce distinct ledger actions', () => {
    const a = runBot(new MomentumStrategy(), series, opts('a'))
    const b = runBot(new MeanReversionStrategy(), series, opts('b'))
    const fillsA = a.records.filter((r) => r.kind === 'fill')
    const fillsB = b.records.filter((r) => r.kind === 'fill')
    expect(fillsA.length).toBeGreaterThan(0)
    expect(fillsB.length).toBeGreaterThan(0)
    expect(fillsA.map((r) => r.seq)).not.toEqual(fillsB.map((r) => r.seq))
    expect(new Set(a.records.map((r) => r.eventId)).size).toBe(a.records.length)
  })

  it('a strategy cannot read future events', () => {
    const peeker: Strategy = {
      id: 'peek',
      name: 'peek',
      rules: [],
      decide(v: MarketView): OrderIntent | null {
        v.priceAt(v.seq + 1) // must throw
        return null
      },
    }
    expect(() => runBot(peeker, series, opts('peek'))).toThrow(/outside the visible history/)
  })

  it('rejects insufficient balance and short sells; never goes negative', () => {
    const greedy: Strategy = {
      id: 'greedy',
      name: 'greedy',
      rules: [],
      decide(v) {
        if (v.seq === 0) return { side: 'sell', qty: 1n * SCALE } // flat -> short attempt
        if (v.seq === 1) return { side: 'buy', quoteNotional: 50_000n * SCALE } // > cash
        if (v.seq === 2) return { side: 'buy', quoteNotional: 10_000n * SCALE } // notional+fee > cash
        if (v.seq === 3) return { side: 'buy', quoteNotional: 9_000n * SCALE } // ok
        return null
      },
    }
    const run = runBot(greedy, series, opts('greedy'))
    const rejects = run.records.filter((r) => r.kind === 'reject')
    expect(rejects.map((r) => r.reason)).toEqual([
      'insufficient base position (no short selling)',
      'insufficient quote balance',
      'insufficient quote balance',
    ])
    expect(run.records.filter((r) => r.kind === 'fill').length).toBe(1)
    for (const r of run.records) {
      expect(parseFixed(r.cashAfter)).toBeGreaterThanOrEqual(0n)
      expect(parseFixed(r.positionAfter)).toBeGreaterThanOrEqual(0n)
    }
  })

  it('forced close at the last event reconciles with balances under the same fee schedule', () => {
    const holder: Strategy = { id: 'hold', name: 'hold', rules: [], decide: (v) => (v.seq === 5 ? { side: 'buy', quoteNotional: 1000n * SCALE } : null) }
    const run = runBot(holder, series, opts('hold'))
    const fc = run.records.filter((r) => r.kind === 'forced_close')
    expect(fc.length).toBe(1)
    expect(fc[0].seq).toBe(series.length - 1)
    expect(fc[0].price).toBe(formatFixed(series.at(-1)!.price))
    const acct = computeAccounting(run.records, { intervalStart: run.meta.intervalStart, intervalEnd: run.meta.intervalEnd })
    expect(acct.forcedCloses).toBe(1)
    expect(acct.endFlat).toBe(true)
    expect(acct.reconciliationOk).toBe(true)
    expect(acct.endingQuote - acct.startingQuote).toBe(acct.netRealizedPnl)
  })

  it('both demo bots start and end flat and reconcile exactly', () => {
    for (const s of [new MomentumStrategy(), new MeanReversionStrategy()]) {
      const run = runBot(s, series, opts(s.id))
      const acct = computeAccounting(run.records, { intervalStart: run.meta.intervalStart, intervalEnd: run.meta.intervalEnd })
      expect(acct.startFlat && acct.endFlat).toBe(true)
      expect(acct.reconciliationOk).toBe(true)
      expect(run.records.at(-1)!.positionAfter).toBe(formatFixed(0n))
    }
  })
})
