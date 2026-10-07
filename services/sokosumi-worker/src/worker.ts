/**
 * Sokosumi Coworker bridge for the ProofDesk verifier.
 *
 * Sokosumi is only an additional hiring surface. This worker owns no verification or
 * payment logic: it turns a Sokosumi Task into a job on the existing MIP-003 verifier,
 * relays the verifier's signed Masumi payment terms to the Task (Sokosumi then funds the
 * escrow from the buyer's credits), and completes the Task with the delivered certificate.
 *
 *   Task READY -> RUNNING -> verifier /start_job -> Task event { masumiPayment }
 *     -> verifier sees FundsLocked, runs the CRE workflow, submits the result hash
 *     -> Task event { status: COMPLETED, comment: certificate summary }
 *
 * Task brief: name the bot to verify ("Bot A", "Bot B", or an account id like acct-bot-a).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const env = (k: string, d?: string) => process.env[k] ?? d
const CORE = env('SOKOSUMI_API_URL', 'https://api.preprod.sokosumi.com')!
const COWORKER_ID = env('SOKOSUMI_COWORKER_ID', '')!
const API_KEY = env('SOKOSUMI_COWORKER_API_KEY', '')!
const VERIFIER = env('SOKOSUMI_VERIFIER_URL', env('VERIFIER_BASE_URL', 'http://127.0.0.1:4200'))!
const SOURCE = env('SOKOSUMI_SOURCE_URL', env('SOURCE_BASE_URL', 'http://127.0.0.1:4100'))!
const DEMO_URL = env('PUBLIC_DEMO_URL', '')
const NETWORK = env('MASUMI_NETWORK', 'Preprod')!
const CONTRACT = env('MASUMI_SMART_CONTRACT_ADDRESS', '')!
const PURCHASER_MPS = env('BUYER_MASUMI_PAYMENT_SERVICE_URL', env('MASUMI_PAYMENT_SERVICE_URL', 'http://127.0.0.1:3001/api/v1'))!
const PURCHASER_MPS_KEY = env('BUYER_MASUMI_PAYMENT_API_KEY', env('MASUMI_PAYMENT_API_KEY', ''))!
// The Sokosumi buyer has no EVM identity; certificates for Sokosumi Tasks are issued to this address.
const BUYER_ADDRESS = env('SOKOSUMI_CERT_BUYER_ADDRESS', env('BUYER_ADDRESS', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'))!
const POLL_MS = Number(env('SOKOSUMI_POLL_MS', '5000'))
const DATA_DIR = env('DATA_DIR', join(process.cwd(), 'data'))!
if (!COWORKER_ID || !API_KEY) {
  console.error('SOKOSUMI_COWORKER_ID and SOKOSUMI_COWORKER_API_KEY are required')
  process.exit(1)
}

type Stage = 'started' | 'awaiting-escrow' | 'completed' | 'paid-out' | 'failed'
interface TaskState { stage: Stage; accountId?: string; nonce?: string; job?: any; paymentEventId?: string; purchaseRequested?: boolean; onChainState?: string | null; paymentTx?: any; error?: string }
mkdirSync(DATA_DIR, { recursive: true })
const journalFile = join(DATA_DIR, 'sokosumi-worker.json')
const journal: Record<string, TaskState> = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : {}
const save = (taskId: string, s: TaskState) => {
  journal[taskId] = s
  writeFileSync(journalFile, JSON.stringify(journal, null, 2), { mode: 0o600 })
  return s
}
const log = (taskId: string, msg: string) => console.log(`${new Date().toISOString()} task=${taskId.slice(0, 8)} ${msg}`)

async function http(base: string, path: string, init: RequestInit & { auth?: boolean } = {}) {
  const headers: Record<string, string> = { accept: 'application/json', ...(init.headers as Record<string, string>) }
  if (init.auth) headers.authorization = `Bearer ${API_KEY}`
  if (init.body) headers['content-type'] = 'application/json'
  const r = await fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(30_000) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${r.status} ${t.slice(0, 300)}`)
  const body = t ? JSON.parse(t) : null
  return body?.data ?? body
}
const core = (path: string, body?: unknown) => http(CORE, path, { auth: true, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
const postEvent = (taskId: string, body: unknown) => core(`/v1/tasks/${encodeURIComponent(taskId)}/events`, body)

/** Fund the already-created MIP-003 job from the configured Preprod purchaser wallet.
 * The Sokosumi credit event is the marketplace receipt; this is the matching Cardano
 * escrow action. It is persisted before polling so retries never purchase twice. */
