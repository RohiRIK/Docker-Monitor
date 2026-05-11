# Spec: Docker Environment Monitor

**Feature slug:** `docker-environment-monitor`
**Project directory:** `Docker-Monitor/`
**Runtime:** TypeScript + Bun
**Status:** Draft

---

## Problem

No automated visibility into Docker environments managed by Jenkins agents. Container crashes, memory pressure, disk bloat, and restart storms go undetected until something breaks. Operations needs a scheduled, low-noise monitor that catches problems early and posts actionable alerts.

---

## What We're Building

Four independent Jenkins automations that compose into a complete Docker monitoring suite:

| Automation | What it checks | Default schedule |
|---|---|---|
| **Container Health Sweep** | Unhealthy/restarting containers; excessive restart counts | `H/15 * * * *` |
| **Resource Usage Report** | Per-container CPU and memory vs configurable thresholds | `H * * * *` |
| **Disk Cleanup Audit** | Dangling images, anonymous volumes, build cache bloat | `H 6 * * *` |
| **Swarm Health Monitor** | Node availability, service replica counts, task failure rate | `H/10 * * * *` |

All four pipelines expose a `CRON_SCHEDULE` string parameter. Changing the parameter value and saving the job reconfigures the trigger for the next run — no Jenkinsfile edit required.

Each automation has its own `Jenkinsfile` and entry-point script. All four share a single TypeScript module (`docker-monitor.ts`) that owns all Docker CLI calls.

---

## Out of Scope

- Kubernetes monitoring
- Automated remediation — `docker rm`, `docker kill`, `docker service update` (report only, no writes)
- ACR / registry scanning
- Multi-host / remote Docker daemon support

---

## File Layout

```
Docker-Monitor/
├── health-sweep/
│   └── Jenkinsfile                        # Pipeline 1
├── resource-report/
│   └── Jenkinsfile                        # Pipeline 2
├── disk-audit/
│   └── Jenkinsfile                        # Pipeline 3
├── swarm-health/
│   └── Jenkinsfile                        # Pipeline 4
├── src/
│   ├── docker-monitor.ts                  # Shared module — all Docker CLI logic + types
│   ├── health-sweep.ts                    # Entry point for Pipeline 1
│   ├── resource-report.ts                 # Entry point for Pipeline 2
│   ├── disk-audit.ts                      # Entry point for Pipeline 3
│   └── swarm-health.ts                    # Entry point for Pipeline 4
├── tests/
│   ├── docker-monitor.test.ts             # Unit tests — shared module
│   ├── health-sweep.test.ts
│   ├── resource-report.test.ts
│   ├── disk-audit.test.ts
│   └── swarm-health.test.ts
├── package.json
├── tsconfig.json
├── specs/
│   └── docker-environment-monitor.md
└── .gitignore
```

---

## Shared Module: `src/docker-monitor.ts`

### Types

```typescript
// ── Container types ──────────────────────────────────────────────────────────
export interface Container {
  id: string
  name: string
  image: string
  status: string          // "running" | "exited" | "restarting" | ...
  health: string          // "healthy" | "unhealthy" | "none" | "starting"
  restartCount: number
  startedAt: string       // ISO timestamp
}

export interface ContainerStats {
  name: string
  cpuPct: number          // parsed from "12.34%"
  memPct: number          // parsed from "512MiB / 2GiB"
  memUsageMiB: number
  memLimitMiB: number
}

export interface DiskUsage {
  images: ImageEntry[]
  volumes: VolumeEntry[]
  buildCache: BuildCacheEntry[]
  totalReclaimableBytes: number
}

export interface MonitorReport<T> {
  healthy: boolean
  issues: T[]
  reportPath: string | null
  generatedAt: string
}

// ── Swarm types ───────────────────────────────────────────────────────────────
export interface SwarmNode {
  id: string
  hostname: string
  status: string        // "Ready" | "Down" | "Disconnected"
  availability: string  // "Active" | "Pause" | "Drain"
  role: string          // "Manager" | "Worker"
  engineVersion: string
}

export interface SwarmService {
  id: string
  name: string
  mode: string          // "replicated" | "global"
  desiredReplicas: number
  runningReplicas: number
  image: string
}

export interface SwarmTask {
  id: string
  serviceName: string
  node: string
  state: string         // "running" | "failed" | "rejected" | "shutdown"
  error: string
  timestamp: string
}

export interface SwarmHealthSummary {
  nodesTotal: number
  nodesDown: number
  servicesDegraded: SwarmService[]   // runningReplicas < desiredReplicas
  recentTaskFailures: SwarmTask[]
  healthy: boolean
}
```

