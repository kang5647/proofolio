import { describe, expect, it } from 'vitest'
import {
  canonicalize,
  certificateDigest,
  buildCertificate,
  computeAccounting,
  digestCanonical,
  formatFixed,
  mulRoundHalfUp,
  parseFixed,
  verifyRun,
  type LedgerRecord,
  type RunMeta,
  SCALE,
} from '../packages/accounting/src/index.ts'
import { paginate } from '../packages/accounting/src/pages.ts'
import { COMMITTED_SEED, generateSeries, runBot } from '../simulator/src/index.ts'
import { MomentumStrategy } from '../bots/src/index.ts'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const ts = (i: number) => new Date(T0 + i * 60_000).toISOString()

/** Hand-built fixture: 10,000 start; buy 10 @ 100 (fee 1.00), buy 10 @ 110 (fee 1.10), sell 15 @ 120 (fee 1.80), sell 5 @ 90 (fee 0.45). */
function fixture(): { meta: RunMeta; records: LedgerRecord[] } {
  let cash = 10_000n * SCALE
  let pos = 0n
  const recs: LedgerRecord[] = []
  const push = (seq: number, kind: LedgerRecord['kind'], side?: 'buy' | 'sell', qty?: bigint, price?: bigint) => {
    if (qty !== undefined && price !== undefined) {
      const notional = (qty * price) / SCALE
      const fee = mulRoundHalfUp(notional, 10n, 10_000n)
      if (side === 'buy') {
        cash -= notional + fee
        pos += qty
      } else {
        cash += notional - fee
        pos -= qty
      }
      recs.push({ eventId: `fx:${seq}:${recs.length}`, seq, ts: ts(seq), kind, side, qty: formatFixed(qty), price: formatFixed(price), notional: formatFixed(notional), fee: formatFixed(fee), cashAfter: formatFixed(cash), positionAfter: formatFixed(pos) })
    } else {
      recs.push({ eventId: `fx:${seq}:${recs.length}`, seq, ts: ts(seq), kind, cashAfter: formatFixed(cash), positionAfter: formatFixed(pos) })
    }
  }
  push(0, 'start')
  push(1, 'fill', 'buy', 10n * SCALE, 100n * SCALE)
  push(2, 'fill', 'buy', 10n * SCALE, 110n * SCALE)
  push(3, 'fill', 'sell', 15n * SCALE, 120n * SCALE)
  push(4, 'forced_close', 'sell', 5n * SCALE, 90n * SCALE)
  push(4, 'end')
  const meta: RunMeta = {
    runId: 'fx', accountId: 'acct-fx', accountCommitment: '0x' + '11'.repeat(32) as `0x${string}`, market: 'SIM-SOL/USDT', sourceVersion: 'proofdesk-sim-source/1.0.0', methodologyVersion: 'proofdesk-accounting/1.0.0', strategyId: 'fx', intervalStart: ts(0), intervalEnd: ts(5), startingQuote: formatFixed(10_000n * SCALE), feeBps: 10, seed: 'fx', dataProvenance: 'simulated-market', recordCount: recs.length, orderedEventIds: recs.map((r) => r.eventId), generatedAt: '2026-01-01T01:00:00.000Z',
  }
  return { meta, records: recs }
}

const scopeOf = (m: RunMeta) => ({ runId: m.runId, accountCommitment: m.accountCommitment, market: m.market, intervalStart: m.intervalStart, intervalEnd: m.intervalEnd, methodologyVersion: m.methodologyVersion })

describe('fixed-point', () => {
  it('parses/formats exactly and rounds fees half-up', () => {
    expect(formatFixed(parseFixed('123.45'))).toBe('123.45000000')
    expect(() => parseFixed('1.123456789')).toThrow()
    expect(() => parseFixed('1e5')).toThrow()
    // 0.1% of 1.23456789 = 0.00123456789 -> 0.00123457
    expect(formatFixed(mulRoundHalfUp(parseFixed('1.23456789'), 10n, 10_000n))).toBe('0.00123457')
  })
})