async function fundEscrow(terms: any, name: string) {
  if (!PURCHASER_MPS_KEY) throw new Error('BUYER_MASUMI_PAYMENT_API_KEY is required to fund the Sokosumi escrow')
  const res = await fetch(`${PURCHASER_MPS}/purchase/`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', token: PURCHASER_MPS_KEY },
    body: JSON.stringify({
      blockchainIdentifier: terms.blockchainIdentifier,
      network: NETWORK,
      paymentSourceType: 'Web3CardanoV2',
      supportedPaymentSourceIndex: 0,
      inputHash: terms.inputHash,
      sellerVkey: terms.sellerVkey,
      agentIdentifier: terms.agentIdentifier,
      Amounts: terms.Amounts,
      payByTime: terms.payByTime,
      submitResultTime: terms.submitResultTime,
      unlockTime: terms.unlockTime,
      externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
      identifierFromPurchaser: terms.identifierFromPurchaser,
      metadata: `Sokosumi Proofolio verification: ${name}`,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Masumi escrow purchase -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text)?.data ?? JSON.parse(text) : null
}

function pickAccount(text: string): string | null {
  if (/acct-bot-a|bot[\s-]*a\b|momentum/i.test(text)) return 'acct-bot-a'
  if (/acct-bot-b|bot[\s-]*b\b|mean[\s-]*rev/i.test(text)) return 'acct-bot-b'
  return null
}

function resultComment(name: string, st: any): string {
  const pd = st.proofdesk
  const cert = JSON.parse(st.result)
  const r = cert.result
  const lines = [
    `ProofDesk verification of ${name}: ${cert.status}`,
    r ? `True net realised PnL: ${r.netRealizedPnl} USDT (gross ${r.grossRealizedPnl}, fees ${r.totalCommissions}, ${r.fillCount} fills, ${r.completedRoundTrips} round-trips). Largest single winning trade: ${r.largestGrossWinningRoundTrip?.gross ?? 'none'} USDT gross.` : `No financial result: ${(cert.reasons ?? []).join('; ')}`,
    `Computed by a Chainlink CRE workflow over the seller's full private ledger (${cert.recordCount} records, execution mode ${cert.executionMode}). The trade history is not delivered.`,
    `Certificate digest: ${pd.certDigest}`,
    `On-chain receipt: tx ${pd.receiptTx} on ${pd.chain} (${pd.receiptMode}), request ${pd.requestId}`,
    `Masumi escrow: ${pd.onChainState}; funds locked tx ${pd.paymentTx?.fundsLocked ?? 'n/a'}; result hash ${pd.resultHash} submitted in tx ${pd.paymentTx?.resultSubmitted ?? 'pending'}`,
    DEMO_URL ? `Verify independently: ${DEMO_URL}` : '',
    'Synthetic simulated market; this is evidence about a claim, not investment advice.',
  ]
  return lines.filter(Boolean).join('\n')
}

async function advance(task: any) {
  let s = journal[task.id]
  if (!s) {
    if (task.status !== 'READY') return
    const accountId = pickAccount(`${task.name ?? ''}\n${task.description ?? ''}`)
    await postEvent(task.id, { status: 'RUNNING' })
    if (!accountId) {
      await postEvent(task.id, { status: 'FAILED', comment: 'Name the candidate to verify in the Task brief: "Bot A" (Momentum-20) or "Bot B" (MeanRev-30). No payment was requested.' })
      save(task.id, { stage: 'failed', error: 'no candidate named' })
      return log(task.id, 'no candidate named in brief; failed without charging')
    }
    s = save(task.id, { stage: 'started', accountId, nonce: randomBytes(10).toString('hex') })
    log(task.id, `started for ${accountId}`)
  }

  if (s.stage === 'started') {
    // `/start_job` is idempotent by purchaser identifier, but a network failure may
    // happen after we persist its response and before Sokosumi accepts the payment
    // event. Resume from that durable job rather than recreating its time-sensitive
    // claim (whose expiry would otherwise change on every poll).
    if (s.job?.terms) {
      const masumiPayment = {
        ...s.job.terms,
        ...(CONTRACT ? {
          PaymentSource: {
            network: NETWORK,
            smartContractAddress: CONTRACT,
            policyId: String(s.job.terms.agentIdentifier).slice(0, 56),
          },
        } : {}),
      }
      const ev = await postEvent(task.id, {
        comment: `Payment requested through Masumi escrow: 1 tUSDM for one verification of ${s.job.name}. Work starts when the escrow is funded on Cardano ${NETWORK}.`,
        masumiPayment,
      })
      s = save(task.id, { ...s, job: { ...s.job, terms: masumiPayment }, stage: 'awaiting-escrow', paymentEventId: ev?.id })
      return log(task.id, `resumed payment request; verifier job ${s.job.id}`)
    }
    const profiles = await http(SOURCE, '/public/profiles')
    const p = profiles.find((x: any) => x.accountId === s.accountId)
    if (!p?.latestRun) throw new Error(`no published run for ${s.accountId}`)
    const run = p.latestRun
    const claimedValue = p.claim?.kind === 'largest-gross-winning-round-trip' ? p.claim.grossPnl : p.claim?.netRealizedPnl
    const claim = {
      version: 'proofolio-claim/1',
      agent: { id: p.accountId, name: p.name },
      claimType: 'trading-performance',
      scope: { runId: run.runId, accountCommitment: run.accountCommitment, market: run.market, intervalStart: run.intervalStart, intervalEnd: run.intervalEnd },
      claimedOutput: { metric: p.claim?.kind === 'largest-gross-winning-round-trip' ? 'largest-gross-winning-round-trip' : 'net-realized-pnl', value: String(claimedValue ?? 0), unit: 'USDT' },
      acceptanceCriteria: ['Evidence must cover the declared scope.', 'Certificate digest must match the on-chain receipt.', 'Certificate must be unexpired.'],
      privateEvidenceRef: `authenticated-private-ledger:${run.runId}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }
    const [quote, job] = await Promise.all([
      http(VERIFIER, '/quote'),
      http(VERIFIER, '/start_job', {
        method: 'POST',
        headers: { 'x-purchaser-id': `sokosumi-${task.id}` },
        body: JSON.stringify({ identifier_from_purchaser: s.nonce, claim, buyerAddress: BUYER_ADDRESS }),
      }),
    ])
    if (quote.mode !== 'masumi') throw new Error('verifier is not in Masumi payment mode; refusing to request a Sokosumi payment')
    const ms = (sec: number) => String(sec * 1000)
    const masumiPayment = {
      blockchainIdentifier: job.blockchainIdentifier,
      agentIdentifier: job.agentIdentifier,
      sellerVkey: job.sellerVKey,
      payByTime: ms(job.payByTime),
      submitResultTime: ms(job.submitResultTime),
      unlockTime: ms(job.unlockTime),
      externalDisputeUnlockTime: ms(job.externalDisputeUnlockTime),
      inputHash: job.input_hash,
      identifierFromPurchaser: job.identifierFromPurchaser,
      paymentSourceType: 'Web3CardanoV2',
      supportedPaymentSourceIndex: 0,
      Amounts: quote.amounts.map((a: any) => ({ amount: a.amount, unit: a.unit })),
      ...(CONTRACT ? { PaymentSource: { network: NETWORK, smartContractAddress: CONTRACT, policyId: String(job.agentIdentifier).slice(0, 56) } } : {}),
    }
    s = save(task.id, { ...s, job: { id: job.id, name: p.name, terms: masumiPayment } })
    const ev = await postEvent(task.id, { comment: `Payment requested through Masumi escrow: ${quote.amounts.map((a: any) => a.display).join(', ')} for one verification of ${p.name}. Work starts when the escrow is funded on Cardano ${NETWORK}.`, masumiPayment })
    s = save(task.id, { ...s, stage: 'awaiting-escrow', paymentEventId: ev?.id })
    return log(task.id, `payment requested; verifier job ${job.id}`)
  }

  if (s.stage === 'awaiting-escrow' || s.stage === 'completed') {
    if (s.stage === 'awaiting-escrow' && !s.purchaseRequested) {
      const purchase = await fundEscrow(s.job.terms, s.job.name)
      s = save(task.id, { ...s, purchaseRequested: true })
      log(task.id, `Cardano escrow purchase requested: ${purchase?.id ?? 'accepted'}`)
    }
    const st = await http(VERIFIER, `/status?job_id=${s.job.id}`)
    const pd = st.proofdesk
    if (pd.onChainState !== s.onChainState) {
      log(task.id, `escrow ${pd.onChainState ?? 'not funded yet'} · job ${pd.state}`)
      s = save(task.id, { ...s, onChainState: pd.onChainState, paymentTx: pd.paymentTx })
    }
    if (s.stage === 'awaiting-escrow') {
      if (st.status === 'failed') {
        await postEvent(task.id, { status: 'FAILED', comment: `Verification did not run: ${pd.error ?? 'job failed'}. Unused escrow refunds under the Masumi contract rules.` })
        save(task.id, { ...s, stage: 'failed', error: pd.error })
        return log(task.id, `failed: ${pd.error}`)
      }
      // Complete only once the result hash is confirmed on-chain, so the Task result and the escrow agree.
      if (st.status === 'completed' && st.result && ['delivered', 'funds_unlock_pending', 'paid_out'].includes(pd.state)) {
        await postEvent(task.id, { status: 'COMPLETED', comment: resultComment(s.job.name, st) })
        save(task.id, { ...s, stage: 'completed' })
        return log(task.id, `completed; certificate ${pd.certDigest}`)
      }
    } else if (pd.paymentTx?.withdrawn) {
      save(task.id, { ...s, stage: 'paid-out', paymentTx: pd.paymentTx })
      log(task.id, `seller payout confirmed: tx ${pd.paymentTx.withdrawn}`)
    }
  }
}

const me = await core('/v1/coworkers/me')
if (me.id !== COWORKER_ID) throw new Error('runtime key does not belong to SOKOSUMI_COWORKER_ID')
console.log(`Sokosumi worker running as "${me.name}" (${COWORKER_ID}) -> verifier ${VERIFIER}`)
for (;;) {
  try {
    const tasks = await core(`/v1/tasks?coworkerId=${encodeURIComponent(COWORKER_ID)}&take=50`)
    for (const t of (Array.isArray(tasks) ? tasks : []).filter((t: any) => (t.assigneeId ?? t.coworkerId) === COWORKER_ID)) {
      if (['paid-out', 'failed'].includes(journal[t.id]?.stage ?? '')) continue
      try {
        await advance(t)
      } catch (e) {
        log(t.id, `blocked: ${(e as Error).message.slice(0, 300)}`)
      }
    }
  } catch (e) {
    console.error(`polling failed: ${(e as Error).message.slice(0, 200)}`)
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}
