import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as dm from "../src/docker-monitor.ts"

type DockerResult = { stdout: string; stderr: string; exitCode: number }
function ok(stdout = ""): DockerResult { return { stdout, stderr: "", exitCode: 0 } }

const ACTIVE_INFO = JSON.stringify({ Swarm: { LocalNodeState: "active", ControlAvailable: true } })
const INACTIVE_INFO = JSON.stringify({ Swarm: { LocalNodeState: "inactive", ControlAvailable: false } })

const goodNodeNdjson = JSON.stringify({
  ID: "n1", Hostname: "manager1", Status: "Ready",
  Availability: "Active", ManagerStatus: "Leader", EngineVersion: "25.0.0",
})
const downNodeNdjson = JSON.stringify({
  ID: "n2", Hostname: "worker1", Status: "Down",
  Availability: "Active", ManagerStatus: "", EngineVersion: "25.0.0",
})
const goodSvcNdjson = JSON.stringify({
  ID: "s1", Name: "web", Mode: "replicated", Replicas: "3/3", Image: "nginx:latest",
})
const degradedSvcNdjson = JSON.stringify({
  ID: "s2", Name: "api", Mode: "replicated", Replicas: "1/3", Image: "api:latest",
})

describe("isSwarmActive", () => {
  let spy: ReturnType<typeof spyOn>
  afterEach(() => spy.mockRestore())

  it("returns true when LocalNodeState is active and ControlAvailable", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue(ok(ACTIVE_INFO))
    expect(await dm.isSwarmActive()).toBe(true)
  })

  it("returns false when Swarm is inactive", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue(ok(INACTIVE_INFO))
    expect(await dm.isSwarmActive()).toBe(false)
  })

  it("returns false when docker info fails", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue({ stdout: "", stderr: "error", exitCode: 1 })
    expect(await dm.isSwarmActive()).toBe(false)
  })
})

describe("getSwarmNodes", () => {
  let spy: ReturnType<typeof spyOn>
  afterEach(() => spy.mockRestore())

  it("parses node list into SwarmNode array", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue(ok(goodNodeNdjson))
    const nodes = await dm.getSwarmNodes()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.hostname).toBe("manager1")
    expect(nodes[0]?.role).toBe("Manager")
  })

  it("returns empty array when swarm has no nodes", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue(ok(""))
    expect(await dm.getSwarmNodes()).toEqual([])
  })
})

describe("getSwarmServices", () => {
  let spy: ReturnType<typeof spyOn>
  afterEach(() => spy.mockRestore())

  it("parses replica string 3/3 correctly", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue(ok(goodSvcNdjson))
    const services = await dm.getSwarmServices()
    expect(services[0]?.runningReplicas).toBe(3)
    expect(services[0]?.desiredReplicas).toBe(3)
  })

  it("parses degraded replica string 1/3 correctly", async () => {
    spy = spyOn(dm, "runDocker").mockResolvedValue(ok(degradedSvcNdjson))
    const services = await dm.getSwarmServices()
    expect(services[0]?.runningReplicas).toBe(1)
    expect(services[0]?.desiredReplicas).toBe(3)
  })
})

describe("classifySwarmHealth", () => {
  const goodNode: dm.SwarmNode = {
    id: "n1", hostname: "m1", status: "Ready", availability: "Active",
    role: "Manager", engineVersion: "25.0.0",
  }
  const goodSvc: dm.SwarmService = {
    id: "s1", name: "web", mode: "replicated",
    runningReplicas: 3, desiredReplicas: 3, image: "nginx",
  }
  const failedTask: dm.SwarmTask = {
    id: "t1", serviceName: "web", node: "m1",
    state: "failed", error: "OOM", timestamp: new Date().toISOString(),
  }

  it("healthy when all good", () => {
    const result = dm.classifySwarmHealth([goodNode], [goodSvc], [], 3)
    expect(result.healthy).toBe(true)
    expect(result.nodesTotal).toBe(1)
    expect(result.nodesDown).toBe(0)
  })

  it("unhealthy — node down (AC-10)", () => {
    const downNode: dm.SwarmNode = { ...goodNode, status: "Down" }
    const result = dm.classifySwarmHealth([goodNode, downNode], [goodSvc], [], 3)
    expect(result.healthy).toBe(false)
    expect(result.nodesDown).toBe(1)
  })

  it("unhealthy — service degraded (AC-10)", () => {
    const degraded: dm.SwarmService = { ...goodSvc, runningReplicas: 1 }
    const result = dm.classifySwarmHealth([goodNode], [degraded], [], 3)
    expect(result.healthy).toBe(false)
    expect(result.servicesDegraded).toHaveLength(1)
  })

  it("unhealthy — task failures >= threshold", () => {
    const result = dm.classifySwarmHealth([goodNode], [goodSvc], [failedTask, failedTask, failedTask], 3)
    expect(result.healthy).toBe(false)
  })

  it("healthy — task failures below threshold", () => {
    const result = dm.classifySwarmHealth([goodNode], [goodSvc], [failedTask], 3)
    expect(result.healthy).toBe(true)
  })
})
