/**
 * Explanation text for the buyer's decision. Deterministic template by default; if
 * ANTHROPIC_API_KEY is set, Claude rewrites the SAME facts into prose. The model never
 * sees raw fills, never computes money, and cannot change the decision.
 */
import type { Certificate } from '../../../packages/accounting/src/certificate.ts'
import type { Decision } from './verify-certificate.ts'

export interface CandidateSummary {
  name: string
  presentation: 'selective' | 'complete'
  publicClaim: string
  certificate: Certificate | null
  evidence: 'VALID' | 'INVALID' | 'MISSING'
  decision: Decision
  rule: string
}

export function templateExplanation(cands: CandidateSummary[]): string {
  const lines = cands.map((c) => {
    const r = c.certificate?.result
    const fin = r ? `scoped net ${r.netRealizedPnl} USDT (gross ${r.grossRealizedPnl}, fees ${r.totalCommissions}, ${r.completedRoundTrips} round-trips, largest single win ${r.largestGrossWinningRoundTrip?.gross ?? 'none'})` : `no financial result (${c.certificate?.status ?? 'no certificate'})`
    return `${c.name}: public claim "${c.publicClaim}" (${c.presentation} presentation). Evidence ${c.evidence}; ${fin}. Decision: ${c.decision} because ${c.rule}.`
  })
  return [
    'Evidence status is separate from financial outcome. All results come from a synthetic simulated market and a local CRE simulation unless the certificate says deployed-confidential; they cannot qualify anyone as a genuinely profitable trader.',
    ...lines,
    'A shortlist means "worth further evaluation", not an allocation of capital.',
  ].join('\n')
}

export async function explain(cands: CandidateSummary[]): Promise<{ text: string; source: 'template' | 'claude' }> {
  const base = templateExplanation(cands)
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return { text: base, source: 'template' }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
        max_tokens: 400,
        system: 'You rewrite a buyer agent\'s verification summary into 3-5 plain sentences for a hiring manager. Use ONLY the numbers and decisions given. Do not add, round, or infer any figure, and do not give investment advice. Keep every caveat about simulated data.',
        messages: [{ role: 'user', content: base }],
      }),
    })
    if (!res.ok) return { text: base, source: 'template' }
    const j = (await res.json()) as { content?: { type: string; text?: string }[] }
    const text = j.content?.find((c) => c.type === 'text')?.text?.trim()
    return text ? { text: `${text}\n\n(Facts as computed: )\n${base}`, source: 'claude' } : { text: base, source: 'template' }
  } catch {
    return { text: base, source: 'template' }
  }
}
