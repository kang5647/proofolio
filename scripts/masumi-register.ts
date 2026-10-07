/**
 * Register the Proofolio verification coworker in the Masumi registry (Preprod) via the local
 * Masumi Payment Service, then poll until the registry NFT is minted and print the agentIdentifier.
 * Usage: AGENT_BASE_URL=https://<host>/agent npx tsx scripts/masumi-register.ts
 * Requires vendor/masumi.env (ADMIN_KEY), a funded Selling wallet, and MPS on :3001.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { TUSDM_UNIT } from '../services/verifier/src/payments.ts'

const env = Object.fromEntries(readFileSync('vendor/masumi.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.split('=', 2) as [string, string]))
const MPS = process.env.MASUMI_PAYMENT_SERVICE_URL ?? 'http://127.0.0.1:3001/api/v1'
const KEY = env.ADMIN_KEY
const BASE = process.env.AGENT_BASE_URL
if (!BASE) throw new Error('AGENT_BASE_URL required (public HTTPS base of the MIP-003 API)')
const PRICE = process.env.MASUMI_PRICE_ATOMIC ?? '1000000' // 1 tUSDM
const wallets = readFileSync('vendor/masumi-wallets.txt', 'utf8').split('\n').filter(Boolean).map((l) => l.split('|'))
const selling = wallets.find((w) => w[0] === 'Selling')!
const sellingVkey = selling[2]
const ps = await (await fetch(`${MPS}/payment-source/?take=5`, { headers: { token: KEY } })).json()
const source = ps.data.PaymentSources.find((s: any) => s.network === 'Preprod')
const call = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${MPS}${path}`, { ...init, headers: { 'content-type': 'application/json', token: KEY, ...(init.headers ?? {}) } })
  const t = await r.text()
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${r.status} ${t.slice(0, 400)}`)
  return JSON.parse(t).data ?? JSON.parse(t)
}

// The list endpoint is eventually consistent after the registry NFT confirms.
// Prefer the identifier saved by a previous successful run so re-running this
// script cannot create a duplicate while that list index catches up.
if (existsSync('vendor/masumi-agent.txt')) {
  const saved = Object.fromEntries(readFileSync('vendor/masumi-agent.txt', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2) as [string, string]))
  if (saved.MASUMI_AGENT_IDENTIFIER) {
    try {
      await call(`/registry/agent-identifier/?network=Preprod&agentIdentifier=${encodeURIComponent(saved.MASUMI_AGENT_IDENTIFIER)}`)
      console.log(`already registered: agentIdentifier=${saved.MASUMI_AGENT_IDENTIFIER} state=RegistrationConfirmed`)
      process.exit(0)
    } catch (error) {
      console.warn(`saved registry identifier is not currently readable; checking local MPS records: ${String(error)}`)
    }
  }
}

const existing = await call(`/registry/?network=Preprod&filterPaymentSourceType=Web3CardanoV2&limit=50`)
const mine = (existing.Assets ?? []).find((a: any) => a.name === 'Proofolio' && a.state !== 'DeregistrationConfirmed')
if (mine?.agentIdentifier) {
  console.log(`already registered: agentIdentifier=${mine.agentIdentifier} state=${mine.state}`)
} else {
  const body = {
    network: 'Preprod',
    type: 'Standard',
    sellingWalletVkey: sellingVkey,
    name: 'Proofolio',
    description: 'Paid verification of a trading bot\'s scoped results: certificate + on-chain receipt, no trade history delivered. Simulated-market demo.',
    apiBaseUrl: BASE,
    Tags: ['verification', 'trading', 'proof', 'chainlink-cre', 'proofdesk'],
    Capability: { name: 'ProofDesk scoped-PnL verifier (CRE confidential workflow)', version: '1.0.0' },
    Author: { name: 'ProofDesk', organization: 'ProofDesk (TOKEN2049 Origins)', contactEmail: process.env.AUTHOR_EMAIL ?? 'dev@clustly.ai' },
    Legal: {},
    ExampleOutputs: [{ name: 'certificate-example', url: `${BASE.replace(/\/agent$/, '')}/api/state`, mimeType: 'application/json' }],
    supportedPaymentSources: [
      { chain: 'Cardano', network: 'Preprod', paymentSourceType: 'Web3CardanoV2', address: source.smartContractAddress, pricing: { pricingType: 'Fixed', fixed: [{ asset: TUSDM_UNIT, amount: PRICE }] } },
    ],
  }
  const reg = await call('/registry/', { method: 'POST', body: JSON.stringify(body) })
  console.log(`registration requested: id=${reg.id} state=${reg.state}`)
}
// Poll for the minted identifier (MPS batches registrations; expect minutes).
for (let i = 0; i < 60; i++) {
  const r = await call(`/registry/?network=Preprod&filterPaymentSourceType=Web3CardanoV2&limit=50`)
  const a = (r.Assets ?? []).find((x: any) => x.name === 'Proofolio' && x.state !== 'DeregistrationConfirmed')
  if (a?.agentIdentifier && a.state === 'RegistrationConfirmed') {
    console.log(`REGISTERED agentIdentifier=${a.agentIdentifier}`)
    writeFileSync('vendor/masumi-agent.txt', `MASUMI_AGENT_IDENTIFIER=${a.agentIdentifier}\nMASUMI_SELLER_VKEY=${sellingVkey}\nMASUMI_CONTRACT=${source.smartContractAddress}\n`)
    process.exit(0)
  }
  console.log(`state=${a?.state ?? 'unknown'} (${i})`)
  await new Promise((res) => setTimeout(res, 20_000))
}
console.log('timed out waiting for RegistrationConfirmed; re-run later')
