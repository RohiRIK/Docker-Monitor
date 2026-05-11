import { writeFile } from "node:fs/promises"

// ── Types ─────────────────────────────────────────────────────────────────────

export type LogLevel = "info" | "warn" | "error"

export type ContainerHealth = "healthy" | "unhealthy" | "restarting" | "excess-restarts"

export type Container = {
  id: string
  name: string
  image: string
  status: string
  health: string
  restartCount: number
  startedAt: string
}

export type ContainerStats = {
  name: string
  cpuPct: number
  memPct: number
  memUsageMiB: number
  memLimitMiB: number
}

export type ImageEntry = {
  id: string
  repoTag: string
  sizeBytes: number
  createdAt: string
  dangling: boolean
}

export type VolumeEntry = {
  name: string
  sizeBytes: number
  isAnonymous: boolean
}

export type BuildCacheEntry = {
  id: string
  sizeBytes: number
  createdAt: string
}

export type DiskUsage = {
  images: ImageEntry[]
  volumes: VolumeEntry[]
  buildCache: BuildCacheEntry[]
  totalReclaimableBytes: number
}

export type ResourceBreach = {
  name: string
  metric: "cpu" | "memory"
  actual: number
  threshold: number
}

export type DiskCandidate = {
  type: "image" | "volume" | "buildCache"
  id: string
  sizeBytes: number
  reason: string
}

export type MonitorReport<T> = {
  healthy: boolean
  issues: T[]
  reportPath: string | null
  generatedAt: string
}

export type SwarmNode = {
  id: string
  hostname: string
  status: string
  availability: string
  role: string
  engineVersion: string
}

export type SwarmService = {
  id: string
  name: string
  mode: string
  desiredReplicas: number
  runningReplicas: number
  image: string
}

export type SwarmTask = {
  id: string
  serviceName: string
  node: string
  state: string
  error: string
  timestamp: string
}

export type SwarmHealthSummary = {
  nodesTotal: number
  nodesDown: number
  servicesDegraded: SwarmService[]
  recentTaskFailures: SwarmTask[]
  healthy: boolean
}

type DockerResult = {
  stdout: string
  stderr: string
  exitCode: number
}

// ── Private helpers ────────────────────────────────────────────────────────────

function parseSizeToBytes(s: string): number {
  const n = parseFloat(s)
  if (isNaN(n)) return 0
  const u = s.replace(/[0-9.\s]/g, "").toUpperCase()
  if (u === "B")   return n
  if (u === "KB" || u === "KIB") return n * 1_024
  if (u === "MB" || u === "MIB") return n * 1_024 * 1_024
  if (u === "GB" || u === "GIB") return n * 1_024 * 1_024 * 1_024
  if (u === "TB" || u === "TIB") return n * 1_024 * 1_024 * 1_024 * 1_024
  return n
}

function parseSizeToMiB(s: string): number {
  return parseSizeToBytes(s) / (1_024 * 1_024)
}

function parseNdjson<T>(raw: string): T[] {
  return raw
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as T)
}

// Detects UUID-shaped volume names (anonymous volumes Docker creates for unnamed mounts)
const UUID_RE = /^[0-9a-f]{64}$/i

// ── Sole Docker CLI boundary ───────────────────────────────────────────────────

/** @internal exported for test mocking only */
export async function runDocker(args: string[]): Promise<DockerResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const timer = setTimeout(() => proc.kill(), 30_000)

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
  } finally {
    clearTimeout(timer)
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────

export function log(
  level: LogLevel,
  context: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    context,
    message,
    ...extra,
  })
  if (level === "error") {
    process.stderr.write(record + "\n")
  } else {
    process.stdout.write(record + "\n")
  }
}

// ── Container queries ─────────────────────────────────────────────────────────

