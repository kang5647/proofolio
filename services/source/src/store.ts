/**
 * Source service state: runs (ledgers), per-account credentials, fault modes.
 * Runs are persisted as JSON files under data/runs so a restart keeps them.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { LedgerRecord, RunMeta } from '../../../packages/accounting/src/ledger.ts'

export interface StoredRun {
  meta: RunMeta
  records: LedgerRecord[]
}

export type FaultMode = 'none' | 'missing-page' | 'duplicate-record'

export interface AccountCredential {
  accountId: string
  /** random demo-only bearer token */
  token: string
}

export class SourceStore {
  readonly runs = new Map<string, StoredRun>()
  readonly faults = new Map<string, FaultMode>()
  readonly credentials = new Map<string, AccountCredential>()

  constructor(readonly dataDir: string) {
    mkdirSync(join(dataDir, 'runs'), { recursive: true })
    this.loadRuns()
    this.loadOrCreateCredentials()
  }

  private loadRuns() {
    const dir = join(this.dataDir, 'runs')
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const run = JSON.parse(readFileSync(join(dir, f), 'utf8')) as StoredRun
      this.runs.set(run.meta.runId, run)
    }
  }

  saveRun(run: StoredRun) {
    this.runs.set(run.meta.runId, run)
    writeFileSync(join(this.dataDir, 'runs', `${run.meta.runId}.json`), JSON.stringify(run, null, 2))
  }

  /** Credentials are demo-only random tokens, provisioned once and stored outside the public API. */
  private loadOrCreateCredentials() {
    const file = join(this.dataDir, 'source-credentials.json')
    if (existsSync(file)) {
      for (const c of JSON.parse(readFileSync(file, 'utf8')) as AccountCredential[]) this.credentials.set(c.accountId, c)
      return
    }
    for (const accountId of ['acct-bot-a', 'acct-bot-b']) {
      this.credentials.set(accountId, { accountId, token: `pd_demo_${randomBytes(24).toString('hex')}` })
    }
    writeFileSync(file, JSON.stringify([...this.credentials.values()], null, 2), { mode: 0o600 })
  }

  accountForToken(token: string): string | null {
    for (const c of this.credentials.values()) if (c.token === token) return c.accountId
    return null
  }

  latestRunFor(accountId: string): StoredRun | null {
    let best: StoredRun | null = null
    for (const r of this.runs.values()) {
      if (r.meta.accountId !== accountId) continue
      if (!best || r.meta.generatedAt > best.meta.generatedAt) best = r
    }
    return best
  }
}
