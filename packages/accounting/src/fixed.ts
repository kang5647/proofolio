/**
 * Fixed-point arithmetic for ProofDesk.
 *
 * Every monetary / quantity value is a bigint scaled by 10^8 ("units").
 * Decimal strings are the only external representation; floats never
 * touch money. This module must stay dependency-free and WASM-safe because
 * it is bundled into the CRE workflow as well as the Node services.
 */
export const DECIMALS = 8
export const SCALE = 10n ** BigInt(DECIMALS)

/** Parse a decimal string ("123.45", "-0.001") into scaled bigint. Throws on junk or excess precision. */
export function parseFixed(s: string): bigint {
  if (typeof s !== 'string' || !/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`invalid decimal string: ${JSON.stringify(s)}`)
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [intPart, fracPart = ''] = body.split('.')
  if (fracPart.length > DECIMALS) throw new Error(`too many decimals (${fracPart.length} > ${DECIMALS}): ${s}`)
  const frac = (fracPart + '0'.repeat(DECIMALS)).slice(0, DECIMALS)
  const v = BigInt(intPart) * SCALE + BigInt(frac)
  return neg ? -v : v
}

/** Format scaled bigint as a decimal string with exactly DECIMALS fraction digits. */
export function formatFixed(v: bigint): string {
  const neg = v < 0n
  const a = neg ? -v : v
  const intPart = a / SCALE
  const frac = (a % SCALE).toString().padStart(DECIMALS, '0')
  return `${neg ? '-' : ''}${intPart}.${frac}`
}

/** (a * b) / SCALE, exact when the true product has <= DECIMALS fraction digits; otherwise throws (we never silently lose precision). */
export function mulExact(a: bigint, b: bigint): bigint {
  const p = a * b
  if (p % SCALE !== 0n) throw new Error('mulExact: product has more than 8 decimals')
  return p / SCALE
}

/** Round-half-up division of a scaled product. Used only for fee computation, which is documented as round-half-up to 8 decimals. */
export function mulRoundHalfUp(a: bigint, bNumerator: bigint, bDenominator: bigint): bigint {
  const num = a * bNumerator
  const den = bDenominator
  const neg = (num < 0n) !== (den < 0n)
  const an = num < 0n ? -num : num
  const ad = den < 0n ? -den : den
  const q = (an + ad / 2n) / ad
  return neg ? -q : q
}

/** Floor a scaled quantity to a step (e.g. 0.0001 => step = 10^4 units). */
export function floorToStep(v: bigint, step: bigint): bigint {
  if (v < 0n) throw new Error('floorToStep: negative')
  return (v / step) * step
}
