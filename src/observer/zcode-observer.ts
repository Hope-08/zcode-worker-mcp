import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isPidAlive } from "../runtime/process-identity.js";
import { normalizeFsPath, resolveZCodeDataPaths } from "../runtime/zcode-discovery.js";
import type { StateDb } from "../store/state-db.js";
import type { AgentReport, InteractionRecord, TaskRecord } from "../types.js";

const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "stalled_or_exited",
  "interrupted_without_result",
]);

interface DesktopTaskMeta {
  task_id: string;
  session_id: string | null;
  title: string | null;
  task_status: string | null;
  workspace_path: string | null;
  mode: string | null;
  model: string | null;
  provider: string | null;
  created_at: number | null;
  updated_at: number | null;
  cli_last_outcome: string | null;
  deleted: number;
}

interface ParsedModelInfo {
  provider_id: string | null;
  model_id: string | null;
  mode: string | null;
  reasoning_level: string | null;
  last_error: string | null;
}

export interface SessionSummary {
  session_id: string | null;
  task_id: string | null;
  title: string | null;
  directory: string | null;
  source: "worker_mcp" | "zcode_desktop" | "zcode_cli";
  effective_state: string;
  worker_status: string | null;
  worker_alive: boolean;
  runtime_alive: boolean;
  runtime_pid: number | null;
  provider_id: string | null;
  model_id: string | null;
  reasoning_level: string | null;
  mode: string | null;
  todo_summary: { total: number; completed: number; in_progress: number; pending: number };
  pending_interactions_count: number;
  last_outcome: string | null;
  created_at: string;
  updated_at: string;
  last_assistant_preview: string | null;
}

export interface InspectSessionResult {
  found: boolean;
  session_id: string | null;
  task_id: string | null;
  effective_state: string;
  diagnosis: string;
  task: {
    status: string;
    attempt: number;
    workspace: string;
    execution_dir: string;
    mode: string;
    provider_id: string | null;
    model_id: string | null;
    reasoning_level: string | null;
    worker_pid: number | null;
    worker_alive: boolean;
    app_server_pid: number | null;
    app_server_alive: boolean;
    error_code: string | null;
    error_message: string | null;
    started_at: string | null;
    finished_at: string | null;
    updated_at: string;
  } | null;
  session: {
    id: string;
    parent_id: string | null;
    directory: string;
    title: string | null;
    last_outcome: string | null;
    trace_id: string | null;
    created_at: string;
    updated_at: string;
    idle_seconds: number;
    deleted: boolean;
  } | null;
  desktop_task: {
    task_id: string;
    title: string | null;
    task_status: string | null;
    mode: string | null;
    model: string | null;
    provider: string | null;
  } | null;
  runtime_presence: {
    active: boolean;
    owner_id: string | null;
    process_id: number | null;
    pid_alive: boolean;
  };
  model_info: ParsedModelInfo;
  todos: Array<{ content: string; status: string; priority: string; position: number }>;
  todo_summary: { total: number; completed: number; in_progress: number; pending: number };
  pending_interactions: Array<{
    request_id: string;
    method: string;
    params: Record<string, unknown>;
    created_at: string;
  }>;
  recent_tools: Array<{
    tool: string;
    status: string | null;
    input_preview: string | null;
    error: string | null;
    updated_at: string;
  }>;
  recent_messages: Array<{
    message_id: string;
    text: string;
    updated_at: string;
  }>;
  result_text: string | null;
  result_truncated?: boolean;
  report: AgentReport | null;
  usage: Record<string, unknown> | null;
}

export const CHARACTER_LIMIT = 25_000;

export interface ListSessionsOptions {
  limit?: number;
  offset?: number;
  workspace?: string;
  active_only?: boolean;
  include_deleted?: boolean;
}

export interface ListSessionsPage {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  truncated?: boolean;
  sessions: SessionSummary[];
}

export interface InspectSessionOptions {
  task_id?: string;
  session_id?: string;
  message_limit?: number;
  tool_limit?: number;
}

export interface WatchSessionOptions extends InspectSessionOptions {
  wait_seconds?: number;
  interval_ms?: number;
  signal?: AbortSignal;
}

function safeJsonParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toIsoFromEpochMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return new Date(0).toISOString();
  }
  return new Date(value).toISOString();
}

function truncateText(text: string | null | undefined, maxLen = 280): string | null {
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length <= maxLen ? collapsed : `${collapsed.slice(0, maxLen - 3)}...`;
}

