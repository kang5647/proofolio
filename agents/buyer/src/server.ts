/**
 * ProofDesk buyer agent + demo screen (port 4300).
 *
 * Tools (deterministic code; see explain.ts for the optional LLM prose):
 *  discover -> inspect schema + quote -> start_job (x2) -> purchase (x2, under spend cap) -> poll
 *  -> retrieve certificate -> validate (digest, receipt, scope, expiry, provenance) -> compare -> decide.
 *
 *  GET  /                      demo UI
 *  GET  /api/state             everything the UI renders
 *  GET  /api/events            SSE feed
 *  POST /api/run-bots          runs both bots (via source admin API)
 *  POST /api/verify            "Verify before hiring": two paid checks, one orchestration action
 *  POST /api/tamper            tamper demo: modify a delivered certificate and re-validate
 *  POST /api/fault             developer: set a source fault mode (missing-page) before verifying
 */
import Fastify from 'fastify'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { Address, Hex } from 'viem'
import { ReceiptChain, explorerTx, explorerAddress } from '../../../services/verifier/src/chain.ts'
import { METHODOLOGY_VERSION, type Certificate } from '../../../packages/accounting/src/index.ts'
import { validateCertificate, decide, type EvidenceCheck, type Decision } from './verify-certificate.ts'
import { explain, type CandidateSummary } from './explain.ts'