describe('FIFO accounting fixture', () => {
  it('matches hand-computed gross, fees, net, round-trips and reconciles', () => {
    const { meta, records } = fixture()
    const a = computeAccounting(records, { intervalStart: meta.intervalStart, intervalEnd: meta.intervalEnd })
    // sell 15 @120: 10 from lot@100 => +200, 5 from lot@110 => +50 ; sell 5 @90: from lot@110 => -100 ; gross = 150
    expect(formatFixed(a.grossRealizedPnl)).toBe('150.00000000')
    expect(formatFixed(a.totalCommissions)).toBe('4.35000000') // 1.00+1.10+1.80+0.45
    expect(formatFixed(a.netRealizedPnl)).toBe('145.65000000')
    expect(a.fillCount).toBe(4)
    expect(a.forcedCloses).toBe(1)
    expect(a.roundTrips.length).toBe(1)
    expect(formatFixed(a.largestGrossWinningRoundTrip!.gross)).toBe('150.00000000')
    expect(a.reconciliationOk).toBe(true)
    expect(a.endingQuote - a.startingQuote).toBe(a.netRealizedPnl)
  })

  it('verifies a complete paginated run and returns VERIFIED with the same figures', () => {
    const { meta, records } = fixture()
    const pages = paginate(meta, records, 2)
    expect(pages.length).toBe(3)
    const out = verifyRun(pages, scopeOf(meta))
    expect(out.status).toBe('VERIFIED')
    expect(out.result!.netRealizedPnl).toBe('145.65000000')
    expect(out.recordCount).toBe(6)
  })

  it('missing page -> UNVERIFIABLE with no financial result', () => {
    const { meta, records } = fixture()
    const pages = paginate(meta, records, 2)
    const out = verifyRun([pages[0], pages[2]], scopeOf(meta))
    expect(out.status).toBe('UNVERIFIABLE')
    expect(out.result).toBeNull()
    expect(out.reasons.join('|')).toMatch(/page index gap|cursor chain|record count/)
    const out2 = verifyRun([pages[0], pages[1]], scopeOf(meta))
    expect(out2.status).toBe('UNVERIFIABLE')
    expect(out2.reasons.join('|')).toMatch(/not marked final/)
  })

  it('duplicate events are detected', () => {
    const { meta, records } = fixture()
    const pages = paginate(meta, records, 2)
    pages[1].records = [...pages[1].records, pages[0].records[1]]
    const out = verifyRun(pages, scopeOf(meta))
    expect(out.status).toBe('UNVERIFIABLE')
    expect(out.reasons.some((r) => r.startsWith('duplicate event'))).toBe(true)
  })

  it('interval boundaries are start-inclusive / end-exclusive and non-flat boundaries are UNVERIFIABLE', () => {
    const { meta, records } = fixture()
    const pages = paginate(meta, records, 10)
    // Scope cuts between the two buys and the sells: position at start non-zero.
    const cut = verifyRun(pages, { ...scopeOf(meta), intervalStart: ts(3), intervalEnd: ts(5) })
    expect(cut.status).toBe('UNVERIFIABLE')
    expect(cut.reasons).toContain('position not flat at interval start')
    // Scope that ends before the forced close: position at end non-zero.
    const early = verifyRun(pages, { ...scopeOf(meta), intervalStart: ts(0), intervalEnd: ts(4) })
    expect(early.status).toBe('UNVERIFIABLE')
    expect(early.reasons).toContain('position not flat at interval end')
    // End-exclusive: interval ending exactly at ts(4) excludes seq 4 records; ending at ts(5) includes them.
    const full = verifyRun(pages, { ...scopeOf(meta), intervalStart: ts(0), intervalEnd: ts(5) })
    expect(full.status).toBe('VERIFIED')
    // Interval outside declared run boundaries is rejected.
    const outside = verifyRun(pages, { ...scopeOf(meta), intervalEnd: ts(6) })
    expect(outside.reasons).toContain('requested interval outside declared run boundaries')
  })

  it('wrong account / run / method scope -> UNVERIFIABLE', () => {
    const { meta, records } = fixture()
    const pages = paginate(meta, records, 10)
    expect(verifyRun(pages, { ...scopeOf(meta), runId: 'other' }).reasons[0]).toMatch(/run mismatch/)
    expect(verifyRun(pages, { ...scopeOf(meta), accountCommitment: ('0x' + '22'.repeat(32)) as `0x${string}` }).reasons[0]).toMatch(/account commitment/)
    expect(verifyRun(pages, { ...scopeOf(meta), methodologyVersion: 'x/9' }).reasons[0]).toMatch(/methodology/)
  })
})

describe('canonical JSON + certificate digest', () => {
  it('is key-order independent and rejects floats', () => {
    expect(canonicalize({ b: 1, a: { d: 'x', c: null } })).toBe('{"a":{"c":null,"d":"x"},"b":1}')
    expect(digestCanonical({ b: 1, a: 2 })).toBe(digestCanonical({ a: 2, b: 1 }))
    expect(() => canonicalize({ x: 1.5 })).toThrow()
  })

  it('tampering with an amount or a date changes the digest (buyer verification fails)', () => {
    const { meta, records } = fixture()
    const out = verifyRun(paginate(meta, records, 10), scopeOf(meta))
    const cert = buildCertificate(
      { requestId: ('0x' + 'ab'.repeat(32)) as `0x${string}`, buyer: '0x0000000000000000000000000000000000000001', accountCommitment: meta.accountCommitment, runId: meta.runId, market: meta.market, intervalStart: meta.intervalStart, intervalEnd: meta.intervalEnd, methodologyVersion: meta.methodologyVersion, nonce: ('0x' + 'cd'.repeat(32)) as `0x${string}`, issuedAt: '2026-01-01T02:00:00.000Z', expiresAt: '2026-01-02T02:00:00.000Z', executionMode: 'local-simulation', executionEngine: 'in-process-fallback' },
      out,
    )
    const d0 = certificateDigest(cert)
    const tamperedAmount = structuredClone(cert)
    tamperedAmount.result!.netRealizedPnl = '1145.65000000'
    expect(certificateDigest(tamperedAmount)).not.toBe(d0)
    const tamperedDate = structuredClone(cert)
    tamperedDate.intervalEnd = '2026-01-01T00:06:00.000Z'
    expect(certificateDigest(tamperedDate)).not.toBe(d0)
    expect(certificateDigest(structuredClone(cert))).toBe(d0)
  })
})

describe('real bot run through the verifier path', () => {
  it('Bot A run verifies and the selective claim differs from net', () => {
    const run = runBot(new MomentumStrategy(), generateSeries(COMMITTED_SEED), { runId: 'r', accountId: 'a', seed: COMMITTED_SEED })
    const out = verifyRun(paginate(run.meta, run.records, 25), scopeOf(run.meta))
    expect(out.status).toBe('VERIFIED')
    expect(out.result!.reconciliation).toBe('ok')
    expect(out.result!.largestGrossWinningRoundTrip).not.toBeNull()
    expect(out.result!.largestGrossWinningRoundTrip!.gross).not.toBe(out.result!.netRealizedPnl)
  })
})