function isUserFacingAssistantText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("<system-reminder>") || trimmed.includes("\n<system-reminder>")) {
    return false;
  }
  return true;
}

function openReadOnlySqlite(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
  } catch {
    return null;
  }
}

function loadDesktopTasksBySession(tasksIndexPath: string): Map<string, DesktopTaskMeta> {
  const map = new Map<string, DesktopTaskMeta>();
  const db = openReadOnlySqlite(tasksIndexPath);
  if (!db) return map;
  try {
    const rows = db
      .prepare(`
        SELECT task_id, title, task_status, workspace_path, mode, model, provider,
               created_at, updated_at, meta_json, cli_last_outcome, deleted
        FROM tasks
      `)
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const meta = safeJsonParse<Record<string, unknown>>(
        typeof row["meta_json"] === "string" ? row["meta_json"] : null,
      );
      const sessionId = typeof meta?.["sessionId"] === "string" ? meta["sessionId"] : null;
      const entry: DesktopTaskMeta = {
        task_id: String(row["task_id"] ?? ""),
        session_id: sessionId,
        title: typeof row["title"] === "string" ? row["title"] : null,
        task_status: typeof row["task_status"] === "string" ? row["task_status"] : null,
        workspace_path: typeof row["workspace_path"] === "string" ? row["workspace_path"] : null,
        mode: typeof row["mode"] === "string" ? row["mode"] : null,
        model: typeof row["model"] === "string" ? row["model"] : null,
        provider: typeof row["provider"] === "string" ? row["provider"] : null,
        created_at: typeof row["created_at"] === "number" ? row["created_at"] : null,
        updated_at: typeof row["updated_at"] === "number" ? row["updated_at"] : null,
        cli_last_outcome: typeof row["cli_last_outcome"] === "string" ? row["cli_last_outcome"] : null,
        deleted: Number(row["deleted"] ?? 0),
      };
      if (sessionId) map.set(sessionId, entry);
    }
  } catch {
    // Desktop index schema or lock failures degrade gracefully without hiding CLI sessions.
  } finally {
    db.close();
  }
  return map;
}

function parseSessionMessagesModel(cliDb: DatabaseSync, sessionId: string): ParsedModelInfo {
  const rows = cliDb
    .prepare("SELECT data FROM message WHERE session_id = ? ORDER BY sequence DESC, time_updated DESC LIMIT 12")
    .all(sessionId) as Array<{ data?: unknown }>;

  let providerId: string | null = null;
  let modelId: string | null = null;
  let mode: string | null = null;
  let reasoningLevel: string | null = null;
  let lastError: string | null = null;

  for (const row of rows) {
    const data = safeJsonParse<Record<string, unknown>>(typeof row.data === "string" ? row.data : null);
    if (!data) continue;
    const role = typeof data["role"] === "string" ? data["role"] : "";

    if (role === "assistant") {
      if (!providerId && typeof data["providerId"] === "string") providerId = data["providerId"];
      if (!modelId && typeof data["modelId"] === "string") modelId = data["modelId"];
      if (!mode && typeof data["mode"] === "string") mode = data["mode"];
      if (!lastError && data["error"]) {
        if (typeof data["error"] === "string") lastError = data["error"];
        else if (typeof data["error"] === "object") {
          const errObj = data["error"] as Record<string, unknown>;
          const msg = errObj["message"] ?? errObj["name"];
          if (typeof msg === "string") lastError = msg;
        }
      }
    } else if (role === "user") {
      const sel = data["modelSelection"];
      if (sel && typeof sel === "object") {
        const selObj = sel as Record<string, unknown>;
        if (!providerId && typeof selObj["providerId"] === "string") providerId = selObj["providerId"];
        if (!modelId && typeof selObj["modelId"] === "string") modelId = selObj["modelId"];
        const opts = selObj["options"];
        if (!reasoningLevel && opts && typeof opts === "object") {
          const lvl = (opts as Record<string, unknown>)["reasoningLevel"];
          if (typeof lvl === "string") reasoningLevel = lvl;
        }
      }
      if (!mode && typeof data["mode"] === "string") mode = data["mode"];
    }
  }

  return {
    provider_id: providerId,
    model_id: modelId,
    mode,
    reasoning_level: reasoningLevel,
    last_error: lastError,
  };
}

