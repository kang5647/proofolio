import type { MarketView, OrderIntent, Strategy } from './types.ts'
import { SCALE } from '../../packages/accounting/src/fixed.ts'

/**
 * Bot B — "MeanRev-30".
 * Entry: flat, and price is at least 2.5% below SMA(30).
 * Exit:  long, and price >= SMA(30) (target) OR price <= entry * (1 - 6%) (stop).
 * Size:  each entry spends 30% of starting cash (3,000 USDT notional); never pyramids.
 * No leverage, no shorts.
 */
export class MeanReversionStrategy implements Strategy {
  id = 'bot-b-meanrev-30'
  name = 'Bot B · MeanRev-30'
  rules = [
    'Enter long when flat and price is at least 2.5% below the 30-event SMA.',
    'Exit when price returns to the 30-event SMA, or falls 6% below entry.',
    'Fixed 3,000 USDT notional per entry; one position at a time; spot only.',
  ]
  private entryPrice: bigint | null = null
  private readonly notional = 3000n * SCALE
  reset() {
    this.entryPrice = null
  }
  decide(v: MarketView): OrderIntent | null {
    const sma = v.sma(30)
    if (sma === null) return null
    if (v.position === 0n) {
      this.entryPrice = null
      if (v.price * 1000n <= sma * 975n) {
        this.entryPrice = v.price
        return { side: 'buy', quoteNotional: this.notional, tag: 'below-sma-2.5pct' }
      }
      return null
    }
    if (v.price >= sma) return { side: 'sell', qty: 'all', tag: 'target-sma' }
    if (this.entryPrice !== null && v.price * 100n <= this.entryPrice * 94n) return { side: 'sell', qty: 'all', tag: 'stop-6pct' }
    return null
  }
}
