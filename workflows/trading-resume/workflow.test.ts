import { describe, expect } from 'bun:test'
import type { HTTPPayload, TeeRuntime } from '@chainlink/cre-sdk'
import { test } from '@chainlink/cre-sdk/test'
import { encodeAbiParameters, encodeFunctionResult, keccak256, stringToBytes, hexToBytes, toHex } from 'viem'
import { initWorkflow, onVerifyRequest, RESUME_RECEIPT_ABI, type Config } from './workflow'
import { paginate } from '../../packages/accounting/src/pages'
import { runBot } from '../../simulator/src/market'
import { generateSeries, COMMITTED_SEED } from '../../simulator/src/series'
import { MomentumStrategy } from '../../bots/src/momentum'

const TOKEN = 'pd_demo_test_token'
const series = generateSeries(COMMITTED_SEED)
const run = runBot(new MomentumStrategy(), series, { runId: 'run-test', accountId: 'acct-bot-a', seed: COMMITTED_SEED })
const pages = paginate(run.meta, run.records, 40)
const REQUEST_ID = ('0x' + '11'.repeat(32)) as `0x${string}`
const NONCE = ('0x' + '22'.repeat(32)) as `0x${string}`
const now = new Date('2026-10-07T00:00:00.000Z')
const sec = (iso: string) => BigInt(Math.floor(Date.parse(iso) / 1000))

const config: Config = {
  chainSelectorName: 'anvil-devnet',
  receiptAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  sourceBaseUrl: 'http://127.0.0.1:4100',
  accounts: [{ accountId: 'acct-bot-a', credentialRef: 'SOURCE_CRED_A' }],
  methodologyVersion: 'proofdesk-accounting/1.0.0',
  maxPages: 12,
  certificateTtlSeconds: 86400,
  executionMode: 'local-simulation',
  authorizedEVMAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
}

function requestStruct(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    buyer: '0x00000000000000000000000000000000000000b0' as `0x${string}`,
    accountCommitment: run.meta.accountCommitment,
    runIdHash: keccak256(stringToBytes(run.meta.runId)),
    marketHash: keccak256(stringToBytes(run.meta.market)),
    intervalStart: sec(run.meta.intervalStart),
    intervalEnd: sec(run.meta.intervalEnd),
    methodologyHash: keccak256(stringToBytes(config.methodologyVersion)),
    nonce: NONCE,
    expiresAt: sec('2026-10-08T00:00:00.000Z'),
    committedAt: sec('2026-10-06T00:00:00.000Z'),
    ...overrides,
  }
}

type Fake = { pagesServed?: Array<unknown>; missingAt?: number; request?: ReturnType<typeof requestStruct> }

function makeRuntime(f: Fake = {}) {
  const logs: string[] = []
  const reports: unknown[] = []
  const writes: unknown[] = []
  const authHeaders: string[] = []
  const served = f.pagesServed ?? pages
  const req = f.request ?? requestStruct()
  const callCapability = ({ payload }: any) => {
    // HTTP client call (TEE) — has url
    if (payload?.url) {
      const auth = payload.multiHeaders?.Authorization?.values?.[0]
      authHeaders.push(auth)
      const url = new URL(payload.url)
      const cursor = url.searchParams.get('cursor')
      const idx = cursor ? served.findIndex((p: any) => p.cursor === cursor) : 0
      if (f.missingAt !== undefined && idx === f.missingAt) return { result: () => ({ statusCode: 404, body: new TextEncoder().encode('{}') }) }
      return { result: () => ({ statusCode: 200, body: new TextEncoder().encode(JSON.stringify(served[idx])) }) }
    }
    // EVM callContract (DON)
    if (payload?.call) {
      const data = encodeFunctionResult({ abi: RESUME_RECEIPT_ABI, functionName: 'getRequest', result: req })
      return { result: () => ({ data: hexToBytes(data) }) }
    }
    // EVM writeReport (DON)
    if (payload?.receiver) {
      writes.push(payload)
      return { result: () => ({ txStatus: 2, txHash: hexToBytes(('0x' + 'ab'.repeat(32)) as `0x${string}`), receiverContractExecutionStatus: 0 }) }
    }
    throw new Error('unexpected capability call ' + JSON.stringify(Object.keys(payload ?? {})))
  }
  const don = {
    config,
    now: () => now,
    log: (m: string) => logs.push(m),
    callCapability,
    report: (input: unknown) => {
      reports.push(input)
      return { result: () => ({ x_generatedCodeOnly_unwrap: () => ({}) }) }
    },
  }
  const runtime = {
    config,
    now: () => now,
    log: (m: string) => logs.push(m),
    getSecret: ({ id }: { id?: string }) => ({ result: () => ({ id, value: TOKEN }) }),
    callCapability,
    usingTheDons: () => don,
  }
  return { runtime: runtime as unknown as TeeRuntime<Config>, logs, reports, writes, authHeaders }
}

