/**
 * End-to-end CRE simulation against the local stack:
 *   anvil (ResumeReceipt) + source service (:4100) + `cre workflow simulate --target local-settings`.
 * Steps: commit a request for the latest run of an account -> update config.local.json -> run the
 * CRE CLI with an HTTP payload -> parse the workflow result -> show the certificate digest.
 * Usage: npx tsx scripts/cre-local-e2e.ts [acct-bot-a|acct-bot-b] [--broadcast]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { toHex, type Hex } from 'viem'
import { ReceiptChain } from '../services/verifier/src/chain.ts'

const root = process.cwd()
const accountId = process.argv[2] ?? 'acct-bot-a'
const broadcast = process.argv.includes('--broadcast')
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const BUYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // anvil account 1
const cre = process.env.CRE_BIN ?? join(process.env.HOME!, '.cre/bin/cre')

const local = JSON.parse(readFileSync(join(root, 'data/local-chain.json'), 'utf8'))
const creds = JSON.parse(readFileSync(join(root, 'data/source-credentials.json'), 'utf8')) as { accountId: string; token: string }[]
const profiles = await (await fetch('http://127.0.0.1:4100/public/profiles')).json()
const prof = profiles.find((p: any) => p.accountId === accountId)
if (!prof?.latestRun) throw new Error(`no run for ${accountId}; POST /admin/run-bots first`)
const run = prof.latestRun

// 1. Commit request on anvil
const chain = new ReceiptChain('sepolia', local.rpcUrl, local.resumeReceipt)
const fields = {
  buyer: BUYER as Hex,
  accountCommitment: run.accountCommitment as Hex,
  runId: run.runId,
  market: run.market,
  intervalStart: run.intervalStart,
  intervalEnd: run.intervalEnd,
  methodologyVersion: run.methodologyVersion,
  nonce: toHex(randomBytes(32)),
  expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
}
const { requestId, txHash } = await chain.commitRequest(ANVIL_KEY, fields)
await new Promise((r) => setTimeout(r, 4000))
console.log(`request committed on anvil: requestId=${requestId} tx=${txHash}`)

// 2. Point the workflow config at the deployed receipt + account commitments
const cfgPath = join(root, 'workflows/trading-resume/config.local.json')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
cfg.receiptAddress = local.resumeReceipt
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')

// 3. Secrets for the simulator come from workflows/.env (local only; not confidential)
const envPath = join(root, 'workflows/.env')
let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
for (const c of creds) {
  const key = c.accountId === 'acct-bot-a' ? 'SECRET_SOURCE_CRED_A' : 'SECRET_SOURCE_CRED_B'
  env = env.split('\n').filter((l) => !l.startsWith(key + '=')).join('\n').replace(/\n*$/, '\n') + `${key}=${c.token}\n`
}
env = env.split('\n').filter((l) => !l.startsWith('CRE_ETH_PRIVATE_KEY=')).join('\n').replace(/\n*$/, '\n') + `CRE_ETH_PRIVATE_KEY=${ANVIL_KEY.slice(2)}\n`
writeFileSync(envPath, env, { mode: 0o600 })

// 4. Run the CRE CLI simulator
const payload = JSON.stringify({ requestId, runId: run.runId, market: run.market })
const args = ['workflow', 'simulate', 'trading-resume', '--target', 'local-settings', '--non-interactive', '--trigger-index', '0', '--http-payload', payload, '-e', '.env', '--allow-insecure-rpc']
if (broadcast) args.push('--broadcast')
console.log(`$ cre ${args.map((a) => (a.startsWith('{') ? `'${a}'` : a)).join(' ')}`)
const t0 = Date.now()
const res = spawnSync(cre, args, { cwd: join(root, 'workflows'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const out = (res.stdout ?? '') + (res.stderr ?? '')
console.log(out.split('\n').filter((l) => /USER LOG|SIMULATION\]|Workflow Simulation Result|✗|error|Error|TEE|tx/i.test(l)).join('\n'))
console.log(`cre exited ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
const m = out.match(/Workflow Simulation Result:\s*\n([\s\S]*?)\n\s*\n/)
if (!m) {
  writeFileSync(join(root, 'data/cre-last-output.log'), out)
  throw new Error('no simulation result found; full output in data/cre-last-output.log')
}
const result = JSON.parse(JSON.parse(m[1].trim()))
console.log(`certificate status=${result.certificate.status} digest=${result.certificateDigest} executionMode=${result.executionMode}`)
console.log(`net=${result.certificate.result?.netRealizedPnl ?? 'n/a'} fees=${result.certificate.result?.totalCommissions ?? 'n/a'} records=${result.certificate.recordCount} receipt=${JSON.stringify(result.receipt)}`)
writeFileSync(join(root, `data/cre-local-${accountId}.json`), JSON.stringify({ requestId, commitTx: txHash, payload: JSON.parse(payload), result, creStdout: out }, null, 2))
console.log(`saved data/cre-local-${accountId}.json`)
