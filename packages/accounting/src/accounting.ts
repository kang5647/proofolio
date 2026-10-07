/**
 * Deterministic scoped accounting over ledger records.
 *
 * Method (proofdesk-accounting/1.0.0):
 *  - Only `fill` and `forced_close` records move money. `reject` records are ignored.
 *  - Lot matching: FIFO. Each buy opens a lot (qty, price). Each sell consumes lots
 *    oldest-first; gross realised PnL for the consumed slice = qty_i * (sellPrice - lotPrice).
 *    All products are exact (qty has <= 4 dp, prices <= 2 dp) so no rounding occurs here.
 *  - Fees: attributed to the record they were charged on; summed separately as totalCommissions.
 *    Fees never enter gross PnL. net = gross - fees.
 *  - Round-trip: the span from position leaving zero to position returning to zero.
 *    Its gross = sum of matched-slice gross inside the span. "Largest gross winning
 *    round-trip" = max gross among round-trips with gross > 0; null if none.
 *  - Forced closes count as fills for fill count and are counted separately in forcedCloses.
 *  - Funding: not applicable (spot only).
 *  - Reconciliation: endingQuote - startingQuote == net  (no deposits/withdrawals, both boundaries flat).
 *  - Scope: only records with intervalStart <= ts < intervalEnd are included. Position at
 *    interval start (replayed from earlier records) must be zero and position after the last
 *    in-scope record must be zero; otherwise the result is UNVERIFIABLE (non-flat boundary).
 */
import { parseFixed, formatFixed, mulExact } from './fixed.ts'
import type { LedgerRecord } from './ledger.ts'

export interface RoundTrip {
  openedSeq: number
  closedSeq: number
  openedEventId: string
  closedEventId: string
  gross: bigint
  fees: bigint
  fills: number
}

export interface AccountingResult {
  grossRealizedPnl: bigint
  totalCommissions: bigint
  netRealizedPnl: bigint
  fillCount: number
  forcedCloses: number
  roundTrips: RoundTrip[]
  startingQuote: bigint
  endingQuote: bigint
  startFlat: boolean
  endFlat: boolean
  reconciliationOk: boolean
  largestGrossWinningRoundTrip: RoundTrip | null
  inScopeRecordCount: number
}

export interface Scope {
  intervalStart: string // ISO, inclusive
  intervalEnd: string // ISO, exclusive
}

function inScope(ts: string, scope: Scope): boolean {
  const t = Date.parse(ts)
  return t >= Date.parse(scope.intervalStart) && t < Date.parse(scope.intervalEnd)
}

/**
 * Run accounting over the full, ordered record list for one run.
 * `records` must be the complete ledger (completeness is checked elsewhere);
 * scoping is applied here so that pre-interval position can be replayed.
 */