function summarizeTodos(
  rows: Array<{ content: string; status: string; priority: string; position: number }>,
): { total: number; completed: number; in_progress: number; pending: number } {
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  for (const item of rows) {
    if (item.status === "completed") completed += 1;
    else if (item.status === "in_progress") inProgress += 1;
    else pending += 1;
  }
  return { total: rows.length, completed, in_progress: inProgress, pending };
}

function deriveStateAndDiagnosis(params: {
  task: TaskRecord | null;
  workerAlive: boolean;
  appServerAlive: boolean;
  presencePidAlive: boolean;
  presencePid: number | null;
  lastOutcome: string | null;
  desktopStatus: string | null;
  pendingInteractionsCount: number;
  lastError: string | null;
  idleSeconds: number;
}): { effective_state: string; diagnosis: string } {
  const {
    task,
    workerAlive,
    appServerAlive,
    presencePidAlive,
    presencePid,
    lastOutcome,
    desktopStatus,
    pendingInteractionsCount,
    lastError,
    idleSeconds,
  } = params;

  if (task) {
    if (task.status === "completed") {
      return { effective_state: "completed", diagnosis: "Task finished and persisted result in state DB." };
    }
    if (task.status === "cancelled") {
      return { effective_state: "cancelled", diagnosis: task.error_message || "Task was cancelled." };
    }
    if (task.status === "failed") {
      return {
        effective_state: "failed",
        diagnosis: task.error_message || lastError || "Task failed.",
      };
    }
    if (task.status === "waiting_input" || pendingInteractionsCount > 0) {
      return {
        effective_state: "waiting_input",
        diagnosis: `Worker is paused awaiting ${pendingInteractionsCount} interaction reply via zcode_reply.`,
      };
    }
    if (task.status === "queued") {
      return { effective_state: "queued", diagnosis: "Worker process is starting up." };
    }
    if (workerAlive && (appServerAlive || presencePidAlive || task.app_server_pid === null)) {
      return {
        effective_state: "running_active",
        diagnosis: `Detached worker PID ${task.worker_pid} is alive (session idle ${idleSeconds}s).`,
      };
    }
    return {
      effective_state: "stalled_or_exited",
      diagnosis: "Managed worker or ZCode child process exited unexpectedly without a final result.",
    };
  }

  if (presencePidAlive) {
    return {
      effective_state: "running_active",
      diagnosis: `ZCode session runtime PID ${presencePid} is alive (idle ${idleSeconds}s).`,
    };
  }
  if (lastError) {
    return { effective_state: "failed", diagnosis: lastError };
  }
  if (desktopStatus === "cancelled" || lastOutcome === "cancelled") {
    return { effective_state: "cancelled", diagnosis: "Session cancelled." };
  }
  if (lastOutcome === "completed" || desktopStatus === "completed") {
    return { effective_state: "completed", diagnosis: "Session completed." };
  }
  if (desktopStatus === "running" || desktopStatus === "in_progress") {
    return {
      effective_state: "stalled_or_exited",
      diagnosis: "Desktop index still marks session active, but runtime presence PID is no longer alive.",
    };
  }
  return { effective_state: "idle", diagnosis: "Session has no live runtime process attached." };
}

function serializeInteraction(item: InteractionRecord): {
  request_id: string;
  method: string;
  params: Record<string, unknown>;
  created_at: string;
} {
  return {
    request_id: item.request_id,
    method: item.method,
    params: safeJsonParse<Record<string, unknown>>(item.params_json) ?? {},
    created_at: item.created_at,
  };
}

export class ZCodeObserver {
  readonly #stateDb: StateDb;

  constructor(stateDb: StateDb) {
    this.#stateDb = stateDb;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const page = await this.listSessionsPage(options);
    return page.sessions;
  }