### Exported Functions

| Function | Purpose |
|---|---|
| `getContainerList()` | `docker ps -a --format json` → `Container[]` |
| `getContainerStats()` | `docker stats --no-stream --format json` → `ContainerStats[]` |
| `getDiskUsage()` | `docker system df -v --format json` → `DiskUsage` |
| `classifyContainerHealth(c, threshold)` | Returns `"healthy" \| "unhealthy" \| "restarting" \| "excess-restarts"` |
| `findResourceBreaches(stats, cpu, mem)` | Returns breach objects for containers exceeding thresholds |
| `findDiskCandidates(usage, ageDays, volMb)` | Returns prune candidates ranked by reclaimable size |
| `writeReport(data, path)` | Serialize report to JSON file; returns path |
| `log(level, context, message)` | Structured JSON log line to stdout/stderr |
| `getSwarmNodes()` | `docker node ls --format json` → `SwarmNode[]` |
| `getSwarmServices()` | `docker service ls --format json` → `SwarmService[]` |
| `getSwarmTaskFailures(since)` | `docker service ps --filter desired-state=failed` → `SwarmTask[]` since ISO timestamp |
| `classifySwarmHealth(nodes, services, tasks)` | Returns `SwarmHealthSummary` |
| `isSwarmActive()` | `docker info --format json` → checks `Swarm.LocalNodeState === "active"` |

**Private (not exported):** `runDocker(args: string[])` — single `Bun.spawn` wrapper; all Docker CLI calls go through here so tests can mock it.

### TypeScript Conventions

- `strict: true` in `tsconfig.json`
- All exported functions have explicit return types
- No `any` — use proper types or `unknown` with type guards
- Env vars validated at entry-point boundary with Zod
- No `console.log` — use `log()` which writes structured JSON
- Spread operators, never mutate objects
- Functions < 50 lines; module < 800 lines

---

## Automation 1: Container Health Sweep

### Pipeline: `health-sweep/Jenkinsfile`

**Purpose:** Detect containers that are unhealthy, restarting, or have restarted more than N times.

**Parameters:**

| Name | Default | Description |
|---|---|---|
| `CRON_SCHEDULE` | `H/15 * * * *` | Cron expression controlling how often this job runs. Empty string disables scheduling. |
| `RESTART_THRESHOLD` | `5` | Alert if RestartCount ≥ this value |
| `INCLUDE_STOPPED` | `true` | Include stopped (Exited) containers in report |
| `DRY_RUN` | `true` | Log findings without sending alerts |

**Environment:**
```groovy
SLACK_WEBHOOK_URL = credentials('slack-webhook-docker-alerts')
```

**Stages:**
1. `Validate Environment` — `docker info` must succeed; `bun --version` present
2. `Install` — `bun install --frozen-lockfile`
3. `Sweep Containers` — `bun run src/health-sweep.ts` with `returnStatus: true`
4. `Notify` (when `DRY_RUN = false` and exit 2) — Slack orange alert

**Exit code contract:**
- `0` — all containers healthy
- `2` — one or more containers unhealthy → `currentBuild.result = 'UNSTABLE'`
- Other non-zero — runtime crash → `error()` → FAILED

**Post:**
```groovy
post {
    unstable { /* Slack orange */ }
    failure  { /* Slack red */    }
    always   { cleanWs()         }
}
```

### Entry Point: `src/health-sweep.ts`

