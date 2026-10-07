/**
 * Strategy contract. A strategy sees ONLY the past and present through MarketView.
 * It never receives the series, future events, or its own realised PnL.
 */
export interface MarketView {
  /** current event sequence */
  readonly seq: number
  readonly ts: string
  /** current price (8-dp scaled) */
  readonly price: bigint
  /** price at an earlier event; throws if i > seq (future) or i < 0 */
  priceAt(i: number): bigint
  /** simple moving average over the last n events incl. current; null if not enough history */
  sma(n: number): bigint | null
  /** current base position (8-dp scaled) */
  readonly position: bigint
  /** current quote cash (8-dp scaled) */
  readonly cash: bigint
}

export type OrderIntent =
  | { side: 'buy'; quoteNotional: bigint; tag?: string }
  | { side: 'sell'; qty: bigint | 'all'; tag?: string }

export interface Strategy {
  id: string
  name: string
  /** Published entry/exit rules, shown on the public profile. */
  rules: string[]
  decide(view: MarketView): OrderIntent | null
  /** Optional reset between runs. */
  reset?(): void
}
