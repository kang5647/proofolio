/**
 * Verification engine: commits the request on-chain, executes the CRE workflow (or the
 * in-process fallback), delivers the receipt, and returns the certificate.
 *
 * Engines:
 *  - cre-simulate: spawns `cre workflow simulate` with the HTTP payload. The simulator reads
 *    the on-chain scope and fetches the source pages inside the TEE handler. Dry run unless
 *    broadcast=true (real Sepolia only). Local mode delivers the same ABI receipt payload
 *    through the MockForwarder so the consumer's forwarder check is exercised.
 *  - in-process-fallback: same shared accounting, run in this process with the source
 *    credentials file. Development only; labelled as such in the certificate.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { toHex, type Address, type Hex } from 'viem'
import { ReceiptChain, type ChainName, type RequestFields } from './chain.ts'
import { buildCertificate, certificateDigest, encodeReceiptPayload, type Certificate } from '../../../packages/accounting/src/certificate.ts'
import { verifyRun, type RequestScope } from '../../../packages/accounting/src/verify.ts'
import type { SourcePage } from '../../../packages/accounting/src/ledger.ts'

export interface EngineConfig {
  engine: 'cre-simulate' | 'in-process-fallback'
  chainName: ChainName
  rpcUrl: string
  receiptAddress: Address
  operatorKey: Hex
  mockForwarder: Address | null
  broadcast: boolean
  creBin: string
  creProjectDir: string
  creTarget: string
  creEnvFile: string
  sourceBaseUrl: string
  credentialsFile: string | null
  certificateTtlSeconds: number
  methodologyVersion: string
}

export interface EngineOutput {
  requestId: Hex
  commitTx: Hex
  nonce: Hex
  expiresAt: string
  certificate: Certificate
  certificateDigest: Hex
  receiptTx: Hex | null
  receiptMode: 'cre-broadcast-forwarder' | 'mock-forwarder-local' | 'dry-run-no-receipt'
  creLog: string | null
}

export interface JobInput {
  runId: string
  accountCommitment: Hex
  market: string
  intervalStart: string
  intervalEnd: string
  buyerAddress: Address
}

export async function runVerification(cfg: EngineConfig, input: JobInput, log: (stage: string, detail?: unknown) => void): Promise<EngineOutput> {
  const chain = new ReceiptChain(cfg.chainName, cfg.rpcUrl, cfg.receiptAddress)
  const nonce = toHex(randomBytes(32))
  const expiresAt = new Date(Date.now() + cfg.certificateTtlSeconds * 1000).toISOString()
  const fields: RequestFields = { buyer: input.buyerAddress, accountCommitment: input.accountCommitment, runId: input.runId, market: input.market, intervalStart: input.intervalStart, intervalEnd: input.intervalEnd, methodologyVersion: cfg.methodologyVersion, nonce, expiresAt }
  const { requestId, txHash: commitTx } = await chain.commitRequest(cfg.operatorKey, fields)
  log('request_committed', { requestId, commitTx, expiresAt })
  if (cfg.chainName === 'sepolia' && cfg.rpcUrl.includes('127.0.0.1')) await new Promise((r) => setTimeout(r, 3500)) // local anvil finality
  else if (cfg.chainName === 'sepolia') await waitFinalized(chain, commitTx)

  let certificate: Certificate
  let creLog: string | null = null
  let receiptTx: Hex | null = null
  let receiptMode: EngineOutput['receiptMode'] = 'dry-run-no-receipt'

  if (cfg.engine === 'cre-simulate') {
    const payload = JSON.stringify({ requestId, runId: input.runId, market: input.market })
    const args = ['workflow', 'simulate', 'trading-resume', '--target', cfg.creTarget, '--non-interactive', '--trigger-index', '0', '--http-payload', payload, '-e', cfg.creEnvFile, '--allow-insecure-rpc']
    if (cfg.broadcast) args.push('--broadcast')
    log('cre_simulate_start', { args: args.filter((a) => !a.startsWith('{')) })
    const { code, output } = await runCli(cfg.creBin, args, cfg.creProjectDir, 240_000)
    creLog = output
    const m = output.match(/Workflow Simulation Result:\s*\n([\s\S]*?)\n\s*\n/)
    if (code !== 0 || !m) {
      const err = output.split('\n').filter((l) => /✗|error|failed/i.test(l)).slice(-3).join(' | ')
      throw new Error(`cre workflow simulate failed (exit ${code}): ${err || 'no result'}`)
    }
    const res = JSON.parse(JSON.parse(m[1].trim()))
    certificate = res.certificate as Certificate
    if (res.certificateDigest !== certificateDigest(certificate)) throw new Error('digest reported by workflow does not match recomputed certificate digest')
    log('cre_simulate_done', { status: certificate.status, records: certificate.recordCount, txHash: res.receipt?.txHash ?? null, dryRun: !cfg.broadcast })
    if (cfg.broadcast && res.receipt?.txHash) {
      receiptTx = res.receipt.txHash
      receiptMode = 'cre-broadcast-forwarder'
    }
  } else {
    certificate = inProcessVerify(cfg, fields, requestId, log)
  }

  // Receipt delivery for local chains: the CRE simulator cannot reach a Keystone forwarder on
  // anvil, so the operator relays the identical ABI payload through the MockForwarder.
  if (!receiptTx && cfg.mockForwarder) {
    const payload = encodeReceiptPayload(certificate)
    receiptTx = await chain.mockForward(cfg.operatorKey, cfg.mockForwarder, payload, '0x0000000000000000000000000000000000000000')
    receiptMode = 'mock-forwarder-local'
    log('receipt_mock_forwarded', { receiptTx, note: 'LOCAL SIMULATION: MockForwarder relay, not a DON-signed report' })
  }
  if (receiptTx) {
    const v = await chain.verifyReceipt(requestId, certificateDigest(certificate))
    if (!v.ok) throw new Error(`receipt recorded but on-chain verification failed: ${v.reason}`)
    log('receipt_verified_onchain', { receiptTx, mode: receiptMode })
  }
  return { requestId, commitTx, nonce, expiresAt, certificate, certificateDigest: certificateDigest(certificate), receiptTx, receiptMode, creLog }
}

async function waitFinalized(chain: ReceiptChain, tx: Hex) {
  const r = await chain.pub.getTransactionReceipt({ hash: tx })
  for (let i = 0; i < 120; i++) {
    const fin = await chain.pub.getBlock({ blockTag: 'finalized' })
    if (fin.number >= r.blockNumber) return
    await new Promise((res) => setTimeout(res, 10_000))
  }
  throw new Error('commit transaction not finalized in time')
}

function runCli(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, HOME: process.env.HOME } })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, output: out })
    })
  })
}

/** Development fallback: identical shared logic, executed here with the local credentials file. */
function inProcessVerify(cfg: EngineConfig, f: RequestFields, requestId: Hex, log: (s: string, d?: unknown) => void): Certificate {
  if (!cfg.credentialsFile) throw new Error('in-process fallback requires credentialsFile')
  const creds = JSON.parse(readFileSync(cfg.credentialsFile, 'utf8')) as { accountId: string; token: string }[]
  const scope: RequestScope = { runId: f.runId, accountCommitment: f.accountCommitment, market: f.market, intervalStart: f.intervalStart, intervalEnd: f.intervalEnd, methodologyVersion: f.methodologyVersion }
  const pages: SourcePage[] = []
  const reasons: string[] = []
  // Try each provisioned credential; the source enforces account scoping (403 otherwise).
  let cursor: string | null = null
  let token: string | null = null
  for (const c of creds) {
    const r = fetchSync(`${cfg.sourceBaseUrl}/private/runs/${encodeURIComponent(f.runId)}/pages`, c.token)
    if (r.status === 200) {
      token = c.token
      pages.push(r.body as SourcePage)
      cursor = (r.body as SourcePage).nextCursor
      break
    }
  }
  if (!token) reasons.push('no provisioned credential authorised for this run')
  for (let i = 1; token && cursor && i < 12; i++) {
    const r = fetchSync(`${cfg.sourceBaseUrl}/private/runs/${encodeURIComponent(f.runId)}/pages?cursor=${encodeURIComponent(cursor)}`, token)
    if (r.status !== 200) {
      reasons.push(`source page ${i} unavailable (HTTP ${r.status})`)
      break
    }
    pages.push(r.body as SourcePage)
    cursor = (r.body as SourcePage).nextCursor
  }
  let outcome = verifyRun(pages, scope)
  if (reasons.length) outcome = { ...outcome, status: 'UNVERIFIABLE', result: null, reasons: [...reasons, ...outcome.reasons] }
  log('in_process_verify_done', { status: outcome.status, records: outcome.recordCount })
  return buildCertificate({ requestId, buyer: f.buyer, accountCommitment: f.accountCommitment, runId: f.runId, market: f.market, intervalStart: f.intervalStart, intervalEnd: f.intervalEnd, methodologyVersion: f.methodologyVersion, nonce: f.nonce, issuedAt: new Date().toISOString(), expiresAt: f.expiresAt, executionMode: 'local-simulation', executionEngine: 'in-process-fallback' }, outcome)
}

/** Minimal synchronous HTTP GET (dev fallback only) using curl, to keep the fallback free of async plumbing. */
function fetchSync(url: string, token: string): { status: number; body: unknown } {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const r = spawnSync('curl', ['-s', '-w', '\n%{http_code}', '-H', `Authorization: Bearer ${token}`, url], { encoding: 'utf8' })
  const lines = r.stdout.trimEnd().split('\n')
  const status = Number(lines.pop())
  const text = lines.join('\n')
  return { status, body: status === 200 ? JSON.parse(text) : text }
}
