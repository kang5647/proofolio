/**
 * ProofDesk verification coworker — MIP-003 Agentic Service API + job worker.
 *
 *  GET  /availability           MIP-003
 *  GET  /input_schema           MIP-003
 *  POST /start_job              MIP-003 (identifier_from_purchaser, input_data)
 *  GET  /status?job_id=         MIP-003 (+ proofdesk detail object)
 *  GET  /quote                  price from the payment provider (never a guessed constant)
 *  GET  /jobs/:id/events        journal for one job (public: no secrets inside)
 *  POST /mock/pay               MOCK MODE ONLY: marks escrow as funded
 *
 * Job state machine (persisted):
 *  awaiting_payment -> funds_locked -> running -> request_committed -> receipt_recorded
 *   -> result_submitted -> delivered -> funds_unlock_pending -> paid_out | failed | refunded
 * The worker never processes a job before the payment provider reports FundsLocked.
 */
import Fastify from 'fastify'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { isAddress, type Address, type Hex } from 'viem'
import { JobStore, type JobRow, type JobState } from './db.ts'
import { MasumiPaymentProvider, MockPaymentProvider, type PaymentProvider } from './payments.ts'
import { runVerification, type EngineConfig, type JobInput } from './engine.ts'
import { canonicalize, certificateBytes, MARKET, METHODOLOGY_VERSION } from '../../../packages/accounting/src/index.ts'
import { parseClaim, TradingPerformanceAdapter, type VerificationClaim } from './adapters.ts'

const env = (k: string, d?: string) => process.env[k] ?? d
const PORT = Number(env('VERIFIER_PORT', '4200'))
const DATA_DIR = env('DATA_DIR', join(process.cwd(), 'data'))!
const PAYMENT_MODE = env('PAYMENT_MODE', 'mock') as 'masumi' | 'mock'
const ENGINE = env('EXECUTION_ENGINE', 'cre-simulate') as EngineConfig['engine']
const SOURCE_BASE_URL = env('SOURCE_BASE_URL', 'http://127.0.0.1:4100')!
const POLL_MS = Number(env('WORKER_POLL_MS', '5000'))
const MAX_CONCURRENT = Number(env('WORKER_MAX_CONCURRENT', '1'))

// Chain config: Sepolia if provided, else local anvil-as-sepolia from data/local-chain.json
const localChainFile = join(DATA_DIR, 'local-chain.json')
const local = existsSync(localChainFile) ? JSON.parse(readFileSync(localChainFile, 'utf8')) : null
const useSepolia = !!(env('SEPOLIA_RPC_URL') && env('SEPOLIA_PRIVATE_KEY') && env('RESUME_RECEIPT_ADDRESS'))
if (!useSepolia && !local) {
  console.error('No chain configured: set SEPOLIA_* vars or run scripts/local-chain-up.sh')
  process.exit(1)
}
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const engineCfg: EngineConfig = {
  engine: ENGINE,
  chainName: 'sepolia',
  rpcUrl: useSepolia ? env('SEPOLIA_RPC_URL')! : local.rpcUrl,
  receiptAddress: (useSepolia ? env('RESUME_RECEIPT_ADDRESS')! : local.resumeReceipt) as Address,
  operatorKey: (useSepolia ? env('SEPOLIA_PRIVATE_KEY')! : ANVIL_KEY) as Hex,
  mockForwarder: useSepolia ? null : (local.mockForwarder as Address),
  broadcast: useSepolia && env('CRE_BROADCAST', 'true') === 'true',
  creBin: env('CRE_BIN', join(process.env.HOME ?? '', '.cre/bin/cre'))!.replace(/^~/, process.env.HOME ?? ''),
  creProjectDir: env('CRE_PROJECT_DIR', join(process.cwd(), 'workflows'))!,
  creTarget: env('CRE_TARGET', useSepolia ? 'staging-settings' : 'local-settings')!,
  creEnvFile: env('CRE_ENV_FILE', '.env')!,
  sourceBaseUrl: SOURCE_BASE_URL,
  credentialsFile: join(DATA_DIR, 'source-credentials.json'),
  certificateTtlSeconds: Number(env('CERTIFICATE_TTL_SECONDS', '86400')),
  methodologyVersion: METHODOLOGY_VERSION,
}

