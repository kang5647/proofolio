/**
 * Event-driven simulated spot market. The simulator owns fills and balances.
 *
 * Execution rules (documented, deterministic):
 *  - Fill price = the current event's price (declared simulated execution price).
 *  - Quantity step 0.0001 base; buy qty = floor(notional / price) to the step.
 *  - Fee = notional * feeBps / 10_000, rounded half-up to 8 dp, charged in quote.
 *  - Buy requires cash >= notional + fee; sell requires position >= qty. Otherwise rejected
 *    and recorded as a `reject` with a reason. Shorting and leverage are impossible.
 *  - At the last event, any open position is force-closed at that event's price under
 *    the same fee schedule and recorded as `forced_close`.
 *  - Every record carries a unique eventId `${runId}:${seq}:${n}`.
 *  - The strategy only ever sees a MarketView bounded to the current event.
 */
import { formatFixed, floorToStep, mulExact, mulRoundHalfUp, SCALE } from '../../packages/accounting/src/fixed.ts'
import { MARKET, METHODOLOGY_VERSION, SOURCE_VERSION, type LedgerRecord, type RunMeta } from '../../packages/accounting/src/ledger.ts'
import { sha256Utf8 } from '../../packages/accounting/src/canonical.ts'
import type { MarketView, Strategy } from '../../bots/src/types.ts'
import type { MarketEvent } from './series.ts'

export const QTY_STEP = 10_000n // 0.0001 in 8-dp units
export const DEFAULT_FEE_BPS = 10 // 0.10%
export const DEFAULT_STARTING_QUOTE = 10_000n * SCALE

export interface RunOptions {
  runId: string
  accountId: string
  startingQuote?: bigint
  feeBps?: number
  seed: string
}

export interface RunResult {
  meta: RunMeta
  records: LedgerRecord[]
}

export function accountCommitment(runId: string, accountId: string): `0x${string}` {
  return sha256Utf8(`proofdesk-account-commitment/1|${runId}|${accountId}`)
}

class BoundedView implements MarketView {
  constructor(
    private readonly events: readonly MarketEvent[],
    readonly seq: number,
    readonly position: bigint,
    readonly cash: bigint,
  ) {}
  get ts() {
    return this.events[this.seq].ts
  }
  get price() {
    return this.events[this.seq].price
  }
  priceAt(i: number): bigint {
    if (!Number.isInteger(i) || i < 0 || i > this.seq) throw new Error(`priceAt(${i}) is outside the visible history [0, ${this.seq}]`)
    return this.events[i].price
  }
  sma(n: number): bigint | null {
    if (n <= 0 || this.seq + 1 < n) return null
    let s = 0n
    for (let i = this.seq - n + 1; i <= this.seq; i++) s += this.events[i].price
    return s / BigInt(n)
  }
}

export function runBot(strategy: Strategy, events: MarketEvent[], opts: RunOptions): RunResult {
  if (events.length === 0) throw new Error('empty series')
  const feeBps = opts.feeBps ?? DEFAULT_FEE_BPS
  let cash = opts.startingQuote ?? DEFAULT_STARTING_QUOTE
  const startingQuote = cash
  let position = 0n
  const records: LedgerRecord[] = []
  let n = 0
  const rec = (seq: number, partial: Omit<LedgerRecord, 'eventId' | 'seq' | 'ts' | 'cashAfter' | 'positionAfter'>) => {
    records.push({ eventId: `${opts.runId}:${seq}:${n++}`, seq, ts: events[seq].ts, cashAfter: formatFixed(cash), positionAfter: formatFixed(position), ...partial })
  }
  const fee = (notional: bigint) => mulRoundHalfUp(notional, BigInt(feeBps), 10_000n)

  strategy.reset?.()
  rec(0, { kind: 'start' })

  const execute = (seq: number, side: 'buy' | 'sell', qty: bigint, kind: 'fill' | 'forced_close', reason?: string) => {
    const price = events[seq].price
    const notional = mulExact(qty, price)
    const f = fee(notional)
    if (side === 'buy') {
      if (qty <= 0n) return rec(seq, { kind: 'reject', side, reason: 'quantity rounds to zero' })
      if (cash < notional + f) return rec(seq, { kind: 'reject', side, qty: formatFixed(qty), price: formatFixed(price), reason: 'insufficient quote balance' })
      cash -= notional + f
      position += qty
    } else {
      if (qty <= 0n) return rec(seq, { kind: 'reject', side, reason: 'nothing to sell' })
      if (position < qty) return rec(seq, { kind: 'reject', side, qty: formatFixed(qty), price: formatFixed(price), reason: 'insufficient base position (no short selling)' })
      cash += notional - f
      position -= qty
    }
    rec(seq, { kind, side, qty: formatFixed(qty), price: formatFixed(price), notional: formatFixed(notional), fee: formatFixed(f), reason })
  }

  const last = events.length - 1
  for (let seq = 0; seq < events.length; seq++) {
    // The last event is reserved for the documented forced close; strategies cannot open there.
    if (seq === last) break
    const view = new BoundedView(events, seq, position, cash)
    const intent = strategy.decide(view)
    if (!intent) continue
    if (intent.side === 'buy') {
      const qty = floorToStep((intent.quoteNotional * SCALE) / events[seq].price, QTY_STEP)
      execute(seq, 'buy', qty, 'fill', intent.tag)
    } else {
      const qty = intent.qty === 'all' ? position : intent.qty
      execute(seq, 'sell', qty, 'fill', intent.tag)
    }
  }
  if (position > 0n) execute(last, 'sell', position, 'forced_close', 'run boundary: forced close at last event')
  rec(last, { kind: 'end' })

  const meta: RunMeta = {
    runId: opts.runId,
    accountId: opts.accountId,
    accountCommitment: accountCommitment(opts.runId, opts.accountId),
    market: MARKET,
    sourceVersion: SOURCE_VERSION,
    methodologyVersion: METHODOLOGY_VERSION,
    strategyId: strategy.id,
    intervalStart: events[0].ts,
    // end-exclusive: one interval past the last event
    intervalEnd: new Date(Date.parse(events[last].ts) + (Date.parse(events[1].ts) - Date.parse(events[0].ts))).toISOString(),
    startingQuote: formatFixed(startingQuote),
    feeBps,
    seed: opts.seed,
    dataProvenance: 'simulated-market',
    recordCount: records.length,
    orderedEventIds: records.map((r) => r.eventId),
    generatedAt: new Date().toISOString(),
  }
  return { meta, records }
}
