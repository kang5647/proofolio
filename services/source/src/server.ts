/**
 * ProofDesk private record source (simulated-market ledgers).
 *
 *  PUBLIC   GET  /public/profiles                  candidate profiles + self-presented claims (no fills)
 *           GET  /public/runs/:runId               run metadata (no records)
 *  PRIVATE  GET  /private/runs/:runId/pages?cursor=   Bearer <account token>  -> SourcePage
 *  ADMIN    POST /admin/run-bots                   x-admin-token  -> run both bots live, new runIds
 *           POST /admin/fault                      x-admin-token  {runId, mode}
 *  DEV      GET  /dev/ledger/:runId                x-dev-token    raw synthetic ledger (developer test view)
 *
 * Never fetches external URLs. Never returns credentials. Logs contain no tokens or fills.
 */
import Fastify from 'fastify'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { SourceStore, type FaultMode } from './store.ts'
import { MomentumStrategy, MeanReversionStrategy } from '../../../bots/src/index.ts'
import { COMMITTED_SEED, DEMO_REGIMES, generateSeries, runBot } from '../../../simulator/src/index.ts'
import { computeAccounting, summarize } from '../../../packages/accounting/src/accounting.ts'
import { paginate } from '../../../packages/accounting/src/pages.ts'

const PORT = Number(process.env.SOURCE_PORT ?? 4100)
const PAGE_SIZE = Number(process.env.SOURCE_PAGE_SIZE ?? 40)
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data')
const ADMIN_TOKEN = process.env.SOURCE_ADMIN_TOKEN
const DEV_TOKEN = process.env.SOURCE_DEV_TOKEN
if (!ADMIN_TOKEN || !DEV_TOKEN) {
  console.error('SOURCE_ADMIN_TOKEN and SOURCE_DEV_TOKEN must be set (see .env.example)')
  process.exit(1)
}

const store = new SourceStore(DATA_DIR)
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers["x-admin-token"]', 'req.headers["x-dev-token"]'] } })