export function computeAccounting(records: LedgerRecord[], scope: Scope): AccountingResult {
  const money = records.filter((r) => r.kind === 'fill' || r.kind === 'forced_close')

  // Replay pre-scope records to find position/cash at interval start.
  let position = 0n
  let lots: { qty: bigint; price: bigint }[] = []
  let startingQuote: bigint | null = null
  let i = 0
  for (; i < money.length && Date.parse(money[i].ts) < Date.parse(scope.intervalStart); i++) {
    const r = money[i]
    position = applyLots(r, lots)
  }
  const startFlat = position === 0n

  // Starting quote: cash before first in-scope money record. Use the 'start' record if the scope
  // begins at run start; otherwise take cashAfter of the last pre-scope record.
  const startRec = records.find((r) => r.kind === 'start')
  if (i === 0) {
    if (!startRec) throw new Error('ledger has no start record')
    startingQuote = parseFixed(startRec.cashAfter)
  } else {
    startingQuote = parseFixed(money[i - 1].cashAfter)
  }

  let gross = 0n
  let fees = 0n
  let fillCount = 0
  let forcedCloses = 0
  let endingQuote = startingQuote
  const roundTrips: RoundTrip[] = []
  let open: { openedSeq: number; openedEventId: string; gross: bigint; fees: bigint; fills: number } | null = null
  let inScopeRecordCount = 0

  for (; i < money.length && inScope(money[i].ts, scope); i++) {
    const r = money[i]
    inScopeRecordCount++
    fillCount++
    if (r.kind === 'forced_close') forcedCloses++
    const fee = parseFixed(r.fee ?? '0')
    fees += fee
    if (position === 0n) open = { openedSeq: r.seq, openedEventId: r.eventId, gross: 0n, fees: 0n, fills: 0 }
    const before = position
    const sliceGross = matchGross(r, lots)
    position = applyLots(r, lots)
    gross += sliceGross
    endingQuote = parseFixed(r.cashAfter)
    if (open) {
      open.gross += sliceGross
      open.fees += fee
      open.fills++
      if (before !== 0n && position === 0n) {
        roundTrips.push({ ...open, closedSeq: r.seq, closedEventId: r.eventId })
        open = null
      }
    }
    if (before === 0n && position === 0n) open = null
  }
  // Remaining records after scope end are ignored, but if there are none in scope, ending = starting.
  const endFlat = position === 0n
  const net = gross - fees
  const reconciliationOk = startFlat && endFlat && endingQuote - startingQuote === net
  const winners = roundTrips.filter((rt) => rt.gross > 0n)
  const largest = winners.length ? winners.reduce((a, b) => (b.gross > a.gross ? b : a)) : null

  return {
    grossRealizedPnl: gross,
    totalCommissions: fees,
    netRealizedPnl: net,
    fillCount,
    forcedCloses,
    roundTrips,
    startingQuote,
    endingQuote,
    startFlat,
    endFlat,
    reconciliationOk,
    largestGrossWinningRoundTrip: largest,
    inScopeRecordCount,
  }

  /** Gross realised for a sell against FIFO lots (does not mutate). Buys return 0. */
  function matchGross(r: LedgerRecord, lotsIn: { qty: bigint; price: bigint }[]): bigint {
    if (r.side !== 'sell') return 0n
    let remaining = parseFixed(r.qty!)
    const price = parseFixed(r.price!)
    let g = 0n
    for (const lot of lotsIn) {
      if (remaining === 0n) break
      const take = lot.qty < remaining ? lot.qty : remaining
      g += mulExact(take, price) - mulExact(take, lot.price)
      remaining -= take
    }
    if (remaining !== 0n) throw new Error(`sell ${r.eventId} exceeds open lots (short selling is not supported)`)
    return g
  }

  /** Apply a record to the FIFO lot book; returns new position. Mutates `lotsIn`. */
  function applyLots(r: LedgerRecord, lotsIn: { qty: bigint; price: bigint }[]): bigint {
    const qty = parseFixed(r.qty!)
    const price = parseFixed(r.price!)
    if (r.side === 'buy') {
      lotsIn.push({ qty, price })
    } else {
      let remaining = qty
      while (remaining > 0n) {
        const lot = lotsIn[0]
        if (!lot) throw new Error(`sell ${r.eventId} exceeds open lots`)
        if (lot.qty <= remaining) {
          remaining -= lot.qty
          lotsIn.shift()
        } else {
          lot.qty -= remaining
          remaining = 0n
        }
      }
    }
    return lotsIn.reduce((s, l) => s + l.qty, 0n)
  }
}

export interface AccountingSummary {
  grossRealizedPnl: string
  totalCommissions: string
  netRealizedPnl: string
  fillCount: number
  completedRoundTrips: number
  forcedCloses: number
  startingQuote: string
  endingQuote: string
  largestGrossWinningRoundTrip: { gross: string; openedEventId: string; closedEventId: string } | null
  funding: 'not-applicable'
  reconciliation: 'ok' | 'mismatch'
}

export function summarize(a: AccountingResult): AccountingSummary {
  const w = a.largestGrossWinningRoundTrip
  return {
    grossRealizedPnl: formatFixed(a.grossRealizedPnl),
    totalCommissions: formatFixed(a.totalCommissions),
    netRealizedPnl: formatFixed(a.netRealizedPnl),
    fillCount: a.fillCount,
    completedRoundTrips: a.roundTrips.length,
    forcedCloses: a.forcedCloses,
    startingQuote: formatFixed(a.startingQuote),
    endingQuote: formatFixed(a.endingQuote),
    largestGrossWinningRoundTrip: w ? { gross: formatFixed(w.gross), openedEventId: w.openedEventId, closedEventId: w.closedEventId } : null,
    funding: 'not-applicable',
    reconciliation: a.reconciliationOk ? 'ok' : 'mismatch',
  }
}
