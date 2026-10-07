/**
 * Persistent job journal (node:sqlite). Every state change is appended to `events`.
 * Restart-safe: pending jobs resume from their persisted state; no in-memory maps.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type JobState =
  | 'awaiting_payment'
  | 'funds_locked'
  | 'running'
  | 'request_committed'
  | 'receipt_recorded'
  | 'result_submitted'
  | 'delivered'
  | 'funds_unlock_pending'
  | 'paid_out'
  | 'failed'
  | 'refunded'

export interface JobRow {
  id: string
  purchaser_key: string
  identifier_from_purchaser: string
  input_hash: string
  input_json: string
  claim_json: string | null
  state: JobState
  payment_mode: 'masumi' | 'mock'
  blockchain_identifier: string | null
  pay_by_time: number | null
  submit_result_time: number | null
  unlock_time: number | null
  external_dispute_unlock_time: number | null
  agent_identifier: string | null
  seller_vkey: string | null
  request_id: string | null
  commit_tx: string | null
  nonce: string | null
  expires_at: string | null
  certificate_json: string | null
  cert_digest: string | null
  receipt_tx: string | null
  receipt_mode: string | null
  result_hash: string | null
  payment_tx_funds_locked: string | null
  payment_tx_result_submitted: string | null
  payment_tx_withdrawn: string | null
  on_chain_state: string | null
  error: string | null
  attempts: number
  created_at: string
  updated_at: string
}

export interface JobEvent {
  id: number
  job_id: string
  ts: string
  stage: string
  detail_json: string | null
}

export class JobStore {
  readonly db: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        purchaser_key TEXT NOT NULL,
        identifier_from_purchaser TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        claim_json TEXT,
        state TEXT NOT NULL,
        payment_mode TEXT NOT NULL,
        blockchain_identifier TEXT, pay_by_time INTEGER, submit_result_time INTEGER, unlock_time INTEGER, external_dispute_unlock_time INTEGER,
        agent_identifier TEXT, seller_vkey TEXT,
        request_id TEXT, commit_tx TEXT, nonce TEXT, expires_at TEXT,
        certificate_json TEXT, cert_digest TEXT, receipt_tx TEXT, receipt_mode TEXT, result_hash TEXT,
        payment_tx_funds_locked TEXT, payment_tx_result_submitted TEXT, payment_tx_withdrawn TEXT, on_chain_state TEXT,
        error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(purchaser_key, identifier_from_purchaser)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        stage TEXT NOT NULL,
        detail_json TEXT
      );
      CREATE INDEX IF NOT EXISTS events_job ON events(job_id);
    `)
    // Existing local journals predate the generic claim envelope. SQLite has no
    // ADD COLUMN IF NOT EXISTS, so tolerate the duplicate-column error.
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN claim_json TEXT') } catch { /* migrated already */ }
  }

  insert(job: Omit<JobRow, 'created_at' | 'updated_at' | 'attempts'>) {
    const now = new Date().toISOString()
    const cols = Object.keys(job)
    this.db
      .prepare(`INSERT INTO jobs (${cols.join(',')}, attempts, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, 0, ?, ?)`)
      .run(...cols.map((c) => (job as any)[c] ?? null), now, now)
    this.event(job.id, 'job_created', { state: job.state })
  }

  get(id: string): JobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null
  }

  getByPurchaser(purchaserKey: string, identifier: string): JobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE purchaser_key = ? AND identifier_from_purchaser = ?').get(purchaserKey, identifier) as JobRow | undefined) ?? null
  }

  listActive(): JobRow[] {
    return this.db.prepare(`SELECT * FROM jobs WHERE state NOT IN ('paid_out','failed','refunded') ORDER BY created_at`).all() as unknown as JobRow[]
  }

  listAll(): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as unknown as JobRow[]
  }

  update(id: string, patch: Partial<JobRow>, stage?: string, detail?: unknown) {
    const keys = Object.keys(patch)
    if (keys.length) {
      this.db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => (patch as any)[k] ?? null), new Date().toISOString(), id)
    }
    if (stage) this.event(id, stage, detail ?? patch)
  }

  setState(id: string, state: JobState, patch: Partial<JobRow> = {}, detail?: unknown) {
    this.update(id, { ...patch, state }, `state:${state}`, detail)
  }

  event(jobId: string, stage: string, detail?: unknown) {
    this.db.prepare('INSERT INTO events (job_id, ts, stage, detail_json) VALUES (?, ?, ?, ?)').run(jobId, new Date().toISOString(), stage, detail === undefined ? null : JSON.stringify(detail))
  }

  events(jobId: string): JobEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id').all(jobId) as unknown as JobEvent[]
  }

  allEvents(limit = 500): JobEvent[] {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as unknown as JobEvent[]
  }
}
