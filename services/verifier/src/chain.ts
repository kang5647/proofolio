/**
 * Thin viem client for the ResumeReceipt consumer (Sepolia or local anvil).
 * Used by the verifier (commit requests, local mock-forward) and the buyer (verify receipts).
 */
import { createPublicClient, createWalletClient, encodeAbiParameters, encodePacked, http, keccak256, parseAbi, parseAbiParameters, stringToBytes, type Address, type Chain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia, anvil } from 'viem/chains'

export const RESUME_RECEIPT_ABI = parseAbi([
  'struct Request { address buyer; bytes32 accountCommitment; bytes32 runIdHash; bytes32 marketHash; uint64 intervalStart; uint64 intervalEnd; bytes32 methodologyHash; bytes32 nonce; uint64 expiresAt; uint64 committedAt; }',
  'struct Receipt { bytes32 certDigest; uint8 status; uint64 recordedAt; bool exists; }',
  'function computeRequestId(address buyer, bytes32 accountCommitment, bytes32 runIdHash, bytes32 marketHash, uint64 intervalStart, uint64 intervalEnd, bytes32 methodologyHash, bytes32 nonce, uint64 expiresAt) pure returns (bytes32)',
  'function commitRequest(bytes32 requestId, address buyer, bytes32 accountCommitment, bytes32 runIdHash, bytes32 marketHash, uint64 intervalStart, uint64 intervalEnd, bytes32 methodologyHash, bytes32 nonce, uint64 expiresAt)',
  'function getRequest(bytes32 requestId) view returns (Request)',
  'function getReceipt(bytes32 requestId) view returns (Receipt)',
  'function verifyReceipt(bytes32 requestId, bytes32 certDigest) view returns (bool ok, string reason)',
  'function getForwarderAddress() view returns (address)',
])

export const MOCK_FORWARDER_ABI = parseAbi(['function forward(address receiver, bytes metadata, bytes report)'])

export interface RequestFields {
  buyer: Address
  accountCommitment: Hex
  runId: string
  market: string
  intervalStart: string // ISO
  intervalEnd: string // ISO
  methodologyVersion: string
  nonce: Hex
  expiresAt: string // ISO
}

const sec = (iso: string) => BigInt(Math.floor(Date.parse(iso) / 1000))

/** Mirrors ResumeReceipt.computeRequestId exactly. */
export function computeRequestId(f: RequestFields): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('string, address, bytes32, bytes32, bytes32, uint64, uint64, bytes32, bytes32, uint64'), [
      'proofdesk-request/1',
      f.buyer,
      f.accountCommitment,
      keccak256(stringToBytes(f.runId)),
      keccak256(stringToBytes(f.market)),
      sec(f.intervalStart),
      sec(f.intervalEnd),
      keccak256(stringToBytes(f.methodologyVersion)),
      f.nonce,
      sec(f.expiresAt),
    ]),
  )
}

export type ChainName = 'sepolia' | 'anvil'

export function chainFor(name: ChainName): Chain {
  return name === 'sepolia' ? sepolia : anvil
}

export function explorerTx(name: ChainName, hash: Hex): string | null {
  return name === 'sepolia' ? `https://sepolia.etherscan.io/tx/${hash}` : null
}
export function explorerAddress(name: ChainName, addr: Address): string | null {
  return name === 'sepolia' ? `https://sepolia.etherscan.io/address/${addr}` : null
}

export class ReceiptChain {
  readonly pub
  constructor(
    readonly chainName: ChainName,
    readonly rpcUrl: string,
    readonly receipt: Address,
  ) {
    this.pub = createPublicClient({ chain: chainFor(chainName), transport: http(rpcUrl) })
  }

  wallet(privateKey: Hex) {
    return createWalletClient({ account: privateKeyToAccount(privateKey), chain: chainFor(this.chainName), transport: http(this.rpcUrl) })
  }

  async commitRequest(privateKey: Hex, f: RequestFields): Promise<{ requestId: Hex; txHash: Hex }> {
    const requestId = computeRequestId(f)
    const w = this.wallet(privateKey)
    const txHash = await w.writeContract({
      address: this.receipt,
      abi: RESUME_RECEIPT_ABI,
      functionName: 'commitRequest',
      args: [requestId, f.buyer, f.accountCommitment, keccak256(stringToBytes(f.runId)), keccak256(stringToBytes(f.market)), sec(f.intervalStart), sec(f.intervalEnd), keccak256(stringToBytes(f.methodologyVersion)), f.nonce, sec(f.expiresAt)],
    })
    await this.pub.waitForTransactionReceipt({ hash: txHash })
    return { requestId, txHash }
  }

  async getRequest(requestId: Hex) {
    return this.pub.readContract({ address: this.receipt, abi: RESUME_RECEIPT_ABI, functionName: 'getRequest', args: [requestId] })
  }

  async getReceipt(requestId: Hex) {
    return this.pub.readContract({ address: this.receipt, abi: RESUME_RECEIPT_ABI, functionName: 'getReceipt', args: [requestId] })
  }

  async verifyReceipt(requestId: Hex, certDigest: Hex): Promise<{ ok: boolean; reason: string }> {
    const [ok, reason] = await this.pub.readContract({ address: this.receipt, abi: RESUME_RECEIPT_ABI, functionName: 'verifyReceipt', args: [requestId, certDigest] })
    return { ok, reason }
  }

  /** LOCAL SIMULATION ONLY: deliver a report through the MockForwarder (stands in for the Keystone forwarder). */
  async mockForward(privateKey: Hex, forwarder: Address, reportPayload: Hex, workflowOwner: Address): Promise<Hex> {
    const metadata = encodePacked(['bytes32', 'bytes10', 'address'], [keccak256(stringToBytes('proofdesk-local-workflow')), '0x00000000000000000000', workflowOwner])
    const w = this.wallet(privateKey)
    const hash = await w.writeContract({ address: forwarder, abi: MOCK_FORWARDER_ABI, functionName: 'forward', args: [this.receipt, metadata, reportPayload] })
    await this.pub.waitForTransactionReceipt({ hash })
    return hash
  }
}