const store = new JobStore(join(DATA_DIR, 'verifier.db'))
const mock = new MockPaymentProvider()
const payments: PaymentProvider =
  PAYMENT_MODE === 'masumi'
    ? new MasumiPaymentProvider({
        baseUrl: env('MASUMI_PAYMENT_SERVICE_URL', 'http://127.0.0.1:3001/api/v1')!,
        apiKey: env('MASUMI_PAYMENT_API_KEY', '')!,
        network: env('MASUMI_NETWORK', 'Preprod') as 'Preprod',
        agentIdentifier: env('MASUMI_AGENT_IDENTIFIER', '')!,
        sellerVkey: env('MASUMI_SELLER_VKEY', '')!,
        payByMinutes: Number(env('MASUMI_PAY_BY_MINUTES', '30')),
        submitResultMinutes: Number(env('MASUMI_SUBMIT_RESULT_MINUTES', '60')),
        unlockAfterSubmitMinutes: Number(env('MASUMI_UNLOCK_AFTER_SUBMIT_MINUTES', '360')),
        disputeAfterSubmitMinutes: Number(env('MASUMI_DISPUTE_AFTER_SUBMIT_MINUTES', '720')),
      })
    : mock

const app = Fastify({ logger: { level: env('LOG_LEVEL', 'info'), redact: ['req.headers.authorization', 'req.headers.token'] } })

const INPUT_SCHEMA = {
  claim: {
    version: 'proofolio-claim/1',
    description: 'Public claim envelope. Private evidence is referenced but never submitted to, or returned by, the buyer API.',
    supportedClaimTypes: ['trading-performance'],
    fields: ['agent', 'claimType', 'scope', 'claimedOutput', 'acceptanceCriteria', 'privateEvidenceRef', 'expiresAt'],
  },
  input_data: [
    { id: 'runId', type: 'string', name: 'Run ID', data: { description: 'Immutable run identifier from the candidate profile' } },
    { id: 'accountCommitment', type: 'string', name: 'Account commitment', data: { description: '0x-prefixed sha256 commitment binding run and account' } },
    { id: 'market', type: 'string', name: 'Market', data: { description: `Must be ${MARKET}` } },
    { id: 'intervalStart', type: 'string', name: 'Interval start (inclusive, ISO-8601 UTC)' },
    { id: 'intervalEnd', type: 'string', name: 'Interval end (exclusive, ISO-8601 UTC)' },
    { id: 'buyerAddress', type: 'string', name: 'Buyer EVM address', data: { description: 'Address the certificate is issued to (Sepolia receipt consumer)' } },
  ],
}

function parseInput(raw: any): JobInput {
  const req = (k: string) => {
    const v = raw?.[k]
    if (typeof v !== 'string' || !v) throw new Error(`input_data.${k} is required`)
    return v
  }
  const input: JobInput = { runId: req('runId'), accountCommitment: req('accountCommitment') as Hex, market: req('market'), intervalStart: req('intervalStart'), intervalEnd: req('intervalEnd'), buyerAddress: req('buyerAddress') as Address }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.accountCommitment)) throw new Error('accountCommitment must be 0x + 64 hex')
  if (input.market !== MARKET) throw new Error(`market must be ${MARKET}`)
  if (!isAddress(input.buyerAddress)) throw new Error('buyerAddress invalid')
  for (const k of ['intervalStart', 'intervalEnd'] as const) if (Number.isNaN(Date.parse(input[k]))) throw new Error(`${k} must be ISO-8601`)
  if (Date.parse(input.intervalStart) >= Date.parse(input.intervalEnd)) throw new Error('interval must be non-empty')
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(input.runId)) throw new Error('runId has invalid characters')
  return input
}

