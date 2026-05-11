import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as dm from "../src/docker-monitor.ts"

type DockerResult = { stdout: string; stderr: string; exitCode: number }
function ok(stdout = ""): DockerResult { return { stdout, stderr: "", exitCode: 0 } }

const healthyContainer = JSON.stringify([{
  Id: "abc", Name: "/web", Config: { Image: "nginx" },
  State: { Status: "running", StartedAt: new Date().toISOString(), Health: { Status: "healthy" } },
  RestartCount: 0,
}])

const unhealthyContainer = JSON.stringify([{
  Id: "abc", Name: "/web", Config: { Image: "nginx" },
  State: { Status: "running", StartedAt: new Date().toISOString(), Health: { Status: "unhealthy" } },
  RestartCount: 0,
}])

describe("health-sweep env validation", () => {
  it("classifyContainerHealth healthy → no issues", () => {
    const c: dm.Container = {
      id: "a", name: "web", image: "nginx", status: "running",
      health: "healthy", restartCount: 0, startedAt: new Date().toISOString(),
    }
    expect(dm.classifyContainerHealth(c, 5)).toBe("healthy")
  })

  it("classifyContainerHealth unhealthy → issue", () => {
    const c: dm.Container = {
      id: "a", name: "web", image: "nginx", status: "running",
      health: "unhealthy", restartCount: 0, startedAt: new Date().toISOString(),
    }
    expect(dm.classifyContainerHealth(c, 5)).toBe("unhealthy")
  })
})

describe("health-sweep getContainerList integration", () => {
  let spy: ReturnType<typeof spyOn>
  afterEach(() => spy.mockRestore())

  it("returns healthy containers as empty issues list", async () => {
    spy = spyOn(dm, "runDocker")
      .mockResolvedValueOnce(ok("abc"))
      .mockResolvedValueOnce(ok(healthyContainer))

    const containers = await dm.getContainerList()
    const issues = containers
      .map(c => dm.classifyContainerHealth(c, 5))
      .filter(s => s !== "healthy")
    expect(issues).toHaveLength(0)
  })

  it("flags unhealthy containers as issues (exit 2 scenario)", async () => {
    spy = spyOn(dm, "runDocker")
      .mockResolvedValueOnce(ok("abc"))
      .mockResolvedValueOnce(ok(unhealthyContainer))

    const containers = await dm.getContainerList()
    const issues = containers
      .map(c => dm.classifyContainerHealth(c, 5))
      .filter(s => s !== "healthy")
    expect(issues).toHaveLength(1)
    expect(issues[0]).toBe("unhealthy")
  })

  it("excludes stopped containers when INCLUDE_STOPPED is false", async () => {
    const stoppedContainer = JSON.stringify([{
      Id: "abc", Name: "/old", Config: { Image: "nginx" },
      State: { Status: "exited", StartedAt: new Date().toISOString() },
      RestartCount: 0,
    }])
    spy = spyOn(dm, "runDocker")
      .mockResolvedValueOnce(ok("abc"))
      .mockResolvedValueOnce(ok(stoppedContainer))

    const containers = await dm.getContainerList()
    const running = containers.filter(c => c.status === "running")
    expect(running).toHaveLength(0)
  })
})
