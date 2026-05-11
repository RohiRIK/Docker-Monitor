import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as dm from "../src/docker-monitor.ts"

type DockerResult = { stdout: string; stderr: string; exitCode: number }
function ok(stdout = ""): DockerResult { return { stdout, stderr: "", exitCode: 0 } }

const OLD_DATE = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000).toISOString()

describe("disk-audit candidate logic", () => {
  const base: dm.DiskUsage = { images: [], volumes: [], buildCache: [], totalReclaimableBytes: 0 }

  it("detects old dangling images as prune candidates", () => {
    const img: dm.ImageEntry = { id: "img1", repoTag: "<none>:<none>", sizeBytes: 100_000, createdAt: OLD_DATE, dangling: true }
    const candidates = dm.findDiskCandidates({ ...base, images: [img] }, 7, 500)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.type).toBe("image")
  })

  it("detects oversized anonymous volumes", () => {
    const vol: dm.VolumeEntry = { name: "a".repeat(64), sizeBytes: 600 * 1_024 * 1_024, isAnonymous: true }
    const candidates = dm.findDiskCandidates({ ...base, volumes: [vol] }, 7, 500)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.type).toBe("volume")
  })

  it("never suggests pruning named volumes", () => {
    const vol: dm.VolumeEntry = { name: "postgres-data", sizeBytes: 5 * 1_024 * 1_024 * 1_024, isAnonymous: false }
    const candidates = dm.findDiskCandidates({ ...base, volumes: [vol] }, 7, 500)
    expect(candidates).toHaveLength(0)
  })

  it("returns empty when nothing qualifies", () => {
    const candidates = dm.findDiskCandidates(base, 7, 500)
    expect(candidates).toHaveLength(0)
  })
})

describe("disk-audit — no destructive docker commands (AC-4)", () => {
  let spy: ReturnType<typeof spyOn>
  afterEach(() => spy.mockRestore())

  it("never calls docker with prune, rm, or rmi", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue(ok(""))
    await dm.getDiskUsage()

    const callArgs: string[] = spy.mock.calls.map((c: unknown[][]) => (c[0] as string[]).join(" "))
    const hasDestructive = callArgs.some((cmd: string) =>
      /\bprune\b|\brm\b|\brmi\b|\bforce\b/.test(cmd)
    )
    expect(hasDestructive).toBe(false)
  })
})

describe("disk-audit getDiskUsage integration", () => {
  let spy: ReturnType<typeof spyOn>
  afterEach(() => spy.mockRestore())

  it("returns structured DiskUsage from docker output", async () => {
    const imgNdjson = JSON.stringify({ ID: "abc", Repository: "<none>", Tag: "<none>", Size: "128MB", CreatedAt: OLD_DATE })
    const volNdjson = JSON.stringify({ Name: "a".repeat(64), Size: "600MB" })

    spy = spyOn(dm, "runDocker")
      .mockResolvedValueOnce(ok(imgNdjson)) // docker images
      .mockResolvedValueOnce(ok(volNdjson)) // docker volume ls
      .mockResolvedValueOnce(ok(""))        // docker system df (optional)

    const usage = await dm.getDiskUsage()
    expect(usage.images).toHaveLength(1)
    expect(usage.volumes).toHaveLength(1)
    expect(usage.images[0]?.dangling).toBe(true)
  })
})
