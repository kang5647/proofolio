/**
 * ProofDesk canonical JSON + digest.
 *
 * Rules (proofdesk-canonical/1):
 *  - object keys sorted by UTF-16 code unit order, recursively
 *  - no whitespace
 *  - `undefined` values are omitted; `null` is kept
 *  - numbers must be safe integers (money is always a decimal string); anything else throws
 *  - strings escaped exactly as JSON.stringify does
 * Digest = sha256(utf8(canonical)) as lowercase hex with 0x prefix.
 *
 * NOTE: this digest is ProofDesk's certificate digest. It is NOT the Masumi
 * input/result hash; those use Masumi's own library/schema.
 */
import { sha256, stringToBytes } from 'viem'

export const CANONICAL_VERSION = 'proofdesk-canonical/1'

export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error(`canonicalize: non-integer number ${value} (use decimal strings for money)`)
      return String(value)
    case 'bigint':
      throw new Error('canonicalize: bigint not allowed; format to a decimal string first')
    case 'undefined':
      throw new Error('canonicalize: undefined at top level')
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',') + ']'
      }
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}'
    }
    default:
      throw new Error(`canonicalize: unsupported type ${typeof value}`)
  }
}

export function digestCanonical(value: unknown): `0x${string}` {
  return sha256(stringToBytes(canonicalize(value)))
}

export function sha256Utf8(s: string): `0x${string}` {
  return sha256(stringToBytes(s))
}
