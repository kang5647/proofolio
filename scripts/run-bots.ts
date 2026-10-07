/**
 * Run both bots on the committed synthetic series and write their ledgers to data/runs/.
 * Usage: npm run bots:run [-- --runSuffix=demo]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MomentumStrategy, MeanReversionStrategy } from '../bots/src/index.ts'
import { COMMITTED_SEED, generateSeries, runBot } from '../simulator/src/index.ts'
import { computeAccounting, summarize } from '../packages/accounting/src/accounting.ts'

const suffix = process.argv.find((a) => a.startsWith('--runSuffix='))?.split('=')[1] ?? 'demo'
const outDir = join(process.cwd(), 'data', 'runs')
mkdirSync(outDir, { recursive: true })

const series = generateSeries(COMMITTED_SEED)
const bots = [
  { strategy: new MomentumStrategy(), accountId: 'acct-bot-a', runId: `run-bot-a-${suffix}` },
  { strategy: new MeanReversionStrategy(), accountId: 'acct-bot-b', runId: `run-bot-b-${suffix}` },
]

console.log(`SIMULATED MARKET  seed=${COMMITTED_SEED}  events=${series.length}  first=${series[0].ts}  last=${series.at(-1)!.ts}`)
for (const b of bots) {
  const run = runBot(b.strategy, series, { runId: b.runId, accountId: b.accountId, seed: COMMITTED_SEED })
  const acct = computeAccounting(run.records, { intervalStart: run.meta.intervalStart, intervalEnd: run.meta.intervalEnd })
  const s = summarize(acct)
  writeFileSync(join(outDir, `${b.runId}.json`), JSON.stringify(run, null, 2))
  console.log(`\n${b.strategy.name}  runId=${b.runId}`)
  console.log(`  fills=${s.fillCount} roundTrips=${s.completedRoundTrips} forcedCloses=${s.forcedCloses} rejects=${run.records.filter((r) => r.kind === 'reject').length}`)
  console.log(`  gross=${s.grossRealizedPnl} fees=${s.totalCommissions} net=${s.netRealizedPnl} reconciliation=${s.reconciliation}`)
  console.log(`  largest gross winning round-trip=${s.largestGrossWinningRoundTrip?.gross ?? 'none'}`)
  console.log(`  wrote data/runs/${b.runId}.json (${run.records.length} records)`)
}
