import type { MarketView, OrderIntent, Strategy } from './types.ts'
import { SCALE } from '../../packages/accounting/src/fixed.ts'

/**
 * Bot A — "Momentum-20".
 * Entry: flat, and price crosses above SMA(20) (previous event at/below SMA, current above).
 * Exit:  long, and price closes below SMA(20) OR price <= entry * (1 - 4%) (stop).
 * Size:  each entry spends 40% of starting cash (4,000 USDT notional); never pyramids.
 * No leverage, no shorts.
 */
export class MomentumStrategy implements Strategy {
  id = 'bot-a-momentum-20'
  name = 'Bot A · Momentum-20'
  rules = [
    'Enter long when flat and price crosses above the 20-event SMA.',
    'Exit when price closes below the 20-event SMA, or falls 4% below entry.',
    'Fixed 4,000 USDT notional per entry; one position at a time; spot only.',
  ]
  private entryPrice: bigint | null = null
  private readonly notional = 4000n * SCALE
  reset() {
    this.entryPrice = null
  }
  decide(v: MarketView): OrderIntent | null {
    const sma = v.sma(20)
    if (sma === null) return null
    if (v.position === 0n) {
      this.entryPrice = null
      if (v.seq < 1) return null
      const prev = v.priceAt(v.seq - 1)
      if (prev <= sma && v.price > sma) {
        this.entryPrice = v.price
        return { side: 'buy', quoteNotional: this.notional, tag: 'sma-cross-up' }
      }
      return null
    }
    const stop = this.entryPrice !== null && v.price * 100n <= this.entryPrice * 96n
    if (v.price < sma) return { side: 'sell', qty: 'all', tag: 'sma-cross-down' }
    if (stop) return { side: 'sell', qty: 'all', tag: 'stop-4pct' }
    return null
  }
}
