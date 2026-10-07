/**
 * Payment providers.
 *  - MasumiPaymentProvider: talks to a Masumi Payment Service (MPS) instance over its REST API.
 *    Seller side: POST /payment (create request), GET /payment (poll on-chain state), POST /payment/submit-result.
 *  - MockPaymentProvider: LOCAL DEVELOPMENT ONLY. No chain, no money. Clearly labelled everywhere.
 */
export interface PaymentTerms {
  blockchainIdentifier: string
  payByTime: number // unix seconds
  submitResultTime: number
  unlockTime: number
  externalDisputeUnlockTime: number
  agentIdentifier: string
  sellerVkey: string
}

export interface PaymentSnapshot {
  onChainState: string | null // Masumi OnChainState or mock equivalent
  nextAction: string | null
  resultHash: string | null
  txFundsLocked: string | null
  txResultSubmitted: string | null
  txWithdrawn: string | null
  raw?: unknown
}

export interface Quote {
  mode: 'masumi' | 'mock'
  pricingType: string
  amounts: { amount: string; unit: string; display: string }[]
  network: string
  agentIdentifier: string | null
  agentName?: string | null
  source: string
}

export interface PaymentProvider {
  readonly mode: 'masumi' | 'mock'
  quote(): Promise<Quote>
  createPaymentRequest(args: { inputHash: string; identifierFromPurchaser: string; metadata?: string }): Promise<PaymentTerms>
  snapshot(blockchainIdentifier: string): Promise<PaymentSnapshot>
  submitResult(blockchainIdentifier: string, resultHashHex64: string): Promise<void>
}

export const TUSDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d'

export function displayAmount(amount: string, unit: string): string {
  if (unit === '' || unit === 'lovelace') return `${(Number(amount) / 1e6).toFixed(6)} tADA`
  if (unit === TUSDM_UNIT) return `${(Number(amount) / 1e6).toFixed(6)} tUSDM`
  return `${amount} ${unit.slice(0, 12)}…`
}

// ─── Masumi ─────────────────────────────────────────────────
export interface MasumiConfig {
  baseUrl: string // e.g. http://127.0.0.1:3001/api/v1
  apiKey: string
  network: 'Preprod' | 'Mainnet'
  agentIdentifier: string
  sellerVkey: string
  payByMinutes: number
  submitResultMinutes: number
  /** escrow unlock (seller payout) and external-dispute deadlines, in minutes after submitResultTime */
  unlockAfterSubmitMinutes: number
  disputeAfterSubmitMinutes: number
}

