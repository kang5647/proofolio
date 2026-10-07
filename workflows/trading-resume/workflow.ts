/**
 * ProofDesk "trading-resume" Confidential Workflow.
 *
 *   HTTP trigger {requestId, runId, market}
 *     -> (DON)  read committed request scope from ResumeReceipt on the configured EVM chain
 *     -> (TEE)  fetch the source credential for the account commitment
 *     -> (TEE)  fetch every authorised source page (bearer auth) and run deterministic accounting
 *     -> (DON)  release ONLY the certificate summary + digest-bound receipt payload, sign, writeReport
 *
 * Confidentiality boundary: the token, raw fills and intermediate balances stay in the TEE handler.
 * The DON sees the certificate (scoped summary) and the ABI receipt payload. In the local
 * simulator none of this is a real enclave; the certificate carries executionMode accordingly.
 *
 * Financial arithmetic is shared verbatim with the Node services (packages/accounting).
 */
import { bytesToHex, cre, decodeJson, encodeCallMsg, getNetwork, hexToBase64, LAST_FINALIZED_BLOCK_NUMBER, ok, prepareReportRequest, text, TxStatus, type HTTPPayload, type Runtime, type TeeRuntime } from '@chainlink/cre-sdk'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToBytes, zeroAddress, type Address, type Hex } from 'viem'
import { z } from 'zod'
import type { SourcePage } from '../../packages/accounting/src/ledger.ts'
import { sha256Utf8 } from '../../packages/accounting/src/canonical.ts'
import { verifyRun, type RequestScope, type VerificationOutcome } from '../../packages/accounting/src/verify.ts'
import { buildCertificate, certificateDigest, encodeReceiptPayload, type Certificate, type ExecutionMode } from '../../packages/accounting/src/certificate.ts'

// ─── Config ─────────────────────────────────────────────────
export const configSchema = z.object({
  chainSelectorName: z.string(),
  receiptAddress: z.string(),
  /** allow-listed source origin; the workflow never fetches anywhere else */
  sourceBaseUrl: z.string().regex(/^https?:\/\/[^\s/]+$/, 'origin only, no path'),
  accounts: z.array(z.object({ accountId: z.string(), credentialRef: z.string() })),
  methodologyVersion: z.string(),
  maxPages: z.number().int().min(1).max(12),
  certificateTtlSeconds: z.number().int().min(60),
  executionMode: z.enum(['local-simulation', 'deployed-confidential']),
  /** 0x address allowed to fire the HTTP trigger (EVM ECDSA key) */
  authorizedEVMAddress: z.string(),
})
export type Config = z.infer<typeof configSchema>

export const RESUME_RECEIPT_ABI = parseAbi([
  'struct Request { address buyer; bytes32 accountCommitment; bytes32 runIdHash; bytes32 marketHash; uint64 intervalStart; uint64 intervalEnd; bytes32 methodologyHash; bytes32 nonce; uint64 expiresAt; uint64 committedAt; }',
  'function getRequest(bytes32 requestId) view returns (Request)',
])

export interface TriggerInput {
  requestId: Hex
  runId: string
  market: string
}

export interface WorkflowOutput {
  certificate: Certificate
  certificateDigest: Hex
  receipt: { txHash: Hex | null; txStatus: string; receiverStatus: number | null } | null
  executionMode: ExecutionMode
  note: string
}

const isoFromSeconds = (s: bigint) => new Date(Number(s) * 1000).toISOString()

