import { z } from "zod"

import {
  classifyContainerHealth,
  getContainerList,
  log,
  writeReport,
  type MonitorReport,
} from "./docker-monitor.ts"

const Env = z.object({
  RESTART_THRESHOLD: z.coerce.number().int().min(1).default(5),
  INCLUDE_STOPPED:   z.enum(["true", "false"]).transform(v => v === "true").default("true"),
  DRY_RUN:           z.enum(["true", "false"]).transform(v => v === "true").default("true"),
  WORKSPACE:         z.string().default("."),
})

type Issue = { name: string; id: string; classification: string; restartCount: number }

async function main(): Promise<void> {
  const env = Env.safeParse(process.env)
  if (!env.success) {
    process.stderr.write(JSON.stringify({ error: "env validation failed", issues: env.error.issues }) + "\n")
    process.exit(1)
  }
  const { RESTART_THRESHOLD, INCLUDE_STOPPED, DRY_RUN, WORKSPACE } = env.data

  log("info", "health-sweep", "starting", { dryRun: DRY_RUN, restartThreshold: RESTART_THRESHOLD })

  let containers = await getContainerList()
  if (!INCLUDE_STOPPED) {
    containers = containers.filter(c => c.status === "running")
  }

  const issues: Issue[] = []
  for (const c of containers) {
    const classification = classifyContainerHealth(c, RESTART_THRESHOLD)
    if (classification !== "healthy") {
      issues.push({ name: c.name, id: c.id, classification, restartCount: c.restartCount })
      log("warn", "health-sweep", `container issue detected`, {
        container: c.name,
        classification,
        restartCount: c.restartCount,
      })
    }
  }

  const report: MonitorReport<Issue> = {
    healthy: issues.length === 0,
    issues,
    reportPath: null,
    generatedAt: new Date().toISOString(),
  }

  if (!DRY_RUN) {
    const path = `${WORKSPACE}/health-report.json`
    await writeReport(report, path)
    log("info", "health-sweep", `report written`, { path })
  }

  log("info", "health-sweep", "complete", { total: containers.length, issues: issues.length })
  process.exit(issues.length > 0 ? 2 : 0)
}

main().catch(err => {
  process.stderr.write(JSON.stringify({ error: String(err) }) + "\n")
  process.exit(1)
})