export class MasumiPaymentProvider implements PaymentProvider {
  readonly mode = 'masumi' as const
  constructor(readonly cfg: MasumiConfig) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', accept: 'application/json', token: this.cfg.apiKey, ...(init.headers ?? {}) },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`MPS ${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
    const body = JSON.parse(text)
    return (body?.data ?? body) as T
  }

  async quote(): Promise<Quote> {
    // Query the minted NFT directly. The paginated registry endpoint is backed by
    // MPS's local index and can briefly omit a newly confirmed registration.
    const agent = await this.call<any>(
      `/registry/agent-identifier/?network=${this.cfg.network}&agentIdentifier=${encodeURIComponent(this.cfg.agentIdentifier)}`,
    )
    const metadata = agent?.Metadata ?? agent
    const source = (metadata?.supportedPaymentSources ?? []).find(
      (candidate: any) => candidate?.chain === 'Cardano' && candidate?.network === this.cfg.network,
    ) ?? metadata?.supportedPaymentSources?.[0]
    const pricing = source?.pricing ?? metadata?.AgentPricing
    const entries = pricing?.fixed ?? pricing?.Pricing ?? []
    const amounts = entries.map((p: any) => {
      const amount = String(p.amount)
      const unit = p.asset ?? p.unit ?? ''
      return { amount, unit, display: displayAmount(amount, unit) }
    })
    return {
      mode: 'masumi',
      pricingType: pricing?.pricingType ?? 'unknown',
      amounts,
      network: this.cfg.network,
      agentIdentifier: this.cfg.agentIdentifier,
      agentName: metadata?.name ?? null,
      source: 'Masumi on-chain registry metadata',
    }
  }

  async createPaymentRequest(args: { inputHash: string; identifierFromPurchaser: string; metadata?: string }): Promise<PaymentTerms> {
    // MIP-003 exposes these deadlines as whole Unix seconds. Sign whole-second
    // millisecond values so the buyer can reconstruct the exact signed terms.
    const now = Math.floor(Date.now() / 1000) * 1000
    const payBy = new Date(now + this.cfg.payByMinutes * 60_000)
    const submitBy = new Date(now + this.cfg.submitResultMinutes * 60_000)
    const unlock = new Date(submitBy.getTime() + this.cfg.unlockAfterSubmitMinutes * 60_000)
    const dispute = new Date(submitBy.getTime() + this.cfg.disputeAfterSubmitMinutes * 60_000)
    const p = await this.call<any>('/payment/', {
      method: 'POST',
      body: JSON.stringify({
        inputHash: args.inputHash,
        network: this.cfg.network,
        agentIdentifier: this.cfg.agentIdentifier,
        paymentSourceType: 'Web3CardanoV2',
        supportedPaymentSourceIndex: 0,
        // Omit RequestedFunds for fixed pricing; MPS resolves it from the
        // selected V2 registry payment source.
        payByTime: payBy.toISOString(),
        submitResultTime: submitBy.toISOString(),
        unlockTime: unlock.toISOString(),
        externalDisputeUnlockTime: dispute.toISOString(),
        identifierFromPurchaser: args.identifierFromPurchaser,
        metadata: args.metadata,
      }),
    })
    const toSec = (v: any) => Math.floor(new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v).getTime() / 1000)
    return {
      blockchainIdentifier: p.blockchainIdentifier,
      payByTime: toSec(p.payByTime),
      submitResultTime: toSec(p.submitResultTime),
      unlockTime: toSec(p.unlockTime),
      externalDisputeUnlockTime: toSec(p.externalDisputeUnlockTime),
      agentIdentifier: this.cfg.agentIdentifier,
      sellerVkey: this.cfg.sellerVkey,
    }
  }

  async snapshot(blockchainIdentifier: string): Promise<PaymentSnapshot> {
    const res = await this.call<{ Payments: any[] }>(
      `/payment/?network=${this.cfg.network}&filterPaymentSourceType=Web3CardanoV2&limit=100&includeHistory=true`,
    )
    const p = (res.Payments ?? []).find((x: any) => x.blockchainIdentifier === blockchainIdentifier)
    if (!p) return { onChainState: null, nextAction: null, resultHash: null, txFundsLocked: null, txResultSubmitted: null, txWithdrawn: null }
    const hist: any[] = p.TransactionHistory ?? []
    const findTx = (states: string[]) => hist.find((t) => states.includes(t.status) || states.includes(t.onChainState))?.txHash ?? null
    const cur = p.CurrentTransaction?.txHash ?? null
    return {
      onChainState: p.onChainState ?? null,
      nextAction: p.NextAction?.requestedAction ?? null,
      resultHash: p.NextAction?.resultHash ?? p.resultHash ?? null,
      txFundsLocked: findTx(['FundsLocked']) ?? (p.onChainState === 'FundsLocked' ? cur : null),
      txResultSubmitted: findTx(['ResultSubmitted']) ?? (p.onChainState === 'ResultSubmitted' ? cur : null),
      txWithdrawn: findTx(['Withdrawn']) ?? (p.onChainState === 'Withdrawn' ? cur : null),
      raw: { onChainState: p.onChainState, NextAction: p.NextAction, CurrentTransaction: p.CurrentTransaction, TransactionHistory: hist },
    }
  }

  async submitResult(blockchainIdentifier: string, resultHashHex64: string): Promise<void> {
    await this.call('/payment/submit-result/', { method: 'POST', body: JSON.stringify({ network: this.cfg.network, blockchainIdentifier, submitResultHash: resultHashHex64 }) })
  }
}

// ─── Mock (local development only) ──────────────────────────
export class MockPaymentProvider implements PaymentProvider {
  readonly mode = 'mock' as const
  private readonly state = new Map<string, { created: number; locked: boolean; resultHash: string | null }>()

  async quote(): Promise<Quote> {
    return { mode: 'mock', pricingType: 'Fixed', amounts: [{ amount: '1000000', unit: TUSDM_UNIT, display: displayAmount('1000000', TUSDM_UNIT) + ' (MOCK — no payment moves)' }], network: 'mock', agentIdentifier: null, source: 'mock provider (local development only)' }
  }
  async createPaymentRequest(args: { inputHash: string; identifierFromPurchaser: string }): Promise<PaymentTerms> {
    const id = `mock-${args.identifierFromPurchaser}-${args.inputHash.slice(0, 12)}`
    const now = Math.floor(Date.now() / 1000)
    if (!this.state.has(id)) this.state.set(id, { created: Date.now(), locked: false, resultHash: null })
    return { blockchainIdentifier: id, payByTime: now + 600, submitResultTime: now + 1800, unlockTime: now + 1800 + 21600, externalDisputeUnlockTime: now + 1800 + 43200, agentIdentifier: 'mock-agent', sellerVkey: 'mock-seller-vkey' }
  }
  /** Explicit "buyer paid" action used by the buyer agent in mock mode. */
  mockLock(id: string): boolean {
    const s = this.state.get(id) ?? { created: Date.now(), locked: false, resultHash: null }
    s.locked = true
    this.state.set(id, s)
    return true
  }
  async snapshot(id: string): Promise<PaymentSnapshot> {
    const s = this.state.get(id)
    if (!s) return { onChainState: null, nextAction: null, resultHash: null, txFundsLocked: null, txResultSubmitted: null, txWithdrawn: null }
    const onChainState = !s.locked ? null : s.resultHash ? 'ResultSubmitted' : 'FundsLocked'
    return { onChainState, nextAction: null, resultHash: s.resultHash, txFundsLocked: s.locked ? 'mock-no-tx' : null, txResultSubmitted: s.resultHash ? 'mock-no-tx' : null, txWithdrawn: null }
  }
  async submitResult(id: string, resultHash: string) {
    const s = this.state.get(id)
    if (!s) throw new Error('unknown mock payment')
    s.resultHash = resultHash
  }
}