Env vars (Zod-validated):
- `RESTART_THRESHOLD` — `z.coerce.number().int().min(1).default(5)`
- `INCLUDE_STOPPED` — `z.enum(['true','false']).transform(v => v === 'true').default('true')`
- `WORKSPACE` — string (injected by Jenkins)

Flow:
1. Validate env vars with Zod; exit 1 on validation error
2. `getContainerList()` → filter stopped if `INCLUDE_STOPPED = false`
3. `classifyContainerHealth(c, RESTART_THRESHOLD)` for each container
4. Collect unhealthy / restarting / excess-restart containers
5. `writeReport(issues, '$WORKSPACE/health-report.json')`
6. `process.exit(issues.length > 0 ? 2 : 0)`

---

## Automation 2: Resource Usage Report

### Pipeline: `resource-report/Jenkinsfile`

**Purpose:** Measure per-container CPU and memory against thresholds; alert on breaches.

**Parameters:**

| Name | Default | Description |
|---|---|---|
| `CRON_SCHEDULE` | `H * * * *` | Cron expression controlling how often this job runs. Empty string disables scheduling. |
| `CPU_THRESHOLD_PCT` | `80` | Alert if container CPU% ≥ this |
| `MEM_THRESHOLD_PCT` | `85` | Alert if container Memory% ≥ this |
| `CONTAINER_FILTER` | `` | Optional name-prefix filter (blank = all) |
| `DRY_RUN` | `true` | Log findings without sending alerts |

**Environment:**
```groovy
SLACK_WEBHOOK_URL = credentials('slack-webhook-docker-alerts')
```

**Stages:**
1. `Validate Environment` — Docker daemon check; validate thresholds are 0–100
2. `Install` — `bun install --frozen-lockfile`
3. `Collect Stats` — `bun run src/resource-report.ts` with `returnStatus: true`
4. `Archive Report` — `archiveArtifacts allowEmptyArchive: true, artifacts: 'resource-report-*.json'`
5. `Notify` — Slack alert for threshold breaches (when not `DRY_RUN`)

**Exit code contract:** same 0 / 2 / other pattern.

### Entry Point: `src/resource-report.ts`

Env vars (Zod-validated):
- `CPU_THRESHOLD_PCT` — `z.coerce.number().min(0).max(100).default(80)`
- `MEM_THRESHOLD_PCT` — `z.coerce.number().min(0).max(100).default(85)`
- `CONTAINER_FILTER` — `z.string().default('')`
- `BUILD_NUMBER` — string (Jenkins-injected)
- `WORKSPACE` — string (Jenkins-injected)

Flow:
1. Validate env vars; exit 1 on error
2. `getContainerList()` → filter by `CONTAINER_FILTER` prefix if set
3. `getContainerStats()` for running containers only
4. `findResourceBreaches(stats, CPU_THRESHOLD_PCT, MEM_THRESHOLD_PCT)`
5. `writeReport(breaches, '$WORKSPACE/resource-report-$BUILD_NUMBER.json')`
6. `process.exit(breaches.length > 0 ? 2 : 0)`

---

## Automation 3: Disk Cleanup Audit

### Pipeline: `disk-audit/Jenkinsfile`

**Purpose:** Identify disk space wasted by dangling images, anonymous volumes, and build cache. Report prune candidates — never execute any destructive command.

**Parameters:**

| Name | Default | Description |
|---|---|---|
| `CRON_SCHEDULE` | `H 6 * * *` | Cron expression controlling how often this job runs. Empty string disables scheduling. |
| `DANGLING_IMAGE_AGE_DAYS` | `7` | Flag dangling images older than N days |
| `VOLUME_SIZE_MB_THRESHOLD` | `500` | Flag anonymous volumes larger than N MB |
| `REPORT_TOP_N` | `10` | Number of largest candidates to highlight |
| `DRY_RUN` | `true` | Always report only — no prune ever |

**Environment:**
```groovy
SLACK_WEBHOOK_URL = credentials('slack-webhook-docker-alerts')
```

