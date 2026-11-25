import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isVerifiedProcessAlive } from "../runtime/process-identity.js";
import { normalizeFsPath } from "../runtime/zcode-discovery.js";
import type { AgentReport, InteractionRecord, TaskPackageInput, TaskRecord, TaskStatus } from "../types.js";

const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["queued", "running", "waiting_input"]);

export class StateDb {
  readonly dbPath: string;
  readonly #db: DatabaseSync;

  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true });
    this.dbPath = path.join(dataRoot, "state.sqlite");
    this.#db = new DatabaseSync(this.dbPath, { timeout: 3000 });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        workspace TEXT NOT NULL,
        execution_dir TEXT NOT NULL,
        normalized_exec_dir TEXT NOT NULL,
        mode TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        reasoning_level TEXT,
        session_id TEXT,
        worker_pid INTEGER,
        worker_start_ticks TEXT,
        app_server_pid INTEGER,
        app_server_start_ticks TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        last_operation_id TEXT,
        task_json TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        result_text TEXT,
        report_json TEXT,
        usage_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_exec_status ON tasks(normalized_exec_dir, status);
      CREATE TABLE IF NOT EXISTS interactions (
        request_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        method TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        reply_json TEXT,
        created_at TEXT NOT NULL,
        replied_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_interactions_task_status ON interactions(task_id, status);
    `);
  }

  close(): void {
    this.#db.close();
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    return (row as TaskRecord | undefined) ?? null;
  }

  getTaskBySessionId(sessionId: string): TaskRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(sessionId);
    return (row as TaskRecord | undefined) ?? null;
  }

  listTasks(limit = 50): TaskRecord[] {
    return this.#db
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as TaskRecord[];
  }

  findActiveByExecDir(executionDir: string): TaskRecord | null {
    const norm = normalizeFsPath(executionDir);
    const row = this.#db
      .prepare("SELECT * FROM tasks WHERE normalized_exec_dir = ? AND status IN ('queued', 'running', 'waiting_input') LIMIT 1")
      .get(norm);
    return (row as TaskRecord | undefined) ?? null;
  }

  async reconcileActiveIfDead(task: TaskRecord): Promise<TaskRecord> {
    if (!ACTIVE_STATUSES.has(task.status)) return task;
    if (task.status === "queued" && task.worker_pid === null) {
      const ageMs = Date.now() - Date.parse(task.updated_at);
      if (ageMs < 15_000) return task;
    }
    const check = await isVerifiedProcessAlive(task.worker_pid, task.worker_start_ticks);
    if (check.alive) return task;

    const now = new Date().toISOString();
    this.#db
      .prepare(`
        UPDATE tasks
        SET status = 'failed',
            error_code = 'worker_exited_unexpectedly',
            error_message = 'Detached worker process is no longer alive (reconciled automatically).',
            finished_at = COALESCE(finished_at, ?),
            updated_at = ?
        WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_input')
      `)
      .run(now, now, task.task_id);
    this.expirePendingInteractions(task.task_id);
    return this.getTask(task.task_id)!;
  }

  async createTask(input: TaskPackageInput, promptText: string): Promise<TaskRecord> {
    if (this.getTask(input.task_id)) {
      throw new Error(`TASK_ALREADY_EXISTS: task_id "${input.task_id}" already exists. Use zcode_continue to resume or pick a new task_id.`);
    }
    const execDir = path.resolve(input.worktree_path || input.workspace);
    const existing = this.findActiveByExecDir(execDir);
    if (existing) {
      const reconciled = await this.reconcileActiveIfDead(existing);
      if (ACTIVE_STATUSES.has(reconciled.status)) {
        throw new Error(
          `WORKSPACE_BUSY: execution directory "${execDir}" is currently occupied by active task "${reconciled.task_id}" (${reconciled.status}). Wait for completion or cancel it first.`,
        );
      }
    }

    const now = new Date().toISOString();
    this.#db
      .prepare(`
        INSERT INTO tasks (
          task_id, status, workspace, execution_dir, normalized_exec_dir,
          mode, provider_id, model_id, reasoning_level, session_id,
          attempt, task_json, prompt_text, created_at, updated_at
        ) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `)
      .run(
        input.task_id,
        path.resolve(input.workspace),
        execDir,
        normalizeFsPath(execDir),
        input.mode,
        input.model?.provider_id ?? null,
        input.model?.model_id ?? null,
        input.model?.reasoning_level ?? null,
        input.resume_session_id ?? null,
        JSON.stringify(input),
        promptText,
        now,
        now,
      );
    return this.getTask(input.task_id)!;
  }

  async prepareContinue(params: {
    taskId: string;
    promptText: string;
    operationId?: string;
    mode?: string;
    providerId?: string | null;
    modelId?: string | null;
    reasoningLevel?: string | null;
  }): Promise<{ task: TaskRecord; deduplicated: boolean }> {
    const existing = this.getTask(params.taskId);
    if (!existing) throw new Error(`TASK_NOT_FOUND: unknown task "${params.taskId}".`);

    if (params.operationId && existing.last_operation_id === params.operationId) {
      return { task: existing, deduplicated: true };
    }

    const current = await this.reconcileActiveIfDead(existing);
    if (ACTIVE_STATUSES.has(current.status)) {
      throw new Error(`TASK_STILL_ACTIVE: task "${params.taskId}" is currently ${current.status}.`);
    }
    if (!current.session_id) {
      throw new Error(`SESSION_MISSING: task "${params.taskId}" has no ZCode session_id to resume.`);
    }

    const busy = this.findActiveByExecDir(current.execution_dir);
    if (busy && busy.task_id !== current.task_id) {
      const reconciledBusy = await this.reconcileActiveIfDead(busy);
      if (ACTIVE_STATUSES.has(reconciledBusy.status)) {
        throw new Error(
          `WORKSPACE_BUSY: execution directory "${current.execution_dir}" is occupied by active task "${reconciledBusy.task_id}".`,
        );
      }
    }

    const now = new Date().toISOString();
    this.#db
      .prepare(`
        UPDATE tasks
        SET status = 'queued',
            attempt = attempt + 1,
            last_operation_id = COALESCE(?, last_operation_id),
            mode = COALESCE(?, mode),
            provider_id = COALESCE(?, provider_id),
            model_id = COALESCE(?, model_id),
            reasoning_level = COALESCE(?, reasoning_level),
            prompt_text = ?,
            worker_pid = NULL,
            worker_start_ticks = NULL,
            app_server_pid = NULL,
            app_server_start_ticks = NULL,
            error_code = NULL,
            error_message = NULL,
            finished_at = NULL,
            updated_at = ?
        WHERE task_id = ?
      `)
      .run(
        params.operationId ?? null,
        params.mode ?? null,
        params.providerId === undefined ? null : params.providerId,
        params.modelId === undefined ? null : params.modelId,
        params.reasoningLevel === undefined ? null : params.reasoningLevel,
        params.promptText,
        now,
        params.taskId,
      );
    this.expirePendingInteractions(params.taskId);
    return { task: this.getTask(params.taskId)!, deduplicated: false };
  }

  markWorkerStarted(taskId: string, workerPid: number, workerStartTicks: string | null): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(`
        UPDATE tasks
        SET status = 'running',
            worker_pid = ?,
            worker_start_ticks = ?,
            started_at = COALESCE(started_at, ?),
            updated_at = ?
        WHERE task_id = ?
      `)
      .run(workerPid, workerStartTicks, now, now, taskId);
  }

  updateRuntimeIdentity(
    taskId: string,
    patch: {
      appServerPid?: number;
      appServerStartTicks?: string | null;
      sessionId?: string;
      providerId?: string | null;
      modelId?: string | null;
      reasoningLevel?: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(`
        UPDATE tasks
        SET app_server_pid = COALESCE(?, app_server_pid),
            app_server_start_ticks = COALESCE(?, app_server_start_ticks),
            session_id = COALESCE(?, session_id),
            provider_id = COALESCE(?, provider_id),
            model_id = COALESCE(?, model_id),
            reasoning_level = COALESCE(?, reasoning_level),
            updated_at = ?
        WHERE task_id = ?
      `)
      .run(
        patch.appServerPid ?? null,
        patch.appServerStartTicks ?? null,
        patch.sessionId ?? null,
        patch.providerId ?? null,
        patch.modelId ?? null,
        patch.reasoningLevel ?? null,
        now,
        taskId,
      );
  }

  setStatus(taskId: string, status: TaskStatus): void {
    const now = new Date().toISOString();
    this.#db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?").run(status, now, taskId);
  }

  finishCompleted(
    taskId: string,
    payload: { resultText: string; report: AgentReport | null; usage: Record<string, unknown> | null },
  ): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(`
        UPDATE tasks
        SET status = 'completed',
            result_text = ?,
            report_json = ?,
            usage_json = ?,
            error_code = NULL,
            error_message = NULL,
            finished_at = ?,
            updated_at = ?
        WHERE task_id = ?
      `)
      .run(
        payload.resultText,
        payload.report ? JSON.stringify(payload.report) : null,
        payload.usage ? JSON.stringify(payload.usage) : null,
        now,
        now,
        taskId,
      );
  }

  finishFailed(taskId: string, errorCode: string, errorMessage: string, status: "failed" | "cancelled" = "failed"): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(`
        UPDATE tasks
        SET status = ?,
            error_code = ?,
            error_message = ?,
            finished_at = ?,
            updated_at = ?
        WHERE task_id = ? AND status NOT IN ('completed', 'cancelled')
      `)
      .run(status, errorCode, errorMessage, now, now, taskId);
    this.expirePendingInteractions(taskId);
  }

  createInteraction(requestId: string, taskId: string, method: string, params: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(`
        INSERT OR REPLACE INTO interactions (request_id, task_id, method, params_json, status, reply_json, created_at, replied_at)
        VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL)
      `)
      .run(requestId, taskId, method, JSON.stringify(params), now);
    this.setStatus(taskId, "waiting_input");
  }

  getInteraction(requestId: string): InteractionRecord | null {
    const row = this.#db.prepare("SELECT * FROM interactions WHERE request_id = ?").get(requestId);
    return (row as InteractionRecord | undefined) ?? null;
  }

  listPendingInteractions(taskId: string): InteractionRecord[] {
    return this.#db
      .prepare("SELECT * FROM interactions WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(taskId) as unknown as InteractionRecord[];
  }

  replyInteraction(requestId: string, reply: Record<string, unknown>): InteractionRecord {
    const existing = this.getInteraction(requestId);
    if (!existing) throw new Error(`INTERACTION_NOT_FOUND: unknown request_id "${requestId}".`);
    if (existing.status !== "pending") {
      throw new Error(`INTERACTION_NOT_PENDING: request "${requestId}" is already ${existing.status}.`);
    }
    const now = new Date().toISOString();
    this.#db
      .prepare("UPDATE interactions SET status = 'replied', reply_json = ?, replied_at = ? WHERE request_id = ?")
      .run(JSON.stringify(reply), now, requestId);
    return this.getInteraction(requestId)!;
  }

  expirePendingInteractions(taskId: string): void {
    const now = new Date().toISOString();
    this.#db
      .prepare("UPDATE interactions SET status = 'expired', replied_at = ? WHERE task_id = ? AND status = 'pending'")
      .run(now, taskId);
  }
}