  async listSessionsPage(options: ListSessionsOptions = {}): Promise<ListSessionsPage> {
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const offset = Math.max(0, options.offset ?? 0);
    const workspaceFilter = options.workspace ? normalizeFsPath(options.workspace) : null;
    const includeDeleted = options.include_deleted ?? false;
    const activeOnly = options.active_only ?? false;

    const managedTasks = this.#stateDb.listTasks(200);
    const reconciledTasks: TaskRecord[] = [];
    for (const t of managedTasks) {
      reconciledTasks.push(await this.#stateDb.reconcileActiveIfDead(t));
    }

    const taskBySession = new Map<string, TaskRecord>();
    const unattachedTasks: TaskRecord[] = [];
    for (const t of reconciledTasks) {
      if (t.session_id) {
        if (!taskBySession.has(t.session_id)) taskBySession.set(t.session_id, t);
      } else {
        unattachedTasks.push(t);
      }
    }

    const paths = resolveZCodeDataPaths();
    const desktopMap = loadDesktopTasksBySession(paths.tasksIndexPath);
    const cliDb = openReadOnlySqlite(paths.cliDbPath);

    const summaries: SessionSummary[] = [];

    for (const t of unattachedTasks) {
      if (workspaceFilter && normalizeFsPath(t.execution_dir) !== workspaceFilter && normalizeFsPath(t.workspace) !== workspaceFilter) {
        continue;
      }
      const pending = this.#stateDb.listPendingInteractions(t.task_id);
      const workerAlive = Boolean(t.worker_pid && isPidAlive(t.worker_pid));
      const { effective_state } = deriveStateAndDiagnosis({
        task: t,
        workerAlive,
        appServerAlive: Boolean(t.app_server_pid && isPidAlive(t.app_server_pid)),
        presencePidAlive: false,
        presencePid: null,
        lastOutcome: null,
        desktopStatus: null,
        pendingInteractionsCount: pending.length,
        lastError: t.error_message,
        idleSeconds: Math.max(0, Math.round((Date.now() - Date.parse(t.updated_at)) / 1000)),
      });
      if (activeOnly && TERMINAL_STATES.has(effective_state)) continue;
      summaries.push({
        session_id: null,
        task_id: t.task_id,
        title: t.task_id,
        directory: t.execution_dir,
        source: "worker_mcp",
        effective_state,
        worker_status: t.status,
        worker_alive: workerAlive,
        runtime_alive: false,
        runtime_pid: t.app_server_pid,
        provider_id: t.provider_id,
        model_id: t.model_id,
        reasoning_level: t.reasoning_level,
        mode: t.mode,
        todo_summary: { total: 0, completed: 0, in_progress: 0, pending: 0 },
        pending_interactions_count: pending.length,
        last_outcome: null,
        created_at: t.created_at,
        updated_at: t.updated_at,
        last_assistant_preview: null,
      });
    }

    if (cliDb) {
      try {
        const whereDeleted = includeDeleted ? "" : "WHERE s.time_deleted IS NULL";
        const rows = cliDb
          .prepare(`
            SELECT s.id, s.directory, s.title, s.time_created, s.time_updated, s.last_outcome, s.time_deleted,
                   p.process_id AS presence_pid
            FROM session s
            LEFT JOIN session_runtime_presence p ON p.session_id = s.id
            ${whereDeleted}
            ORDER BY s.time_updated DESC
            LIMIT 200
          `)
          .all() as Array<Record<string, unknown>>;

        for (const row of rows) {
          const sessionId = String(row["id"] ?? "");
          const directory = typeof row["directory"] === "string" ? row["directory"] : "";
          const task = taskBySession.get(sessionId) ?? null;
          if (workspaceFilter) {
            const matchSessionDir = directory && normalizeFsPath(directory) === workspaceFilter;
            const matchTaskDir =
              task &&
              (normalizeFsPath(task.execution_dir) === workspaceFilter ||
                normalizeFsPath(task.workspace) === workspaceFilter);
            if (!matchSessionDir && !matchTaskDir) continue;
          }

          const desktop = desktopMap.get(sessionId) ?? null;
          if (!includeDeleted && desktop && desktop.deleted === 1) continue;

          const presencePid = typeof row["presence_pid"] === "number" ? row["presence_pid"] : null;
          const presencePidAlive = Boolean(presencePid && isPidAlive(presencePid));
          const workerAlive = Boolean(task?.worker_pid && isPidAlive(task.worker_pid));
          const appServerAlive = Boolean(task?.app_server_pid && isPidAlive(task.app_server_pid));
          const pending = task ? this.#stateDb.listPendingInteractions(task.task_id) : [];
          const modelInfo = parseSessionMessagesModel(cliDb, sessionId);

          const updatedMs = Number(row["time_updated"] ?? 0);
          const idleSeconds = updatedMs > 0 ? Math.max(0, Math.round((Date.now() - updatedMs) / 1000)) : 0;

          const { effective_state } = deriveStateAndDiagnosis({
            task,
            workerAlive,
            appServerAlive,
            presencePidAlive,
            presencePid,
            lastOutcome: typeof row["last_outcome"] === "string" ? row["last_outcome"] : null,
            desktopStatus: desktop?.task_status ?? null,
            pendingInteractionsCount: pending.length,
            lastError: task?.error_message ?? modelInfo.last_error,
            idleSeconds,
          });
          if (activeOnly && (TERMINAL_STATES.has(effective_state) || effective_state === "idle")) continue;

          const todoRows = cliDb
            .prepare("SELECT content, status, priority, position FROM todo WHERE session_id = ?")
            .all(sessionId) as Array<{ content: string; status: string; priority: string; position: number }>;

          const partRows = cliDb
            .prepare(`
              SELECT p.data
              FROM part p
              JOIN message m ON m.id = p.message_id
              WHERE p.session_id = ?
                AND json_extract(m.data, '$.role') = 'assistant'
                AND json_extract(p.data, '$.type') = 'text'
              ORDER BY p.time_updated DESC
              LIMIT 5
            `)
            .all(sessionId) as Array<{ data?: unknown }>;

          let preview: string | null = null;
          for (const pr of partRows) {
            const pData = safeJsonParse<Record<string, unknown>>(typeof pr.data === "string" ? pr.data : null);
            const text = typeof pData?.["text"] === "string" ? pData["text"] : "";
            if (isUserFacingAssistantText(text)) {
              preview = truncateText(text, 220);
              break;
            }
          }

          summaries.push({
            session_id: sessionId,
            task_id: task?.task_id ?? desktop?.task_id ?? null,
            title: desktop?.title ?? (typeof row["title"] === "string" ? row["title"] : null),
            directory: directory || task?.execution_dir || null,
            source: task ? "worker_mcp" : desktop ? "zcode_desktop" : "zcode_cli",
            effective_state,
            worker_status: task?.status ?? null,
            worker_alive: workerAlive,
            runtime_alive: presencePidAlive,
            runtime_pid: presencePid ?? task?.app_server_pid ?? null,
            provider_id: modelInfo.provider_id ?? task?.provider_id ?? null,
            model_id: modelInfo.model_id ?? task?.model_id ?? desktop?.model ?? null,
            reasoning_level: modelInfo.reasoning_level ?? task?.reasoning_level ?? null,
            mode: modelInfo.mode ?? task?.mode ?? desktop?.mode ?? null,
            todo_summary: summarizeTodos(todoRows),
            pending_interactions_count: pending.length,
            last_outcome: typeof row["last_outcome"] === "string" ? row["last_outcome"] : null,
            created_at: toIsoFromEpochMs(Number(row["time_created"] ?? 0)),
            updated_at: toIsoFromEpochMs(updatedMs),
            last_assistant_preview: preview,
          });
        }
      } finally {
        cliDb.close();
      }
    }

    summaries.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    const total = summaries.length;
    let items = summaries.slice(offset, offset + limit);
    let truncated = false;

    const buildPage = (slice: SessionSummary[], isTruncated: boolean): ListSessionsPage => {
      const nextOffset = offset + slice.length;
      const hasMore = total > nextOffset;
      return {
        total,
        count: slice.length,
        offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: nextOffset } : {}),
        ...(isTruncated ? { truncated: true } : {}),
        sessions: slice,
      };
    };