export async function getContainerList(): Promise<Container[]> {
  const idsResult = await runDocker(["ps", "-q"])
  if (idsResult.exitCode !== 0) {
    throw new Error(`docker ps failed: ${idsResult.stderr}`)
  }
  const ids = idsResult.stdout.split("\n").map(s => s.trim()).filter(Boolean)
  if (ids.length === 0) return []

  // docker inspect gives us RestartCount + Health.Status + full metadata
  const inspectResult = await runDocker(["inspect", ...ids])
  if (inspectResult.exitCode !== 0) {
    throw new Error(`docker inspect failed: ${inspectResult.stderr}`)
  }

  type RawInspect = {
    Id: string
    Name: string
    Config: { Image: string }
    State: {
      Status: string
      StartedAt: string
      Health?: { Status: string }
    }
    RestartCount: number
  }

  const raw = JSON.parse(inspectResult.stdout) as RawInspect[]
  return raw.map(c => ({
    id: c.Id.slice(0, 12),
    name: c.Name.replace(/^\//, ""),
    image: c.Config.Image,
    status: c.State.Status,
    health: c.State.Health?.Status ?? "none",
    restartCount: c.RestartCount,
    startedAt: c.State.StartedAt,
  }))
}

export async function getContainerStats(): Promise<ContainerStats[]> {
  const result = await runDocker([
    "stats", "--no-stream", "--format", "{{json .}}",
  ])
  if (result.exitCode !== 0) {
    throw new Error(`docker stats failed: ${result.stderr}`)
  }
  if (!result.stdout) return []

  type RawStats = {
    Name: string
    CPUPerc: string
    MemPerc: string
    MemUsage: string
  }

  return parseNdjson<RawStats>(result.stdout).map(s => {
    const [usageStr = "0", limitStr = "0"] = s.MemUsage.split(" / ")
    return {
      name: s.Name,
      cpuPct: parseFloat(s.CPUPerc.replace("%", "")),
      memPct: parseFloat(s.MemPerc.replace("%", "")),
      memUsageMiB: parseSizeToMiB(usageStr),
      memLimitMiB: parseSizeToMiB(limitStr),
    }
  })
}

// ── Disk queries ──────────────────────────────────────────────────────────────

export async function getDiskUsage(): Promise<DiskUsage> {
  // Dangling images (untagged)
  const imgResult = await runDocker([
    "images", "--filter", "dangling=true", "--format", "{{json .}}",
  ])
  if (imgResult.exitCode !== 0) {
    throw new Error(`docker images failed: ${imgResult.stderr}`)
  }

  // All volumes
  const volResult = await runDocker(["volume", "ls", "--format", "{{json .}}"])
  if (volResult.exitCode !== 0) {
    throw new Error(`docker volume ls failed: ${volResult.stderr}`)
  }

  // Summary for reclaimable total (requires Docker 25+)
  const dfResult = await runDocker(["system", "df", "--format", "{{json .}}"])

  type RawImage  = { ID: string; Repository: string; Tag: string; Size: string; CreatedAt: string }
  type RawVolume = { Name: string; Size: string }
  type RawDf     = { Reclaimable: string }

  const images: ImageEntry[] = parseNdjson<RawImage>(imgResult.stdout).map(i => ({
    id: i.ID,
    repoTag: `${i.Repository}:${i.Tag}`,
    sizeBytes: parseSizeToBytes(i.Size),
    createdAt: i.CreatedAt,
    dangling: true,
  }))

  const volumes: VolumeEntry[] = parseNdjson<RawVolume>(volResult.stdout).map(v => ({
    name: v.Name,
    sizeBytes: parseSizeToBytes(v.Size === "N/A" ? "0B" : v.Size),
    isAnonymous: UUID_RE.test(v.Name),
  }))

  let totalReclaimableBytes = 0
  if (dfResult.exitCode === 0 && dfResult.stdout) {
    const dfRows = parseNdjson<RawDf>(dfResult.stdout)
    for (const row of dfRows) {
      const match = row.Reclaimable.match(/^([\d.]+\s*\w+)/)
      if (match?.[1]) totalReclaimableBytes += parseSizeToBytes(match[1])
    }
  }

  return { images, volumes, buildCache: [], totalReclaimableBytes }
}

// ── Pure classification functions ──────────────────────────────────────────────

export function classifyContainerHealth(
  c: Container,
  restartThreshold: number,
): ContainerHealth {
  if (c.status === "restarting") return "restarting"
  if (c.health === "unhealthy")  return "unhealthy"
  if (c.restartCount >= restartThreshold) return "excess-restarts"
  return "healthy"
}

export function findResourceBreaches(
  stats: ContainerStats[],
  cpuThreshold: number,
  memThreshold: number,
): ResourceBreach[] {
  const breaches: ResourceBreach[] = []
  for (const s of stats) {
    if (s.cpuPct >= cpuThreshold) {
      breaches.push({ name: s.name, metric: "cpu", actual: s.cpuPct, threshold: cpuThreshold })
    }
    if (s.memPct >= memThreshold) {
      breaches.push({ name: s.name, metric: "memory", actual: s.memPct, threshold: memThreshold })
    }
  }
  return breaches
}

export function findDiskCandidates(
  usage: DiskUsage,
  ageDays: number,
  volMb: number,
): DiskCandidate[] {
  const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1_000
  const candidates: DiskCandidate[] = []

  for (const img of usage.images) {
    if (img.dangling && new Date(img.createdAt).getTime() < cutoff) {
      candidates.push({
        type: "image",
        id: img.id,
        sizeBytes: img.sizeBytes,
        reason: `dangling image older than ${ageDays} days`,
      })
    }
  }

  for (const vol of usage.volumes) {
    if (vol.isAnonymous && vol.sizeBytes >= volMb * 1_024 * 1_024) {
      candidates.push({
        type: "volume",
        id: vol.name,
        sizeBytes: vol.sizeBytes,
        reason: `anonymous volume exceeds ${volMb}MB threshold`,
      })
    }
  }

  return candidates.sort((a, b) => b.sizeBytes - a.sizeBytes)
}

// ── Report writer ─────────────────────────────────────────────────────────────

export async function writeReport<T>(
  data: MonitorReport<T>,
  path: string,
): Promise<string> {
  await writeFile(path, JSON.stringify(data, null, 2), "utf8")
  return path
}

// ── Swarm queries ─────────────────────────────────────────────────────────────

export async function isSwarmActive(): Promise<boolean> {
  const result = await runDocker(["info", "--format", "{{json .}}"])
  if (result.exitCode !== 0) return false

  type RawInfo = { Swarm?: { LocalNodeState?: string; ControlAvailable?: boolean } }
  const info = JSON.parse(result.stdout) as RawInfo
  return (
    info.Swarm?.LocalNodeState === "active" &&
    (info.Swarm?.ControlAvailable === true)
  )
}

export async function getSwarmNodes(): Promise<SwarmNode[]> {
  const result = await runDocker(["node", "ls", "--format", "{{json .}}"])
  if (result.exitCode !== 0) {
    throw new Error(`docker node ls failed: ${result.stderr}`)
  }
  if (!result.stdout) return []

  type RawNode = {
    ID: string
    Hostname: string
    Status: string
    Availability: string
    ManagerStatus: string
    EngineVersion: string
  }

  return parseNdjson<RawNode>(result.stdout).map(n => ({
    id: n.ID,
    hostname: n.Hostname,
    status: n.Status,
    availability: n.Availability,
    role: n.ManagerStatus ? "Manager" : "Worker",
    engineVersion: n.EngineVersion,
  }))
}

export async function getSwarmServices(): Promise<SwarmService[]> {
  const result = await runDocker(["service", "ls", "--format", "{{json .}}"])
  if (result.exitCode !== 0) {
    throw new Error(`docker service ls failed: ${result.stderr}`)
  }
  if (!result.stdout) return []

  type RawService = { ID: string; Name: string; Mode: string; Replicas: string; Image: string }

  return parseNdjson<RawService>(result.stdout).map(s => {
    // Replicas field: "3/3" for replicated, "3/3 (global)" for global
    const replicaStr = s.Replicas.split(" ")[0] ?? "0/0"
    const [runStr = "0", desStr = "0"] = replicaStr.split("/")
    return {
      id: s.ID,
      name: s.Name,
      mode: s.Mode,
      runningReplicas: parseInt(runStr, 10),
      desiredReplicas: parseInt(desStr, 10),
      image: s.Image,
    }
  })
}

export async function getSwarmTaskFailures(since: string): Promise<SwarmTask[]> {
  // Get all services first, then check failed tasks per service
  const services = await getSwarmServices()
  if (services.length === 0) return []

  const sinceMs = new Date(since).getTime()
  const allTasks: SwarmTask[] = []

  await Promise.all(
    services.map(async svc => {
      const result = await runDocker([
        "service", "ps", svc.id,
        "--filter", "desired-state=failed",
        "--no-trunc",
        "--format", "{{json .}}",
      ])
      if (result.exitCode !== 0 || !result.stdout) return

      type RawTask = {
        ID: string
        Name: string
        Node: string
        CurrentState: string
        Error: string
        UpdatedAt?: string
      }

      const tasks = parseNdjson<RawTask>(result.stdout)
      for (const t of tasks) {
        // Only include tasks with a real error and within the time window
        if (!t.Error) continue
        const taskTime = t.UpdatedAt ? new Date(t.UpdatedAt).getTime() : 0
        if (taskTime < sinceMs) continue
        allTasks.push({
          id: t.ID,
          serviceName: svc.name,
          node: t.Node,
          state: "failed",
          error: t.Error,
          timestamp: t.UpdatedAt ?? new Date().toISOString(),
        })
      }
    }),
  )

  return allTasks
}

export function classifySwarmHealth(
  nodes: SwarmNode[],
  services: SwarmService[],
  tasks: SwarmTask[],
  taskFailureThreshold: number,
): SwarmHealthSummary {
  const nodesDown = nodes.filter(
    n => n.status !== "Ready" || n.availability !== "Active",
  ).length

  const servicesDegraded = services.filter(
    s => s.mode !== "global" && s.runningReplicas < s.desiredReplicas,
  )

  const recentTaskFailures = tasks

  const healthy =
    nodesDown === 0 &&
    servicesDegraded.length === 0 &&
    recentTaskFailures.length < taskFailureThreshold

  return {
    nodesTotal: nodes.length,
    nodesDown,
    servicesDegraded,
    recentTaskFailures,
    healthy,
  }
}