// ─── TEE handler ────────────────────────────────────────────
export const onVerifyRequest = (runtime: TeeRuntime<Config>, payload: HTTPPayload): string => {
  const config = runtime.config
  const input = decodeJson(payload.input) as TriggerInput
  if (!input?.requestId || !input.runId || !input.market) throw new Error('trigger input must contain requestId, runId, market')

  // Step 1 (DON): read the committed, immutable scope. Public data; no need for the enclave.
  const don = runtime.usingTheDons()
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.chainSelectorName, isTestnet: true })
  if (!network) throw new Error(`unknown network ${config.chainSelectorName}`)
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)
  const req = readRequest(don, evm, config.receiptAddress as Address, input.requestId)
  if (req.committedAt === 0n) throw new Error(`request ${input.requestId} is not committed on-chain`)
  runtime.log(`scope read: request=${input.requestId.slice(0, 10)}… buyer=${req.buyer} interval=[${isoFromSeconds(req.intervalStart)}, ${isoFromSeconds(req.intervalEnd)})`)

  const scopeReasons: string[] = []
  if (keccak256(stringToBytes(input.runId)) !== req.runIdHash) scopeReasons.push('runId does not match committed runIdHash')
  if (keccak256(stringToBytes(input.market)) !== req.marketHash) scopeReasons.push('market does not match committed marketHash')
  if (keccak256(stringToBytes(config.methodologyVersion)) !== req.methodologyHash) scopeReasons.push('methodology version does not match committed methodologyHash')
  const nowMs = runtime.now().getTime()
  if (BigInt(Math.floor(nowMs / 1000)) >= req.expiresAt) scopeReasons.push('request expired before verification')

  const scope: RequestScope = {
    runId: input.runId,
    accountCommitment: req.accountCommitment,
    market: input.market,
    intervalStart: isoFromSeconds(req.intervalStart),
    intervalEnd: isoFromSeconds(req.intervalEnd),
    methodologyVersion: config.methodologyVersion,
  }

  // Step 2+3 (TEE): credential + pages + accounting. Nothing from here is logged.
  let outcome: VerificationOutcome
  if (scopeReasons.length) {
    outcome = { status: 'UNVERIFIABLE', reasons: scopeReasons, recordCount: 0, completeness: 'incomplete', boundaryStatus: { startFlat: false, endFlat: false }, sourceAsOf: null, result: null }
  } else {
    outcome = fetchAndVerify(runtime, config, scope)
  }
  runtime.log(`enclave verification complete: status=${outcome.status} records=${outcome.recordCount} reasons=${outcome.reasons.length}`)

  // Step 4 (DON): release the certificate summary + receipt payload only.
  const certificate = buildCertificate(
    {
      requestId: input.requestId,
      buyer: req.buyer,
      accountCommitment: req.accountCommitment,
      runId: input.runId,
      market: input.market,
      intervalStart: scope.intervalStart,
      intervalEnd: scope.intervalEnd,
      methodologyVersion: config.methodologyVersion,
      nonce: req.nonce,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: isoFromSeconds(req.expiresAt),
      executionMode: config.executionMode,
      executionEngine: config.executionMode === 'deployed-confidential' ? 'cre-deployed' : 'cre-simulate',
    },
    outcome,
  )
  const digest = certificateDigest(certificate)
  const receiptPayload = encodeReceiptPayload(certificate)

  const report = don.report(prepareReportRequest(receiptPayload)).result()
  const write = evm.writeReport(don, { receiver: config.receiptAddress, report }).result()
  const txHash = write.txHash && write.txHash.length ? bytesToHex(write.txHash) : null
  runtime.log(`receipt write: status=${TxStatus[write.txStatus] ?? write.txStatus} tx=${txHash ?? 'dry-run'} digest=${digest.slice(0, 10)}…`)
  if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`receipt write failed: ${write.errorMessage || write.txStatus}`)

  const out: WorkflowOutput = {
    certificate,
    certificateDigest: digest,
    receipt: { txHash, txStatus: TxStatus[write.txStatus] ?? String(write.txStatus), receiverStatus: write.receiverContractExecutionStatus ?? null },
    executionMode: config.executionMode,
    note:
      config.executionMode === 'local-simulation'
        ? 'CRE LOCAL SIMULATION: not a real TEE, no DON consensus. Dry run unless --broadcast.'
        : 'Deployed confidential workflow execution.',
  }
  return JSON.stringify(out)
}

function readRequest(don: Runtime<Config>, evm: InstanceType<typeof cre.capabilities.EVMClient>, receipt: Address, requestId: Hex) {
  const data = encodeFunctionData({ abi: RESUME_RECEIPT_ABI, functionName: 'getRequest', args: [requestId] })
  const res = evm.callContract(don, { call: encodeCallMsg({ from: zeroAddress, to: receipt, data }), blockNumber: LAST_FINALIZED_BLOCK_NUMBER }).result()
  return decodeFunctionResult({ abi: RESUME_RECEIPT_ABI, functionName: 'getRequest', data: bytesToHex(res.data) })
}

function fetchAndVerify(runtime: TeeRuntime<Config>, config: Config, scope: RequestScope): VerificationOutcome {
  // Commitment = sha256("proofdesk-account-commitment/1|runId|accountId"); accountId is public, the credential is not.
  const account = config.accounts.find((a) => sha256Utf8(`proofdesk-account-commitment/1|${scope.runId}|${a.accountId}`).toLowerCase() === scope.accountCommitment.toLowerCase())
  if (!account) {
    return { status: 'UNVERIFIABLE', reasons: ['no source credential provisioned for this account commitment'], recordCount: 0, completeness: 'incomplete', boundaryStatus: { startFlat: false, endFlat: false }, sourceAsOf: null, result: null }
  }
  // Vault secret released only into the enclave (simulator: from .env).
  const token = runtime.getSecret({ id: account.credentialRef }).result().value
  const http = new cre.capabilities.HTTPClient()
  const pages: SourcePage[] = []
  const fetchReasons: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < config.maxPages; i++) {
    const url = `${config.sourceBaseUrl}/private/runs/${encodeURIComponent(scope.runId)}/pages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    const resp = http.sendRequest(runtime, { url, method: 'GET', multiHeaders: { Authorization: { values: [`Bearer ${token}`] } } }).result()
    if (!ok(resp)) {
      fetchReasons.push(`source page ${i} unavailable (HTTP ${resp.statusCode})`)
      break
    }
    const page = JSON.parse(text(resp)) as SourcePage
    pages.push(page)
    if (page.final || !page.nextCursor) break
    cursor = page.nextCursor
    if (i === config.maxPages - 1) fetchReasons.push('page limit reached before final page')
  }
  const outcome = verifyRun(pages, scope)
  if (fetchReasons.length) {
    return { ...outcome, status: 'UNVERIFIABLE', result: null, reasons: [...fetchReasons, ...outcome.reasons] }
  }
  return outcome
}

// ─── Init ───────────────────────────────────────────────────
export function initWorkflow(config: Config) {
  const httpTrigger = new cre.capabilities.HTTPCapability()
  return [
    cre.handlerInTee(
      httpTrigger.trigger({ authorizedKeys: [{ type: 'KEY_TYPE_ECDSA_EVM', publicKey: config.authorizedEVMAddress }] }),
      onVerifyRequest,
      [{ tee: 'nitro', regions: ['us-west-2'] }],
    ),
  ]
}