**Stages:**
1. `Validate Environment` — Docker daemon check
2. `Install` — `bun install --frozen-lockfile`
3. `Audit Disk Usage` — `bun run src/disk-audit.ts`
4. `Archive Report` — `archiveArtifacts allowEmptyArchive: true, artifacts: 'disk-audit-*.json'`
5. `Notify` — Slack summary with total reclaimable space (always sends, not gated by DRY_RUN)

**Exit code:** always 0 (informational only — no concept of failure)

**Note:** `DRY_RUN` param is present for UI consistency but the pipeline never prunes regardless. The parameter is a no-op guard to make the intent obvious to anyone reading the job config.

### Entry Point: `src/disk-audit.ts`

Env vars (Zod-validated):
- `DANGLING_IMAGE_AGE_DAYS` — `z.coerce.number().int().min(0).default(7)`
- `VOLUME_SIZE_MB_THRESHOLD` — `z.coerce.number().min(0).default(500)`
- `REPORT_TOP_N` — `z.coerce.number().int().min(1).max(100).default(10)`
- `BUILD_NUMBER`, `WORKSPACE` — Jenkins-injected strings

Flow:
1. Validate env vars; exit 1 on error
2. `getDiskUsage()` → full disk breakdown
3. `findDiskCandidates(usage, DANGLING_IMAGE_AGE_DAYS, VOLUME_SIZE_MB_THRESHOLD)`
4. Sort by reclaimable size desc; take top `REPORT_TOP_N`
5. `writeReport(candidates, '$WORKSPACE/disk-audit-$BUILD_NUMBER.json')`
6. `process.exit(0)`

---

## Automation 4: Swarm Health Monitor

### Pipeline: `swarm-health/Jenkinsfile`

**Purpose:** Monitor Docker Swarm cluster health — node availability, service replica counts vs desired, and recent task failure rate. Alert when services are degraded or nodes go down.

**Parameters:**

| Name | Default | Description |
|---|---|---|
| `CRON_SCHEDULE` | `H/10 * * * *` | Cron expression controlling how often this job runs. Empty string disables scheduling. |
| `TASK_FAILURE_WINDOW_MINUTES` | `30` | Look back N minutes for task failures |
| `TASK_FAILURE_THRESHOLD` | `3` | Alert if ≥ N task failures within the window |
| `DRY_RUN` | `true` | Log findings without sending alerts |

**Environment:**
```groovy
SLACK_WEBHOOK_URL = credentials('slack-webhook-docker-alerts')
```

**Stages:**
1. `Validate Environment` — `docker info` succeeds; confirm Swarm is active (`LocalNodeState == active`); `bun --version` present
2. `Install` — `bun install --frozen-lockfile`
3. `Check Swarm Health` — `bun run src/swarm-health.ts` with `returnStatus: true`
4. `Notify` (when `DRY_RUN = false` and exit 2) — Slack orange alert listing degraded services and down nodes

**Exit code contract:**
- `0` — all nodes Ready/Active; all services at desired replica count; task failures below threshold
- `2` — one or more issues found → `currentBuild.result = 'UNSTABLE'`
- Other non-zero — Swarm not active or runtime crash → FAILED

**Post:**
```groovy
post {
    unstable { /* Slack orange — list degraded services */ }
    failure  { /* Slack red — Swarm unreachable or not initialized */ }
    always   { cleanWs() }
}
```

### Entry Point: `src/swarm-health.ts`

Env vars (Zod-validated):
- `TASK_FAILURE_WINDOW_MINUTES` — `z.coerce.number().int().min(1).default(30)`
- `TASK_FAILURE_THRESHOLD` — `z.coerce.number().int().min(1).default(3)`
- `WORKSPACE` — Jenkins-injected string

