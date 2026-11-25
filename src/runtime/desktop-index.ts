import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface DesktopIndexSyncEntry {
  databasePath: string;
  workspaceKey: string;
  workspacePath: string;
  sessionId: string;
  taskId: string;
  title: string;
  model: string | null;
  provider: string;
  mode: string;
}

const REQUIRED_COLUMNS = [
  "workspace_key",
  "workspace_path",
  "workspace_identity",
  "task_id",
  "title",
  "task_status",
  "provider",
  "mode",
  "model",
  "created_at",
  "updated_at",
  "unread_at",
  "pinned",
  "archived",
  "deleted",
  "title_overridden",
  "meta_json",
  "searchable_text",
];

function hasRequiredSchema(db: DatabaseSync): boolean {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name?: unknown }>)
      .map((c) => c.name)
      .filter((n): n is string => typeof n === "string"),
  );
  return REQUIRED_COLUMNS.every((col) => cols.has(col));
}

function withOwnedRow(
  databasePath: string,
  operation: (db: DatabaseSync) => void,
): void {
  if (!existsSync(databasePath)) return;
  const db = new DatabaseSync(databasePath, { timeout: 1000 });
  try {
    if (!hasRequiredSchema(db)) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      operation(db);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

function updateOwned(
  db: DatabaseSync,
  entry: DesktopIndexSyncEntry,
  status: "running" | "completed" | "error",
): void {
  const row = db
    .prepare("SELECT meta_json FROM tasks WHERE workspace_key = ? AND task_id = ?")
    .get(entry.workspaceKey, entry.sessionId) as { meta_json?: unknown } | undefined;
  if (!row || typeof row.meta_json !== "string") return;

  let meta: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.meta_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    meta = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (meta["traceId"] !== entry.taskId || meta["taskId"] !== entry.sessionId) return;

  const now = Date.now();
  meta["updatedAt"] = now;
  meta["status"] = status;
  if (entry.model) meta["model"] = entry.model;
  db.prepare(
    "UPDATE tasks SET task_status = ?, model = COALESCE(?, model), updated_at = ?, meta_json = ? WHERE workspace_key = ? AND task_id = ?",
  ).run(status, entry.model, now, JSON.stringify(meta), entry.workspaceKey, entry.sessionId);
}

/**
 * Best-effort sync into ZCode Desktop's tasks-index.sqlite so delegated tasks
 * appear in the Desktop UI sidebar. Never overrides existing user-owned rows.
 */
export function registerDesktopTaskSafe(entry: DesktopIndexSyncEntry): void {
  try {
    withOwnedRow(entry.databasePath, (db) => {
      const now = Date.now();
      const title = entry.title.trim().slice(0, 80) || entry.taskId;
      const metaJson = JSON.stringify({
        taskId: entry.sessionId,
        traceId: entry.taskId,
        title,
        titleOverridden: false,
        workspaceKey: entry.workspaceKey,
        workspacePath: entry.workspacePath,
        createdAt: now,
        updatedAt: now,
        mode: entry.mode,
        model: entry.model,
        provider: entry.provider,
        status: "running",
        target: null,
      });

      db.prepare(`
        INSERT OR IGNORE INTO tasks (
          workspace_key, workspace_path, workspace_identity, task_id,
          title, task_status, provider, mode, model,
          created_at, updated_at, unread_at, pinned, archived, deleted,
          title_overridden, meta_json, searchable_text
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 0, ?, ?)
      `).run(
        entry.workspaceKey,
        entry.workspacePath,
        entry.sessionId,
        title,
        "running",
        entry.provider,
        entry.mode,
        entry.model,
        now,
        now,
        metaJson,
        entry.taskId,
      );

      updateOwned(db, entry, "running");
    });
  } catch {
    // Best-effort UI mirror only; never block or fail worker execution.
  }
}

export function updateDesktopTaskStatusSafe(
  entry: DesktopIndexSyncEntry,
  status: "completed" | "error",
): void {
  try {
    withOwnedRow(entry.databasePath, (db) => {
      updateOwned(db, entry, status);
    });
  } catch {
    // Best-effort UI mirror only.
  }
}
