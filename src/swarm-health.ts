import { z } from "zod"

import {
  classifySwarmHealth,
  getSwarmNodes,
  getSwarmServices,
  getSwarmTaskFailures,
  isSwarmActive,
  log,
  writeReport,
  type MonitorReport,
  type SwarmHealthSummary,
} from "./docker-monitor.ts"

const Env = z.object({
  TASK_FAILURE_WINDOW_MINUTES: z.coerce.number().int().min(1).default(30),
  TASK_FAILURE_THRESHOLD:      z.coerce.number().int().min(1).default(3),
  DRY_RUN:                     z.enum(["true", "false"]).transform(v => v === "true").default("true"),
  BUILD_NUMBER:                z.string().default("0"),
  WORKSPACE:                   z.string().default("."),
})

async function main(): Promise<void> {
  const env = Env.safeParse(process.env)
  if (!env.success) {
    process.stderr.write(JSON.stringify({ error: "env validation failed", issues: env.error.issues }) + "\n")
    process.exit(1)
  }
  const { TASK_FAILURE_WINDOW_MINUTES, TASK_FAILURE_THRESHOLD, DRY_RUN, BUILD_NUMBER, WORKSPACE } = env.data

  log("info", "swarm-health", "starting", { windowMinutes: TASK_FAILURE_WINDOW_MINUTES, threshold: TASK_FAILURE_THRESHOLD })

  // Fail fast if Swarm is not active — requires manager node
  const active = await isSwarmActive()
  if (!active) {
    log("error", "swarm-health", "Docker Swarm is not active or this node is not a manager. Cannot run Swarm health checks.")
    process.exit(1)
  }

  const since = new Date(Date.now() - TASK_FAILURE_WINDOW_MINUTES * 60 * 1_000).toISOString()
  const [nodes, services, tasks] = await Promise.all([
    getSwarmNodes(),
    getSwarmServices(),
    getSwarmTaskFailures(since),
  ])

  const summary = classifySwarmHealth(nodes, services, tasks, TASK_FAILURE_THRESHOLD)

  for (const svc of summary.servicesDegraded) {
    log("warn", "swarm-health", "service degraded", {
      service: svc.name, running: svc.runningReplicas, desired: svc.desiredReplicas,
    })
  }
  if (summary.nodesDown > 0) {
    log("warn", "swarm-health", "nodes down", { count: summary.nodesDown })
  }
  if (summary.recentTaskFailures.length > 0) {
    log("warn", "swarm-health", "task failures detected", { count: summary.recentTaskFailures.length })
  }

  const report: MonitorReport<SwarmHealthSummary> = {
    healthy: summary.healthy,
    issues: summary.healthy ? [] : [summary],
    reportPath: null,
    generatedAt: new Date().toISOString(),
  }

  if (!DRY_RUN) {
    const path = `${WORKSPACE}/swarm-health-${BUILD_NUMBER}.json`
    await writeReport(report, path)
    log("info", "swarm-health", "report written", { path })
  }

  log("info", "swarm-health", "complete", { healthy: summary.healthy, nodesDown: summary.nodesDown })
  process.exit(summary.healthy ? 0 : 2)
}

main().catch(err => {
  process.stderr.write(JSON.stringify({ error: String(err) }) + "\n")
  process.exit(1)
})