Flow:
1. Validate env vars with Zod; `process.exit(1)` on validation error
2. `isSwarmActive()` — if not active, log error and `process.exit(1)` (hard fail, not soft)
3. `getSwarmNodes()` — collect all nodes
4. `getSwarmServices()` — collect all services; parse `runningReplicas` vs `desiredReplicas`
5. `getSwarmTaskFailures(since)` — `since` = now minus `TASK_FAILURE_WINDOW_MINUTES`
6. `classifySwarmHealth(nodes, services, tasks)` → `SwarmHealthSummary`
7. `writeReport(summary, '$WORKSPACE/swarm-health-report.json')`
8. `process.exit(summary.healthy ? 0 : 2)`

---

## Tests

Framework: **Bun test** (`bun test`) — built-in, no extra deps.

All Docker CLI calls go through `runDocker()`. Tests mock it via `mock()` from `bun:test`.

### `tests/docker-monitor.test.ts`

| Test | What it verifies |
|---|---|
| `getContainerList` returns typed array | Mock `docker ps` NDJSON → `Container[]` with correct fields |
| `getContainerList` handles empty output | Zero containers → `[]`, no crash |
| `getContainerStats` parses `"12.34%"` CPU string | Strips `%`, returns `number` |
| `getContainerStats` parses `"512MiB / 2GiB"` mem string | Returns `memUsageMiB=512`, `memLimitMiB=2048` |
| `classifyContainerHealth` → healthy | Status `running`, health `healthy`, restarts < threshold |
| `classifyContainerHealth` → unhealthy | Health status `unhealthy` |
| `classifyContainerHealth` → restarting | Status `restarting` |
| `classifyContainerHealth` → excess-restarts | RestartCount ≥ threshold |
| `findResourceBreaches` returns breaches | CPU 95% > threshold 80% → breach object |
| `findResourceBreaches` returns empty | All within thresholds → `[]` |
| `getDiskUsage` parses `docker system df` JSON | Correct `totalReclaimableBytes` |
| `findDiskCandidates` filters by age | Image older than `ageDays` → included |
| `findDiskCandidates` filters by volume size | Volume < threshold → excluded |
| `log` emits parseable JSON | Output contains `timestamp`, `level`, `context`, `message` |
| `writeReport` writes valid JSON file | File exists, parses correctly, contains `healthy` + `issues` |

### `tests/swarm-health.test.ts`

| Test | What it verifies |
|---|---|
| `isSwarmActive` returns true | Mock `docker info` JSON with `Swarm.LocalNodeState = "active"` |
| `isSwarmActive` returns false | `LocalNodeState = "inactive"` → false |
| `getSwarmNodes` returns typed array | Mock `docker node ls` NDJSON → `SwarmNode[]` |
| `getSwarmNodes` handles single-node swarm | One node, role Manager → correct fields |
| `getSwarmServices` parses replicas | `"3/3"` → `runningReplicas=3, desiredReplicas=3` |
| `getSwarmServices` detects degraded | `"1/3"` → `runningReplicas=1, desiredReplicas=3` |
| `getSwarmTaskFailures` filters by state | Only tasks with `state=failed` returned |
| `getSwarmTaskFailures` respects `since` | Tasks older than window excluded |
| `classifySwarmHealth` → healthy | All nodes Ready, all services at desired count, failures < threshold |
| `classifySwarmHealth` → unhealthy (node down) | One node `status=Down` → `healthy=false`, `nodesDown=1` |
| `classifySwarmHealth` → unhealthy (degraded service) | `runningReplicas < desiredReplicas` → in `servicesDegraded` |
| `classifySwarmHealth` → unhealthy (task failures) | Failure count ≥ threshold → `healthy=false` |

Coverage target: **80%** of exported functions.

### `package.json` test script

```json
{
  "scripts": {
    "test": "bun test",
    "test:coverage": "bun test --coverage"
  }
}
```

Jenkins calls `bun test --reporter=junit --reporter-outfile=reports/test-results.xml` to produce JUnit XML for the Jenkins test results plugin.

---

## `package.json` (root)

```json
{
  "name": "docker-monitor",
  "private": true,
  "scripts": {
    "health-sweep":    "bun run src/health-sweep.ts",
    "resource-report": "bun run src/resource-report.ts",
    "disk-audit":      "bun run src/disk-audit.ts",
    "swarm-health":    "bun run src/swarm-health.ts",
    "test":            "bun test",
    "typecheck":       "bunx tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.5.0"
  }
}
```

