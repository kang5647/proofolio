/**
 * ProofDesk certificate: the only financial artifact released to the buyer.
 * Bytes = canonical JSON (canonical.ts); digest = sha256 of those bytes.
 * The receipt written on-chain binds requestId -> certificate digest.
 */
import { encodeAbiParameters, parseAbiParameters, type Hex } from 'viem'
import { canonicalize, digestCanonical } from './canonical.ts'
import type { AccountingSummary } from './accounting.ts'
import type { VerificationOutcome } from './verify.ts'

export const CERTIFICATE_VERSION = 'proofdesk-cert/1'

export type ExecutionMode = 'local-simulation' | 'deployed-confidential'
export type ExecutionEngine = 'cre-simulate' | 'in-process-fallback' | 'cre-deployed'

export interface Certificate {
  version: typeof CERTIFICATE_VERSION
  requestId: Hex
  buyer: Hex
  accountCommitment: Hex
  runId: string
  market: string
  intervalStart: string
  intervalEnd: string
  methodologyVersion: string
  nonce: Hex
  issuedAt: string
  expiresAt: string
  sourceAsOf: string | null
  dataProvenance: 'simulated-market'
  executionMode: ExecutionMode
  executionEngine: ExecutionEngine
  status: 'VERIFIED' | 'UNVERIFIABLE'
  reasons: string[]
  recordCount: number
  completeness: 'complete' | 'incomplete'
  boundaryStatus: { startFlat: boolean; endFlat: boolean }
  result: AccountingSummary | null
  limitations: string[]
}

export const STANDARD_LIMITATIONS = [
  'All prices, fills and balances come from a synthetic simulated market (SIM-SOL/USDT); nothing was executed on an exchange.',
  'Authentication proves access to the ProofDesk demo source, not genuine exchange performance.',
  'The service operator runs the simulator and can inspect its ledger; this is a demo trust boundary, not production privacy.',
  'Only scoped realised PnL is certified. No ROI, Sharpe, drawdown or account-level performance is computed.',
  'Funding is not applicable to this spot-only simulation.',
]

export const STATUS_CODE: Record<Certificate['status'], number> = { VERIFIED: 1, UNVERIFIABLE: 2 }

export interface CertificateInputs {
  requestId: Hex
  buyer: Hex
  accountCommitment: Hex
  runId: string
  market: string
  intervalStart: string
  intervalEnd: string
  methodologyVersion: string
  nonce: Hex
  issuedAt: string
  expiresAt: string
  executionMode: ExecutionMode
  executionEngine: ExecutionEngine
}

export function buildCertificate(inp: CertificateInputs, outcome: VerificationOutcome): Certificate {
  const limitations = [...STANDARD_LIMITATIONS]
  if (inp.executionMode === 'local-simulation') {
    limitations.push('Execution mode is local-simulation: the CRE simulator is not a real TEE and has no DON consensus.')
  }
  return {
    version: CERTIFICATE_VERSION,
    requestId: inp.requestId,
    buyer: inp.buyer,
    accountCommitment: inp.accountCommitment,
    runId: inp.runId,
    market: inp.market,
    intervalStart: inp.intervalStart,
    intervalEnd: inp.intervalEnd,
    methodologyVersion: inp.methodologyVersion,
    nonce: inp.nonce,
    issuedAt: inp.issuedAt,
    expiresAt: inp.expiresAt,
    sourceAsOf: outcome.sourceAsOf,
    dataProvenance: 'simulated-market',
    executionMode: inp.executionMode,
    executionEngine: inp.executionEngine,
    status: outcome.status,
    reasons: outcome.reasons,
    recordCount: outcome.recordCount,
    completeness: outcome.completeness,
    boundaryStatus: outcome.boundaryStatus,
    result: outcome.result,
    limitations,
  }
}

export function certificateBytes(cert: Certificate): string {
  return canonicalize(cert)
}

export function certificateDigest(cert: Certificate): Hex {
  return digestCanonical(cert)
}

/** ABI payload the CRE report carries to ResumeReceipt._processReport. */
export const RECEIPT_ABI = 'bytes32 requestId, bytes32 certDigest, uint8 status, uint64 expiresAt, bytes32 accountCommitment, bytes32 nonce'

export function encodeReceiptPayload(cert: Certificate): Hex {
  return encodeAbiParameters(parseAbiParameters(RECEIPT_ABI), [
    cert.requestId,
    certificateDigest(cert),
    STATUS_CODE[cert.status],
    BigInt(Math.floor(Date.parse(cert.expiresAt) / 1000)),
    cert.accountCommitment,
    cert.nonce,
  ])
}
