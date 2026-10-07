/**
 * Buyer-side certificate validation. Deterministic; no LLM involved.
 * Checks: digest recomputation, on-chain receipt binding, scope match against the
 * request the buyer asked for, expiry, provenance/mode labels, result consistency.
 */
import type { Hex } from 'viem'
import { certificateDigest, CERTIFICATE_VERSION, type Certificate } from '../../../packages/accounting/src/certificate.ts'
import { parseFixed } from '../../../packages/accounting/src/fixed.ts'
import type { ReceiptChain } from '../../../services/verifier/src/chain.ts'

export interface ExpectedScope {
  runId: string
  accountCommitment: Hex
  market: string
  intervalStart: string
  intervalEnd: string
  buyerAddress: Hex
  methodologyVersion: string
}

export interface EvidenceCheck {
  evidence: 'VALID' | 'INVALID'
  checks: { name: string; ok: boolean; detail: string }[]
}

export async function validateCertificate(cert: Certificate, expected: ExpectedScope, chain: ReceiptChain, now = new Date()): Promise<EvidenceCheck> {
  const checks: EvidenceCheck['checks'] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  add('schema', cert.version === CERTIFICATE_VERSION, `version=${cert.version}`)
  const digest = certificateDigest(cert)
  add('scope.runId', cert.runId === expected.runId, `${cert.runId}`)
  add('scope.accountCommitment', cert.accountCommitment.toLowerCase() === expected.accountCommitment.toLowerCase(), cert.accountCommitment.slice(0, 18) + '…')
  add('scope.market', cert.market === expected.market, cert.market)
  add('scope.interval', cert.intervalStart === expected.intervalStart && cert.intervalEnd === expected.intervalEnd, `[${cert.intervalStart}, ${cert.intervalEnd})`)
  add('scope.buyer', cert.buyer.toLowerCase() === expected.buyerAddress.toLowerCase(), cert.buyer)
  add('scope.methodology', cert.methodologyVersion === expected.methodologyVersion, cert.methodologyVersion)
  add('expiry', Date.parse(cert.expiresAt) > now.getTime(), `expires ${cert.expiresAt}`)
  add('provenance.labelled', cert.dataProvenance === 'simulated-market', `dataProvenance=${cert.dataProvenance}`)
  add('mode.labelled', ['local-simulation', 'deployed-confidential'].includes(cert.executionMode), `executionMode=${cert.executionMode} engine=${cert.executionEngine}`)

  // On-chain receipt: request must exist, receipt must bind this exact digest, request not expired.
  try {
    const req = await chain.getRequest(cert.requestId)
    add('chain.request', req.committedAt !== 0n, `request committed at ${req.committedAt}`)
    add('chain.request.nonce', req.nonce === cert.nonce, 'nonce bound')
    add('chain.request.buyer', req.buyer.toLowerCase() === expected.buyerAddress.toLowerCase(), req.buyer)
    const v = await chain.verifyReceipt(cert.requestId, digest)
    add('chain.receipt', v.ok, v.ok ? `receipt binds digest ${digest.slice(0, 18)}…` : v.reason)
  } catch (e) {
    add('chain.receipt', false, `chain read failed: ${(e as Error).message.slice(0, 120)}`)
  }

  // Internal consistency of a VERIFIED result.
  if (cert.status === 'VERIFIED') {
    const r = cert.result
    if (!r) add('result.present', false, 'VERIFIED without result')
    else {
      const gross = parseFixed(r.grossRealizedPnl)
      const fees = parseFixed(r.totalCommissions)
      const net = parseFixed(r.netRealizedPnl)
      add('result.net=gross-fees', gross - fees === net, `${r.grossRealizedPnl} - ${r.totalCommissions} = ${r.netRealizedPnl}`)
      add('result.reconciled', r.reconciliation === 'ok' && parseFixed(r.endingQuote) - parseFixed(r.startingQuote) === net, `ending-starting = net`)
      add('result.boundaries', cert.boundaryStatus.startFlat && cert.boundaryStatus.endFlat && cert.completeness === 'complete', `complete=${cert.completeness}`)
    }
  } else {
    add('result.absent', cert.result === null, 'UNVERIFIABLE carries no financial result')
  }
  return { evidence: checks.every((c) => c.ok) ? 'VALID' : 'INVALID', checks }
}

export type Decision = 'SHORTLIST' | 'DECLINE' | 'INSUFFICIENT_EVIDENCE'

/** Deterministic decision rule. Evidence first, then the scoped net result. Not investment advice. */
export function decide(cert: Certificate | null, evidence: EvidenceCheck | null): { decision: Decision; rule: string } {
  if (!cert || !evidence || evidence.evidence !== 'VALID') return { decision: 'INSUFFICIENT_EVIDENCE', rule: 'certificate missing or failed buyer validation' }
  if (cert.status !== 'VERIFIED' || !cert.result) return { decision: 'INSUFFICIENT_EVIDENCE', rule: `verifier returned ${cert.status}: ${cert.reasons.join('; ')}` }
  const net = parseFixed(cert.result.netRealizedPnl)
  if (net > 0n) return { decision: 'SHORTLIST', rule: `scoped net realised PnL ${cert.result.netRealizedPnl} > 0 after ${cert.result.totalCommissions} fees over ${cert.result.fillCount} fills` }
  return { decision: 'DECLINE', rule: `scoped net realised PnL ${cert.result.netRealizedPnl} <= 0 after fees` }
}