    let page = buildPage(items, truncated);
    while (items.length > 1 && JSON.stringify({ ok: true, ...page }).length > CHARACTER_LIMIT) {
      items = items.slice(0, Math.ceil(items.length / 2));
      truncated = true;
      page = buildPage(items, truncated);
    }
    return page;
  }

  async inspectSession(options: InspectSessionOptions): Promise<InspectSessionResult> {
    const messageLimit = Math.max(1, Math.min(30, options.message_limit ?? 6));
    const toolLimit = Math.max(1, Math.min(50, options.tool_limit ?? 12));

    let task: TaskRecord | null = null;
    if (options.task_id) {
      const raw = this.#stateDb.getTask(options.task_id);
      if (raw) task = await this.#stateDb.reconcileActiveIfDead(raw);
    }

    let sessionId = options.session_id ?? task?.session_id ?? null;
    if (!task && sessionId) {
      const raw = this.#stateDb.getTaskBySessionId(sessionId);
      if (raw) task = await this.#stateDb.reconcileActiveIfDead(raw);
    }

    const paths = resolveZCodeDataPaths();
    const desktopMap = loadDesktopTasksBySession(paths.tasksIndexPath);
    const cliDb = openReadOnlySqlite(paths.cliDbPath);

    let sessionRow: Record<string, unknown> | null = null;
    let presenceRow: Record<string, unknown> | null = null;
    let modelInfo: ParsedModelInfo = {
      provider_id: task?.provider_id ?? null,
      model_id: task?.model_id ?? null,
      mode: task?.mode ?? null,
      reasoning_level: task?.reasoning_level ?? null,
      last_error: null,
    };
    let todos: Array<{ content: string; status: string; priority: string; position: number }> = [];
    const recentTools: InspectSessionResult["recent_tools"] = [];
    const recentMessages: InspectSessionResult["recent_messages"] = [];

    if (cliDb && sessionId) {
      try {
        sessionRow =
          (cliDb
            .prepare(`
              SELECT id, parent_id, directory, title, time_created, time_updated, last_outcome, trace_id, time_deleted
              FROM session WHERE id = ?
            `)
            .get(sessionId) as Record<string, unknown> | undefined) ?? null;

        presenceRow =
          (cliDb
            .prepare("SELECT session_id, owner_id, process_id FROM session_runtime_presence WHERE session_id = ?")
            .get(sessionId) as Record<string, unknown> | undefined) ?? null;

        if (sessionRow) {
          modelInfo = parseSessionMessagesModel(cliDb, sessionId);
          todos = (cliDb
            .prepare("SELECT content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position ASC")
            .all(sessionId) as Array<Record<string, unknown>>).map((r) => ({
            content: String(r["content"] ?? ""),
            status: String(r["status"] ?? "pending"),
            priority: String(r["priority"] ?? "medium"),
            position: Number(r["position"] ?? 0),
          }));

          const toolParts = cliDb
            .prepare(`
              SELECT p.data, p.time_updated
              FROM part p
              JOIN message m ON m.id = p.message_id
              WHERE p.session_id = ?
                AND json_extract(m.data, '$.role') = 'assistant'
                AND json_extract(p.data, '$.type') = 'tool'
              ORDER BY p.time_updated DESC
              LIMIT ?
            `)
            .all(sessionId, toolLimit) as Array<{ data?: unknown; time_updated?: unknown }>;

          for (const tp of toolParts) {
            const pData = safeJsonParse<Record<string, unknown>>(typeof tp.data === "string" ? tp.data : null);
            if (!pData) continue;
            const state = (pData["state"] && typeof pData["state"] === "object" ? pData["state"] : {}) as Record<
              string,
              unknown
            >;
            const inputRaw = state["input"] ? JSON.stringify(state["input"]) : null;
            recentTools.push({
              tool: String(pData["tool"] ?? "unknown"),
              status: typeof state["status"] === "string" ? state["status"] : null,
              input_preview: truncateText(inputRaw, 220),
              error: typeof state["error"] === "string" ? truncateText(state["error"], 300) : null,
              updated_at: toIsoFromEpochMs(Number(tp.time_updated ?? 0)),
            });
          }

          const textParts = cliDb
            .prepare(`
              SELECT p.message_id, p.data, p.time_updated
              FROM part p
              JOIN message m ON m.id = p.message_id
              WHERE p.session_id = ?
                AND json_extract(m.data, '$.role') = 'assistant'
                AND json_extract(p.data, '$.type') = 'text'
              ORDER BY p.time_updated DESC
              LIMIT ?
            `)
            .all(sessionId, messageLimit * 3) as Array<{ message_id?: unknown; data?: unknown; time_updated?: unknown }>;

          for (const tp of textParts) {
            if (recentMessages.length >= messageLimit) break;
            const pData = safeJsonParse<Record<string, unknown>>(typeof tp.data === "string" ? tp.data : null);
            const text = typeof pData?.["text"] === "string" ? pData["text"] : "";
            if (!isUserFacingAssistantText(text)) continue;
            recentMessages.push({
              message_id: String(tp.message_id ?? ""),
              text: text.trim().slice(0, 4000),
              updated_at: toIsoFromEpochMs(Number(tp.time_updated ?? 0)),
            });
          }
        }
      } finally {
        cliDb.close();
      }
    }

    const desktop = sessionId ? desktopMap.get(sessionId) ?? null : null;
    const pending = task ? this.#stateDb.listPendingInteractions(task.task_id).map(serializeInteraction) : [];
    const workerAlive = Boolean(task?.worker_pid && isPidAlive(task.worker_pid));
    const appServerAlive = Boolean(task?.app_server_pid && isPidAlive(task.app_server_pid));
    const presencePid = typeof presenceRow?.["process_id"] === "number" ? presenceRow["process_id"] : null;
    const presencePidAlive = Boolean(presencePid && isPidAlive(presencePid));

    const updatedMs =
      typeof sessionRow?.["time_updated"] === "number"
        ? sessionRow["time_updated"]
        : task
          ? Date.parse(task.updated_at)
          : 0;
    const idleSeconds = updatedMs > 0 ? Math.max(0, Math.round((Date.now() - updatedMs) / 1000)) : 0;

    if (!task && !sessionRow) {
      return {
        found: false,
        session_id: sessionId,
        task_id: options.task_id ?? null,
        effective_state: "not_found",
        diagnosis: "No matching task in state DB and no matching session in ZCode CLI DB.",
        task: null,
        session: null,
        desktop_task: null,
        runtime_presence: { active: false, owner_id: null, process_id: null, pid_alive: false },
        model_info: modelInfo,
        todos: [],
        todo_summary: { total: 0, completed: 0, in_progress: 0, pending: 0 },
        pending_interactions: [],
        recent_tools: [],
        recent_messages: [],
        result_text: null,
        report: null,
        usage: null,
      };
    }

    const { effective_state, diagnosis } = deriveStateAndDiagnosis({
      task,
      workerAlive,
      appServerAlive,
      presencePidAlive,
      presencePid,
      lastOutcome: typeof sessionRow?.["last_outcome"] === "string" ? sessionRow["last_outcome"] : null,
      desktopStatus: desktop?.task_status ?? null,
      pendingInteractionsCount: pending.length,
      lastError: task?.error_message ?? modelInfo.last_error,
      idleSeconds,
    });

    const rawInspect: InspectSessionResult = {
      found: true,
      session_id: sessionId,
      task_id: task?.task_id ?? desktop?.task_id ?? null,
      effective_state,
      diagnosis,
      task: task
        ? {
            status: task.status,
            attempt: task.attempt,
            workspace: task.workspace,
            execution_dir: task.execution_dir,
            mode: task.mode,
            provider_id: task.provider_id,
            model_id: task.model_id,
            reasoning_level: task.reasoning_level,
            worker_pid: task.worker_pid,
            worker_alive: workerAlive,
            app_server_pid: task.app_server_pid,
            app_server_alive: appServerAlive,
            error_code: task.error_code,
            error_message: task.error_message,
            started_at: task.started_at,
            finished_at: task.finished_at,
            updated_at: task.updated_at,
          }
        : null,
      session: sessionRow
        ? {
            id: String(sessionRow["id"] ?? ""),
            parent_id: typeof sessionRow["parent_id"] === "string" ? sessionRow["parent_id"] : null,
            directory: String(sessionRow["directory"] ?? ""),
            title: typeof sessionRow["title"] === "string" ? sessionRow["title"] : null,
            last_outcome: typeof sessionRow["last_outcome"] === "string" ? sessionRow["last_outcome"] : null,
            trace_id: typeof sessionRow["trace_id"] === "string" ? sessionRow["trace_id"] : null,
            created_at: toIsoFromEpochMs(Number(sessionRow["time_created"] ?? 0)),
            updated_at: toIsoFromEpochMs(Number(sessionRow["time_updated"] ?? 0)),
            idle_seconds: idleSeconds,
            deleted: sessionRow["time_deleted"] !== null && sessionRow["time_deleted"] !== undefined,
          }
        : null,
      desktop_task: desktop
        ? {
            task_id: desktop.task_id,
            title: desktop.title,
            task_status: desktop.task_status,
            mode: desktop.mode,
            model: desktop.model,
            provider: desktop.provider,
          }
        : null,
      runtime_presence: {
        active: Boolean(presenceRow),
        owner_id: typeof presenceRow?.["owner_id"] === "string" ? presenceRow["owner_id"] : null,
        process_id: presencePid,
        pid_alive: presencePidAlive,
      },
      model_info: {
        provider_id: modelInfo.provider_id ?? task?.provider_id ?? null,
        model_id: modelInfo.model_id ?? task?.model_id ?? desktop?.model ?? null,
        mode: modelInfo.mode ?? task?.mode ?? desktop?.mode ?? null,
        reasoning_level: modelInfo.reasoning_level ?? task?.reasoning_level ?? null,
        last_error: modelInfo.last_error,
      },
      todos,
      todo_summary: summarizeTodos(todos),
      pending_interactions: pending,
      recent_tools: recentTools,
      recent_messages: recentMessages,
      result_text: task?.result_text ?? null,
      report: safeJsonParse<AgentReport>(task?.report_json),
      usage: safeJsonParse<Record<string, unknown>>(task?.usage_json),
    };
    return applyInspectCharacterLimit(rawInspect);
  }

  async watchSession(options: WatchSessionOptions): Promise<{
    changed: boolean;
    waited_ms: number;
    snapshot: InspectSessionResult;
  }> {
    const waitMs = Math.max(0, Math.min(25_000, Math.round((options.wait_seconds ?? 10) * 1000)));
    const intervalMs = Math.max(300, Math.min(3000, options.interval_ms ?? 1000));
    const signal = options.signal;

    const start = Date.now();
    const initial = await this.inspectSession(options);
    const baselineFingerprint = snapshotFingerprint(initial);

    if (
      signal?.aborted ||
      !initial.found ||
      TERMINAL_STATES.has(initial.effective_state) ||
      initial.effective_state === "waiting_input" ||
      waitMs === 0
    ) {
      return { changed: false, waited_ms: Date.now() - start, snapshot: initial };
    }

    const deadline = start + waitMs;
    while (Date.now() < deadline && !signal?.aborted) {
      const delayMs = Math.min(intervalMs, Math.max(50, deadline - Date.now()));
      await sleepAbortable(delayMs, signal);
      if (signal?.aborted) break;
      const current = await this.inspectSession(options);
      if (
        snapshotFingerprint(current) !== baselineFingerprint ||
        TERMINAL_STATES.has(current.effective_state) ||
        current.effective_state === "waiting_input"
      ) {
        return {
          changed: snapshotFingerprint(current) !== baselineFingerprint,
          waited_ms: Date.now() - start,
          snapshot: current,
        };
      }
    }

    const finalSnapshot = await this.inspectSession(options);
    return {
      changed: snapshotFingerprint(finalSnapshot) !== baselineFingerprint,
      waited_ms: Date.now() - start,
      snapshot: finalSnapshot,
    };
  }
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function applyInspectCharacterLimit(result: InspectSessionResult, maxChars = CHARACTER_LIMIT): InspectSessionResult {
  if (JSON.stringify({ ok: true, ...result }).length <= maxChars) return result;

  const trimmed: InspectSessionResult = {
    ...result,
    recent_messages: [...result.recent_messages],
    recent_tools: [...result.recent_tools],
  };

  if (trimmed.result_text && trimmed.result_text.length > 8000) {
    const tail = trimmed.result_text.slice(-8000);
    trimmed.result_text = `...[truncated older output to fit MCP response budget]...\n${tail}`;
    trimmed.result_truncated = true;
  }

  while (trimmed.recent_messages.length > 1 && JSON.stringify({ ok: true, ...trimmed }).length > maxChars) {
    trimmed.recent_messages.pop();
    trimmed.result_truncated = true;
  }

  if (trimmed.recent_messages[0] && JSON.stringify({ ok: true, ...trimmed }).length > maxChars) {
    trimmed.recent_messages[0] = {
      ...trimmed.recent_messages[0],
      text: truncateText(trimmed.recent_messages[0].text, 1200) ?? "",
    };
    trimmed.result_truncated = true;
  }

  while (trimmed.recent_tools.length > 3 && JSON.stringify({ ok: true, ...trimmed }).length > maxChars) {
    trimmed.recent_tools.pop();
    trimmed.result_truncated = true;
  }

  if (trimmed.result_text && trimmed.result_text.length > 2000 && JSON.stringify({ ok: true, ...trimmed }).length > maxChars) {
    const tail = trimmed.result_text.slice(-2000);
    trimmed.result_text = `...[truncated to stay under ${maxChars} chars]...\n${tail}`;
    trimmed.result_truncated = true;
  }

  return trimmed;
}

function snapshotFingerprint(s: InspectSessionResult): string {
  return JSON.stringify({
    state: s.effective_state,
    sessionId: s.session_id,
    todo: s.todo_summary,
    pending: s.pending_interactions.map((p) => p.request_id),
    lastTool: s.recent_tools[0]?.updated_at ?? null,
    lastMsg: s.recent_messages[0]?.message_id ?? null,
    finishedAt: s.task?.finished_at ?? null,
  });
}
