import { describe, expect, it } from 'vitest'
import { TradingPerformanceAdapter } from '../services/verifier/src/adapters.ts'

const base = {
  version: 'proofolio-claim/1',
  agent: { id: 'agent-a', name: 'Agent A' },
  claimType: 'trading-performance',
  scope: {
    runId: 'run-demo-a',
    accountCommitment: '0x' + '1'.repeat(64),
    market: 'SIM-SOL/USDT',
    intervalStart: '2026-01-01T00:00:00.000Z',
    intervalEnd: '2026-01-01T01:00:00.000Z',
  },
  claimedOutput: { metric: 'net-realized-pnl', value: '783.78', unit: 'USDT' },
  acceptanceCriteria: ['Evidence covers the declared scope.'],
  privateEvidenceRef: 'authenticated-private-ledger:run-demo-a',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

describe('TradingPerformanceAdapter', () => {
  it('accepts a public claim without private evidence', () => {
    const claim = TradingPerformanceAdapter.parse(base)
    expect(claim.agent.id).toBe('agent-a')
    expect(claim.privateEvidenceRef).toBe('authenticated-private-ledger:run-demo-a')
    expect(TradingPerformanceAdapter.toEngineInput(claim, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8').runId).toBe('run-demo-a')
  })

  it('rejects unsupported adapters and expired claims', () => {
    expect(() => TradingPerformanceAdapter.parse({ ...base, claimType: 'research-evidence' })).toThrow('only trading-performance')
    expect(() => TradingPerformanceAdapter.parse({ ...base, expiresAt: '2020-01-01T00:00:00.000Z' })).toThrow('must be in the future')
  })
})