function safeEq(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

const PROFILES = [
  {
    accountId: 'acct-bot-a',
    strategy: new MomentumStrategy(),
    presentation: 'selective' as const,
    blurb: 'Publishes only its single best round-trip. Full scoped results are available only through an authenticated verification.',
  },
  {
    accountId: 'acct-bot-b',
    strategy: new MeanReversionStrategy(),
    presentation: 'complete' as const,
    blurb: 'Publishes its complete scoped net result (self-reported; still unverified until checked).',
  },
]

app.get('/health', async () => ({ ok: true, service: 'proofdesk-source', dataProvenance: 'simulated-market' }))

app.get('/public/profiles', async () => {
  return PROFILES.map((p) => {
    const run = store.latestRunFor(p.accountId)
    let claim: Record<string, unknown> = { kind: 'no-run-yet' }
    if (run) {
      const s = summarize(computeAccounting(run.records, { intervalStart: run.meta.intervalStart, intervalEnd: run.meta.intervalEnd }))
      claim =
        p.presentation === 'selective'
          ? s.largestGrossWinningRoundTrip
            ? { kind: 'largest-gross-winning-round-trip', grossPnl: s.largestGrossWinningRoundTrip.gross, note: 'Single best trade, gross of fees. Not an aggregate result.' }
            : { kind: 'largest-gross-winning-round-trip', grossPnl: null, note: 'This run produced no winning round-trip.' }
          : { kind: 'complete-net-result', netRealizedPnl: s.netRealizedPnl, grossRealizedPnl: s.grossRealizedPnl, totalCommissions: s.totalCommissions, fillCount: s.fillCount, completedRoundTrips: s.completedRoundTrips, note: 'Self-reported complete scoped result.' }
    }
    return {
      accountId: p.accountId,
      name: p.strategy.name,
      strategyId: p.strategy.id,
      rules: p.strategy.rules,
      presentation: p.presentation,
      blurb: p.blurb,
      sourceMode: 'authenticated-private-source',
      dataProvenance: 'simulated-market',
      latestRun: run
        ? { runId: run.meta.runId, accountCommitment: run.meta.accountCommitment, market: run.meta.market, intervalStart: run.meta.intervalStart, intervalEnd: run.meta.intervalEnd, methodologyVersion: run.meta.methodologyVersion, recordCount: run.meta.recordCount, seed: run.meta.seed, generatedAt: run.meta.generatedAt }
        : null,
      claim,
    }
  })
})

app.get<{ Params: { runId: string } }>('/public/runs/:runId', async (req, reply) => {
  const run = store.runs.get(req.params.runId)
  if (!run) return reply.code(404).send({ error: 'unknown run' })
  const { orderedEventIds: _omit, accountId: _omit2, ...pub } = run.meta
  return pub
})

app.get<{ Params: { runId: string }; Querystring: { cursor?: string } }>('/private/runs/:runId/pages', async (req, reply) => {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return reply.code(401).send({ error: 'missing bearer token' })
  const accountId = store.accountForToken(auth.slice(7))
  if (!accountId) return reply.code(401).send({ error: 'invalid token' })
  const run = store.runs.get(req.params.runId)
  if (!run) return reply.code(404).send({ error: 'unknown run' })
  if (run.meta.accountId !== accountId) return reply.code(403).send({ error: 'token not authorised for this run' })
  const pages = paginate(run.meta, run.records, PAGE_SIZE)
  const cursor = req.query.cursor ?? pages[0].cursor
  const idx = pages.findIndex((p) => p.cursor === cursor)
  if (idx < 0) return reply.code(404).send({ error: cursor === `${run.meta.runId}#p${pages.length}` ? 'page unavailable (intentional missing-page fault mode)' : 'unknown cursor' })
  const fault = store.faults.get(run.meta.runId) ?? 'none'
  const page = structuredClone(pages[idx])
  if (fault === 'missing-page') {
    // Intentional fault: the chain advertises one more page than will ever be served.
    if (idx === pages.length - 1) {
      page.final = false
      page.nextCursor = `${run.meta.runId}#p${pages.length}`
    }
  }
  if (fault === 'duplicate-record' && idx === pages.length - 1 && pages[0].records.length > 1) page.records.push(pages[0].records[1])
  return page
})

app.post<{ Body: { suffix?: string } }>('/admin/run-bots', async (req, reply) => {
  if (!safeEq(req.headers['x-admin-token'] as string | undefined, ADMIN_TOKEN)) return reply.code(401).send({ error: 'unauthorised' })
  const suffix = (req.body?.suffix ?? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)).replace(/[^a-zA-Z0-9]/g, '')
  const series = generateSeries(COMMITTED_SEED)
  const out = []
  for (const p of PROFILES) {
    const letter = p.accountId.endsWith('-a') ? 'a' : 'b'
    const runId = `run-bot-${letter}-${suffix}`
    if (store.runs.has(runId)) return reply.code(409).send({ error: `run ${runId} exists` })
    const run = runBot(p.strategy, series, { runId, accountId: p.accountId, seed: COMMITTED_SEED })
    store.saveRun(run)
    const s = summarize(computeAccounting(run.records, { intervalStart: run.meta.intervalStart, intervalEnd: run.meta.intervalEnd }))
    out.push({ accountId: p.accountId, runId, accountCommitment: run.meta.accountCommitment, intervalStart: run.meta.intervalStart, intervalEnd: run.meta.intervalEnd, recordCount: run.meta.recordCount, fills: s.fillCount, roundTrips: s.completedRoundTrips, forcedCloses: s.forcedCloses })
    req.log.info({ runId, records: run.meta.recordCount, fills: s.fillCount }, 'bot run completed')
  }
  return { seed: COMMITTED_SEED, regimes: DEMO_REGIMES.map((r) => r.name), events: series.length, runs: out }
})

app.post<{ Body: { runId: string; mode: FaultMode } }>('/admin/fault', async (req, reply) => {
  if (!safeEq(req.headers['x-admin-token'] as string | undefined, ADMIN_TOKEN)) return reply.code(401).send({ error: 'unauthorised' })
  const { runId, mode } = req.body ?? ({} as any)
  if (!store.runs.has(runId)) return reply.code(404).send({ error: 'unknown run' })
  if (!['none', 'missing-page', 'duplicate-record'].includes(mode)) return reply.code(400).send({ error: 'bad mode' })
  store.faults.set(runId, mode)
  return { runId, mode }
})

app.get<{ Params: { runId: string } }>('/dev/ledger/:runId', async (req, reply) => {
  if (!safeEq(req.headers['x-dev-token'] as string | undefined, DEV_TOKEN)) return reply.code(401).send({ error: 'unauthorised' })
  const run = store.runs.get(req.params.runId)
  if (!run) return reply.code(404).send({ error: 'unknown run' })
  return { warning: 'DEVELOPER TEST VIEW — synthetic ledger. Not production privacy.', ...run }
})

app.listen({ port: PORT, host: process.env.HOST ?? '127.0.0.1' }).then(() => {
  app.log.info({ runs: store.runs.size, accounts: [...store.credentials.keys()] }, 'source ready')
})
