#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { ZCodeObserver } from "./observer/zcode-observer.js";
import { runWaitCli, WAIT_HELP_TEXT } from "./cli/wait.js";
import { buildContinuePrompt, buildTaskPrompt } from "./prompts/task-prompt.js";
import { updateDesktopTaskStatusSafe } from "./runtime/desktop-index.js";
import { isVerifiedProcessAlive, killVerifiedProcessTree } from "./runtime/process-identity.js";
import { discoverZCodeRuntime, resolveDataRoot, resolveZCodeDataPaths } from "./runtime/zcode-discovery.js";
import { probeZCodeModels, resolveModelTarget } from "./runtime/zcode-rpc.js";
import { StateDb } from "./store/state-db.js";
import type { ModelSelection, TaskPackageInput, ZCodeRuntimePaths } from "./types.js";

const SERVER_NAME = "zcode-worker-mcp";
const SERVER_VERSION = "0.1.0";

const SERVER_INSTRUCTIONS = [
  "zcode-worker-mcp orchestrates local ZCode sessions with detached workers, per-task model selection, and unified observability across ZCode Desktop, CLI, and MCP.",
  "Built-in orchestration rules:",
  "1. Dispatch & isolation: Only one active task may run per execution directory; specify distinct `worktree_path` values for concurrent tasks on one repository, and include explicit `allowed_paths`, `forbidden_paths`, `acceptance_criteria`, and `test_commands`.",
  "2. Model selection: Call `zcode_models` when unsure of available providers, `model_id`, or `reasoning_level`. Passing `model` on `zcode_start`/`zcode_continue` applies only to that session without overwriting workspace defaults.",
  "3. Default waiting (`wait` notification, zero polling tokens): After `zcode_start` or `zcode_continue`, prefer launching `zcode-worker-mcp wait <task_id> --timeout <sec>` (optionally `--notify`) as a background shell command and ending your turn until notified, instead of looping `zcode_watch_session`.",
  "4. Periodic inspection (opt-in or fallback): Use `zcode_watch_session` (<=25s) and `zcode_inspect_session` (optionally via a lightweight watcher subagent or schedule) when periodic progress updates are desired or background shell execution is unavailable.",
  "5. Unified sessions & handoff: Query `zcode_list_sessions` and `zcode_inspect_session` by either `task_id` or `session_id` (covering MCP, ZCode Desktop, and CLI). Pass `resume_session_id` to `zcode_start` to attach directly to an existing Desktop/CLI session.",
  "6. Interactions, cancellation & verification: For `waiting_input`, check `pending_interactions` and call `zcode_reply` only within explicit user authorization (ask the user when uncertain), then resume waiting. Cancel safely with `zcode_cancel`. After `completed`, independently verify diffs/allowed paths and build/test commands before accepting the result.",
].join("\n");

const ModelSchema = z.strictObject({
  provider_id: z.string().min(1).optional().describe("Optional provider ID from zcode_models (required only if model_id matches multiple providers)."),
  model_id: z.string().min(1).describe("Target model_id returned by zcode_models (e.g. 'deepseek-v4.1-flash:1017')."),
  reasoning_level: z.string().min(1).optional().describe("Optional reasoning level supported by the model; defaults to the model's default level when required."),
});

