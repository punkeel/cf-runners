import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { WorkerEnvironment } from "./environment";
import { githubRunnerTokenFor, type GitHubRepositoryTarget } from "./github-repository";
import { githubTokenForRunner, type GitHubAppDependencies } from "./github-app";
import { GitHubJobAssignmentClient, type GitHubJobDetail } from "./github-job-assignment";
import { deleteGitHubRunner } from "./provision";
import { assignResourceTraceRunner } from "./resource-traces";
import { startRunnerProvisioningWorkflows } from "./runner-provisioning-workflow";
import { runnerProfileSchema, type RunnerProfile } from "./runner-profiles";
import { DEFAULT_ACCOUNT_CAPACITY, fitsAccountCapacity } from "./scheduler-policy";

const SCHEDULER_ALARM_DELAY_MS = 60_000;
// A running Container's job-started hook polls runner-cache assignment about
// once per second. The GitHub self-heal below is an escape hatch for lost
// `in_progress` deliveries, so bound it instead of calling the API per poll.
const RUNNER_ASSIGNMENT_GITHUB_RECONCILE_INTERVAL_MS = 10_000;
// Each reconcile probes candidate jobs through the GitHub API with a 5 s
// per-request timeout; cap the whole sweep so it stays well inside the
// job-started hook's 30 s budget even when the candidate list is full.
const RUNNER_ASSIGNMENT_GITHUB_RECONCILE_BUDGET_MS = 8_000;
const RUNNER_COMPLETION_GRACE_MS = 30_000;
// GitHub can deliver workflow_job: completed before actions/cache finishes its
// post-job upload through the runner's local results proxy. Keep the one-job
// runner-to-cache mapping briefly after Container shutdown for that finalizer.
const RUNNER_CACHE_POST_JOB_GRACE_MS = 5 * 60_000;
const RUNNER_CLEANUP_RETRY_MS = 60_000;
const ACTIVE_JOB_STATES = ["admitted", "provisioning", "running", "releasing", "stopped-awaiting-completion"] as const;

type JobStatus =
  | "queued"
  | "admitted"
  | "provisioning"
  | "running"
  | "releasing"
  | "stopped-awaiting-completion"
  | "completed"
  | "cancelled"
  | "failed";

const activeJobStates = new Set<JobStatus>(ACTIVE_JOB_STATES);

type SchedulerEventDetailScalar = boolean | number | string | null;
type SchedulerEventDetailValue = SchedulerEventDetailScalar | readonly SchedulerEventDetailScalar[];

interface SchedulerEventDetail {
  readonly [property: string]: SchedulerEventDetailValue | undefined;
}

type SchedulerEventData = SchedulerEventDetail | string | null;

const schedulerEventDetailSchema = z.union([
  z.string(),
  z.null(),
  z.record(
    z.string(),
    z.union([
      z.boolean(),
      z.number(),
      z.string(),
      z.null(),
      z.array(z.union([z.boolean(), z.number(), z.string(), z.null()])),
    ]),
  ),
]);

interface JobRow {
  [column: string]: ArrayBuffer | number | string | null;
  job_id: string;
  runner_name: string;
  github_owner: string;
  github_repository: string;
  head_sha: string;
  worker_origin: string;
  github_installation_id: number | null;
  cache_scope: string;
  cache_fallback_scope: string | null;
  cache_write_allowed: number;
  github_assignment_observed: number;
  profile_json: string;
  profile_key: string;
  vcpu: number;
  memory_mib: number;
  disk_mb: number;
  status: JobStatus;
  created_at: number;
  updated_at: number;
  runner_id: number | null;
  runner_attempt: number;
  provisioning_owner_scoped: number;
  failure_reason: string | null;
  container_stopped_at: number | null;
  container_exit_code: number | null;
  container_stop_reason: string | null;
  recovery_due_at: number | null;
  runner_cleanup_state: "none" | "retry" | "done";
  runner_cleanup_due_at: number | null;
  runner_cleanup_attempts: number;
}

interface SchedulerEventRow {
  [column: string]: ArrayBuffer | number | string | null;
  event_id: number;
  job_id: string | null;
  kind: string;
  detail_json: string | null;
  created_at: number;
}

/**
 * A JIT runner has a durable identity of its own. Keep it separate from its
 * source job: GitHub may assign two compatible runners to each other's jobs,
 * and processing one assignment must not erase the other runner's mapping.
 */
interface JitRunnerRow {
  [column: string]: ArrayBuffer | number | string | null;
  runner_name: string;
  source_job_id: string;
  github_owner: string;
  github_repository: string;
  profile_key: string;
  github_runner_id: number | null;
  assigned_job_id: string | null;
  assignment_observed: number;
  created_at: number;
  updated_at: number;
}

interface ResourceTotals {
  vcpu: number;
  memoryMib: number;
  diskMb: number;
}

export interface SchedulerJobInput {
  jobId: string;
  headSha: string;
  runnerName: string;
  target: GitHubRepositoryTarget;
  installationId?: number;
  profile: RunnerProfile;
  workerOrigin: string;
  /** GitHub-compatible cache visibility resolved from the signed workflow run. */
  cacheScope?: SchedulerCacheScope;
}

export interface SchedulerCacheScope {
  scope: string;
  fallbackScope?: string;
  writeAllowed: boolean;
}

export interface SchedulerAdmission {
  jobId: string;
  runnerName: string;
  workflowId: string;
}

export interface SchedulerResult {
  accepted: boolean;
  queueReason?: string;
  admissions: SchedulerAdmission[];
}

export interface SchedulerRunnerClaimInput {
  jobId: string;
  runnerName: string;
  runnerId?: number;
  target: GitHubRepositoryTarget;
  profile: RunnerProfile;
}

export interface RunnerProvisioningPlan {
  kind: "provision";
  jobId: string;
  headSha: string;
  runnerName: string;
  target: GitHubRepositoryTarget;
  workerOrigin: string;
  cacheScope?: SchedulerCacheScope;
  installationId: number | null;
  profile: RunnerProfile;
}

export type SchedulerProvisioningClaim =
  | { kind: "wait" }
  | { kind: "cancelled" }
  | { kind: "missing" }
  | RunnerProvisioningPlan;

export interface SchedulerStatus {
  capacity: {
    limit: ResourceTotals;
    reserved: ResourceTotals;
  };
  jobs: Array<{
    jobId: string;
    runnerName: string;
    repository: string;
    profileKey: string;
    status: JobStatus;
    queueWaitMs: number | null;
    runnerId: number | null;
    containerStoppedAt: number | null;
    containerExitCode: number | null;
    containerStopReason: string | null;
    recoveryDueAt: number | null;
    runnerCleanupState: "none" | "retry" | "done";
  }>;
  events: Array<{
    eventId: number;
    jobId: string | null;
    kind: string;
    detail: SchedulerEventData;
    createdAt: number;
  }>;
}

