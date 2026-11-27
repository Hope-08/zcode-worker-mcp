import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ZCodeObserver, type InspectSessionResult } from "../observer/zcode-observer.js";
import { resolveDataRoot } from "../runtime/zcode-discovery.js";
import { StateDb } from "../store/state-db.js";

const execFileAsync = promisify(execFile);

const ACTIVE_WAIT_STATES = new Set(["queued", "running_active", "running_inactive"]);
const DEFAULT_IDLE_WARN_SEC = 300;

export interface WaitCliArgs {
  help: boolean;
  taskId?: string;
  sessionId?: string;
  target?: string;
  timeoutSec: number;
  intervalMs: number;
  heartbeatSec: number;
  quiet: boolean;
  notify: boolean;
}

export interface WaitOutcome {
  exitCode: number;
  reason: string;
  waited_ms: number;
  snapshot: InspectSessionResult;
}

export interface WaitExecutionOptions {
  onLog?: (line: string) => void;
  idleWarnSec?: number;
}

export const WAIT_HELP_TEXT = `Usage: zcode-worker-mcp wait <task_id_or_session_id> [options]

Wait until a ZCode task/session finishes or pauses for input.
Streams compact live progress & liveness heartbeats to stderr while keeping stdout purely for final JSON.

Options:
  --task <task_id>        Target a managed task_id explicitly
  --session <session_id>  Target a ZCode session_id explicitly
  --timeout <seconds>     Max seconds to wait (1..14400, default: 3600)
  --interval <ms>         Local SQLite check interval ms (200..5000, default: 1000)
  --heartbeat <seconds>   Liveness heartbeat interval when idle (0 to disable, 5..600, default: 60)
  --quiet, -q             Suppress live progress logs on stderr (final JSON still written to stdout)
  --notify, --toast       Enable OS desktop notification on completion (enabled by default)
  --no-notify, --no-toast Disable OS desktop notification
  -h, --help              Show this help text

Exit codes:
  0    Reached terminal state or waiting_input
  1    Invalid arguments
  2    Target task/session not found
  124  Timed out waiting for completion`;

export function parseWaitArgs(argv: string[]): WaitCliArgs {
  let help = false;
  let taskId: string | undefined;
  let sessionId: string | undefined;
  let target: string | undefined;
  let timeoutSec = 3600;
  let intervalMs = 1000;
  let heartbeatSec = 60;
  let quiet = false;
  let notify = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--quiet" || arg === "-q") {
      quiet = true;
      continue;
    }
    if (arg === "--notify" || arg === "--toast") {
      notify = true;
      continue;
    }
    if (arg === "--no-notify" || arg === "--no-toast") {
      notify = false;
      continue;
    }
    if (arg === "--task") {
      const val = argv[++i];
      if (!val) throw new Error("--task requires a value");
      taskId = val;
      continue;
    }
    if (arg === "--session") {
      const val = argv[++i];
      if (!val) throw new Error("--session requires a value");
      sessionId = val;
      continue;
    }
    if (arg === "--timeout") {
      const val = Number(argv[++i]);
      if (!Number.isFinite(val) || val < 1 || val > 14_400) {
        throw new Error("--timeout must be a number between 1 and 14400 seconds");
      }
      timeoutSec = val;
      continue;
    }
    if (arg === "--interval") {
      const val = Number(argv[++i]);
      if (!Number.isFinite(val) || val < 200 || val > 5000) {
        throw new Error("--interval must be a number between 200 and 5000 ms");
      }
      intervalMs = Math.round(val);
      continue;
    }
    if (arg === "--heartbeat") {
      const val = Number(argv[++i]);
      if (!Number.isFinite(val) || (val !== 0 && (val < 5 || val > 600))) {
        throw new Error("--heartbeat must be 0 or a number between 5 and 600 seconds");
      }
      heartbeatSec = Math.round(val);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (target) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    target = arg;
  }

  if (!help && !taskId && !sessionId && !target) {
    throw new Error("Target task_id or session_id is required. Run `zcode-worker-mcp wait --help`.");
  }

  return { help, taskId, sessionId, target, timeoutSec, intervalMs, heartbeatSec, quiet, notify };
}

