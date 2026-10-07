/**
 * Ledger record types shared by simulator, source API, verifier and CRE workflow.
 * All amounts are decimal strings (8 dp) in serialized form.
 */
export const MARKET = 'SIM-SOL/USDT'
export const SOURCE_VERSION = 'proofdesk-sim-source/1.0.0'
export const METHODOLOGY_VERSION = 'proofdesk-accounting/1.0.0'

export type RecordKind = 'start' | 'fill' | 'forced_close' | 'reject' | 'end'
export type Side = 'buy' | 'sell'

export interface LedgerRecord {
  /** Globally unique: `${runId}:${seq}:${n}` */
  eventId: string
  /** Market event sequence number this record was produced at (0-based). */
  seq: number
  /** Simulated timestamp, ISO-8601 UTC. */
  ts: string
  kind: RecordKind
  side?: Side
  /** base quantity, decimal string */
  qty?: string
  /** execution price, decimal string (quote per base) */
  price?: string
  /** qty * price, decimal string */
  notional?: string
  /** commission in quote, decimal string */
  fee?: string
  /** quote balance after this record */
  cashAfter: string
  /** base position after this record */
  positionAfter: string
  /** for 'reject' and 'forced_close' */
  reason?: string
}

export interface RunMeta {
  runId: string
  accountId: string
  /** sha256 commitment binding runId+accountId, hex 0x */
  accountCommitment: `0x${string}`
  market: string
  sourceVersion: string
  methodologyVersion: string
  strategyId: string
  /** declared run boundaries: start inclusive, end exclusive, ISO-8601 */
  intervalStart: string
  intervalEnd: string
  startingQuote: string
  feeBps: number
  seed: string
  dataProvenance: 'simulated-market'
  recordCount: number
  /** ordered event IDs for completeness checks */
  orderedEventIds: string[]
  generatedAt: string
}

export interface SourcePage {
  runId: string
  accountCommitment: `0x${string}`
  market: string
  sourceVersion: string
  methodologyVersion: string
  intervalStart: string
  intervalEnd: string
  recordCount: number
  pageIndex: number
  pageSize: number
  cursor: string
  nextCursor: string | null
  final: boolean
  /** As-of marker for the whole run (immutable once generated). */
  sourceAsOf: string
  records: LedgerRecord[]
}