function now(): number {
  return Date.now();
}

function parseProfile(value: string): RunnerProfile {
  return runnerProfileSchema.parse(JSON.parse(value));
}

function parseEventDetail(value: string | null): SchedulerEventData {
  if (value === null) {
    return null;
  }
  try {
    const parsed = schedulerEventDetailSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : value;
  } catch {
    return value;
  }
}

function activeStatusList(): string {
  return ACTIVE_JOB_STATES.map(() => "?").join(", ");
}

function storedCacheScope(scope: string, fallbackScope: string | null, writeAllowed: number): SchedulerCacheScope {
  const result: SchedulerCacheScope = { scope, writeAllowed: writeAllowed !== 0 };
  if (fallbackScope !== null) {
    result.fallbackScope = fallbackScope;
  }
  return result;
}

function jobMatchesRunnerClaim(job: JobRow, input: SchedulerRunnerClaimInput): boolean {
  return (
    job.github_owner.toLowerCase() === input.target.owner.toLowerCase() &&
    job.github_repository.toLowerCase() === input.target.repository.toLowerCase() &&
    job.profile_key === input.profile.key
  );
}

/**
 * One scheduler exists per Cloudflare account. The account is deliberately the
 * coordination atom: all resource reservations for this runner service live in
 * one SQLite-backed Durable Object, while Workflows handle runner start.
 */
export class AccountRunnerScheduler extends DurableObject<WorkerEnvironment> {
  private readonly runnerReconcileAttempts = new Map<
    string,
    { timestamp: number; cursor: number; runId?: string; page: number }
  >();
  assignmentDependencies?: GitHubAppDependencies;

