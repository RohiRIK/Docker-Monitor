# Docker Monitor

Jenkins automation suite that monitors a Docker + Docker Swarm environment via four independent scheduled pipelines. All monitoring logic is written in TypeScript and runs on Bun. No automated remediation — report and alert only.

Full specification: [`specs/docker-environment-monitor.md`](specs/docker-environment-monitor.md)

---

## Architecture

| Pipeline | Jenkinsfile | Script | Default schedule | What it checks |
|---|---|---|---|---|
| Container Health Sweep | `health-sweep/Jenkinsfile` | `src/health-sweep.ts` | Every 15 min | Unhealthy/restarting containers, excess restarts |
| Resource Usage Report | `resource-report/Jenkinsfile` | `src/resource-report.ts` | Every hour | CPU% and Memory% vs thresholds |
| Disk Cleanup Audit | `disk-audit/Jenkinsfile` | `src/disk-audit.ts` | Daily ~06:00 | Dangling images, anonymous volumes |
| Swarm Health Monitor | `swarm-health/Jenkinsfile` | `src/swarm-health.ts` | Every 10 min | Swarm nodes, service replicas, task failures |

All four pipelines share a single TypeScript module — `src/docker-monitor.ts` — which is the sole boundary to the Docker CLI. No other file calls `docker` directly.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker Engine 25+ | Required for `docker system df --format json`. Earlier versions will skip the reclaimable total in disk-audit. |
| Bun ≥ 1.1 | `bun --version` must succeed on the Jenkins agent |
| Docker CLI on `PATH` | Agent must have access to the Docker daemon socket |
| Swarm manager node | `swarm-health` pipeline requires a manager node. Worker nodes cannot run `docker node ls`. |

---

## Local Development

```bash
# Install dependencies
bun install

# Run a specific monitor against your local Docker daemon
bun run health-sweep
bun run resource-report
bun run disk-audit
bun run swarm-health

# Run tests (no Docker required — all mocked)
bun test

# Run tests with coverage
bun test --coverage

# Type-check
bunx tsc --noEmit
```

Environment variables are read by each script. All have safe defaults so you can run them locally without setting anything:

```bash
RESTART_THRESHOLD=3 bun run health-sweep
CPU_THRESHOLD_PCT=70 MEM_THRESHOLD_PCT=80 bun run resource-report
DANGLING_IMAGE_AGE_DAYS=3 bun run disk-audit
TASK_FAILURE_WINDOW_MINUTES=60 bun run swarm-health
```

---

## Jenkins Setup

1. **Create a Jenkins credential** — Secret Text, ID: `slack-webhook-docker-alerts`, value: your Slack incoming webhook URL.

2. **Create four Pipeline jobs** (or one Multibranch Pipeline per subdirectory):
   - Job 1 → Pipeline script from SCM → path: `health-sweep/Jenkinsfile`
   - Job 2 → Pipeline script from SCM → path: `resource-report/Jenkinsfile`
   - Job 3 → Pipeline script from SCM → path: `disk-audit/Jenkinsfile`
   - Job 4 → Pipeline script from SCM → path: `swarm-health/Jenkinsfile`

3. **Set the agent label** — replace `PLACEHOLDER_LINUX_AGENT` in pipelines 1–3 and `PLACEHOLDER_SWARM_MANAGER_AGENT` in pipeline 4 with your actual Jenkins agent labels.

4. **First run** — trigger each job manually once. Jenkins registers the `CRON_SCHEDULE` parameter on the first run; the cron trigger activates from the second run onward.

5. **Adjusting the schedule** — change the `CRON_SCHEDULE` parameter value in the job UI and save. The new schedule takes effect on the next build.

---

## Credentials

| Credential ID | Type | Required by |
|---|---|---|
| `slack-webhook-docker-alerts` | Secret text (Slack webhook URL) | All four pipelines |

No other credentials are needed. All data comes from the local Docker daemon via CLI.

---

## Pipeline Parameters

### Container Health Sweep

| Parameter | Default | Description |
|---|---|---|
| `CRON_SCHEDULE` | `H/15 * * * *` | Cron expression. Empty string pauses scheduling. |
| `RESTART_THRESHOLD` | `5` | Alert if RestartCount ≥ this value |
| `INCLUDE_STOPPED` | `true` | Include stopped (Exited) containers |
| `DRY_RUN` | `true` | Log only — skip Slack alerts and report writes |

### Resource Usage Report

| Parameter | Default | Description |
|---|---|---|
| `CRON_SCHEDULE` | `H * * * *` | Cron expression. Empty string pauses scheduling. |
| `CPU_THRESHOLD_PCT` | `80` | Alert if CPU% ≥ this value (0–100) |
| `MEM_THRESHOLD_PCT` | `85` | Alert if Memory% ≥ this value (0–100) |
| `CONTAINER_FILTER` | _(blank)_ | Name prefix filter — blank checks all containers |
| `DRY_RUN` | `true` | Log only — skip Slack alerts |

### Disk Cleanup Audit

| Parameter | Default | Description |
|---|---|---|
| `CRON_SCHEDULE` | `H 6 * * *` | Cron expression. Empty string pauses scheduling. |
| `DANGLING_IMAGE_AGE_DAYS` | `7` | Flag dangling images older than N days |
| `VOLUME_SIZE_MB_THRESHOLD` | `500` | Flag anonymous volumes larger than N MB |
| `REPORT_TOP_N` | `10` | Top N candidates by reclaimable size in report |
| `DRY_RUN` | `true` | No-op — disk audit never prunes regardless |

### Swarm Health Monitor

| Parameter | Default | Description |
|---|---|---|
| `CRON_SCHEDULE` | `H/10 * * * *` | Cron expression. Empty string pauses scheduling. |
| `TASK_FAILURE_WINDOW_MINUTES` | `30` | Look-back window for failed Swarm tasks |
| `TASK_FAILURE_THRESHOLD` | `3` | Alert if failed task count ≥ this value |
| `DRY_RUN` | `true` | Log only — skip Slack alerts |

---

## Exit Code Contract

All four pipelines follow the same exit code convention:

| Exit code | Meaning | Jenkins build result |
|---|---|---|
| `0` | Healthy — nothing to alert on | SUCCESS |
| `2` | Issues found (unhealthy containers, threshold breach, degraded services) | UNSTABLE |
| `1` | Configuration / environment error (missing Swarm, bad env vars) | FAILURE |
| Other non-zero | Runtime crash | FAILURE |

Exit code `2` sets `currentBuild.result = 'UNSTABLE'` rather than `FAILED`, so a monitor finding issues does not block downstream jobs.

---

## Troubleshooting

**`bun not found on PATH`** — install Bun on the Jenkins agent: `curl -fsSL https://bun.sh/install | bash`

**`Docker daemon is not reachable`** — ensure the Jenkins agent user has access to the Docker socket (`/var/run/docker.sock`) or is in the `docker` group.

**`Docker Swarm is not active`** — run `docker swarm init` on the manager node first, or ensure the agent is configured to target a Swarm manager.

**`This node is a Swarm worker, not a manager`** — the `swarm-health` job must run on a manager node. Update `PLACEHOLDER_SWARM_MANAGER_AGENT` to an agent label that targets a manager.

**`CRON_SCHEDULE has no effect after changing it`** — the trigger updates on the *next* build after you save the job. Trigger one manual run to activate the new schedule.

**`bun install --frozen-lockfile fails`** — `bun.lock` must be committed to the repository. Run `bun install` locally and commit the generated lockfile.