const env = (k: string, d?: string) => process.env[k] ?? d
const PORT = Number(env('BUYER_PORT', '4300'))
const DATA_DIR = env('DATA_DIR', join(process.cwd(), 'data'))!
const SOURCE = env('SOURCE_BASE_URL', 'http://127.0.0.1:4100')!
const VERIFIER = env('VERIFIER_BASE_URL', 'http://127.0.0.1:4200')!
const SOURCE_ADMIN_TOKEN = env('SOURCE_ADMIN_TOKEN', '')!
const SPEND_CAP = BigInt(env('BUYER_TOTAL_SPEND_CAP', '2000000')!) // atomic units of the quoted asset
const BUYER_ADDRESS = (env('BUYER_ADDRESS', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8') as Address)
const BUYER_MPS_URL = env('BUYER_MASUMI_PAYMENT_SERVICE_URL', env('MASUMI_PAYMENT_SERVICE_URL', 'http://127.0.0.1:3001/api/v1'))!
const BUYER_MPS_KEY = env('BUYER_MASUMI_PAYMENT_API_KEY', env('MASUMI_PAYMENT_API_KEY', ''))!
const MASUMI_NETWORK = env('MASUMI_NETWORK', 'Preprod')!
const localChainFile = join(DATA_DIR, 'local-chain.json')
const local = existsSync(localChainFile) ? JSON.parse(readFileSync(localChainFile, 'utf8')) : null
const useSepolia = !!(env('SEPOLIA_RPC_URL') && env('RESUME_RECEIPT_ADDRESS'))
const chain = new ReceiptChain('sepolia', useSepolia ? env('SEPOLIA_RPC_URL')! : local?.rpcUrl, (useSepolia ? env('RESUME_RECEIPT_ADDRESS') : local?.resumeReceipt) as Address)
const chainLabel = useSepolia ? 'Ethereum Sepolia' : 'local anvil (chain id 11155111 impersonation) — LOCAL SIMULATION'

interface FeedEvent { ts: string; actor: 'buyer' | 'verifier' | 'payment' | 'cre' | 'chain' | 'bots'; text: string; link?: string | null }
interface CandidateState {
  verificationRequestId?: string
  accountId: string
  name: string
  presentation: 'selective' | 'complete'
  rules: string[]
  publicClaim: string
  claim?: any
  run: any
  jobId: string | null
  blockchainIdentifier: string | null
  paymentState: string | null
  jobState: string | null
  deadlines: any
  paymentTx: any
  certificate: Certificate | null
  certDigest: Hex | null
  receiptTx: string | null
  receiptMode: string | null
  requestId: Hex | null
  evidence: EvidenceCheck | null
  decision: Decision | null
  rule: string | null
  verifierEvents?: { ts: string; stage: string; detail: any }[]
  tampered?: { field: string; evidence: EvidenceCheck }
}
interface BuyerState {
  labels: string[]
  chain: string
  receiptContract: Address
  explorer: { receiptContract: string | null }
  specialist: any
  quotePreview?: any
  spendCap: string
  spent: string
  jobsCreated: number
  paymentsMade: number
  candidates: CandidateState[]
  explanation: { text: string; source: string } | null
  feed: FeedEvent[]
  running: boolean
  lastError: string | null
}

const stateFile = join(DATA_DIR, 'buyer-state.json')
mkdirSync(DATA_DIR, { recursive: true })
const state: BuyerState = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : { labels: [], chain: chainLabel, receiptContract: chain.receipt, explorer: { receiptContract: useSepolia ? explorerAddress('sepolia', chain.receipt) : null }, specialist: null, spendCap: SPEND_CAP.toString(), spent: '0', jobsCreated: 0, paymentsMade: 0, candidates: [], explanation: null, feed: [], running: false, lastError: null }
state.running = false
// Chain wiring is configuration, not journal state: never serve a stale label after a mode switch.
state.chain = chainLabel
state.receiptContract = chain.receipt
state.explorer = { receiptContract: useSepolia ? explorerAddress('sepolia', chain.receipt) : null }
const persist = () => writeFileSync(stateFile, JSON.stringify(state, null, 2))
const sseClients = new Set<(e: FeedEvent) => void>()
function log(actor: FeedEvent['actor'], text: string, link?: string | null) {
  const e: FeedEvent = { ts: new Date().toISOString(), actor, text, link: link ?? null }
  state.feed.push(e)
  if (state.feed.length > 400) state.feed.splice(0, state.feed.length - 400)
  for (const c of sseClients) c(e)
  persist()
}

const j = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init)
  const t = await r.text()
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${r.status} ${t.slice(0, 200)}`)
  return t ? JSON.parse(t) : null
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function refreshLabels() {
  const h = await j(`${VERIFIER}/health`).catch(() => null)
  state.labels = ['SIMULATED TRADING (synthetic SIM-SOL/USDT market, fixed seed)', h?.engine === 'cre-simulate' ? 'CRE LOCAL SIMULATION (not a real TEE / DON)' : 'IN-PROCESS FALLBACK (dev only)', h?.paymentMode === 'masumi' ? `CARDANO PREPROD via Masumi (test funds)` : 'MOCK PAYMENTS (local development; no funds move)', useSepolia ? 'RECEIPT: Ethereum Sepolia via cre simulate --broadcast (Chainlink simulation forwarder, not DON-signed)' : 'RECEIPT: local anvil chain (MockForwarder)']
}

// Public quote discovery is read-only. It lets the landing screen show the
// current price before a buyer explicitly hires the verifier.
async function refreshQuotePreview() {
  const quote = await j(`${VERIFIER}/quote`)
  state.quotePreview = quote
  persist()
}

// Escrow settlement (result submission, payout) lands on Cardano after the
// certificate is delivered and the decision loop has exited; keep it current.
async function refreshSettlement() {
  if (state.running) return
  for (const c of state.candidates) {
    if (!c.jobId || !c.certificate || c.paymentState === 'Withdrawn') continue
    const pd = (await j(`${VERIFIER}/status?job_id=${c.jobId}`).catch(() => null))?.proofdesk
    if (!pd || (pd.state === c.jobState && pd.onChainState === c.paymentState)) continue
    c.jobState = pd.state
    c.paymentState = pd.onChainState
    c.paymentTx = pd.paymentTx
    log('payment', `${c.name}: ${pd.state}${pd.onChainState ? ` (escrow ${pd.onChainState})` : ''}`)
  }
}

async function loadCandidates() {
  const profiles = await j(`${SOURCE}/public/profiles`)
  state.candidates = profiles.map((p: any) => {
    const prev = state.candidates.find((c) => c.accountId === p.accountId && c.run?.runId === p.latestRun?.runId)
    const claim = p.claim.kind === 'largest-gross-winning-round-trip' ? (p.claim.grossPnl ? `Best trade: +${p.claim.grossPnl} USDT gross` : 'No winning trade to show') : p.claim.kind === 'complete-net-result' ? `Net realised PnL: ${p.claim.netRealizedPnl} USDT (self-reported)` : 'No run yet'
    return prev ?? { accountId: p.accountId, name: p.name, presentation: p.presentation, rules: p.rules, publicClaim: claim, run: p.latestRun, jobId: null, blockchainIdentifier: null, paymentState: null, jobState: null, deadlines: null, paymentTx: null, certificate: null, certDigest: null, receiptTx: null, receiptMode: null, requestId: null, evidence: null, decision: null, rule: null }
  })
  persist()
}

async function purchase(c: CandidateState, start: any, quoteAmounts: { amount: string; unit: string }[]) {
  if (state.specialist.quote.mode === 'mock') {
    await j(`${VERIFIER}/mock/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blockchainIdentifier: start.blockchainIdentifier }) })
    log('payment', `MOCK payment marked for ${c.name} (no funds moved)`)
    return
  }
  // Real Masumi purchase from the buyer's own payment service (purchasing wallet).
  const body = {
    blockchainIdentifier: start.blockchainIdentifier,
    network: MASUMI_NETWORK,
    paymentSourceType: 'Web3CardanoV2',
    supportedPaymentSourceIndex: 0,
    inputHash: start.input_hash,
    sellerVkey: start.sellerVKey,
    agentIdentifier: start.agentIdentifier,
    Amounts: quoteAmounts.map((a) => ({ amount: a.amount, unit: a.unit })),
    payByTime: String(start.payByTime * 1000),
    submitResultTime: String(start.submitResultTime * 1000),
    unlockTime: String(start.unlockTime * 1000),
    externalDisputeUnlockTime: String(start.externalDisputeUnlockTime * 1000),
    identifierFromPurchaser: start.identifierFromPurchaser,
    metadata: `proofdesk buyer: ${c.accountId}`,
  }
  const res = await fetch(`${BUYER_MPS_URL}/purchase/`, { method: 'POST', headers: { 'content-type': 'application/json', token: BUYER_MPS_KEY }, body: JSON.stringify(body) })
  const t = await res.text()
  if (!res.ok) throw new Error(`Masumi purchase failed: ${res.status} ${t.slice(0, 300)}`)
  const p = JSON.parse(t)?.data ?? JSON.parse(t)
  log('payment', `Masumi purchase requested on ${MASUMI_NETWORK} for ${c.name}: purchase id ${p.id ?? '?'}; escrow funding tx pending`)
}