---

## Jenkinsfile Stage Pattern (all three)

```groovy
// Shared pattern — all four Jenkinsfiles follow this structure
pipeline {
    agent { label 'PLACEHOLDER_LINUX_AGENT' }

    options {
        timeout(time: 15, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timestamps()
    }

    // CRON_SCHEDULE param drives the trigger — change the param, save job, done.
    // On the very first run params is not yet populated, so the Elvis operator
    // falls back to the defaultValue defined in parameters {}.
    triggers {
        cron(params.CRON_SCHEDULE ?: '')
    }

    parameters {
        string(
            name: 'CRON_SCHEDULE',
            defaultValue: 'PLACEHOLDER_DEFAULT_CRON',
            description: 'Cron expression (e.g. "H/10 * * * *"). Set to empty string to pause scheduling without deleting the job.'
        )
        /* additional per-automation params follow */
    }

    environment {
        SLACK_WEBHOOK_URL = credentials('slack-webhook-docker-alerts')
    }

    stages {
        stage('Validate Environment') { /* docker info + bun --version */ }
        stage('Install')              { steps { sh 'bun install --frozen-lockfile' } }
        stage('Run')                  { /* bun run src/<script>.ts, returnStatus: true */ }
        stage('Archive Report')       { /* archiveArtifacts */ }
        stage('Notify')               { /* Slack via shared-lib-slack-notification */ }
    }

    post {
        unstable { /* orange Slack */ }
        failure  { /* red Slack */    }
        always   { cleanWs()         }
    }
}
```

---

## Notifications

Reuses `shared-lib-slack-notification.groovy` (already in `templates/`). Colors:

| State | Color |
|---|---|
| All healthy | `#36A64F` green |
| UNSTABLE (issues found) | `#FFA500` orange |
| FAILURE (crash) | `#FF0000` red |

---

## Credentials Required in Jenkins

| Credential ID | Type | Used by |
|---|---|---|
| `slack-webhook-docker-alerts` | Secret text | All three pipelines |

No API tokens — all data from local Docker daemon via CLI.

---

## Acceptance Criteria

### AC-1: Health sweep runs on schedule and writes a report
- Given: `health-sweep/Jenkinsfile` configured with `H/15 * * * *`
- When: triggered (manual or scheduled)
- Then: all containers inspected; `health-report.json` written to workspace; exit 0 if healthy, 2 if any issues

### AC-2: Unhealthy container → UNSTABLE, not FAILED
- Given: one container has health status `unhealthy`
- When: sweep runs
- Then: `currentBuild.result = 'UNSTABLE'`; Slack orange sent (DRY_RUN=false); build does NOT fail

### AC-3: Resource threshold breaches are detected
- Given: container CPU% exceeds `CPU_THRESHOLD_PCT`
- When: resource report runs
- Then: breach logged with container name, metric, actual %, threshold %; exit code 2

### AC-4: Disk audit never prunes
- Given: any run of `disk-audit/Jenkinsfile`
- When: run completes
- Then: zero `docker prune`, `docker rm`, or `docker rmi` commands executed; JSON report written

### AC-5: All pipelines fail fast when Docker daemon is unreachable
- Given: `docker info` returns non-zero
- When: `Validate Environment` stage runs
- Then: build fails immediately with clear error; `bun run` never invoked

### AC-6: DRY_RUN=true → no external side effects
- Given: `DRY_RUN = true` (default on all three)
- When: any pipeline runs
- Then: no Slack message sent; no files written outside workspace; findings to console only

### AC-7: Bun tests pass with 80%+ coverage
- Given: `bun test --coverage` runs in CI
- Then: all required test cases pass; `runDocker()` mocked — no real Docker calls in tests

