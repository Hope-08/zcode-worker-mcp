import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ZCodeObserver, type InspectSessionResult } from "../observer/zcode-observer.js";
import { resolveDataRoot } from "../runtime/zcode-discovery.js";
import { StateDb } from "../store/state-db.js";

const execFileAsync = promisify(execFile);

const ACTIVE_WAIT_STATES = new Set(["queued", "running_active", "running_inactive"]);

export interface WaitCliArgs {
  help: boolean;
  taskId?: string;
  sessionId?: string;
  target?: string;
  timeoutSec: number;
  intervalMs: number;
  notify: boolean;
}

export interface WaitOutcome {
  exitCode: number;
  reason: string;
  waited_ms: number;
  snapshot: InspectSessionResult;
}

export const WAIT_HELP_TEXT = `Usage: zcode-worker-mcp wait <task_id_or_session_id> [options]

Block quietly until a ZCode task/session finishes or pauses for input, then print JSON and exit.

Options:
  --task <task_id>        Target a managed task_id explicitly
  --session <session_id>  Target a ZCode session_id explicitly
  --timeout <seconds>     Max seconds to wait (1..14400, default: 3600)
  --interval <ms>         Local SQLite check interval ms (200..5000, default: 1000)
  --notify, --toast       Send an OS desktop notification when finished
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
  let notify = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--notify" || arg === "--toast") {
      notify = true;
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

  return { help, taskId, sessionId, target, timeoutSec, intervalMs, notify };
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

export async function waitForCompletion(observer: ZCodeObserver, args: WaitCliArgs): Promise<WaitOutcome> {
  const start = Date.now();
  const timeoutMs = args.timeoutSec * 1000;
  const deadline = start + timeoutMs;

  let snap = await inspectTarget(observer, args);
  if (!snap.found) {
    return { exitCode: 2, reason: "not_found", waited_ms: Date.now() - start, snapshot: snap };
  }

  while (ACTIVE_WAIT_STATES.has(snap.effective_state)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { exitCode: 124, reason: "timeout", waited_ms: Date.now() - start, snapshot: snap };
    }
    await new Promise((r) => setTimeout(r, Math.min(args.intervalMs, remaining)));
    snap = await inspectTarget(observer, args);
    if (!snap.found) {
      return { exitCode: 2, reason: "not_found", waited_ms: Date.now() - start, snapshot: snap };
    }
  }

  return {
    exitCode: 0,
    reason: snap.effective_state,
    waited_ms: Date.now() - start,
    snapshot: snap,
  };
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
    outcome = await waitForCompletion(observer, args);
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