async function verifyBeforeHiring(options: { loadDemoCandidates?: boolean } = {}) {
  if (state.running) throw new Error('already running')
  state.running = true
  state.lastError = null
  try {
    await refreshLabels()
    if (options.loadDemoCandidates !== false) await loadCandidates()
    log('buyer', 'Discovering verification specialist…')
    const [avail, schema, quote] = await Promise.all([j(`${VERIFIER}/availability`), j(`${VERIFIER}/input_schema`), j(`${VERIFIER}/quote`)])
    state.specialist = { availability: avail, schema, quote, url: VERIFIER }
    log('buyer', `Specialist ${avail.status}: ${avail.message}`)
    log('buyer', `Quote: ${quote.amounts.map((a: any) => a.display).join(', ')} per check (${quote.source})`)
    const perJob = quote.amounts.reduce((s: bigint, a: any) => s + BigInt(a.amount), 0n)
    const purchaserId = 'proofdesk-buyer-' + BUYER_ADDRESS.slice(2, 10)

    const targets = state.candidates.filter((c) => c.run)
    log('buyer', `Requesting ${targets.length} checks (one job + one payment per candidate; not a bundled payment). Spend cap ${state.spendCap} atomic units.`)
    for (const c of targets) {
      if (c.jobId && c.certificate) continue
      if (c.jobId && c.blockchainIdentifier) {
        log('buyer', `Resuming existing paid-job poll for ${c.name}: ${c.jobId.slice(0, 8)}…`)
        continue
      }
      const spentSoFar = BigInt(state.spent)
      if (spentSoFar + perJob > SPEND_CAP) {
        log('buyer', `Spend cap would be exceeded for ${c.name}; skipping purchase`)
        continue
      }
      const claimedValue = String(c.publicClaim).match(/[-+]?\d[\d,]*\.\d+/)?.[0]?.replace(/,/g, '') ?? '0'
      const claim = c.claim ?? {
        version: 'proofolio-claim/1',
        agent: { id: c.accountId, name: c.name },
        claimType: 'trading-performance',
        scope: { runId: c.run.runId, accountCommitment: c.run.accountCommitment, market: c.run.market, intervalStart: c.run.intervalStart, intervalEnd: c.run.intervalEnd },
        claimedOutput: { metric: c.presentation === 'selective' ? 'largest-gross-winning-round-trip' : 'net-realized-pnl', value: claimedValue, unit: 'USDT' },
        acceptanceCriteria: ['Evidence must cover the declared scope.', 'Certificate digest must match the on-chain receipt.', 'Certificate must be unexpired.'],
        privateEvidenceRef: `authenticated-private-ledger:${c.run.runId}`,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      }
      c.claim = claim
      const idf = c.jobId ? undefined : randomBytes(10).toString('hex')
      const start = await j(`${VERIFIER}/start_job`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-purchaser-id': purchaserId }, body: JSON.stringify({ identifier_from_purchaser: idf, claim, buyerAddress: BUYER_ADDRESS }) })
      const isNew = c.jobId !== start.id
      c.jobId = start.id
      c.blockchainIdentifier = start.blockchainIdentifier
      c.deadlines = { payByTime: start.payByTime, submitResultTime: start.submitResultTime, unlockTime: start.unlockTime, externalDisputeUnlockTime: start.externalDisputeUnlockTime }
      if (isNew) state.jobsCreated++
      log('verifier', `Job ${start.id.slice(0, 8)}… for ${c.name}: awaiting payment, blockchainIdentifier ${String(start.blockchainIdentifier).slice(0, 24)}…, payBy ${new Date(start.payByTime * 1000).toISOString()}`)
      await purchase(c, start, quote.amounts)
      state.spent = (spentSoFar + perJob).toString()
      state.paymentsMade++
      persist()
    }

    // Poll jobs until delivered.
    const deadline = Date.now() + 40 * 60_000
    const pending = new Set(targets.filter((c) => c.jobId && !c.certificate).map((c) => c.accountId))
    while (pending.size && Date.now() < deadline) {
      for (const c of targets) {
        if (!pending.has(c.accountId)) continue
        // A paid job outlives any single request: a verifier restart or network blip must not abort the run.
        const s = await j(`${VERIFIER}/status?job_id=${c.jobId}`).catch(() => null)
        if (!s) continue
        const journal = await j(`${VERIFIER}/jobs/${c.jobId}/events`).catch(() => null)
        if (Array.isArray(journal)) c.verifierEvents = journal
        const pd = s.proofdesk
        if (pd.state !== c.jobState) {
          c.jobState = pd.state
          c.paymentState = pd.onChainState
          c.paymentTx = pd.paymentTx
          const actor: FeedEvent['actor'] = pd.state === 'funds_locked' ? 'payment' : ['request_committed', 'receipt_recorded'].includes(pd.state) ? 'chain' : pd.state === 'running' ? 'cre' : 'verifier'
          const link = pd.state === 'request_committed' && pd.commitTx && useSepolia ? explorerTx('sepolia', pd.commitTx) : pd.state === 'receipt_recorded' && pd.receiptTx && useSepolia ? explorerTx('sepolia', pd.receiptTx) : null
          log(actor, `${c.name}: ${pd.state}${pd.onChainState ? ` (escrow ${pd.onChainState})` : ''}${pd.state === 'request_committed' ? ` request ${pd.requestId.slice(0, 12)}…` : ''}${pd.state === 'receipt_recorded' ? ` receipt tx ${String(pd.receiptTx).slice(0, 14)}… [${pd.receiptMode}]` : ''}${pd.error ? ` error: ${pd.error}` : ''}`, link)
          persist()
        }
        if (s.status === 'failed') {
          pending.delete(c.accountId)
          continue
        }
        if (s.status === 'completed' && s.result) {
          c.certificate = JSON.parse(s.result)
          c.certDigest = pd.certDigest
          c.receiptTx = pd.receiptTx
          c.receiptMode = pd.receiptMode
          c.requestId = pd.requestId
          log('verifier', `${c.name}: certificate delivered (status ${c.certificate!.status}, digest ${String(pd.certDigest).slice(0, 14)}…)`)
          c.evidence = await validateCertificate(c.certificate!, { runId: c.run.runId, accountCommitment: c.run.accountCommitment, market: c.run.market, intervalStart: c.run.intervalStart, intervalEnd: c.run.intervalEnd, buyerAddress: BUYER_ADDRESS, methodologyVersion: METHODOLOGY_VERSION }, chain)
          const failed = c.evidence.checks.filter((x) => !x.ok).map((x) => x.name)
          log('buyer', `${c.name}: buyer validation ${c.evidence.evidence}${failed.length ? ` (failed: ${failed.join(', ')})` : ' — digest, receipt, scope, expiry, provenance all match'}`)
          const d = decide(c.certificate, c.evidence)
          c.decision = d.decision
          c.rule = d.rule
          log('buyer', `${c.name}: ${d.decision} — ${d.rule}`)
          pending.delete(c.accountId)
          persist()
        }
      }
      if (pending.size) await sleep(3000)
    }
    const summaries: CandidateSummary[] = targets.map((c) => ({ name: c.name, presentation: c.presentation, publicClaim: c.publicClaim, certificate: c.certificate, evidence: c.evidence ? c.evidence.evidence : 'MISSING', decision: c.decision ?? 'INSUFFICIENT_EVIDENCE', rule: c.rule ?? 'no certificate delivered' }))
    state.explanation = await explain(summaries)
    log('buyer', `Explanation ready (${state.explanation.source}).`)
  } catch (e) {
    state.lastError = (e as Error).message
    log('buyer', `Error: ${state.lastError}`)
  } finally {
    state.running = false
    persist()
  }
}

const app = Fastify({ logger: { level: env('LOG_LEVEL', 'info') } })
// The demo HTML is also convenient to inspect directly from disk. Permit that
// local preview to call the same local buyer API; deployed requests remain
// same-origin through the reverse proxy.
app.addHook('onRequest', async (_req, reply) => {
  reply.header('access-control-allow-origin', '*')
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS')
  reply.header('access-control-allow-headers', 'content-type')
})
app.options('*', async (_req, reply) => reply.code(204).send())
app.get('/', async (_req, reply) => reply.type('text/html').send(readFileSync(join(process.cwd(), 'demo/index.html'), 'utf8')))
app.get('/api/state', async () => {
  await refreshLabels().catch(() => {})
  await refreshQuotePreview().catch(() => {})
  if (!state.candidates.length) await loadCandidates().catch(() => {})
  // A buyer restart must not strand a paid verifier job. `verifyBeforeHiring`
  // detects existing job identifiers and resumes polling; it never purchases
  // a second time for those candidates.
  if (!state.running && state.candidates.some((c) => c.jobId && !c.certificate)) void verifyBeforeHiring()
  await refreshSettlement().catch(() => {})
  return state
})
app.get('/api/events', (req, reply) => {
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (e: FeedEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
  sseClients.add(send)
  req.raw.on('close', () => sseClients.delete(send))
})
app.post('/api/run-bots', async () => {
  log('bots', 'Running both bots on the same fixed-seed simulated market…')
  const r = await j(`${SOURCE}/admin/run-bots`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': SOURCE_ADMIN_TOKEN }, body: '{}' })
  for (const run of r.runs) log('bots', `${run.accountId}: run ${run.runId} — ${run.fills} fills, ${run.roundTrips} round-trips, ${run.forcedCloses} forced closes, ${run.recordCount} records (seed ${r.seed})`)
  state.candidates = []
  state.explanation = null
  state.spent = '0'
  await loadCandidates()
  return r
})
app.post('/api/verify', async (_req, reply) => {
  if (state.running) return reply.code(409).send({ error: 'already running' })
  void verifyBeforeHiring()
  return { started: true }
})

function validateExternalClaim(claim: any): string | null {
  const scope = claim?.scope
  if (!claim || claim.version !== 'proofolio-claim/1') return 'submit a complete proofolio-claim/1 trading-performance claim'
  if (claim.claimType !== 'trading-performance') return 'Unsupported verification adapter'
  if (!scope?.runId || !scope?.accountCommitment || !scope?.market || !scope?.intervalStart || !scope?.intervalEnd) return 'submit a complete proofolio-claim/1 trading-performance claim'
  return null
}

function submitExternalClaim(claim: any) {
  const verificationRequestId = randomBytes(12).toString('hex')
  const scope = claim.scope
  // The verifier remains the authority for schema/expiry validation. The buyer
  // only presents this public envelope and never receives private evidence.
  state.candidates = [{
    verificationRequestId,
    accountId: String(claim.agent?.id ?? 'external-agent'),
    name: String(claim.agent?.name ?? claim.agent?.id ?? 'External agent'),
    presentation: 'complete',
    rules: Array.isArray(claim.acceptanceCriteria) ? claim.acceptanceCriteria : [],
    publicClaim: `${claim.claimedOutput?.metric ?? 'claimed output'}: ${claim.claimedOutput?.value ?? '—'} ${claim.claimedOutput?.unit ?? ''}`.trim(),
    claim,
    run: { ...scope, recordCount: null },
    jobId: null, blockchainIdentifier: null, paymentState: null, jobState: null, deadlines: null, paymentTx: null,
    certificate: null, certDigest: null, receiptTx: null, receiptMode: null, requestId: null, evidence: null, decision: null, rule: null,
  }]
  state.explanation = null
  state.spent = '0'
  state.jobsCreated = 0
  state.paymentsMade = 0
  state.lastError = null
  persist()
  log('buyer', `External ${claim.claimType} claim submitted for ${state.candidates[0].name}; private evidence remains referenced, not disclosed.`)
  void verifyBeforeHiring({ loadDemoCandidates: false })
  return state.candidates[0]
}

function externalRequestStatus(c: CandidateState) {
  const status = state.lastError ? 'failed' : c.certificate ? 'verified' : c.jobId && ['running', 'request_committed', 'receipt_recorded', 'result_submitted', 'delivered'].includes(c.jobState ?? '') ? 'verifying' : 'pending_payment'
  return {
    verificationRequestId: c.verificationRequestId,
    status,
    masumiJob: c.jobId ? { id: c.jobId, blockchainIdentifier: c.blockchainIdentifier, escrowState: c.paymentState, paymentTx: c.paymentTx?.fundsLocked ?? null } : null,
    certificate: c.certificate,
    receipt: c.receiptTx ? { digest: c.certDigest, transaction: c.receiptTx, mode: c.receiptMode } : null,
    finalVerdict: c.decision,
    error: state.lastError,
  }
}

app.post<{ Body: { claim?: any } }>('/api/verify-claim', async (req, reply) => {
  if (state.running) return reply.code(409).send({ error: 'a verification is already running' })
  const claim = req.body?.claim
  const error = validateExternalClaim(claim)
  if (error) return reply.code(error === 'Unsupported verification adapter' ? 422 : 400).send({ error })
  const candidate = submitExternalClaim(claim)
  return { started: true, verificationRequestId: candidate.verificationRequestId }
})

// Public integration surface. This intentionally shares the same state and
// verifier pipeline as the UI rather than introducing a second custom flow.
app.post<{ Body: any }>('/verification-requests', async (req, reply) => {
  if (state.running) return reply.code(409).send({ error: 'a verification is already running' })
  const body: any = req.body
  const claim = body?.claim ?? body
  const error = validateExternalClaim(claim)
  if (error) return reply.code(error === 'Unsupported verification adapter' ? 422 : 400).send({ error })
  await refreshQuotePreview().catch(() => {})
  const candidate = submitExternalClaim(claim)
  return reply.code(202).send({
    verificationRequestId: candidate.verificationRequestId,
    status: 'pending_payment',
    requiredPayment: state.quotePreview?.amounts ?? null,
    masumiJob: null,
    pollUrl: `/verification-requests/${candidate.verificationRequestId}`,
  })
})

app.get<{ Params: { id: string } }>('/verification-requests/:id', async (req, reply) => {
  const candidate = state.candidates.find((c) => c.verificationRequestId === req.params.id)
  if (!candidate) return reply.code(404).send({ error: 'verification request not found' })
  return externalRequestStatus(candidate)
})
app.post('/api/reset', async () => {
  state.candidates = []
  state.explanation = null
  state.spent = '0'
  state.jobsCreated = 0
  state.paymentsMade = 0
  state.lastError = null
  state.feed = []
  await loadCandidates()
  return { ok: true }
})
app.post<{ Body: { accountId: string; field?: 'netRealizedPnl' | 'intervalEnd' } }>('/api/tamper', async (req, reply) => {
  const c = state.candidates.find((x) => x.accountId === req.body?.accountId)
  if (!c?.certificate) return reply.code(400).send({ error: 'no certificate for that candidate' })
  const field = req.body.field ?? 'netRealizedPnl'
  const copy: Certificate = structuredClone(c.certificate)
  if (field === 'netRealizedPnl' && copy.result) copy.result.netRealizedPnl = (Number(copy.result.netRealizedPnl) + 1000).toFixed(8)
  else copy.intervalEnd = new Date(Date.parse(copy.intervalEnd) + 3600_000).toISOString()
  const ev = await validateCertificate(copy, { runId: c.run.runId, accountCommitment: c.run.accountCommitment, market: c.run.market, intervalStart: c.run.intervalStart, intervalEnd: c.run.intervalEnd, buyerAddress: BUYER_ADDRESS, methodologyVersion: METHODOLOGY_VERSION }, chain)
  c.tampered = { field, evidence: ev }
  log('buyer', `TAMPER TEST on ${c.name}: changed ${field}; buyer validation ${ev.evidence} (${ev.checks.filter((x) => !x.ok).map((x) => x.name).join(', ')})`)
  return { field, evidence: ev, decision: decide(copy, ev) }
})
app.post<{ Body: { accountId: string; mode: string } }>('/api/fault', async (req) => {
  const c = state.candidates.find((x) => x.accountId === req.body?.accountId)
  if (!c?.run) throw new Error('unknown candidate')
  const r = await j(`${SOURCE}/admin/fault`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': SOURCE_ADMIN_TOKEN }, body: JSON.stringify({ runId: c.run.runId, mode: req.body.mode }) })
  log('bots', `Developer fault mode for ${c.name}: ${r.mode}`)
  return r
})

app.listen({ port: PORT, host: env('HOST', '127.0.0.1') }).then(() => app.log.info({ chain: chainLabel }, 'buyer agent ready'))