/** Legacy MIP-003 callers may still send the former flat trading scope. */
function legacyClaim(raw: any): VerificationClaim {
  const input = parseInput(raw)
  return TradingPerformanceAdapter.parse({
    version: 'proofolio-claim/1',
    agent: { id: 'legacy-trading-agent' },
    claimType: 'trading-performance',
    scope: { ...input, buyerAddress: undefined },
    claimedOutput: { metric: 'net-realized-pnl', value: '0', unit: 'USDT' },
    acceptanceCriteria: ['Certificate must bind the declared scope and on-chain receipt.'],
    privateEvidenceRef: `private-ledger:${input.runId}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  })
}

const inputHashOf = (input: JobInput) => createHash('sha256').update(canonicalize(input)).digest('hex')

app.get('/availability', async () => ({ status: 'available', type: 'masumi-agent', service: 'Proofolio', verificationAdapters: ['trading-performance'], message: `Proofolio verifier ready (payment=${payments.mode}, engine=${ENGINE}, adapter=trading-performance)` }))
app.get('/input_schema', async () => INPUT_SCHEMA)
app.get('/quote', async () => payments.quote())
app.get('/health', async () => ({ ok: true, paymentMode: payments.mode, engine: ENGINE, chain: useSepolia ? 'sepolia' : 'anvil-as-sepolia (local)', receipt: engineCfg.receiptAddress }))

app.post<{ Body: { identifier_from_purchaser?: string; input_data?: unknown; claim?: unknown; buyerAddress?: string } }>('/start_job', async (req, reply) => {
  const idf = req.body?.identifier_from_purchaser
  if (typeof idf !== 'string' || !/^[0-9a-fA-F]{14,26}$/.test(idf)) return reply.code(400).send({ error: 'identifier_from_purchaser must be 14-26 hex characters (Masumi nonce format)' })
  let input: JobInput, claim: VerificationClaim
  try {
    const buyerAddress = (req.body?.buyerAddress ?? (req.body?.input_data as any)?.buyerAddress) as Address
    claim = req.body?.claim ? parseClaim(req.body.claim) : legacyClaim(req.body?.input_data)
    input = TradingPerformanceAdapter.toEngineInput(claim, buyerAddress)
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message })
  }
  const purchaserKey = String(req.headers['x-purchaser-id'] ?? 'anonymous')
  // The Masumi input hash binds both public claim and verification scope.
  const inputHash = createHash('sha256').update(canonicalize({ claim, input })).digest('hex')
  const existing = store.getByPurchaser(purchaserKey, idf)
  if (existing) {
    if (existing.input_hash !== inputHash) return reply.code(409).send({ error: 'identifier_from_purchaser already used with different input_data' })
    return reply.send(startJobResponse(existing))
  }
  const terms = await payments.createPaymentRequest({ inputHash, identifierFromPurchaser: idf, metadata: `proofolio:${claim.claimType}:${input.runId}` })
  const id = randomUUID()
  store.insert({
    id, purchaser_key: purchaserKey, identifier_from_purchaser: idf, input_hash: inputHash, input_json: JSON.stringify(input), claim_json: JSON.stringify(claim), state: 'awaiting_payment', payment_mode: payments.mode,
    blockchain_identifier: terms.blockchainIdentifier, pay_by_time: terms.payByTime, submit_result_time: terms.submitResultTime, unlock_time: terms.unlockTime, external_dispute_unlock_time: terms.externalDisputeUnlockTime,
    agent_identifier: terms.agentIdentifier, seller_vkey: terms.sellerVkey,
    request_id: null, commit_tx: null, nonce: null, expires_at: null, certificate_json: null, cert_digest: null, receipt_tx: null, receipt_mode: null, result_hash: null,
    payment_tx_funds_locked: null, payment_tx_result_submitted: null, payment_tx_withdrawn: null, on_chain_state: null, error: null,
  })
  req.log.info({ job: id, claimType: claim.claimType, runId: input.runId, paymentMode: payments.mode }, 'job created, awaiting payment')
  return reply.send(startJobResponse(store.get(id)!))
})

function startJobResponse(j: JobRow) {
  return {
    id: j.id,
    blockchainIdentifier: j.blockchain_identifier,
    payByTime: j.pay_by_time,
    submitResultTime: j.submit_result_time,
    unlockTime: j.unlock_time,
    externalDisputeUnlockTime: j.external_dispute_unlock_time,
    agentIdentifier: j.agent_identifier,
    sellerVKey: j.seller_vkey,
    identifierFromPurchaser: j.identifier_from_purchaser,
    input_hash: j.input_hash,
    claim: j.claim_json ? JSON.parse(j.claim_json) : null,
  }
}

const MIP_STATUS: Record<JobState, 'awaiting_payment' | 'running' | 'completed' | 'failed'> = {
  awaiting_payment: 'awaiting_payment', funds_locked: 'running', running: 'running', request_committed: 'running', receipt_recorded: 'running', result_submitted: 'completed', delivered: 'completed', funds_unlock_pending: 'completed', paid_out: 'completed', failed: 'failed', refunded: 'failed',
}

app.get<{ Querystring: { job_id?: string } }>('/status', async (req, reply) => {
  const j = req.query.job_id ? store.get(req.query.job_id) : null
  if (!j) return reply.code(404).send({ error: 'job not found' })
  const body: Record<string, unknown> = { status: MIP_STATUS[j.state] }
  if (j.certificate_json && ['result_submitted', 'delivered', 'funds_unlock_pending', 'paid_out'].includes(j.state)) body.result = j.certificate_json
  body.proofdesk = {
    state: j.state,
    paymentMode: j.payment_mode,
    blockchainIdentifier: j.blockchain_identifier,
    onChainState: j.on_chain_state,
    deadlines: { payByTime: j.pay_by_time, submitResultTime: j.submit_result_time, unlockTime: j.unlock_time, externalDisputeUnlockTime: j.external_dispute_unlock_time },
    requestId: j.request_id, commitTx: j.commit_tx, receiptTx: j.receipt_tx, receiptMode: j.receipt_mode, certDigest: j.cert_digest, resultHash: j.result_hash,
    paymentTx: { fundsLocked: j.payment_tx_funds_locked, resultSubmitted: j.payment_tx_result_submitted, withdrawn: j.payment_tx_withdrawn },
    claim: j.claim_json ? JSON.parse(j.claim_json) : null,
    chain: useSepolia ? 'sepolia' : 'anvil-as-sepolia (local simulation)', receiptContract: engineCfg.receiptAddress, error: j.error,
  }
  return body
})

app.get<{ Params: { id: string } }>('/jobs/:id/events', async (req, reply) => {
  if (!store.get(req.params.id)) return reply.code(404).send({ error: 'job not found' })
  return store.events(req.params.id).map((e) => ({ ts: e.ts, stage: e.stage, detail: e.detail_json ? JSON.parse(e.detail_json) : null }))
})

app.post<{ Body: { blockchainIdentifier?: string } }>('/mock/pay', async (req, reply) => {
  if (payments.mode !== 'mock') return reply.code(404).send({ error: 'not in mock payment mode' })
  const id = req.body?.blockchainIdentifier
  if (!id) return reply.code(400).send({ error: 'blockchainIdentifier required' })
  mock.mockLock(id)
  return { ok: true, note: 'MOCK payment — no funds moved' }
})

// ─── Worker ─────────────────────────────────────────────────
let inFlight = 0
async function tick() {
  for (const j of store.listActive()) {
    if (inFlight >= MAX_CONCURRENT) break
    try {
      await advance(j)
    } catch (e) {
      app.log.error({ job: j.id, err: (e as Error).message }, 'job advance error')
      store.update(j.id, { error: (e as Error).message, attempts: j.attempts + 1 }, 'error', { message: (e as Error).message })
      if (j.attempts + 1 >= 3 && ['funds_locked', 'running', 'request_committed'].includes(j.state)) store.setState(j.id, 'failed', {}, { reason: 'exceeded retry budget' })
    }
  }
}

async function advance(j: JobRow) {
  const snap = await payments.snapshot(j.blockchain_identifier!)
  if (snap.onChainState && snap.onChainState !== j.on_chain_state) store.update(j.id, { on_chain_state: snap.onChainState, payment_tx_funds_locked: snap.txFundsLocked ?? j.payment_tx_funds_locked, payment_tx_result_submitted: snap.txResultSubmitted ?? j.payment_tx_result_submitted, payment_tx_withdrawn: snap.txWithdrawn ?? j.payment_tx_withdrawn }, 'payment_state', { onChainState: snap.onChainState, nextAction: snap.nextAction })

  switch (j.state) {
    case 'awaiting_payment': {
      if (snap.onChainState === 'FundsLocked') store.setState(j.id, 'funds_locked', {}, { txFundsLocked: snap.txFundsLocked })
      else if (j.pay_by_time && Date.now() / 1000 > j.pay_by_time + 600 && !snap.onChainState) store.setState(j.id, 'failed', { error: 'payment deadline passed without escrow funding' })
      return
    }
    case 'funds_locked':
    case 'running':
    // A run that failed after committing its request is retried with a fresh request, within the retry budget.
    case 'request_committed': {
      if (j.submit_result_time && Date.now() / 1000 > j.submit_result_time - 60) {
        store.setState(j.id, 'failed', { error: 'submitResultTime too close; not starting (funds will refund per escrow rules)' })
        return
      }
      inFlight++
      try {
        store.setState(j.id, 'running')
        const input = JSON.parse(j.input_json) as JobInput
        const out = await runVerification(engineCfg, input, (stage, detail) => {
          store.event(j.id, stage, detail)
          if (stage === 'request_committed') store.update(j.id, { request_id: (detail as any).requestId, commit_tx: (detail as any).commitTx, expires_at: (detail as any).expiresAt, state: 'request_committed' })
        })
        const certJson = certificateBytes(out.certificate) // canonical bytes == what the digest covers
        const resultHash = createHash('sha256').update(certJson).digest('hex')
        store.setState(j.id, out.receiptTx ? 'receipt_recorded' : 'running', { certificate_json: certJson, cert_digest: out.certificateDigest, receipt_tx: out.receiptTx, receipt_mode: out.receiptMode, nonce: out.nonce, result_hash: resultHash, error: null }, { receiptMode: out.receiptMode, status: out.certificate.status })
        if (!out.receiptTx) {
          store.setState(j.id, 'failed', { error: 'no receipt could be recorded (dry run without forwarder); certificate not delivered' })
          return
        }
        await payments.submitResult(j.blockchain_identifier!, resultHash)
        store.setState(j.id, 'result_submitted', {}, { resultHash })
      } finally {
        inFlight--
      }
      return
    }
    case 'receipt_recorded': {
      await payments.submitResult(j.blockchain_identifier!, j.result_hash!)
      store.setState(j.id, 'result_submitted', {}, { resultHash: j.result_hash })
      return
    }
    case 'result_submitted': {
      if (snap.onChainState === 'ResultSubmitted' || snap.resultHash === j.result_hash) store.setState(j.id, 'delivered', {}, { txResultSubmitted: snap.txResultSubmitted })
      return
    }
    case 'delivered': {
      if (j.unlock_time && Date.now() / 1000 >= j.unlock_time) store.setState(j.id, 'funds_unlock_pending')
      if (snap.onChainState === 'Withdrawn') store.setState(j.id, 'paid_out', {}, { txWithdrawn: snap.txWithdrawn })
      return
    }
    case 'funds_unlock_pending': {
      if (snap.onChainState === 'Withdrawn') store.setState(j.id, 'paid_out', {}, { txWithdrawn: snap.txWithdrawn })
      if (snap.onChainState?.startsWith('Refund')) store.setState(j.id, 'refunded')
      return
    }
    default:
      return
  }
}

app.listen({ port: PORT, host: env('HOST', '127.0.0.1') }).then(() => {
  app.log.info({ paymentMode: payments.mode, engine: ENGINE, chain: useSepolia ? 'sepolia' : 'local', pending: store.listActive().length }, 'verifier ready; resuming persisted jobs')
  setInterval(() => void tick(), POLL_MS)
  void tick()
})
