/** Deterministic pagination of a run into SourcePages (used by the source API and tests). */
import type { LedgerRecord, RunMeta, SourcePage } from './ledger.ts'

export function cursorFor(runId: string, pageIndex: number): string {
  return `${runId}#p${pageIndex}`
}

export function paginate(meta: RunMeta, records: LedgerRecord[], pageSize: number): SourcePage[] {
  const pages: SourcePage[] = []
  const total = Math.max(1, Math.ceil(records.length / pageSize))
  for (let i = 0; i < total; i++) {
    pages.push({
      runId: meta.runId,
      accountCommitment: meta.accountCommitment,
      market: meta.market,
      sourceVersion: meta.sourceVersion,
      methodologyVersion: meta.methodologyVersion,
      intervalStart: meta.intervalStart,
      intervalEnd: meta.intervalEnd,
      recordCount: meta.recordCount,
      pageIndex: i,
      pageSize,
      cursor: cursorFor(meta.runId, i),
      nextCursor: i + 1 < total ? cursorFor(meta.runId, i + 1) : null,
      final: i + 1 === total,
      sourceAsOf: meta.generatedAt,
      records: records.slice(i * pageSize, (i + 1) * pageSize),
    })
  }
  return pages
}