const ModeSchema = z.enum(["yolo", "build", "edit", "plan", "guarded"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_SCRIPT_PATH = path.join(__dirname, "worker.js");

function okResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errResult(code: string, message: string, details?: Record<string, unknown>) {
  const payload = { ok: false, error: { code, message, ...(details ? { details } : {}) } };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function assertExistingDirectory(dirPath: string, label: string): string {
  const resolved = path.resolve(dirPath);
  if (!existsSync(resolved)) {
    throw new Error(`INVALID_${label.toUpperCase()}: path does not exist: "${resolved}".`);
  }
  const st = statSync(resolved);
  if (!st.isDirectory()) {
    throw new Error(`INVALID_${label.toUpperCase()}: path is not a directory: "${resolved}".`);
  }
  return resolved;
}

function spawnDetachedWorker(dataRoot: string, taskId: string): number {
  const logsDir = path.join(dataRoot, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${taskId}.log`);
  const logFd = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [WORKER_SCRIPT_PATH, dataRoot, taskId], {
      cwd: dataRoot,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    if (!child.pid) {
      throw new Error("Failed to acquire detached worker PID.");
    }
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

async function resolveRequestedModel(
  runtime: ZCodeRuntimePaths,
  execDir: string,
  requested: ModelSelection,
  signal?: AbortSignal,
): Promise<{ providerId: string; modelId: string; reasoningLevel?: string }> {
  const catalog = await probeZCodeModels(runtime, execDir, signal);
  return resolveModelTarget(catalog.models, requested);
}

function buildInteractionAnswer(
  method: string,
  paramsRaw: string,
  args: {
    decision?: "allow" | "deny";
    reason?: string;
    answers?: Record<string, string>;
    approve_plan?: boolean;
  },
): Record<string, unknown> {
  const params = JSON.parse(paramsRaw) as Record<string, unknown>;

  if (method === "interaction/requestPermission") {
    if (!args.decision) {
      throw new Error("INVALID_REPLY: decision ('allow' or 'deny') is required for permission requests.");
    }
    if (args.decision === "allow") {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      reason: args.reason?.trim() || "Denied by MCP host.",
    };
  }

  if (args.decision === "deny") {
    return { action: "decline", ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}) };
  }

  const schemaObj = params["schema"] && typeof params["schema"] === "object" ? (params["schema"] as Record<string, unknown>) : null;
  if (schemaObj?.["interaction"] === "plan_approval") {
    if (args.approve_plan === false) {
      return { action: "decline", ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}) };
    }
    return { action: "accept", content: { answer_0: "approve" } };
  }

  if (!args.answers || Object.keys(args.answers).length === 0) {
    throw new Error("INVALID_REPLY: answers map is required for user input requests (or pass decision='deny').");
  }
  return {
    action: "accept",
    content: { answers: args.answers },
  };
}

function createServer(): McpServer {
  const dataRoot = resolveDataRoot();
  const stateDb = new StateDb(dataRoot);
  const observer = new ZCodeObserver(stateDb);

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  const prevOnClose = server.server.onclose;
  server.server.onclose = () => {
    try {
      stateDb.close();
    } finally {
      prevOnClose?.();
    }
  };

  server.registerTool(
    "zcode_doctor",
    {
      title: "ZCode Environment & Worker Health Check",
      description:
        "Inspect local ZCode CLI/Desktop installation, SQLite stores, configured runtime availability, and live worker processes without leaking credentials.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const runtime = discoverZCodeRuntime();
        const active = await observer.listSessions({ active_only: true, limit: 20 });
        return okResult({
          ok: true,
          server: { name: SERVER_NAME, version: SERVER_VERSION, node_version: process.version },
          data_root: dataRoot,
          state_db_path: stateDb.dbPath,
          runtime: {
            node_executable: runtime.nodeExecutable,
            install_dir: runtime.installDir,
            zcode_entrypoint: runtime.zcodeEntrypoint,
            app_version: runtime.appVersion,
            build_commit_id: runtime.buildCommitId,
            builtin_config_file: runtime.builtinConfigFile,
            zcode_data_dir: runtime.zcodeDataDir,
            cli_db_exists: existsSync(runtime.cliDbPath),
            tasks_index_exists: existsSync(runtime.tasksIndexPath),
            personal_config_exists: existsSync(runtime.personalConfigFile),
          },
          active_sessions_count: active.length,
          active_sessions: active,
        });
      } catch (err) {
        return errResult("DOCTOR_FAILED", err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "zcode_models",
    {
      title: "List Available ZCode Models",
      description:
        "Probe local ZCode app-server for the current model selection and all available providers, model_id values, and reasoning levels (sanitized, no API keys).",
      inputSchema: z.strictObject({
        workspace: z.string().min(1).optional().describe("Workspace path used for ZCode context (defaults to current working directory)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspace }, ctx) => {
      try {
        const targetDir = assertExistingDirectory(workspace ?? process.cwd(), "workspace");
        const runtime = discoverZCodeRuntime();
        const catalog = await probeZCodeModels(runtime, targetDir, ctx.mcpReq.signal);
        return okResult({
          ok: true,
          workspace: targetDir,
          current_model: catalog.current_model,
          models: catalog.models,
        });
      } catch (err) {
        return errResult("MODELS_PROBE_FAILED", err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "zcode_start",
    {
      title: "Start (or Resume) a Detached ZCode Worker Task",
      description:
        "Dispatch a structured coding or analysis task to a detached ZCode worker that survives MCP restarts. Supports per-task model/provider/reasoning selection and optional resume_session_id.",
      inputSchema: z.strictObject({
        task_id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._-]+$/, "task_id may only contain letters, numbers, '.', '_' and '-'.")
          .describe("Unique managed task identifier (letters, numbers, '.', '_' and '-')."),
        workspace: z.string().min(1).describe("Absolute path to the project repository root."),
        worktree_path: z.string().min(1).optional().describe("Optional isolated git worktree execution path when running concurrent tasks on one repository."),
        mode: ModeSchema.default("yolo").describe("ZCode execution mode: yolo, build, edit, plan, or guarded."),
        model: ModelSchema.optional().describe("Optional per-session model override; omit to use ZCode's current default."),
        resume_session_id: z.string().min(1).optional().describe("Optional existing ZCode session ID (e.g. sess_...) to resume instead of creating a brand new session."),
        objective: z.string().min(1).describe("Clear goal statement describing what ZCode should accomplish."),
        requirements: z.array(z.string().min(1)).default([]).describe("Concrete implementation requirements."),
        allowed_paths: z.array(z.string().min(1)).default([]).describe("Workspace-relative paths ZCode is permitted to modify."),
        forbidden_paths: z.array(z.string().min(1)).default([]).describe("Paths ZCode must never create, modify, or delete."),
        acceptance_criteria: z.array(z.string().min(1)).default([]).describe("Verifiable completion criteria checked independently after completion."),
        test_commands: z.array(z.string().min(1)).default([]).describe("Build, lint, or test commands ZCode should run before finishing."),
        context: z.string().optional().describe("Optional additional context, baseline commit, or constraints."),
        context_files: z.array(z.string().min(1)).default([]).describe("Key reference file paths ZCode should read first."),
        timeout_sec: z.number().int().min(60).max(14400).optional().describe("Worker execution timeout in seconds (60..14400, default 3600)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args, ctx) => {
      try {
        const workspaceDir = assertExistingDirectory(args.workspace, "workspace");
        const execDir = assertExistingDirectory(args.worktree_path ?? workspaceDir, "worktree_path");
        const runtime = discoverZCodeRuntime();

        let resolvedModel: { providerId: string; modelId: string; reasoningLevel?: string } | null = null;
        if (args.model) {
          resolvedModel = await resolveRequestedModel(runtime, execDir, args.model, ctx.mcpReq.signal);
        }

        const taskInput: TaskPackageInput = {
          task_id: args.task_id,
          workspace: workspaceDir,
          ...(args.worktree_path ? { worktree_path: execDir } : {}),
          mode: args.mode,
          ...(resolvedModel
            ? {
                model: {
                  provider_id: resolvedModel.providerId,
                  model_id: resolvedModel.modelId,
                  ...(resolvedModel.reasoningLevel ? { reasoning_level: resolvedModel.reasoningLevel } : {}),
                },
              }
            : args.model
              ? { model: args.model }
              : {}),
          ...(args.resume_session_id ? { resume_session_id: args.resume_session_id } : {}),
          objective: args.objective,
          requirements: args.requirements,
          allowed_paths: args.allowed_paths,
          forbidden_paths: args.forbidden_paths,
          acceptance_criteria: args.acceptance_criteria,
          test_commands: args.test_commands,
          ...(args.context ? { context: args.context } : {}),
          context_files: args.context_files,
          ...(args.timeout_sec !== undefined ? { timeout_sec: args.timeout_sec } : {}),
        };

        const promptText = buildTaskPrompt(taskInput);
        const task = await stateDb.createTask(taskInput, promptText);

        let workerPid: number;
        try {
          workerPid = spawnDetachedWorker(dataRoot, task.task_id);
        } catch (spawnErr) {
          stateDb.finishFailed(
            task.task_id,
            "WORKER_SPAWN_FAILED",
            spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
          );
          throw spawnErr;
        }

        return okResult({
          ok: true,
          task_id: task.task_id,
          status: task.status,
          execution_dir: task.execution_dir,
          mode: task.mode,
          model: {
            provider_id: task.provider_id,
            model_id: task.model_id,
            reasoning_level: task.reasoning_level,
          },
          session_id: task.session_id,
          worker_pid: workerPid,
          log_path: path.join(dataRoot, "logs", `${task.task_id}.log`),
          wait_command: `zcode-worker-mcp wait ${task.task_id}`,
        });
      } catch (err) {
        return errResult("START_FAILED", err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "zcode_continue",
    {
      title: "Continue an Existing Managed Task",
      description:
        "Continue an existing task on its bound ZCode session_id with new feedback, optional updated requirements, or a different model/mode.",
      inputSchema: z.strictObject({
        task_id: z.string().min(1).describe("Existing managed task_id from zcode_start or zcode_list_sessions."),
        feedback: z.string().min(1).describe("Follow-up guidance, fixes, or verification gaps for ZCode to address."),
        additional_requirements: z.array(z.string().min(1)).default([]).describe("Optional extra requirements added for this attempt."),
        mode: ModeSchema.optional().describe("Optional execution mode override for this continuation."),
        model: ModelSchema.optional().describe("Optional per-session model override for this continuation."),
        operation_id: z.string().min(1).optional().describe("Optional idempotency key to prevent duplicate continuation launches."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args, ctx) => {
      try {
        const existing = stateDb.getTask(args.task_id);
        if (!existing) {
          return errResult("TASK_NOT_FOUND", `Unknown task "${args.task_id}". Call zcode_list_sessions to inspect known tasks or use zcode_start.`);
        }

        let resolvedModel: { providerId: string; modelId: string; reasoningLevel?: string } | null = null;
        if (args.model) {
          const runtime = discoverZCodeRuntime();
          resolvedModel = await resolveRequestedModel(runtime, existing.execution_dir, args.model, ctx.mcpReq.signal);
        }

        const promptText = buildContinuePrompt(existing, args.feedback, args.additional_requirements);
        const { task, deduplicated } = await stateDb.prepareContinue({
          taskId: args.task_id,
          promptText,
          ...(args.mode ? { mode: args.mode } : {}),
          ...(resolvedModel
            ? {
                providerId: resolvedModel.providerId,
                modelId: resolvedModel.modelId,
                reasoningLevel: resolvedModel.reasoningLevel ?? null,
              }
            : {}),
          ...(args.operation_id ? { operationId: args.operation_id } : {}),
        });

        let workerPid = task.worker_pid;
        if (!deduplicated) {
          try {
            workerPid = spawnDetachedWorker(dataRoot, task.task_id);
          } catch (spawnErr) {
            stateDb.finishFailed(
              task.task_id,
              "WORKER_SPAWN_FAILED",
              spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
            );
            throw spawnErr;
          }
        }

        return okResult({
          ok: true,
          deduplicated,
          task_id: task.task_id,
          attempt: task.attempt,
          status: task.status,
          session_id: task.session_id,
          mode: task.mode,
          model: {
            provider_id: task.provider_id,
            model_id: task.model_id,
            reasoning_level: task.reasoning_level,
          },
          worker_pid: workerPid,
          wait_command: `zcode-worker-mcp wait ${task.task_id}`,
        });
      } catch (err) {
        return errResult("CONTINUE_FAILED", err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "zcode_list_sessions",
    {
      title: "List Unified ZCode Sessions",
      description:
        "List sessions across zcode-worker-mcp, ZCode Desktop, and ZCode CLI with live runtime PID checks, model/mode info, todo counts, pagination, and latest assistant previews.",
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum sessions to return per page (1..100, default 20)."),
        offset: z.number().int().min(0).default(0).describe("Number of sessions to skip for pagination (default 0)."),
        workspace: z.string().min(1).optional().describe("Optional workspace directory filter."),
        active_only: z.boolean().default(false).describe("When true, return only queued, running, or waiting_input sessions."),
        include_deleted: z.boolean().default(false).describe("Include sessions marked deleted in ZCode SQLite."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const page = await observer.listSessionsPage(args);
        return okResult({ ok: true, ...page });
      } catch (err) {
        return errResult("LIST_SESSIONS_FAILED", err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "zcode_inspect_session",
    {
      title: "Inspect Live Progress of Any ZCode Task or Session",
      description:
        "Get real-time progress by task_id or session_id: effective state, live PID check, todos, recent tool calls, assistant messages, pending interactions, and final result/report.",
      inputSchema: z
        .strictObject({
          task_id: z.string().min(1).optional().describe("Managed task_id (optional if session_id is provided)."),
          session_id: z.string().min(1).optional().describe("ZCode session ID such as 'sess_...' (works for Desktop, CLI, and managed tasks)."),
          message_limit: z.number().int().min(1).max(30).default(6).describe("Max recent assistant messages to include (1..30)."),
          tool_limit: z.number().int().min(1).max(50).default(12).describe("Max recent tool calls to include (1..50)."),
        })
        .refine((v) => Boolean(v.task_id || v.session_id), {
          message: "Either task_id or session_id must be provided.",
        }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await observer.inspectSession(args);
        if (!result.found) {
          return errResult("NOT_FOUND", `${result.diagnosis} Call zcode_list_sessions to check available IDs.`, {
            ...(args.task_id ? { task_id: args.task_id } : {}),
            ...(args.session_id ? { session_id: args.session_id } : {}),
          });
        }
        return okResult({ ok: true, ...result });
      } catch (err) {
        return errResult("INSPECT_FAILED", err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "zcode_watch_session",
    {
      title: "Watch a ZCode Session for Progress or Completion",
      description:
        "Short-poll (<=25s) for periodic progress checks or environments without background commands. For zero-token completion wakeup, prefer running `zcode-worker-mcp wait <task_id>` in background.",
      inputSchema: z
        .strictObject({
          task_id: z.string().min(1).optional().describe("Managed task_id (optional if session_id is provided)."),
          session_id: z.string().min(1).optional().describe("ZCode session ID such as 'sess_...'."),
          wait_seconds: z.number().min(0).max(25).default(10).describe("Seconds to wait for state change before returning (0..25)."),
          interval_ms: z.number().int().min(300).max(3000).default(1000).describe("Local polling interval in milliseconds (300..3000)."),
          message_limit: z.number().int().min(1).max(20).default(5).describe("Max recent assistant messages to include."),
          tool_limit: z.number().int().min(1).max(30).default(10).describe("Max recent tool calls to include."),
        })
        .refine((v) => Boolean(v.task_id || v.session_id), {
          message: "Either task_id or session_id must be provided.",
        }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, ctx) => {
      try {
        const watched = await observer.watchSession({ ...args, signal: ctx.mcpReq.signal });
        if (!watched.snapshot.found) {
          return errResult("NOT_FOUND", `${watched.snapshot.diagnosis} Call zcode_list_sessions to find valid IDs.`);
        }
        return okResult({ ok: true, ...watched });
      } catch (err) {
        return errResult("WATCH_FAILED", err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "zcode_reply",
    {
      title: "Reply to a Pending Worker Permission or Input Request",
      description:
        "Answer a waiting_input task's pending interaction (permission allow/deny, plan approval, or user input answers) so ZCode resumes.",
      inputSchema: z.strictObject({
        task_id: z.string().min(1).describe("Task ID currently in waiting_input state."),
        request_id: z.string().min(1).optional().describe("Optional when the task has exactly one pending interaction."),
        decision: z.enum(["allow", "deny"]).optional().describe("Decision for permission prompts ('allow' or 'deny')."),
        reason: z.string().max(2000).optional().describe("Optional explanation when denying a permission or declining a request."),
        answers: z.record(z.string(), z.string()).optional().describe("Question-to-answer map for user-input prompts."),
        approve_plan: z.boolean().optional().describe("Set true/false for plan approval interactions."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const pending = stateDb.listPendingInteractions(args.task_id);
        let targetId = args.request_id;
        if (!targetId) {
          if (pending.length === 0) {
            return errResult("NO_PENDING_INTERACTION", `Task "${args.task_id}" has no pending interaction requests.`);
          }
          if (pending.length > 1) {
            return errResult(
              "AMBIGUOUS_INTERACTION",
              `Task "${args.task_id}" has ${pending.length} pending requests; pass request_id explicitly.`,
              { request_ids: pending.map((p) => p.request_id) },
            );
          }
          targetId = pending[0]!.request_id;
        }

        const record = stateDb.getInteraction(targetId);
        if (!record || record.task_id !== args.task_id) {
          return errResult("INTERACTION_NOT_FOUND", `Unknown interaction "${targetId}" for task "${args.task_id}".`);
        }

        const answer = buildInteractionAnswer(record.method, record.params_json, args);
        const updated = stateDb.replyInteraction(targetId, answer);

        return okResult({
          ok: true,
          task_id: args.task_id,
          request_id: updated.request_id,
          status: updated.status,
          replied_at: updated.replied_at,
        });
      } catch (err) {
        return errResult("REPLY_FAILED", err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "zcode_cancel",
    {
      title: "Safely Cancel a Managed ZCode Worker Task",
      description:
        "Terminate verified worker/app-server processes (strictly guarding against Windows PID reuse) and release the workspace lock.",
      inputSchema: z.strictObject({
        task_id: z.string().min(1).describe("Managed task_id to cancel."),
        reason: z.string().max(1000).default("Cancelled by caller").describe("Optional cancellation reason recorded in task history."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ task_id, reason }) => {
      try {
        const existing = stateDb.getTask(task_id);
        if (!existing) {
          return errResult("TASK_NOT_FOUND", `Unknown task "${task_id}". Call zcode_list_sessions to check existing tasks.`);
        }

        const reconciled = await stateDb.reconcileActiveIfDead(existing);
        if (reconciled.status === "completed" || reconciled.status === "cancelled" || reconciled.status === "failed") {
          return okResult({
            ok: true,
            already_finished: true,
            task_id: reconciled.task_id,
            status: reconciled.status,
            error_code: reconciled.error_code,
            error_message: reconciled.error_message,
          });
        }

        const appServerIdentity = await isVerifiedProcessAlive(
          reconciled.app_server_pid,
          reconciled.app_server_start_ticks,
        );
        const appServerKill =
          reconciled.app_server_pid && appServerIdentity.alive
            ? await killVerifiedProcessTree(reconciled.app_server_pid, reconciled.app_server_start_ticks)
            : { status: appServerIdentity.pidReused ? ("pid_reused" as const) : ("already_exited" as const) };

        const workerIdentity = await isVerifiedProcessAlive(reconciled.worker_pid, reconciled.worker_start_ticks);
        const workerKill =
          reconciled.worker_pid && workerIdentity.alive
            ? await killVerifiedProcessTree(reconciled.worker_pid, reconciled.worker_start_ticks)
            : { status: workerIdentity.pidReused ? ("pid_reused" as const) : ("already_exited" as const) };

        if (appServerKill.status === "kill_failed" || workerKill.status === "kill_failed") {
          return errResult("CANCEL_FAILED", "Verified ZCode process tree could not be terminated cleanly.", {
            app_server: appServerKill,
            worker: workerKill,
          });
        }

        stateDb.finishFailed(task_id, "cancelled_by_caller", reason, "cancelled");
        if (reconciled.session_id) {
          const paths = resolveZCodeDataPaths();
          updateDesktopTaskStatusSafe(
            {
              databasePath: paths.tasksIndexPath,
              workspaceKey: reconciled.workspace,
              workspacePath: reconciled.execution_dir,
              sessionId: reconciled.session_id,
              taskId: reconciled.task_id,
              title: reconciled.task_id,
              model:
                reconciled.provider_id && reconciled.model_id
                  ? `${reconciled.provider_id}/${reconciled.model_id}`
                  : reconciled.model_id,
              provider: "glm",
              mode: reconciled.mode,
            },
            "error",
          );
        }

        return okResult({
          ok: true,
          task_id,
          status: "cancelled",
          process_cleanup: {
            app_server: appServerKill.status,
            worker: workerKill.status,
          },
        });
      } catch (err) {
        return errResult("CANCEL_FAILED", err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}

const subcommand = process.argv[2];
if (subcommand === "wait") {
  void runWaitCli(process.argv.slice(3)).then((code) => process.exit(code));
} else if (subcommand === "--help" || subcommand === "-h") {
  process.stdout.write(
    `zcode-worker-mcp v${SERVER_VERSION}\n\nCommands:\n  (default)   Run MCP server over stdio\n  wait        Block until a ZCode task/session completes or waits for input\n\n${WAIT_HELP_TEXT}\n`,
  );
  process.exit(0);
} else {
  const serverHandle = serveStdio(() => createServer());

  process.on("SIGINT", () => {
    void serverHandle.close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void serverHandle.close().finally(() => process.exit(0));
  });
}