  constructor(ctx: DurableObjectState, env: WorkerEnvironment) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      this.releaseCompletedJobsAwaitingContainerStop();
      this.scheduleReleaseRecoveries();
      // A Worker deployment can reset an in-flight scheduler invocation. Re-arm
      // the persisted alarm while reconstructing the DO so queued admissions
      // and recovery work continue without another GitHub delivery.
      await this.scheduleWorkAlarmIfNeeded();
    });
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_jobs (
        job_id TEXT PRIMARY KEY,
        runner_name TEXT NOT NULL,
        github_owner TEXT NOT NULL DEFAULT '',
        github_repository TEXT NOT NULL DEFAULT '',
        head_sha TEXT NOT NULL DEFAULT '',
        worker_origin TEXT NOT NULL DEFAULT '',
        github_installation_id INTEGER,
        cache_scope TEXT NOT NULL DEFAULT '',
        cache_fallback_scope TEXT,
        cache_write_allowed INTEGER NOT NULL DEFAULT 0,
        github_assignment_observed INTEGER NOT NULL DEFAULT 0,
        profile_json TEXT NOT NULL,
        profile_key TEXT NOT NULL,
        vcpu REAL NOT NULL,
        memory_mib INTEGER NOT NULL,
        disk_mb INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        runner_id INTEGER,
        runner_attempt INTEGER NOT NULL DEFAULT 1,
        failure_reason TEXT,
        container_stopped_at INTEGER,
        container_exit_code INTEGER,
        container_stop_reason TEXT,
        recovery_due_at INTEGER,
        runner_cleanup_state TEXT NOT NULL DEFAULT 'none',
        runner_cleanup_due_at INTEGER,
        runner_cleanup_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS scheduler_jobs_queue ON scheduler_jobs(status, created_at, job_id);
      CREATE INDEX IF NOT EXISTS scheduler_jobs_runner ON scheduler_jobs(runner_name);
      CREATE TABLE IF NOT EXISTS scheduler_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        kind TEXT NOT NULL,
        detail_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scheduler_events_recent ON scheduler_events(created_at DESC, event_id DESC);
      CREATE TABLE IF NOT EXISTS scheduler_jit_runners (
        runner_name TEXT PRIMARY KEY,
        source_job_id TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_repository TEXT NOT NULL,
        profile_key TEXT NOT NULL,
        assigned_job_id TEXT,
        assignment_observed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scheduler_jit_runners_assignment
        ON scheduler_jit_runners(assigned_job_id, assignment_observed, updated_at);
    `);

    const jobColumns = this.rows<{ name: string }>("PRAGMA table_info(scheduler_jobs)");
    const jobColumnMigrations = [
      ["github_owner", "TEXT NOT NULL DEFAULT ''"],
      ["github_repository", "TEXT NOT NULL DEFAULT ''"],
      ["head_sha", "TEXT NOT NULL DEFAULT ''"],
      ["worker_origin", "TEXT NOT NULL DEFAULT ''"],
      ["github_installation_id", "INTEGER"],
      ["cache_scope", "TEXT NOT NULL DEFAULT ''"],
      ["cache_fallback_scope", "TEXT"],
      ["cache_write_allowed", "INTEGER NOT NULL DEFAULT 0"],
      ["github_assignment_observed", "INTEGER NOT NULL DEFAULT 0"],
      ["runner_attempt", "INTEGER NOT NULL DEFAULT 1"],
      ["provisioning_owner_scoped", "INTEGER NOT NULL DEFAULT 0"],
      ["container_stopped_at", "INTEGER"],
      ["container_exit_code", "INTEGER"],
      ["container_stop_reason", "TEXT"],
      ["recovery_due_at", "INTEGER"],
      ["runner_cleanup_state", "TEXT NOT NULL DEFAULT 'none'"],
      ["runner_cleanup_due_at", "INTEGER"],
      ["runner_cleanup_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, definition] of jobColumnMigrations) {
      if (!jobColumns.some((column) => column.name === name)) {
        this.ctx.storage.sql.exec(`ALTER TABLE scheduler_jobs ADD COLUMN ${name} ${definition}`);
      }
    }

    const jitRunnerColumns = this.rows<{ name: string }>("PRAGMA table_info(scheduler_jit_runners)");
    const jitRunnerColumnMigrations = [["github_runner_id", "INTEGER"]] as const;
    for (const [name, definition] of jitRunnerColumnMigrations) {
      if (!jitRunnerColumns.some((column) => column.name === name)) {
        this.ctx.storage.sql.exec(`ALTER TABLE scheduler_jit_runners ADD COLUMN ${name} ${definition}`);
      }
    }
    // Jobs that were queued before the pool became multi-repository belong to
    // the original POC repository and must retain a usable cleanup credential.
    if (this.env.LEGACY_GITHUB_OWNER !== undefined && this.env.LEGACY_GITHUB_REPOSITORY !== undefined) {
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET github_owner = ?, github_repository = ?
         WHERE github_owner = '' AND github_repository = ''`,
        this.env.LEGACY_GITHUB_OWNER,
        this.env.LEGACY_GITHUB_REPOSITORY,
      );
    }
  }

  private rows<T extends Record<string, ArrayBuffer | number | string | null>>(
    statement: string,
    ...bindings: unknown[]
  ): T[] {
    return this.ctx.storage.sql.exec<T>(statement, ...bindings).toArray();
  }

  private recordEvent(kind: string, options: { jobId?: string; detail?: SchedulerEventDetail } = {}): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO scheduler_events (job_id, kind, detail_json, created_at)
       VALUES (?, ?, ?, ?)`,
      options.jobId ?? null,
      kind,
      options.detail === undefined ? null : JSON.stringify(options.detail),
      now(),
    );
  }

  private job(jobId: string): JobRow | undefined {
    return this.rows<JobRow>("SELECT * FROM scheduler_jobs WHERE job_id = ?", jobId)[0];
  }

  private reservedResources(): ResourceTotals {
    const row = this.rows<{ vcpu: number | null; memory_mib: number | null; disk_mb: number | null }>(
      `SELECT COALESCE(SUM(vcpu), 0) AS vcpu,
              COALESCE(SUM(memory_mib), 0) AS memory_mib,
              COALESCE(SUM(disk_mb), 0) AS disk_mb
       FROM scheduler_jobs WHERE status IN (${activeStatusList()})`,
      ...ACTIVE_JOB_STATES,
    )[0];
    return {
      vcpu: row?.vcpu ?? 0,
      memoryMib: row?.memory_mib ?? 0,
      diskMb: row?.disk_mb ?? 0,
    };
  }

  private canReserve(profile: RunnerProfile): boolean {
    return fitsAccountCapacity(this.reservedResources(), profile, DEFAULT_ACCOUNT_CAPACITY);
  }

  private admissionFor(job: JobRow): SchedulerAdmission {
    return {
      jobId: job.job_id,
      runnerName: job.runner_name,
      workflowId: `${job.job_id}-attempt-${job.runner_attempt}`,
    };
  }

  private readyAdmissions(): SchedulerAdmission[] {
    return this.rows<JobRow>(
      "SELECT * FROM scheduler_jobs WHERE status = 'admitted' ORDER BY created_at ASC, job_id ASC",
    ).map((job) => this.admissionFor(job));
  }

  private admitNext(): SchedulerAdmission[] {
    const next = this.rows<JobRow>(
      "SELECT * FROM scheduler_jobs WHERE status = 'queued' ORDER BY created_at ASC, job_id ASC LIMIT 1",
    )[0];
    if (next === undefined) {
      return [];
    }

    const profile = parseProfile(next.profile_json);
    if (!this.canReserve(profile)) {
      return [];
    }

    this.ctx.storage.sql.exec(
      "UPDATE scheduler_jobs SET status = 'admitted', updated_at = ? WHERE job_id = ?",
      now(),
      next.job_id,
    );
    this.recordEvent("scheduler-admitted", {
      jobId: next.job_id,
      detail: { profileKey: profile.key },
    });
    return [this.admissionFor(next)];
  }

  private queueReason(job: JobRow): string | undefined {
    if (job.status !== "queued") {
      return undefined;
    }
    if (!this.canReserve(parseProfile(job.profile_json))) {
      return "waiting-for-account-resource-budget";
    }
    return "waiting-for-earlier-queued-job";
  }

  private async scheduleWorkAlarmIfNeeded(): Promise<void> {
    const work = this.rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scheduler_jobs WHERE status IN ('queued', 'admitted')",
    )[0];
    const recovery = this.rows<{ earliest_due: number | null }>(
      `SELECT MIN(due_at) AS earliest_due
       FROM (
         SELECT recovery_due_at AS due_at
         FROM scheduler_jobs
         WHERE status = 'stopped-awaiting-completion' AND recovery_due_at IS NOT NULL
         UNION ALL
         SELECT runner_cleanup_due_at AS due_at
         FROM scheduler_jobs
         WHERE runner_cleanup_state = 'retry' AND runner_cleanup_due_at IS NOT NULL
         UNION ALL
         SELECT recovery_due_at AS due_at
         FROM scheduler_jobs
         WHERE status = 'releasing' AND recovery_due_at IS NOT NULL
       )`,
    )[0];
    const recoveryDue = (work?.count ?? 0) > 0 ? now() + SCHEDULER_ALARM_DELAY_MS : undefined;
    const scheduledDue = [recovery?.earliest_due, recoveryDue].filter(
      (due): due is number => due !== null && due !== undefined,
    );
    const nextAlarm = scheduledDue.length === 0 ? undefined : Math.max(now(), Math.min(...scheduledDue));
    if (nextAlarm !== undefined) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  async submit(job: SchedulerJobInput): Promise<SchedulerResult> {
    const existing = this.job(job.jobId);
    if (existing !== undefined) {
      if (existing.head_sha === "" && job.headSha !== "") {
        this.ctx.storage.sql.exec(
          "UPDATE scheduler_jobs SET head_sha = ?, updated_at = ? WHERE job_id = ? AND head_sha = ''",
          job.headSha,
          now(),
          job.jobId,
        );
      }
      return { accepted: true, queueReason: this.queueReason(existing), admissions: [] };
    }

    const timestamp = now();
    this.ctx.storage.sql.exec(
      `INSERT INTO scheduler_jobs
       (job_id, runner_name, github_owner, github_repository, head_sha, worker_origin, github_installation_id, cache_scope, cache_fallback_scope, cache_write_allowed, profile_json, profile_key, vcpu, memory_mib, disk_mb, status,
        created_at, updated_at, runner_id, runner_attempt, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, 1, NULL)`,
      job.jobId,
      job.runnerName,
      job.target.owner,
      job.target.repository,
      job.headSha,
      job.workerOrigin,
      job.installationId ?? null,
      job.cacheScope?.scope ?? "",
      job.cacheScope?.fallbackScope ?? null,
      job.cacheScope?.writeAllowed === true ? 1 : 0,
      JSON.stringify(job.profile),
      job.profile.key,
      job.profile.vcpu,
      job.profile.memoryMib,
      job.profile.diskMb,
      timestamp,
      timestamp,
    );
    this.recordEvent("github-job-queued", {
      jobId: job.jobId,
      detail: {
        repository: `${job.target.owner}/${job.target.repository}`,
        headSha: job.headSha,
        installationId: job.installationId ?? null,
        cacheScope: job.cacheScope?.scope ?? null,
        cacheFallbackScope: job.cacheScope?.fallbackScope ?? null,
        cacheWriteAllowed: job.cacheScope?.writeAllowed === true,
        profileKey: job.profile.key,
        runnerName: job.runnerName,
      },
    });

    const admissions = this.admitNext();
    await this.scheduleWorkAlarmIfNeeded();
    const stored = this.job(job.jobId);
    return { accepted: true, queueReason: stored === undefined ? undefined : this.queueReason(stored), admissions };
  }

  async claimProvisioning(jobId: string, runnerName?: string): Promise<SchedulerProvisioningClaim> {
    const job = this.job(jobId);
    if (job === undefined) {
      return { kind: "missing" };
    }
    if (runnerName !== undefined && job.runner_name !== runnerName) {
      return { kind: "cancelled" };
    }
    const planFor = (): RunnerProvisioningPlan => ({
      kind: "provision",
      jobId,
      headSha: job.head_sha,
      runnerName: job.runner_name,
      target: { owner: job.github_owner, repository: job.github_repository },
      workerOrigin: job.worker_origin,
      cacheScope:
        job.cache_scope === ""
          ? undefined
          : storedCacheScope(job.cache_scope, job.cache_fallback_scope, job.cache_write_allowed),
      installationId: job.github_installation_id,
      profile: parseProfile(job.profile_json),
    });
    if (job.status === "queued") {
      // Admission is FIFO through admitNext(); a queued job has no reservation yet.
      return { kind: "wait" };
    }
    if (job.status === "admitted") {
      this.ctx.storage.sql.exec(
        "UPDATE scheduler_jobs SET status = 'provisioning', provisioning_owner_scoped = ?, updated_at = ? WHERE job_id = ?",
        runnerName === undefined ? 0 : 1,
        now(),
        jobId,
      );
      return planFor();
    }
    if (job.status === "provisioning" || job.status === "running") {
      return planFor();
    }
    return { kind: "cancelled" };
  }

  async canStart(jobId: string, runnerName?: string): Promise<boolean> {
    const job = this.job(jobId);
    return job?.status === "provisioning" && (runnerName === undefined || job.runner_name === runnerName);
  }

  async runnerProvisioned(jobId: string, runnerName: string, runnerId: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET runner_id = ?, updated_at = ?
       WHERE job_id = ? AND runner_name = ? AND status = 'provisioning'`,
      runnerId,
      now(),
      jobId,
      runnerName,
    );
    const job = this.rows<JobRow>(
      "SELECT * FROM scheduler_jobs WHERE job_id = ? AND runner_name = ? AND runner_id = ?",
      jobId,
      runnerName,
      runnerId,
    )[0];
    if (job === undefined) {
      return;
    }
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `INSERT INTO scheduler_jit_runners
       (runner_name, source_job_id, github_owner, github_repository, profile_key, github_runner_id, assigned_job_id, assignment_observed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
       ON CONFLICT(runner_name) DO UPDATE SET
         source_job_id = excluded.source_job_id,
         github_owner = excluded.github_owner,
         github_repository = excluded.github_repository,
         profile_key = excluded.profile_key,
         github_runner_id = excluded.github_runner_id,
         assigned_job_id = NULL,
         assignment_observed = 0,
         updated_at = excluded.updated_at`,
      runnerName,
      jobId,
      job.github_owner,
      job.github_repository,
      job.profile_key,
      runnerId,
      timestamp,
      timestamp,
    );
    this.recordEvent("jit-runner-created", {
      jobId,
      detail: { runnerId },
    });
  }

  async runnerStarted(runnerName: string): Promise<void> {
    const job = this.rows<JobRow>(
      "SELECT * FROM scheduler_jobs WHERE runner_name = ? AND status = 'provisioning'",
      runnerName,
    )[0];
    this.ctx.storage.sql.exec(
      "UPDATE scheduler_jobs SET status = 'running', updated_at = ? WHERE runner_name = ? AND status = 'provisioning'",
      now(),
      runnerName,
    );
    if (job !== undefined) {
      this.recordEvent("container-started", { jobId: job.job_id });
    }
  }

  /**
   * A JIT runner may receive a different compatible queued job. Require
   * GitHub's authoritative `in_progress` delivery before granting cache
   * access, and bind that access to the actual assigned job and its scope.
   */
  async cacheAssignment(
    runnerName: string,
    repository: string,
    runId?: string,
  ): Promise<
    | {
        jobId: string;
        cacheScope: SchedulerCacheScope;
      }
    | undefined
  > {
    const [owner, repo, extra] = repository.split("/");
    if (owner === undefined || repo === undefined || extra !== undefined) {
      return undefined;
    }
    const runner = this.rows<JitRunnerRow>(
      `SELECT * FROM scheduler_jit_runners
       WHERE runner_name = ?
         AND lower(github_owner) = lower(?)
         AND lower(github_repository) = lower(?)
         AND assignment_observed = 1
         AND assigned_job_id IS NOT NULL`,
      runnerName,
      owner,
      repo,
    )[0];
    if (runner !== undefined && runner.assigned_job_id !== null) {
      const assignedJob = this.job(runner.assigned_job_id);
      if (
        assignedJob !== undefined &&
        assignedJob.github_owner.toLowerCase() === owner.toLowerCase() &&
        assignedJob.github_repository.toLowerCase() === repo.toLowerCase() &&
        assignedJob.profile_key === runner.profile_key &&
        assignedJob.cache_scope !== ""
      ) {
        return {
          jobId: assignedJob.job_id,
          cacheScope: storedCacheScope(
            assignedJob.cache_scope,
            assignedJob.cache_fallback_scope,
            assignedJob.cache_write_allowed,
          ),
        };
      }
    }
    const job = this.rows<JobRow>(
      `SELECT * FROM scheduler_jobs
       WHERE runner_name = ?
         AND lower(github_owner) = lower(?)
         AND lower(github_repository) = lower(?)
         AND (
           status IN ('provisioning', 'running', 'releasing')
           OR (status = 'completed' AND updated_at >= ?)
         )`,
      runnerName,
      owner,
      repo,
      now() - RUNNER_CACHE_POST_JOB_GRACE_MS,
    )[0];
    if (job !== undefined && job.github_assignment_observed === 1 && job.cache_scope !== "") {
      return {
        jobId: job.job_id,
        cacheScope: storedCacheScope(job.cache_scope, job.cache_fallback_scope, job.cache_write_allowed),
      };
    }
    if (runId !== undefined && !/^[1-9][0-9]*$/u.test(runId)) {
      return undefined;
    }
    return this.reconcileRunnerAssignmentFromGitHub(runnerName, owner, repo, runId);
  }

  /**
   * `workflow_job: in_progress` is the authoritative runner-to-job assignment,
   * but GitHub does not re-deliver webhooks the Worker drops or fails to
   * acknowledge, so a lost delivery leaves a running job polling for its
   * assignment until the job-started hook times out. New hooks provide their
   * actual workflow run, whose jobs can be listed without scanning unrelated
   * queued jobs. Older hooks retain a deadline-bounded candidate scan. Both
   * paths require GitHub to confirm this runner and use the webhook's
   * ownership-transfer and resource-attribution paths.
   */
  private async reconcileRunnerAssignmentFromGitHub(
    runnerName: string,
    owner: string,
    repo: string,
    runId?: string,
  ): Promise<{ jobId: string; cacheScope: SchedulerCacheScope } | undefined> {
    const runner = this.rows<JitRunnerRow>(
      `SELECT * FROM scheduler_jit_runners
       WHERE runner_name = ?
         AND lower(github_owner) = lower(?)
         AND lower(github_repository) = lower(?)`,
      runnerName,
      owner,
      repo,
    )[0];
    if (runner === undefined) {
      return undefined;
    }
    const attempt: { timestamp: number; cursor: number; runId?: string; page: number } =
      this.runnerReconcileAttempts.get(runnerName) ?? {
        timestamp: 0,
        cursor: Number.MAX_SAFE_INTEGER,
        page: 1,
      };
    const timestamp = this.assignmentNow();
    if (timestamp - attempt.timestamp < RUNNER_ASSIGNMENT_GITHUB_RECONCILE_INTERVAL_MS) {
      return undefined;
    }
    // Entries live only for the duration of a Durable Object instance, but a
    // long-lived scheduler would otherwise accumulate one entry per claimed
    // runner forever; drop state for runners that have not polled recently.
    for (const [name, entry] of this.runnerReconcileAttempts) {
      if (timestamp - entry.timestamp > 60 * 60 * 1000) {
        this.runnerReconcileAttempts.delete(name);
      }
    }
    attempt.timestamp = timestamp;
    if (attempt.runId !== runId) {
      attempt.runId = runId;
      attempt.page = 1;
    }
    this.runnerReconcileAttempts.set(runnerName, attempt);
    const deadline = timestamp + RUNNER_ASSIGNMENT_GITHUB_RECONCILE_BUDGET_MS;

    const target: GitHubRepositoryTarget = { owner, repository: repo };
    const client = new GitHubJobAssignmentClient(this.env, target, this.assignmentDependencies);
    if (runId !== undefined) {
      const sourceJob = this.job(runner.source_job_id);
      if (sourceJob === undefined) {
        return undefined;
      }
      while (this.assignmentNow() < deadline) {
        const remaining = deadline - this.assignmentNow();
        if (remaining <= 0) {
          return undefined;
        }
        // eslint-disable-next-line no-await-in-loop -- page requests stop as soon as this runner is found or the sweep deadline expires.
        const page = await client.workflowJobs(
          runId,
          attempt.page,
          sourceJob.github_installation_id,
          AbortSignal.timeout(remaining),
        );
        if (page === undefined) {
          return undefined;
        }
        const detail = page.jobs.find((job) => job.status === "in_progress" && job.runner_name === runnerName);
        if (detail !== undefined) {
          return this.applyReconciledAssignment(runner, String(detail.id), detail, target);
        }
        if (page.jobs.length < 100 || attempt.page * 100 >= page.total_count) {
          attempt.page = 1;
          return undefined;
        }
        attempt.page += 1;
      }
      return undefined;
    }

    // SQL pages bound memory, not the number of candidates reachable per
    // sweep. Keep probing pages while the deadline permits, and resume after
    // the last actually probed row when a slow request exhausts the budget.
    while (this.assignmentNow() < deadline) {
      const candidates = this.rows<JobRow>(
        `SELECT * FROM scheduler_jobs
       WHERE lower(github_owner) = lower(?)
         AND lower(github_repository) = lower(?)
         AND profile_key = ?
         AND github_assignment_observed = 0
         AND status IN ('queued', 'admitted', 'provisioning', 'running')
         AND CAST(job_id AS INTEGER) < ?
       ORDER BY CAST(job_id AS INTEGER) DESC
       LIMIT 9`,
        owner,
        repo,
        runner.profile_key,
        attempt.cursor,
      );
      // One lookahead row tells us whether a full eight-row page is also
      // the final page, even if its last probe consumes the whole budget.
      for (const candidate of candidates.slice(0, 8)) {
        const remaining = deadline - this.assignmentNow();
        if (remaining <= 0) {
          return undefined;
        }
        const signal = AbortSignal.timeout(remaining);
        // eslint-disable-next-line no-await-in-loop -- sequential probes share a credential and stop at the first match or deadline.
        const detail = await (this.jobDetailOverride === undefined
          ? client.jobDetail(candidate.job_id, candidate.github_installation_id, signal)
          : this.jobDetailOverride(candidate.job_id, target, candidate.github_installation_id));
        attempt.cursor = Number(candidate.job_id);
        if (detail?.status === "in_progress" && detail.runner_name === runnerName) {
          // eslint-disable-next-line no-await-in-loop -- assignment validation follows the authoritative API response.
          const result = await this.applyReconciledAssignment(runner, candidate.job_id, detail, target);
          if (result !== undefined) {
            return result;
          }
        }
      }
      if (candidates.length <= 8) {
        // Reset only after fully consuming this page; an interrupted page
        // must retain its cursor so its unprobed tail is revisited.
        attempt.cursor = Number.MAX_SAFE_INTEGER;
        return undefined;
      }
    }
    return undefined;
  }

  private assignmentNow(): number {
    return this.assignmentDependencies?.now() ?? now();
  }

  private async applyReconciledAssignment(
    runner: JitRunnerRow,
    jobId: string,
    detail: GitHubJobDetail,
    target: GitHubRepositoryTarget,
  ): Promise<{ jobId: string; cacheScope: SchedulerCacheScope } | undefined> {
    const fresh = this.job(jobId);
    if (
      fresh === undefined ||
      !["queued", "admitted", "provisioning", "running"].includes(fresh.status) ||
      fresh.github_owner.toLowerCase() !== target.owner.toLowerCase() ||
      fresh.github_repository.toLowerCase() !== target.repository.toLowerCase() ||
      fresh.profile_key !== runner.profile_key ||
      detail.runner_id === 0
    ) {
      return undefined;
    }
    const result = await this.workflowJobStarted({
      jobId,
      runnerName: runner.runner_name,
      runnerId: detail.runner_id ?? runner.github_runner_id ?? undefined,
      target,
      profile: parseProfile(fresh.profile_json),
    });
    if (!result.accepted) {
      this.recordEvent("jit-runner-assignment-unreconciled", {
        jobId,
        detail: { runnerName: runner.runner_name, sourceJobId: runner.source_job_id },
      });
      return undefined;
    }
    this.runnerReconcileAttempts.delete(runner.runner_name);
    this.recordEvent("github-assignment-reconciled", {
      jobId,
      detail: {
        runnerName: runner.runner_name,
        runnerId: detail.runner_id ?? runner.github_runner_id,
        via: "github-api",
      },
    });
    this.ctx.waitUntil(startRunnerProvisioningWorkflows(this.env, result.admissions));
    await assignResourceTraceRunner(this.env, {
      runnerName: runner.runner_name,
      jobId,
      repository: `${target.owner}/${target.repository}`,
    });
    const assigned = this.job(jobId);
    if (assigned === undefined || assigned.github_assignment_observed !== 1 || assigned.cache_scope === "") {
      return undefined;
    }
    return {
      jobId,
      cacheScope: storedCacheScope(assigned.cache_scope, assigned.cache_fallback_scope, assigned.cache_write_allowed),
    };
  }

  /**
   * Authoritative state of a single workflow job. The `jobDetailOverride`
   * seam exists so tests can answer without real API credentials or network
   * access.
   */
  jobDetailOverride?: (
    jobId: string,
    target: GitHubRepositoryTarget,
    installationId: number | null,
  ) => Promise<GitHubJobDetail | undefined>;

  /** @deprecated Use cacheAssignment, which follows a JIT runner's actual job. */
  async cacheScope(runnerName: string, repository: string, jobId: string): Promise<SchedulerCacheScope | undefined> {
    const [owner, repo, extra] = repository.split("/");
    if (owner === undefined || repo === undefined || extra !== undefined) {
      return undefined;
    }
    const job = this.rows<JobRow>(
      `SELECT * FROM scheduler_jobs
       WHERE job_id = ?
         AND runner_name = ?
         AND lower(github_owner) = lower(?)
         AND lower(github_repository) = lower(?)
         AND status IN ('provisioning', 'running', 'releasing')`,
      jobId,
      runnerName,
      owner,
      repo,
    )[0];
    if (job === undefined || job.github_assignment_observed === 0 || job.cache_scope === "") {
      return undefined;
    }
    return storedCacheScope(job.cache_scope, job.cache_fallback_scope, job.cache_write_allowed);
  }

  /**
   * A JIT configuration is not pinned to the queued job that caused its
   * creation. GitHub may give it any older compatible job in the repository.
   * Its `in_progress` delivery is therefore the authoritative runner-to-job
   * assignment. Move the active Container reservation to that actual job and
   * put the displaced job back through normal admission with a fresh JIT name.
   */
  async workflowJobStarted(input: SchedulerRunnerClaimInput): Promise<SchedulerResult> {
    const assignmentRecorded = this.recordJitRunnerAssignment(input);
    const runnerOwner = this.rows<JobRow>(
      `SELECT * FROM scheduler_jobs
       WHERE runner_name = ? AND status IN ('provisioning', 'running', 'releasing')`,
      input.runnerName,
    )[0];
    if (runnerOwner === undefined) {
      // The runner is ours and GitHub says it executes a job we know, but no
      // scheduler job still owns the runner — typically a mutual cross-
      // assignment where both runners were displaced onto each other's jobs.
      // Attach the runner to the job actually running so the displaced job is
      // not requeued behind a runner that will never exist.
      const actualJob = this.job(input.jobId);
      // `provisioning` is excluded deliberately: an in-flight provisioning
      // workflow for that job would observe `canStart() === false` after the
      // rename and tear the adopted job down via provisioningFailed.
      if (
        assignmentRecorded &&
        actualJob !== undefined &&
        jobMatchesRunnerClaim(actualJob, input) &&
        (actualJob.status === "queued" || actualJob.status === "admitted" || actualJob.status === "running")
      ) {
        this.ctx.storage.sql.exec(
          `UPDATE scheduler_jobs
           SET status = 'running', runner_name = ?, runner_id = ?, failure_reason = NULL,
               container_stopped_at = NULL, container_exit_code = NULL, container_stop_reason = NULL,
               recovery_due_at = NULL, runner_cleanup_state = 'none', runner_cleanup_due_at = NULL,
               github_assignment_observed = 1, updated_at = ?
           WHERE job_id = ?`,
          input.runnerName,
          input.runnerId ?? null,
          now(),
          actualJob.job_id,
        );
        this.recordEvent("github-job-started-adopted-unowned-runner", {
          jobId: input.jobId,
          detail: { runnerName: input.runnerName, runnerId: input.runnerId },
        });
        return { accepted: true, admissions: [] };
      }
      this.recordEvent("github-job-started-without-owned-job", {
        jobId: input.jobId,
        detail: { runnerName: input.runnerName, runnerId: input.runnerId },
      });
      return { accepted: false, admissions: [] };
    }

    const actualJob = this.job(input.jobId);
    if (
      !jobMatchesRunnerClaim(runnerOwner, input) ||
      actualJob === undefined ||
      !jobMatchesRunnerClaim(actualJob, input)
    ) {
      this.recordEvent("github-job-started-with-unmatched-runner", {
        jobId: input.jobId,
        detail: {
          runnerName: input.runnerName,
          runnerOwnerJobId: runnerOwner.job_id,
          profileKey: input.profile.key,
        },
      });
      return { accepted: false, admissions: [] };
    }

    if (runnerOwner.job_id === input.jobId) {
      this.ctx.storage.sql.exec(
        "UPDATE scheduler_jobs SET github_assignment_observed = 1, updated_at = ? WHERE job_id = ?",
        now(),
        input.jobId,
      );
      this.recordEvent("github-job-started", {
        jobId: input.jobId,
        detail: { runnerName: input.runnerName, runnerId: input.runnerId ?? runnerOwner.runner_id },
      });
      return { accepted: true, admissions: [] };
    }

    if (actualJob.profile_key !== input.profile.key) {
      this.recordEvent("github-job-started-with-unmatched-runner", {
        jobId: input.jobId,
        detail: {
          runnerName: input.runnerName,
          runnerOwnerJobId: runnerOwner.job_id,
          profileKey: input.profile.key,
        },
      });
      return { accepted: false, admissions: [] };
    }

    const timestamp = now();
    const retryAttempt = runnerOwner.runner_attempt + 1;
    const retryRunnerName = `${runnerOwner.runner_name.replace(/-r\d+$/u, "")}-r${retryAttempt}`;

    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET status = 'queued', runner_name = ?, runner_attempt = ?, runner_id = NULL,
           failure_reason = ?, container_stopped_at = NULL, container_exit_code = NULL,
           container_stop_reason = NULL, recovery_due_at = NULL, runner_cleanup_state = 'none',
           runner_cleanup_due_at = NULL, github_assignment_observed = 0, updated_at = ?
       WHERE job_id = ?`,
      retryRunnerName,
      retryAttempt,
      `JIT runner ${input.runnerName} was assigned to GitHub job ${input.jobId}; retrying with a fresh runner`,
      timestamp,
      runnerOwner.job_id,
    );
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET status = 'running', runner_name = ?, runner_id = ?, failure_reason = NULL,
           container_stopped_at = NULL, container_exit_code = NULL, container_stop_reason = NULL,
           recovery_due_at = NULL, runner_cleanup_state = 'none', runner_cleanup_due_at = NULL,
           github_assignment_observed = 1, updated_at = ?
       WHERE job_id = ?`,
      input.runnerName,
      input.runnerId ?? runnerOwner.runner_id,
      timestamp,
      actualJob.job_id,
    );
    this.recordEvent("jit-runner-reassigned", {
      jobId: actualJob.job_id,
      detail: {
        runnerName: input.runnerName,
        runnerId: input.runnerId ?? runnerOwner.runner_id,
        fromJobId: runnerOwner.job_id,
      },
    });
    this.recordEvent("github-job-requeued-after-jit-mismatch", {
      jobId: runnerOwner.job_id,
      detail: { runnerName: retryRunnerName, assignedJobId: actualJob.job_id, retryAttempt },
    });

    const admissions = this.admitNext();
    await this.scheduleWorkAlarmIfNeeded();
    return { accepted: true, admissions };
  }

  private recordJitRunnerAssignment(input: SchedulerRunnerClaimInput): boolean {
    const runner = this.rows<JitRunnerRow>(
      "SELECT * FROM scheduler_jit_runners WHERE runner_name = ?",
      input.runnerName,
    )[0];
    const assignedJob = this.job(input.jobId);
    if (
      runner === undefined ||
      assignedJob === undefined ||
      runner.github_owner.toLowerCase() !== input.target.owner.toLowerCase() ||
      runner.github_repository.toLowerCase() !== input.target.repository.toLowerCase() ||
      runner.profile_key !== input.profile.key ||
      !jobMatchesRunnerClaim(assignedJob, input)
    ) {
      this.recordEvent("jit-runner-assignment-unmatched", {
        jobId: input.jobId,
        detail: {
          runnerName: input.runnerName,
          runnerRegistered: runner !== undefined,
          jobRegistered: assignedJob !== undefined,
        },
      });
      return false;
    }
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jit_runners
       SET assigned_job_id = ?, assignment_observed = 1, updated_at = ?
       WHERE runner_name = ?`,
      input.jobId,
      now(),
      input.runnerName,
    );
    return true;
  }

  private releaseJob(job: JobRow, status: "completed" | "cancelled" | "failed", reason?: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET status = ?, updated_at = ?, failure_reason = ?, recovery_due_at = NULL
       WHERE job_id = ?`,
      status,
      now(),
      reason ?? null,
      job.job_id,
    );
    this.recordEvent("scheduler-released", {
      jobId: job.job_id,
      detail: { status },
    });
  }

  async provisioningFailed(jobId: string, reason: string, runnerName?: string): Promise<SchedulerResult> {
    const job = this.job(jobId);
    // Only the workflow that owns the current provisioning attempt may fail
    // the job. A stale or retried workflow — identifiable by the runner name
    // from its claim, which embeds the `-rN` attempt suffix — must never tear
    // down a job that already moved on (adopted onto a different JIT runner
    // after a GitHub cross-assignment) or was re-queued and claimed again.
    // During deployment, old workflows still send two arguments. An
    // unscoped failure is accepted only for an attempt claimed through the
    // legacy protocol. New workflows persist scoped ownership when claiming,
    // so an old workflow cannot fail a replacement attempt.
    const ownsAttempt =
      job !== undefined &&
      (runnerName === undefined
        ? job.provisioning_owner_scoped === 0 && job.github_assignment_observed === 0
        : job.runner_name === runnerName);
    if (job === undefined || job.status !== "provisioning" || !ownsAttempt) {
      if (job !== undefined && activeJobStates.has(job.status)) {
        this.recordEvent("provisioning-failed-ignored", {
          jobId,
          detail: { status: job.status, runnerName, currentRunnerName: job.runner_name, reason },
        });
      }
      return { accepted: false, admissions: [] };
    }
    this.releaseJob(job, "failed", reason);
    const admissions = this.admitNext();
    await this.scheduleWorkAlarmIfNeeded();
    return { accepted: false, admissions };
  }

  async workflowJobCompleted(jobId: string): Promise<SchedulerResult> {
    const job = this.job(jobId);
    if (job === undefined) {
      return { accepted: false, admissions: [] };
    }
    if (job.status === "queued" || job.status === "admitted") {
      this.releaseJob(job, "cancelled", "GitHub completed before the runner started");
      this.recordEvent("github-job-completed-before-start", { jobId });
      const admissions = this.admitNext();
      await this.scheduleWorkAlarmIfNeeded();
      return { accepted: true, admissions };
    }
    if (job.status === "stopped-awaiting-completion") {
      this.releaseJob(job, "completed");
      this.recordEvent("github-job-completed-after-container-stop", { jobId });
      const admissions = this.admitNext();
      await this.scheduleWorkAlarmIfNeeded();
      return { accepted: true, admissions };
    }
    if (job.status === "provisioning" || job.status === "running") {
      const timestamp = now();
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET status = 'releasing', recovery_due_at = ?, updated_at = ?
         WHERE job_id = ?`,
        timestamp + RUNNER_COMPLETION_GRACE_MS,
        timestamp,
        jobId,
      );
      this.recordEvent("github-job-completed", { jobId });
      await this.scheduleWorkAlarmIfNeeded();
    }
    return { accepted: true, admissions: [] };
  }

  async runnerStopped(runnerName: string, stop: { exitCode: number; reason: string }): Promise<SchedulerResult> {
    const job = this.rows<JobRow>("SELECT * FROM scheduler_jobs WHERE runner_name = ?", runnerName)[0];
    if (job === undefined || !activeJobStates.has(job.status)) {
      return { accepted: false, admissions: [] };
    }
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET container_stopped_at = ?, container_exit_code = ?, container_stop_reason = ?, updated_at = ?
       WHERE job_id = ?`,
      timestamp,
      stop.exitCode,
      stop.reason,
      timestamp,
      job.job_id,
    );
    this.recordEvent("container-stopped", {
      jobId: job.job_id,
      detail: stop,
    });
    if (job.status === "releasing") {
      this.releaseJob(job, "completed");
      const admissions = this.admitNext();
      await this.scheduleWorkAlarmIfNeeded();
      return { accepted: true, admissions };
    }

    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET status = 'stopped-awaiting-completion', recovery_due_at = ?, updated_at = ?
       WHERE job_id = ?`,
      timestamp + RUNNER_COMPLETION_GRACE_MS,
      timestamp,
      job.job_id,
    );
    this.recordEvent("container-stop-awaiting-github-completion", {
      jobId: job.job_id,
      detail: { recoveryDueAt: timestamp + RUNNER_COMPLETION_GRACE_MS },
    });
    await this.scheduleWorkAlarmIfNeeded();
    return { accepted: true, admissions: [] };
  }

  private async retryRunnerCleanup(job: JobRow): Promise<void> {
    const timestamp = now();
    if (job.runner_id === null) {
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET runner_cleanup_state = 'done', runner_cleanup_due_at = NULL
         WHERE job_id = ?`,
        job.job_id,
      );
      this.recordEvent("jit-runner-cleanup-skipped", { jobId: job.job_id });
      return;
    }

    try {
      const target = { owner: job.github_owner, repository: job.github_repository };
      const token = await githubTokenForRunner(this.env, target, job.github_installation_id, (legacyTarget) =>
        githubRunnerTokenFor(this.env, legacyTarget),
      );
      if (token === undefined) {
        throw new Error(`No GitHub App installation token is available for ${target.owner}`);
      }
      const result = await deleteGitHubRunner({ ...target, token }, job.runner_id);
      if (result.kind === "deleted" || result.kind === "not-found") {
        this.ctx.storage.sql.exec(
          `UPDATE scheduler_jobs
           SET runner_cleanup_state = 'done', runner_cleanup_due_at = NULL,
               runner_cleanup_attempts = runner_cleanup_attempts + 1
           WHERE job_id = ?`,
          job.job_id,
        );
        this.recordEvent("jit-runner-cleanup-complete", {
          jobId: job.job_id,
          detail: { runnerId: job.runner_id, result: result.kind },
        });
        return;
      }

      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET runner_cleanup_state = 'retry', runner_cleanup_due_at = ?,
             runner_cleanup_attempts = runner_cleanup_attempts + 1
         WHERE job_id = ?`,
        timestamp + RUNNER_CLEANUP_RETRY_MS,
        job.job_id,
      );
      this.recordEvent("jit-runner-cleanup-retry", {
        jobId: job.job_id,
        detail: { runnerId: job.runner_id, result: result.kind, retryAt: timestamp + RUNNER_CLEANUP_RETRY_MS },
      });
    } catch (error) {
      this.ctx.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET runner_cleanup_state = 'retry', runner_cleanup_due_at = ?,
             runner_cleanup_attempts = runner_cleanup_attempts + 1
         WHERE job_id = ?`,
        timestamp + RUNNER_CLEANUP_RETRY_MS,
        job.job_id,
      );
      this.recordEvent("jit-runner-cleanup-retry", {
        jobId: job.job_id,
        detail: {
          runnerId: job.runner_id,
          error: error instanceof Error ? error.message : String(error),
          retryAt: timestamp + RUNNER_CLEANUP_RETRY_MS,
        },
      });
    }
  }

  private async recoverStoppedRunners(): Promise<SchedulerAdmission[]> {
    const timestamp = now();
    const stoppedJobs = this.rows<JobRow>(
      `SELECT * FROM scheduler_jobs
       WHERE status IN ('stopped-awaiting-completion', 'releasing')
         AND recovery_due_at IS NOT NULL
         AND recovery_due_at <= ?
       ORDER BY recovery_due_at ASC, job_id ASC`,
      timestamp,
    );
    const admissions: SchedulerAdmission[] = [];
    for (const job of stoppedJobs) {
      const awaitingContainerStop = job.status === "releasing";
      this.recordEvent(
        awaitingContainerStop ? "container-stop-missing-recovery-started" : "container-stop-recovery-started",
        {
          jobId: job.job_id,
          detail: { runnerId: job.runner_id, stoppedAt: job.container_stopped_at },
        },
      );
      // eslint-disable-next-line no-await-in-loop -- each deletion is an account-scoped recovery action.
      await this.retryRunnerCleanup(job);
      this.releaseJob(
        job,
        awaitingContainerStop ? "completed" : "failed",
        awaitingContainerStop ? undefined : "Container stopped before GitHub reported the job complete",
      );
      admissions.push(...this.admitNext());
    }

    const cleanupRetries = this.rows<JobRow>(
      `SELECT * FROM scheduler_jobs
       WHERE runner_cleanup_state = 'retry'
         AND runner_cleanup_due_at IS NOT NULL
         AND runner_cleanup_due_at <= ?
       ORDER BY runner_cleanup_due_at ASC, job_id ASC`,
      timestamp,
    );
    for (const job of cleanupRetries) {
      // eslint-disable-next-line no-await-in-loop -- each deletion is an account-scoped recovery action.
      await this.retryRunnerCleanup(job);
    }
    return admissions;
  }

  /**
   * A Worker deployment can interrupt a Container's onStop callback after
   * GitHub has completed the job. Persist a deadline so that the account-level
   * reservation cannot be stranded if that callback never reaches this DO.
   */
  private scheduleReleaseRecoveries(): void {
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_jobs
       SET recovery_due_at = ?
       WHERE status = 'releasing' AND recovery_due_at IS NULL`,
      now() + RUNNER_COMPLETION_GRACE_MS,
    );
  }

  /**
   * GitHub's completed event is authoritative: the JIT runner can no longer
   * receive work. If a Worker deployment interrupted its later onStop callback,
   * free the scheduler reservation before admitting the first post-deploy job.
   */
  private releaseCompletedJobsAwaitingContainerStop(): void {
    const releasingJobs = this.rows<JobRow>("SELECT * FROM scheduler_jobs WHERE status = 'releasing'");
    for (const job of releasingJobs) {
      this.releaseJob(job, "completed");
      this.recordEvent("container-stop-missing-recovered", {
        jobId: job.job_id,
        detail: { runnerId: job.runner_id, stoppedAt: job.container_stopped_at },
      });
    }
  }

  async alarm(): Promise<void> {
    const recoveredAdmissions = await this.recoverStoppedRunners();
    const admissions = [...recoveredAdmissions, ...this.readyAdmissions(), ...this.admitNext()];
    await this.scheduleWorkAlarmIfNeeded();
    const uniqueAdmissions = new Map(admissions.map((admission) => [admission.jobId, admission]));
    for (const admission of uniqueAdmissions.values()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- deterministic workflow IDs make each admission idempotent.
        await this.env.RUNNER_PROVISIONING_WORKFLOW.create({
          id: admission.workflowId,
          params: { jobId: admission.jobId, runnerName: admission.runnerName },
          retention: { successRetention: "1 day", errorRetention: "7 days" },
        });
      } catch {
        // A duplicate workflow ID means the original durable workflow is already responsible for the admission.
      }
    }
  }

  async status(): Promise<SchedulerStatus> {
    const reserved = this.reservedResources();
    const jobs = this.rows<JobRow>("SELECT * FROM scheduler_jobs ORDER BY created_at DESC LIMIT 100").map((job) => ({
      jobId: job.job_id,
      runnerName: job.runner_name,
      repository: `${job.github_owner}/${job.github_repository}`,
      profileKey: job.profile_key,
      status: job.status,
      queueWaitMs: job.status === "queued" ? Math.max(0, now() - job.created_at) : null,
      runnerId: job.runner_id,
      containerStoppedAt: job.container_stopped_at,
      containerExitCode: job.container_exit_code,
      containerStopReason: job.container_stop_reason,
      recoveryDueAt: job.recovery_due_at,
      runnerCleanupState: job.runner_cleanup_state,
    }));
    const events = this.rows<SchedulerEventRow>(
      "SELECT * FROM scheduler_events ORDER BY created_at DESC, event_id DESC LIMIT 100",
    ).map((event) => ({
      eventId: event.event_id,
      jobId: event.job_id,
      kind: event.kind,
      detail: parseEventDetail(event.detail_json),
      createdAt: event.created_at,
    }));
    return { capacity: { limit: DEFAULT_ACCOUNT_CAPACITY, reserved }, jobs, events };
  }
}
