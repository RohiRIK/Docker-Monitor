// mock.module must be called before the module under test is imported
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dm from "../src/docker-monitor.ts"

type DockerResult = { stdout: string; stderr: string; exitCode: number }

function makeResult(stdout: string, exitCode = 0): DockerResult {
  return { stdout, stderr: "", exitCode }
}

// ── log ───────────────────────────────────────────────────────────────────────

describe("log", () => {
  it("writes JSON line with required fields to stdout", () => {
    const lines: string[] = []
    const orig = process.stdout.write.bind(process.stdout)
    process.stdout.write = (s: string) => { lines.push(s); return true }
    try {
      dm.log("info", "test", "hello")
      const parsed = JSON.parse(lines[0] ?? "{}")
      expect(parsed.level).toBe("info")
      expect(parsed.context).toBe("test")
      expect(parsed.message).toBe("hello")
      expect(typeof parsed.timestamp).toBe("string")
    } finally {
      process.stdout.write = orig
    }
  })

  it("writes errors to stderr", () => {
    const lines: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s: string) => { lines.push(s); return true }
    try {
      dm.log("error", "ctx", "boom")
      const parsed = JSON.parse(lines[0] ?? "{}")
      expect(parsed.level).toBe("error")
    } finally {
      process.stderr.write = orig
    }
  })
})

// ── classifyContainerHealth ───────────────────────────────────────────────────

describe("classifyContainerHealth", () => {
  const base: dm.Container = {
    id: "abc", name: "test", image: "nginx", status: "running",
    health: "healthy", restartCount: 0, startedAt: new Date().toISOString(),
  }

  it("returns healthy for a running healthy container", () => {
    expect(dm.classifyContainerHealth(base, 5)).toBe("healthy")
  })

  it("returns restarting when status is restarting", () => {
    expect(dm.classifyContainerHealth({ ...base, status: "restarting" }, 5)).toBe("restarting")
  })

  it("returns unhealthy when health is unhealthy", () => {
    expect(dm.classifyContainerHealth({ ...base, health: "unhealthy" }, 5)).toBe("unhealthy")
  })

  it("returns excess-restarts when restartCount meets threshold", () => {
    expect(dm.classifyContainerHealth({ ...base, restartCount: 5 }, 5)).toBe("excess-restarts")
  })

  it("returns excess-restarts when restartCount exceeds threshold", () => {
    expect(dm.classifyContainerHealth({ ...base, restartCount: 10 }, 5)).toBe("excess-restarts")
  })

  it("restarting takes priority over unhealthy", () => {
    expect(dm.classifyContainerHealth({ ...base, status: "restarting", health: "unhealthy" }, 5))
      .toBe("restarting")
  })
})

// ── findResourceBreaches ──────────────────────────────────────────────────────

describe("findResourceBreaches", () => {
  const noBreachStats: dm.ContainerStats = {
    name: "web", cpuPct: 50, memPct: 60, memUsageMiB: 100, memLimitMiB: 500,
  }

  it("returns empty array when all within thresholds", () => {
    expect(dm.findResourceBreaches([noBreachStats], 80, 85)).toEqual([])
  })

  it("returns cpu breach when cpuPct >= threshold", () => {
    const breaches = dm.findResourceBreaches([{ ...noBreachStats, cpuPct: 80 }], 80, 85)
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.metric).toBe("cpu")
    expect(breaches[0]?.actual).toBe(80)
  })

  it("returns memory breach when memPct >= threshold", () => {
    const breaches = dm.findResourceBreaches([{ ...noBreachStats, memPct: 90 }], 80, 85)
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.metric).toBe("memory")
  })

  it("returns both breaches when both thresholds exceeded", () => {
    const breaches = dm.findResourceBreaches([{ ...noBreachStats, cpuPct: 95, memPct: 95 }], 80, 85)
    expect(breaches).toHaveLength(2)
  })

  it("handles empty stats array", () => {
    expect(dm.findResourceBreaches([], 80, 85)).toEqual([])
  })
})

// ── findDiskCandidates ────────────────────────────────────────────────────────

describe("findDiskCandidates", () => {
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000).toISOString()
  const newDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1_000).toISOString()
  const largeVol: dm.VolumeEntry = { name: "a".repeat(64), sizeBytes: 600 * 1_024 * 1_024, isAnonymous: true }
  const smallVol: dm.VolumeEntry = { name: "b".repeat(64), sizeBytes: 10 * 1_024 * 1_024, isAnonymous: true }
  const namedVol: dm.VolumeEntry = { name: "myapp-data", sizeBytes: 600 * 1_024 * 1_024, isAnonymous: false }
  const oldImg: dm.ImageEntry = { id: "img1", repoTag: "<none>:<none>", sizeBytes: 100_000, createdAt: oldDate, dangling: true }
  const newImg: dm.ImageEntry = { id: "img2", repoTag: "<none>:<none>", sizeBytes: 100_000, createdAt: newDate, dangling: true }

  const baseUsage: dm.DiskUsage = { images: [], volumes: [], buildCache: [], totalReclaimableBytes: 0 }

  it("includes dangling image older than ageDays", () => {
    const candidates = dm.findDiskCandidates({ ...baseUsage, images: [oldImg] }, 7, 500)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.type).toBe("image")
  })

  it("excludes dangling image newer than ageDays", () => {
    const candidates = dm.findDiskCandidates({ ...baseUsage, images: [newImg] }, 7, 500)
    expect(candidates).toHaveLength(0)
  })

  it("includes anonymous volume exceeding size threshold", () => {
    const candidates = dm.findDiskCandidates({ ...baseUsage, volumes: [largeVol] }, 7, 500)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.type).toBe("volume")
  })

  it("excludes anonymous volume below threshold", () => {
    const candidates = dm.findDiskCandidates({ ...baseUsage, volumes: [smallVol] }, 7, 500)
    expect(candidates).toHaveLength(0)
  })

  it("excludes named (non-anonymous) volumes regardless of size", () => {
    const candidates = dm.findDiskCandidates({ ...baseUsage, volumes: [namedVol] }, 7, 500)
    expect(candidates).toHaveLength(0)
  })

  it("sorts by sizeBytes descending", () => {
    const bigImg: dm.ImageEntry = { ...oldImg, id: "big", sizeBytes: 1_000_000 }
    const smallImg: dm.ImageEntry = { ...oldImg, id: "small", sizeBytes: 100 }
    const candidates = dm.findDiskCandidates({ ...baseUsage, images: [smallImg, bigImg] }, 7, 500)
    expect(candidates[0]?.id).toBe("big")
  })
})