const payload = (input: object) => ({ input: new TextEncoder().encode(JSON.stringify(input)) }) as unknown as HTTPPayload
const trigger = payload({ requestId: REQUEST_ID, runId: run.meta.runId, market: run.meta.market })

describe('onVerifyRequest', () => {
  test('verifies a complete run, releases only the certificate, writes the receipt', () => {
    const { runtime, reports, writes, authHeaders, logs } = makeRuntime()
    const out = JSON.parse(onVerifyRequest(runtime, trigger))
    expect(out.certificate.status).toBe('VERIFIED')
    expect(out.certificate.result.reconciliation).toBe('ok')
    expect(out.certificate.executionMode).toBe('local-simulation')
    expect(out.receipt.txStatus).toBe('SUCCESS')
    expect(reports).toHaveLength(1)
    expect(writes).toHaveLength(1)
    expect(authHeaders.every((h) => h === `Bearer ${TOKEN}`)).toBe(true)
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain('"kind":"fill"')
    for (const l of logs) {
      expect(l).not.toContain(TOKEN)
      expect(l).not.toContain('cashAfter')
    }
  })

  test('missing page -> UNVERIFIABLE certificate with null result, still delivered', () => {
    const { runtime } = makeRuntime({ missingAt: 1 })
    const out = JSON.parse(onVerifyRequest(runtime, trigger))
    expect(out.certificate.status).toBe('UNVERIFIABLE')
    expect(out.certificate.result).toBeNull()
    expect(out.certificate.reasons.join('|')).toContain('unavailable')
  })

  test('runId not matching the committed hash -> UNVERIFIABLE without touching the source', () => {
    const { runtime, authHeaders } = makeRuntime()
    const out = JSON.parse(onVerifyRequest(runtime, payload({ requestId: REQUEST_ID, runId: 'another-run', market: run.meta.market })))
    expect(out.certificate.status).toBe('UNVERIFIABLE')
    expect(authHeaders).toHaveLength(0)
  })

  test('uncommitted request throws (no certificate issued)', () => {
    const { runtime } = makeRuntime({ request: requestStruct({ committedAt: 0n }) })
    expect(() => onVerifyRequest(runtime, trigger)).toThrow('not committed')
  })

  test('unknown account commitment -> UNVERIFIABLE, secret never requested', () => {
    const other = ('0x' + '99'.repeat(32)) as `0x${string}`
    const { runtime, authHeaders } = makeRuntime({ request: requestStruct({ accountCommitment: other }) })
    const out = JSON.parse(onVerifyRequest(runtime, trigger))
    expect(out.certificate.status).toBe('UNVERIFIABLE')
    expect(out.certificate.reasons[0]).toContain('no source credential')
    expect(authHeaders).toHaveLength(0)
  })
})

describe('initWorkflow', () => {
  test('registers one HTTP-triggered TEE handler', () => {
    const handlers = initWorkflow(config)
    expect(handlers).toHaveLength(1)
    expect(handlers[0].fn).toBe(onVerifyRequest)
    expect(handlers[0].requirements).toBeDefined()
  })
})
