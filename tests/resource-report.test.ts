import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as dm from "../src/docker-monitor.ts"

type DockerResult = { stdout: string; stderr: string; exitCode: number }
function ok(stdout = ""): DockerResult { return { stdout, stderr: "", exitCode: 0 } }

describe("resource-report threshold logic", () => {
  it("no breach when all stats within thresholds", () => {
    const stats: dm.ContainerStats[] = [
      { name: "web", cpuPct: 50, memPct: 60, memUsageMiB: 100, memLimitMiB: 500 },
    ]
    expect(dm.findResourceBreaches(stats, 80, 85)).toHaveLength(0)
  })

  it("cpu breach when at exactly the threshold", () => {
    const stats: dm.ContainerStats[] = [
      { name: "web", cpuPct: 80, memPct: 60, memUsageMiB: 100, memLimitMiB: 500 },
    ]
    const breaches = dm.findResourceBreaches(stats, 80, 85)
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.metric).toBe("cpu")
    expect(breaches[0]?.name).toBe("web")
  })

  it("memory breach when memPct exceeds threshold", () => {
    const stats: dm.ContainerStats[] = [
      { name: "db", cpuPct: 10, memPct: 90, memUsageMiB: 450, memLimitMiB: 500 },
    ]
    const breaches = dm.findResourceBreaches(stats, 80, 85)
    expect(breaches).toHaveLength(1)
    expect(breaches[0]?.metric).toBe("memory")
  })

  it("multiple containers — only breaching ones returned", () => {
    const stats: dm.ContainerStats[] = [
      { name: "ok", cpuPct: 20, memPct: 30, memUsageMiB: 50, memLimitMiB: 500 },
      { name: "bad", cpuPct: 95, memPct: 95, memUsageMiB: 475, memLimitMiB: 500 },
    ]
    const breaches = dm.findResourceBreaches(stats, 80, 85)
    expect(breaches.every(b => b.name === "bad")).toBe(true)
    expect(breaches).toHaveLength(2)
  })
})

describe("resource-report getContainerStats integration", () => {
  let spy: ReturnType<typeof spyOn>
  afterEach(() => spy.mockRestore())

  it("parses docker stats NDJSON output", async () => {
    const ndjson = [
      JSON.stringify({ Name: "web", CPUPerc: "5.00%", MemPerc: "10.00%", MemUsage: "100MiB / 1GiB" }),
      JSON.stringify({ Name: "db",  CPUPerc: "85.00%", MemPerc: "90.00%", MemUsage: "900MiB / 1GiB" }),
    ].join("\n")

    spy = spyOn(dm, "runDocker").mockResolvedValue(ok(ndjson))
    const stats = await dm.getContainerStats()
    expect(stats).toHaveLength(2)

    const db = stats.find(s => s.name === "db")
    expect(db?.cpuPct).toBe(85)
    expect(db?.memLimitMiB).toBe(1024)
  })

  it("returns empty when docker stats returns no output", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue(ok(""))
    expect(await dm.getContainerStats()).toEqual([])
  })
})