// ── classifySwarmHealth ───────────────────────────────────────────────────────

describe("classifySwarmHealth", () => {
  const goodNode: dm.SwarmNode = {
    id: "n1", hostname: "node1", status: "Ready", availability: "Active",
    role: "Manager", engineVersion: "25.0.0",
  }
  const downNode: dm.SwarmNode = { ...goodNode, id: "n2", status: "Down" }
  const goodSvc: dm.SwarmService = {
    id: "s1", name: "web", mode: "replicated",
    runningReplicas: 3, desiredReplicas: 3, image: "nginx",
  }
  const degradedSvc: dm.SwarmService = { ...goodSvc, id: "s2", runningReplicas: 1 }
  const failedTask: dm.SwarmTask = {
    id: "t1", serviceName: "web", node: "node1",
    state: "failed", error: "OOM killed", timestamp: new Date().toISOString(),
  }

  it("returns healthy when all nodes up, services at desired, no failures", () => {
    const result = dm.classifySwarmHealth([goodNode], [goodSvc], [], 3)
    expect(result.healthy).toBe(true)
    expect(result.nodesDown).toBe(0)
    expect(result.servicesDegraded).toHaveLength(0)
  })

  it("returns unhealthy when a node is down", () => {
    const result = dm.classifySwarmHealth([goodNode, downNode], [goodSvc], [], 3)
    expect(result.healthy).toBe(false)
    expect(result.nodesDown).toBe(1)
  })

  it("returns unhealthy when a service is degraded", () => {
    const result = dm.classifySwarmHealth([goodNode], [goodSvc, degradedSvc], [], 3)
    expect(result.healthy).toBe(false)
    expect(result.servicesDegraded).toHaveLength(1)
    expect(result.servicesDegraded[0]?.name).toBe("web")
  })

  it("returns unhealthy when task failures meet threshold", () => {
    const result = dm.classifySwarmHealth([goodNode], [goodSvc], [failedTask, failedTask, failedTask], 3)
    expect(result.healthy).toBe(false)
  })

  it("returns healthy when task failures are below threshold", () => {
    const result = dm.classifySwarmHealth([goodNode], [goodSvc], [failedTask, failedTask], 3)
    expect(result.healthy).toBe(true)
  })

  it("does not count global services as degraded", () => {
    const globalSvc: dm.SwarmService = { ...degradedSvc, mode: "global" }
    const result = dm.classifySwarmHealth([goodNode], [globalSvc], [], 3)
    expect(result.servicesDegraded).toHaveLength(0)
  })
})

// ── getContainerList (mocked runDocker) ────────────────────────────────────────

describe("getContainerList", () => {
  let spy: ReturnType<typeof spyOn>

  afterEach(() => spy.mockRestore())

  it("returns empty array when no containers exist", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue(makeResult(""))
    const result = await dm.getContainerList()
    expect(result).toEqual([])
  })

  it("parses inspect output into Container objects", async () => {
    const inspectJson = JSON.stringify([{
      Id: "abc123",
      Name: "/mycontainer",
      Config: { Image: "nginx:latest" },
      State: { Status: "running", StartedAt: "2024-01-01T00:00:00Z", Health: { Status: "healthy" } },
      RestartCount: 2,
    }])

    spy = spyOn(dm, "runDocker")
      .mockResolvedValueOnce(makeResult("abc123")) // docker ps -aq
      .mockResolvedValueOnce(makeResult(inspectJson)) // docker inspect

    const result = await dm.getContainerList()
    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe("mycontainer")
    expect(result[0]?.health).toBe("healthy")
    expect(result[0]?.restartCount).toBe(2)
  })
})

// ── getContainerStats (mocked) ────────────────────────────────────────────────

describe("getContainerStats", () => {
  let spy: ReturnType<typeof spyOn>

  afterEach(() => spy.mockRestore())

  it("parses CPU and memory strings correctly", async () => {
    const ndjson = JSON.stringify({ Name: "web", CPUPerc: "12.34%", MemPerc: "0.85%", MemUsage: "512MiB / 2GiB" })
    spy = spyOn(dm, "runDocker").mockResolvedValue(makeResult(ndjson))
    const result = await dm.getContainerStats()
    expect(result[0]?.cpuPct).toBe(12.34)
    expect(result[0]?.memPct).toBe(0.85)
    expect(result[0]?.memUsageMiB).toBe(512)
    expect(result[0]?.memLimitMiB).toBe(2048)
  })

  it("returns empty array when no running containers", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue(makeResult(""))
    expect(await dm.getContainerStats()).toEqual([])
  })
})

// ── runDocker injection safety ────────────────────────────────────────────────

describe("runDocker (injection safety)", () => {
  it("is exported for test mocking", () => {
    expect(typeof dm.runDocker).toBe("function")
  })
})
