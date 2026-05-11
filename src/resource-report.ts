import { z } from "zod"

import {
  findResourceBreaches,
  getContainerList,
  getContainerStats,
  log,
  writeReport,
  type MonitorReport,
  type ResourceBreach,
} from "./docker-monitor.ts"

const Env = z.object({
  CPU_THRESHOLD_PCT: z.coerce.number().min(0).max(100).default(80),
  MEM_THRESHOLD_PCT: z.coerce.number().min(0).max(100).default(85),
  CONTAINER_FILTER:  z.string().default(""),
  DRY_RUN:           z.enum(["true", "false"]).transform(v => v === "true").default("true"),
  BUILD_NUMBER:      z.string().default("0"),
  WORKSPACE:         z.string().default("."),
})

async function main(): Promise<void> {
  const env = Env.safeParse(process.env)
  if (!env.success) {
    process.stderr.write(JSON.stringify({ error: "env validation failed", issues: env.error.issues }) + "\n")
    process.exit(1)
  }
  const { CPU_THRESHOLD_PCT, MEM_THRESHOLD_PCT, CONTAINER_FILTER, DRY_RUN, BUILD_NUMBER, WORKSPACE } = env.data

  log("info", "resource-report", "starting", { cpuThreshold: CPU_THRESHOLD_PCT, memThreshold: MEM_THRESHOLD_PCT })

  let containers = await getContainerList()
  if (CONTAINER_FILTER) {
    containers = containers.filter(c => c.name.startsWith(CONTAINER_FILTER))
  }
  const runningIds = new Set(containers.filter(c => c.status === "running").map(c => c.name))

  const allStats = await getContainerStats()
  const stats = allStats.filter(s => runningIds.has(s.name))

  const breaches = findResourceBreaches(stats, CPU_THRESHOLD_PCT, MEM_THRESHOLD_PCT)
  for (const b of breaches) {
    log("warn", "resource-report", "threshold breach", {
      container: b.name, metric: b.metric, actual: b.actual, threshold: b.threshold,
    })
  }

  const report: MonitorReport<ResourceBreach> = {
    healthy: breaches.length === 0,
    issues: breaches,
    reportPath: null,
    generatedAt: new Date().toISOString(),
  }

  if (!DRY_RUN) {
    const path = `${WORKSPACE}/resource-report-${BUILD_NUMBER}.json`
    await writeReport(report, path)
    log("info", "resource-report", "report written", { path })
  }

  log("info", "resource-report", "complete", { checked: stats.length, breaches: breaches.length })
  process.exit(breaches.length > 0 ? 2 : 0)
}

main().catch(err => {
  process.stderr.write(JSON.stringify({ error: String(err) }) + "\n")
  process.exit(1)
})
