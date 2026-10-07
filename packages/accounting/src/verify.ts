/**
 * Scope + completeness verification over fetched source pages, then accounting.
 * Pure: used identically by the Node verifier (local fallback) and the CRE workflow.
 */
import type { LedgerRecord, SourcePage } from './ledger.ts'
import { computeAccounting, summarize, type AccountingSummary } from './accounting.ts'

export interface RequestScope {
  runId: string
  accountCommitment: `0x${string}`
  market: string
  intervalStart: string
  intervalEnd: string
  methodologyVersion: string
}

export interface VerificationOutcome {
  status: 'VERIFIED' | 'UNVERIFIABLE'
  reasons: string[]
  recordCount: number
  completeness: 'complete' | 'incomplete'
  boundaryStatus: { startFlat: boolean; endFlat: boolean }
  sourceAsOf: string | null
  result: AccountingSummary | null
}

/**
 * Validate the page chain and assemble ordered records.
 * Returns reasons for every defect found (never throws on data defects).
 */
export function assembleRecords(pages: SourcePage[], scope: RequestScope): { records: LedgerRecord[]; reasons: string[]; sourceAsOf: string | null; declaredCount: number } {
  const reasons: string[] = []
  if (pages.length === 0) return { records: [], reasons: ['no pages fetched'], sourceAsOf: null, declaredCount: 0 }
  const head = pages[0]
  if (head.runId !== scope.runId) reasons.push(`run mismatch: source=${head.runId} request=${scope.runId}`)
  if (head.accountCommitment.toLowerCase() !== scope.accountCommitment.toLowerCase()) reasons.push('account commitment mismatch')
  if (head.market !== scope.market) reasons.push(`market mismatch: source=${head.market} request=${scope.market}`)
  if (head.methodologyVersion !== scope.methodologyVersion) reasons.push(`methodology mismatch: source=${head.methodologyVersion} request=${scope.methodologyVersion}`)
  // Request interval must lie within the run's declared boundaries.
  if (Date.parse(scope.intervalStart) < Date.parse(head.intervalStart) || Date.parse(scope.intervalEnd) > Date.parse(head.intervalEnd)) {
    reasons.push('requested interval outside declared run boundaries')
  }
  if (Date.parse(scope.intervalStart) >= Date.parse(scope.intervalEnd)) reasons.push('empty or inverted interval')

  // Page chain: indexes contiguous, cursors link, exactly one final page at the end.
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]
    if (p.pageIndex !== i) reasons.push(`page index gap: expected ${i} got ${p.pageIndex}`)
    if (p.runId !== head.runId) reasons.push(`page ${i} belongs to another run`)
    if (p.sourceAsOf !== head.sourceAsOf) reasons.push(`page ${i} sourceAsOf differs`)
    const isLast = i === pages.length - 1
    if (isLast && !p.final) reasons.push('last fetched page is not marked final (missing pages)')
    if (!isLast && p.final) reasons.push(`page ${i} marked final but more pages followed`)
    if (!isLast && p.nextCursor !== pages[i + 1].cursor) reasons.push(`cursor chain broken at page ${i}`)
  }

  const records: LedgerRecord[] = []
  const seen = new Set<string>()
  let lastSeq = -1
  for (const p of pages) {
    for (const r of p.records) {
      if (seen.has(r.eventId)) {
        reasons.push(`duplicate event ${r.eventId}`)
        continue
      }
      seen.add(r.eventId)
      if (r.seq < lastSeq) reasons.push(`out-of-order event ${r.eventId}`)
      lastSeq = r.seq
      records.push(r)
    }
  }
  if (records.length !== head.recordCount) reasons.push(`record count mismatch: declared ${head.recordCount}, received ${records.length}`)
  if (!records.some((r) => r.kind === 'start')) reasons.push('missing start boundary record')
  if (!records.some((r) => r.kind === 'end')) reasons.push('missing end boundary record')
  return { records, reasons, sourceAsOf: head.sourceAsOf, declaredCount: head.recordCount }
}

export function verifyRun(pages: SourcePage[], scope: RequestScope): VerificationOutcome {
  const { records, reasons, sourceAsOf } = assembleRecords(pages, scope)
  const base = {
    recordCount: records.length,
    sourceAsOf,
  }
  if (reasons.length) {
    return { status: 'UNVERIFIABLE', reasons, completeness: 'incomplete', boundaryStatus: { startFlat: false, endFlat: false }, result: null, ...base }
  }
  let acct
  try {
    acct = computeAccounting(records, { intervalStart: scope.intervalStart, intervalEnd: scope.intervalEnd })
  } catch (e) {
    return { status: 'UNVERIFIABLE', reasons: [`accounting error: ${(e as Error).message}`], completeness: 'complete', boundaryStatus: { startFlat: false, endFlat: false }, result: null, ...base }
  }
  const boundaryStatus = { startFlat: acct.startFlat, endFlat: acct.endFlat }
  const problems: string[] = []
  if (!acct.startFlat) problems.push('position not flat at interval start')
  if (!acct.endFlat) problems.push('position not flat at interval end')
  if (acct.startFlat && acct.endFlat && !acct.reconciliationOk) problems.push('balance reconciliation failed')
  if (problems.length) {
    return { status: 'UNVERIFIABLE', reasons: problems, completeness: 'complete', boundaryStatus, result: null, ...base }
  }
  return { status: 'VERIFIED', reasons: [], completeness: 'complete', boundaryStatus, result: summarize(acct), ...base }
}