async function inspectTarget(observer: ZCodeObserver, args: WaitCliArgs): Promise<InspectSessionResult> {
  if (args.taskId || args.sessionId) {
    return observer.inspectSession({
      ...(args.taskId ? { task_id: args.taskId } : {}),
      ...(args.sessionId ? { session_id: args.sessionId } : {}),
    });
  }
  const byTask = await observer.inspectSession({ task_id: args.target });
  if (byTask.found) return byTask;
  return observer.inspectSession({ session_id: args.target });
}

function nowStamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function singleLine(text: string | null | undefined, maxLen = 120): string {
  if (!text) return "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 3)}...`;
}

function formatDurationCompact(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function formatLiveness(snap: InspectSessionResult): string {
  const parts: string[] = [];
  if (snap.task) {
    const wPid = snap.task.worker_pid;
    parts.push(wPid ? `worker=${snap.task.worker_alive ? `up(${wPid})` : `down(${wPid})`}` : "worker=starting");
  }
  const zPid = snap.task?.app_server_pid ?? snap.runtime_presence.process_id;
  const zAlive = snap.task?.app_server_alive || snap.runtime_presence.pid_alive;
  if (zPid) {
    parts.push(`zcode=${zAlive ? `up(${zPid})` : `down(${zPid})`}`);
  } else if (snap.task) {
    parts.push("zcode=starting");
  }
  return parts.join(" ");
}

function computeIdleSeconds(snap: InspectSessionResult): number {
  if (snap.session) return snap.session.idle_seconds;
  if (snap.task?.updated_at) {
    return Math.max(0, Math.round((Date.now() - Date.parse(snap.task.updated_at)) / 1000));
  }
  return 0;
}

function formatToolSummary(tool: InspectSessionResult["recent_tools"][number]): string {
  const status = tool.status ?? "unknown";
  const suffix = tool.error ? ` err="${singleLine(tool.error, 80)}"` : tool.input_preview ? ` ${singleLine(tool.input_preview, 90)}` : "";
  return `[tool ${status}] ${tool.tool}${suffix}`;
}

function createProgressTracker(
  args: WaitCliArgs,
  onLog: (line: string) => void,
  idleWarnSec: number,
  startTimeMs: number,
) {
  let prevState = "";
  let prevSessionId: string | null = null;
  let prevTodoKey = "";
  let prevToolKey = "";
  let prevMsgId = "";
  let lastEmitAt = startTimeMs;
  const heartbeatMs = args.heartbeatSec > 0 ? args.heartbeatSec * 1000 : 0;

  const emit = (msg: string) => {
    onLog(`[${nowStamp()}] ${msg}`);
    lastEmitAt = Date.now();
  };

  const describeActiveTodo = (snap: InspectSessionResult): string => {
    const { total, completed } = snap.todo_summary;
    if (total === 0) return "";
    const current = snap.todos.find((t) => t.status === "in_progress") ?? snap.todos.find((t) => t.status !== "completed");
    return current
      ? `todos ${completed}/${total} ("${singleLine(current.content, 60)}")`
      : `todos ${completed}/${total} (all completed)`;
  };

  return {
    onInitial(snap: InspectSessionResult): void {
      prevState = snap.effective_state;
      prevSessionId = snap.session_id;
      const todoText = describeActiveTodo(snap);
      prevTodoKey = `${snap.todo_summary.completed}/${snap.todo_summary.total}|${snap.todos.find((t) => t.status === "in_progress")?.content ?? ""}`;
      const latestTool = snap.recent_tools[0];
      prevToolKey = latestTool ? `${latestTool.tool}|${latestTool.status}|${latestTool.updated_at}` : "";
      const latestMsg = snap.recent_messages[0];
      prevMsgId = latestMsg?.message_id ?? "";

      const label = snap.task_id ?? snap.session_id ?? args.target ?? "target";
      const model =
        snap.model_info.provider_id && snap.model_info.model_id
          ? `${snap.model_info.provider_id}/${snap.model_info.model_id}`
          : snap.model_info.model_id ?? "default";
      const hb = args.heartbeatSec > 0 ? `${args.heartbeatSec}s` : "off";
      emit(
        `[wait] target=${label} state=${snap.effective_state} model=${model} ${formatLiveness(snap)} heartbeat=${hb}${todoText ? ` | ${todoText}` : ""}`,
      );
      if (latestTool) emit(formatToolSummary(latestTool));
    },

    onTick(snap: InspectSessionResult): void {
      let emitted = false;

      if (snap.effective_state !== prevState || snap.session_id !== prevSessionId) {
        const sessTag = snap.session_id ? ` session=${snap.session_id}` : "";
        emit(`[state] ${prevState || "-"} -> ${snap.effective_state}${sessTag} (${formatLiveness(snap)})`);
        prevState = snap.effective_state;
        prevSessionId = snap.session_id;
        emitted = true;
      }

      const activeTodo = snap.todos.find((t) => t.status === "in_progress")?.content ?? "";
      const todoKey = `${snap.todo_summary.completed}/${snap.todo_summary.total}|${activeTodo}`;
      if (todoKey !== prevTodoKey && snap.todo_summary.total > 0) {
        emit(`[todo] ${describeActiveTodo(snap)}`);
        prevTodoKey = todoKey;
        emitted = true;
      }

      const latestTool = snap.recent_tools[0];
      const toolKey = latestTool ? `${latestTool.tool}|${latestTool.status}|${latestTool.updated_at}` : "";
      if (latestTool && toolKey !== prevToolKey) {
        emit(formatToolSummary(latestTool));
        prevToolKey = toolKey;
        emitted = true;
      }

      const latestMsg = snap.recent_messages[0];
      if (latestMsg && latestMsg.message_id !== prevMsgId) {
        emit(`[assistant] ${singleLine(latestMsg.text, 120)}`);
        prevMsgId = latestMsg.message_id;
        emitted = true;
      }

      if (!emitted && heartbeatMs > 0 && Date.now() - lastEmitAt >= heartbeatMs) {
        const idleSec = computeIdleSeconds(snap);
        const liveness = formatLiveness(snap);
        const todoBit = snap.todo_summary.total > 0 ? ` | todos ${snap.todo_summary.completed}/${snap.todo_summary.total}` : "";
        const toolBit = latestTool ? ` | last=${latestTool.tool}(${latestTool.status ?? "unknown"})` : "";
        const procDown = snap.task && (!snap.task.worker_alive || (snap.task.app_server_pid !== null && !snap.task.app_server_alive));
        const warnLabel = idleWarnSec >= 60 ? `${Math.floor(idleWarnSec / 60)}m` : `${idleWarnSec}s`;
        const warnTag = procDown
          ? " [WARN process]"
          : idleWarnSec > 0 && idleSec >= idleWarnSec
            ? ` [WARN idle >= ${warnLabel}]`
            : "";
        emit(`[alive] ${liveness} | elapsed ${formatDurationCompact(Date.now() - startTimeMs)} | idle ${idleSec}s${todoBit}${toolBit}${warnTag}`);
      }
    },

    onFinish(outcome: WaitOutcome): void {
      const detail = singleLine(outcome.snapshot.report?.summary ?? outcome.snapshot.diagnosis, 140);
      emit(`[done] reason=${outcome.reason} exit=${outcome.exitCode} elapsed=${formatDurationCompact(outcome.waited_ms)}${detail ? ` | ${detail}` : ""}`);
    },
  };
}

export async function waitForCompletion(
  observer: ZCodeObserver,
  args: WaitCliArgs,
  options: WaitExecutionOptions = {},
): Promise<WaitOutcome> {
  const start = Date.now();
  const timeoutMs = args.timeoutSec * 1000;
  const deadline = start + timeoutMs;
  const idleWarnSec = options.idleWarnSec ?? DEFAULT_IDLE_WARN_SEC;
  const logger = !args.quiet && options.onLog ? createProgressTracker(args, options.onLog, idleWarnSec, start) : null;

  let snap = await inspectTarget(observer, args);
  if (!snap.found) {
    return { exitCode: 2, reason: "not_found", waited_ms: Date.now() - start, snapshot: snap };
  }

  logger?.onInitial(snap);

  while (ACTIVE_WAIT_STATES.has(snap.effective_state)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const timeoutOutcome: WaitOutcome = {
        exitCode: 124,
        reason: "timeout",
        waited_ms: Date.now() - start,
        snapshot: snap,
      };
      logger?.onFinish(timeoutOutcome);
      return timeoutOutcome;
    }
    await new Promise((r) => setTimeout(r, Math.min(args.intervalMs, remaining)));
    snap = await inspectTarget(observer, args);
    if (!snap.found) {
      const missingOutcome: WaitOutcome = {
        exitCode: 2,
        reason: "not_found",
        waited_ms: Date.now() - start,
        snapshot: snap,
      };
      logger?.onFinish(missingOutcome);
      return missingOutcome;
    }
    if (ACTIVE_WAIT_STATES.has(snap.effective_state)) {
      logger?.onTick(snap);
    }
  }

  const outcome: WaitOutcome = {
    exitCode: 0,
    reason: snap.effective_state,
    waited_ms: Date.now() - start,
    snapshot: snap,
  };
  logger?.onFinish(outcome);
  return outcome;
}