### AC-8: `runDocker()` is the sole Docker CLI boundary
- Given: `docker-monitor.ts` routes all CLI calls through `runDocker(args)`
- When: tests mock `runDocker`
- Then: all exported functions are fully testable without a Docker daemon

### AC-9: Cron schedule is configurable via parameter without editing the Jenkinsfile
- Given: any of the four pipelines is running
- When: an operator changes `CRON_SCHEDULE` to a new expression (e.g. `0 * * * *`) and saves the job
- Then: the trigger is updated on that run; subsequent runs fire on the new schedule
- When: `CRON_SCHEDULE` is set to empty string
- Then: scheduled triggering is disabled; manual triggers still work

### AC-10: Swarm Health Monitor detects degraded services and down nodes
- Given: `swarm-health/Jenkinsfile` runs against a Swarm where one service has `1/3` replicas running
- When: `swarm-health.ts` executes
- Then: `servicesDegraded` contains the service; `healthy = false`; exit code 2; Slack orange sent (DRY_RUN=false)

### AC-10: Swarm Health Monitor fails fast when Swarm is not active
- Given: the Jenkins agent has Docker but Swarm is not initialized (`docker info → LocalNodeState: "inactive"`)
- When: the pipeline runs
- Then: `Validate Environment` or entry-point exits 1 immediately with a clear error; build marked FAILED

### AC-11: Env vars validated at entry-point with Zod
- Given: a required env var is missing or out of range
- When: any entry-point script starts
- Then: Zod throws a formatted validation error; `process.exit(1)` before any Docker call

### AC-12: TypeScript strict mode — no type errors
- Given: `bunx tsc --noEmit` runs in `Validate Environment` stage (or as a separate `Typecheck` stage)
- Then: zero errors; no `any` types

---

## Constraints & Gotchas

- **`docker stats --no-stream` blocks until all containers respond.** Wrap with a timeout via `AbortController` + `Bun.spawn`. Kill after 30s.
- **`docker stats` CPU% is a string `"12.34%"` — parse with `parseFloat(s)`; do not coerce directly.** Same for memory (`"512MiB / 2GiB"` → split on ` / `, strip unit suffix, convert to MiB).
- **`docker system df --format json` is available from Docker Engine 25+.** If older, fall back to `docker system df -v` and parse table output. Validate Docker version in `Validate Environment`.
- **Bun must be installed on the Jenkins agent.** Add `bun --version` to `Validate Environment`; no fallback to Node.
- **`bun install --frozen-lockfile` requires a committed `bun.lockb`.** The lockfile must be committed alongside `package.json`.
- **Never default `DRY_RUN` to `false`** — all three pipelines default `true`. Established convention across this repo.
- **Exit code 2 = soft findings** — same contract as HiBobTeamsSync and HibobCustomFieldSync. Do not use any other non-zero code for informational-level findings.
- **`runDocker()` must not shell-expand user input** — args passed as a string array to `Bun.spawn`, never interpolated into a shell string. Prevents command injection.
- **`CRON_SCHEDULE` parameter / first-run bootstrapping.** On the very first build, `params.CRON_SCHEDULE` is `null` (parameters not yet populated). The Elvis operator `params.CRON_SCHEDULE ?: ''` prevents an NPE and disables the cron for that one run. Jenkins picks up the `defaultValue` from `parameters {}` on the second run and onwards. Run the job manually once after initial setup to activate the schedule.
- **`docker node ls` requires Swarm manager role.** If the agent is a worker node, the command fails. The `Validate Environment` stage must confirm the local node is a manager (`docker info --format '{{.Swarm.ControlAvailable}}'` returns `true`).
- **`docker service ps` with `--filter desired-state=failed` only returns tasks from services visible to this manager.** If the Swarm has multiple managers, run this pipeline on the leader or a manager, not a worker.
- **Swarm task `error` field can be empty for graceful shutdowns.** Only count tasks with a non-empty `error` string as failures; `shutdown` state without error is normal.
- **`docker service ls` replica string is `"N/M"` for replicated, `"N/N (global)"` for global services.** Parse accordingly — global services don't have a meaningful "degraded" state.
