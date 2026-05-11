// AUDIT ONLY — this script never executes any docker prune, docker rm, or docker rmi command.
import { z } from "zod"

import {
  findDiskCandidates,
  getDiskUsage,
  log,
  writeReport,
  type DiskCandidate,
  type MonitorReport,
} from "./docker-monitor.ts"

const Env = z.object({
  DANGLING_IMAGE_AGE_DAYS:   z.coerce.number().int().min(0).default(7),
  VOLUME_SIZE_MB_THRESHOLD:  z.coerce.number().min(0).default(500),
  REPORT_TOP_N:              z.coerce.number().int().min(1).max(100).default(10),
  DRY_RUN:                   z.enum(["true", "false"]).transform(v => v === "true").default("true"),
  BUILD_NUMBER:              z.string().default("0"),
  WORKSPACE:                 z.string().default("."),
})

async function main(): Promise<void> {
  const env = Env.safeParse(process.env)
  if (!env.success) {
    process.stderr.write(JSON.stringify({ error: "env validation failed", issues: env.error.issues }) + "\n")
    process.exit(1)
  }
  const { DANGLING_IMAGE_AGE_DAYS, VOLUME_SIZE_MB_THRESHOLD, REPORT_TOP_N, DRY_RUN, BUILD_NUMBER, WORKSPACE } = env.data

  log("info", "disk-audit", "starting", { ageDays: DANGLING_IMAGE_AGE_DAYS, volMb: VOLUME_SIZE_MB_THRESHOLD })

  const usage = await getDiskUsage()
  const allCandidates = findDiskCandidates(usage, DANGLING_IMAGE_AGE_DAYS, VOLUME_SIZE_MB_THRESHOLD)
  const topCandidates = allCandidates.slice(0, REPORT_TOP_N)

  const totalReclaimable = topCandidates.reduce((sum, c) => sum + c.sizeBytes, 0)
  log("info", "disk-audit", "candidates found", {
    total: allCandidates.length,
    shown: topCandidates.length,
    reclaimableBytes: totalReclaimable,
  })

  const report: MonitorReport<DiskCandidate> = {
    healthy: true,
    issues: topCandidates,
    reportPath: null,
    generatedAt: new Date().toISOString(),
  }

  // Disk audit always writes the report regardless of DRY_RUN (informational only, no side effects)
  const path = `${WORKSPACE}/disk-audit-${BUILD_NUMBER}.json`
  await writeReport(report, path)
  log("info", "disk-audit", "report written", { path, dryRun: DRY_RUN })

  // Always exit 0 — disk audit is informational; it never signals UNSTABLE
  process.exit(0)
}

main().catch(err => {
  process.stderr.write(JSON.stringify({ error: String(err) }) + "\n")
  process.exit(1)
})