async function sendDesktopNotificationSafe(outcome: WaitOutcome): Promise<void> {
  const label = outcome.snapshot.task_id ?? outcome.snapshot.session_id ?? "ZCode Task";
  const title = `zcode-worker-mcp: ${label} (${outcome.reason})`;
  const body = (
    outcome.snapshot.report?.summary ??
    outcome.snapshot.diagnosis ??
    `State: ${outcome.snapshot.effective_state}`
  ).slice(0, 240);

  try {
    if (process.platform === "win32") {
      const psScript = [
        "$t = [System.Security.SecurityElement]::Escape($env:ZWM_NOTIFY_TITLE);",
        "$b = [System.Security.SecurityElement]::Escape($env:ZWM_NOTIFY_BODY);",
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;",
        '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;',
        '$xml.LoadXml("<toast><visual><binding template=`"ToastText02`"><text id=`"1`">$t</text><text id=`"2`">$b</text></binding></visual></toast>");',
        "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('zcode-worker-mcp');",
        "$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml));",
      ].join(" ");
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        {
          timeout: 3000,
          windowsHide: true,
          env: { ...process.env, ZWM_NOTIFY_TITLE: title, ZWM_NOTIFY_BODY: body },
        },
      );
    } else if (process.platform === "darwin") {
      await execFileAsync(
        "osascript",
        ["-e", "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run", title, body],
        { timeout: 3000 },
      );
    } else {
      await execFileAsync("notify-send", [title, body], { timeout: 3000 });
    }
  } catch {
    // Desktop toast is best-effort; never mask task outcome.
  }
}

export async function runWaitCli(argv: string[]): Promise<number> {
  let args: WaitCliArgs;
  try {
    args = parseWaitArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (args.help) {
    process.stdout.write(`${WAIT_HELP_TEXT}\n`);
    return 0;
  }

  const dataRoot = resolveDataRoot();
  const stateDb = new StateDb(dataRoot);
  let outcome: WaitOutcome;
  try {
    const observer = new ZCodeObserver(stateDb);
    outcome = await waitForCompletion(observer, args, {
      onLog: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    stateDb.close();
  }

  if (args.notify && outcome.exitCode === 0) {
    await sendDesktopNotificationSafe(outcome);
  }

  const payload = {
    ok: outcome.exitCode === 0,
    reason: outcome.reason,
    waited_ms: outcome.waited_ms,
    ...outcome.snapshot,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return outcome.exitCode;
}
