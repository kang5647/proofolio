/**
 * Verification adapters turn a public, typed claim into the scoped input that
 * the verifier and CRE workflow can independently check.  They deliberately
 * do not execute caller-supplied code: each adapter owns its own safe logic.
 */
import { isAddress, type Address, type Hex } from 'viem'
import { MARKET } from '../../../packages/accounting/src/index.ts'
import type { JobInput } from './engine.ts'

export interface AgentIdentity {
  id: string
  name?: string
}

export interface VerificationClaim {
  version: 'proofolio-claim/1'
  agent: AgentIdentity
  claimType: 'trading-performance'
  scope: {
    runId: string
    accountCommitment: Hex
    market: string
    intervalStart: string
    intervalEnd: string
  }
  claimedOutput: { metric: 'net-realized-pnl' | 'largest-gross-winning-round-trip'; value: string; unit: 'USDT' }
  acceptanceCriteria: string[]
  /** Opaque public locator only. Credentials and records never appear here. */
  privateEvidenceRef: string
  expiresAt: string
}

export interface VerificationAdapter<C extends VerificationClaim = VerificationClaim> {
  readonly claimType: C['claimType']
  parse(raw: unknown): C
  toEngineInput(claim: C, buyerAddress: Address): JobInput
}

const required = (v: unknown, label: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} is required`)
  return v
}

export const TradingPerformanceAdapter: VerificationAdapter = {
  claimType: 'trading-performance',
  parse(raw: any): VerificationClaim {
    if (raw?.version !== 'proofolio-claim/1') throw new Error('claim.version must be proofolio-claim/1')
    if (raw?.claimType !== 'trading-performance') throw new Error('only trading-performance is currently supported')
    const scope = raw.scope ?? {}
    const claim: VerificationClaim = {
      version: raw.version,
      agent: { id: required(raw.agent?.id, 'claim.agent.id'), ...(typeof raw.agent?.name === 'string' ? { name: raw.agent.name } : {}) },
      claimType: raw.claimType,
      scope: {
        runId: required(scope.runId, 'claim.scope.runId'),
        accountCommitment: required(scope.accountCommitment, 'claim.scope.accountCommitment') as Hex,
        market: required(scope.market, 'claim.scope.market'),
        intervalStart: required(scope.intervalStart, 'claim.scope.intervalStart'),
        intervalEnd: required(scope.intervalEnd, 'claim.scope.intervalEnd'),
      },
      claimedOutput: { metric: raw.claimedOutput?.metric, value: required(raw.claimedOutput?.value, 'claim.claimedOutput.value'), unit: raw.claimedOutput?.unit },
      acceptanceCriteria: Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()) : [],
      privateEvidenceRef: required(raw.privateEvidenceRef, 'claim.privateEvidenceRef'),
      expiresAt: required(raw.expiresAt, 'claim.expiresAt'),
    }
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(claim.scope.runId)) throw new Error('claim.scope.runId has invalid characters')
    if (!/^0x[0-9a-fA-F]{64}$/.test(claim.scope.accountCommitment)) throw new Error('claim.scope.accountCommitment must be 0x + 64 hex')
    if (claim.scope.market !== MARKET) throw new Error(`claim.scope.market must be ${MARKET}`)
    if (!['net-realized-pnl', 'largest-gross-winning-round-trip'].includes(claim.claimedOutput.metric)) throw new Error('unsupported claimedOutput.metric')
    if (claim.claimedOutput.unit !== 'USDT') throw new Error('claimedOutput.unit must be USDT')
    if (!claim.acceptanceCriteria.length) throw new Error('claim.acceptanceCriteria must contain at least one rule')
    for (const k of ['intervalStart', 'intervalEnd'] as const) if (Number.isNaN(Date.parse(claim.scope[k]))) throw new Error(`claim.scope.${k} must be ISO-8601`)
    if (Date.parse(claim.scope.intervalStart) >= Date.parse(claim.scope.intervalEnd)) throw new Error('claim scope interval must be non-empty')
    if (Number.isNaN(Date.parse(claim.expiresAt)) || Date.parse(claim.expiresAt) <= Date.now()) throw new Error('claim.expiresAt must be in the future')
    return claim
  },
  toEngineInput(claim, buyerAddress) {
    if (!isAddress(buyerAddress)) throw new Error('buyerAddress invalid')
    return { ...claim.scope, buyerAddress }
  },
}

export const adapters: Record<VerificationClaim['claimType'], VerificationAdapter> = {
  'trading-performance': TradingPerformanceAdapter,
}

export function parseClaim(raw: unknown): VerificationClaim {
  const type = (raw as any)?.claimType
  const adapter = adapters[type as keyof typeof adapters]
  if (!adapter) throw new Error(`unsupported claimType ${String(type)}; available: trading-performance`)
  return adapter.parse(raw)
}
