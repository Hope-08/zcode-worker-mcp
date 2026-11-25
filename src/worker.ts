import path from "node:path";
import { extractAgentReport } from "./prompts/task-prompt.js";
import { registerDesktopTaskSafe, updateDesktopTaskStatusSafe, type DesktopIndexSyncEntry } from "./runtime/desktop-index.js";
import { getProcessStartTicks } from "./runtime/process-identity.js";
import { discoverZCodeRuntime } from "./runtime/zcode-discovery.js";
import { extractCatalogFromSnapshot, resolveModelTarget, ZCodeRpcClient } from "./runtime/zcode-rpc.js";
import { StateDb } from "./store/state-db.js";
import type { TaskPackageInput } from "./types.js";

const DEFAULT_TIMEOUT_SEC = 3600;

async function main(): Promise<void> {
  const [, , dataRootArg, taskIdArg] = process.argv;
  if (!dataRootArg || !taskIdArg) {
    console.error("Usage: worker.js <dataRoot> <taskId>");
    process.exit(1);
  }

  const db = new StateDb(dataRootArg);
  const task = db.getTask(taskIdArg);
  if (!task) {
    console.error(`Unknown task: ${taskIdArg}`);
    db.close();
    process.exit(1);
    return;
  }

  const myTicks = await getProcessStartTicks(process.pid);
  db.markWorkerStarted(task.task_id, process.pid, myTicks);

  let client: ZCodeRpcClient | null = null;
  let desktopEntry: DesktopIndexSyncEntry | null = null;
  let settled = false;

  try {
    const runtime = discoverZCodeRuntime();
    const taskInput = JSON.parse(task.task_json) as TaskPackageInput;
    const timeoutMs = Math.max(60, Math.min(14_400, taskInput.timeout_sec ?? DEFAULT_TIMEOUT_SEC)) * 1000;
    const execDir = path.resolve(task.execution_dir);
    const workspaceRoot = path.resolve(task.workspace);

    let resolveTurn!: (payload: { response: string; usage: Record<string, unknown> | null }) => void;
    let rejectTurn!: (err: Error) => void;
    const turnPromise = new Promise<{ response: string; usage: Record<string, unknown> | null }>((res, rej) => {
      resolveTurn = res;
      rejectTurn = rej;
    });

    let activeSessionId = task.session_id;
    let activeTurnId: string | null = null;
    let awaitingTurnStart = false;
    let lastSeq = 0;

    client = await ZCodeRpcClient.spawn(runtime, execDir, {
      onRuntimeIdentity: ({ pid, startTicks }) => {
        db.updateRuntimeIdentity(task.task_id, { appServerPid: pid, appServerStartTicks: startTicks });
      },
      onSessionEvent: (type, payload, raw) => {
        if (settled) return;
        const evSession = typeof raw["sessionId"] === "string" ? raw["sessionId"] : undefined;
        if (evSession && activeSessionId && evSession !== activeSessionId) return;

        const seq = typeof raw["seq"] === "number" ? raw["seq"] : null;
        if (seq !== null) {
          if (seq <= lastSeq) return;
          lastSeq = seq;
        }

        const turnId =
          typeof raw["turnId"] === "string"
            ? raw["turnId"]
            : typeof payload["turnId"] === "string"
              ? payload["turnId"]
              : null;

        if (awaitingTurnStart && type !== "turn.started") return;
        if (activeTurnId && turnId && turnId !== activeTurnId) return;

        if (type === "turn.started") {
          if (turnId) activeTurnId = turnId;
          awaitingTurnStart = false;
        } else if (type === "turn.completed") {
          const response = typeof payload["response"] === "string" ? payload["response"] : "";
          const usage =
            payload["usage"] && typeof payload["usage"] === "object" && !Array.isArray(payload["usage"])
              ? (payload["usage"] as Record<string, unknown>)
              : null;
          resolveTurn({ response, usage });
        } else if (type === "turn.failed") {
          const errObj = (payload["error"] && typeof payload["error"] === "object" ? payload["error"] : {}) as Record<string, unknown>;
          const msg = typeof errObj["message"] === "string" ? errObj["message"] : "ZCode turn failed";
          const code = typeof errObj["code"] === "string" ? errObj["code"] : "zcode_turn_failed";
          rejectTurn(Object.assign(new Error(msg), { code }));
        }
      },
      onInteractionRequest: async (requestId, method, params) => {
        db.createInteraction(requestId, task.task_id, method, params);
        try {
          const reply = await waitForInteractionReply(db, task.task_id, requestId, timeoutMs);
          db.setStatus(task.task_id, "running");
          return reply;
        } catch (err) {
          db.setStatus(task.task_id, "running");
          throw err;
        }
      },
    });

    const snapshot = activeSessionId
      ? await client.request("session/resume", {
          sessionId: activeSessionId,
          workspace: { workspacePath: execDir, workspaceKey: workspaceRoot },
        })
      : await client.request("session/create", {
          workspace: { workspacePath: execDir, workspaceKey: workspaceRoot },
          mode: task.mode,
          persistence: "immediate",
        });

    const snapObj = (snapshot && typeof snapshot === "object" ? snapshot : {}) as Record<string, unknown>;
    const sessObj = (snapObj["session"] && typeof snapObj["session"] === "object" ? snapObj["session"] : {}) as Record<string, unknown>;
    const sessionId = typeof sessObj["sessionId"] === "string" ? sessObj["sessionId"] : activeSessionId;
    if (!sessionId) throw new Error("ZCode app-server did not return session.sessionId");
    activeSessionId = sessionId;
    db.updateRuntimeIdentity(task.task_id, { sessionId });

    if (task.session_id) {
      await client.request("session/setMode", { sessionId, mode: task.mode });
    }

    const catalog = extractCatalogFromSnapshot(snapshot);
    let selectedProvider = catalog.current?.provider_id ?? null;
    let selectedModel = catalog.current?.model_id ?? null;
    let selectedReasoning = catalog.current?.reasoning_level ?? null;

    if (task.model_id) {
      const target = resolveModelTarget(catalog.models, {
        ...(task.provider_id ? { provider_id: task.provider_id } : {}),
        model_id: task.model_id,
        ...(task.reasoning_level ? { reasoning_level: task.reasoning_level } : {}),
      });
      const needsSwitch =
        catalog.current?.provider_id !== target.providerId ||
        catalog.current?.model_id !== target.modelId ||
        (target.reasoningLevel !== undefined && catalog.current?.reasoning_level !== target.reasoningLevel);

      if (needsSwitch) {
        await client.request("session/setModel", {
          sessionId,
          model: {
            providerId: target.providerId,
            modelId: target.modelId,
            ...(target.reasoningLevel ? { options: { reasoningLevel: target.reasoningLevel } } : {}),
          },
          persistAsWorkspaceLastUsed: false,
        });
      }
      selectedProvider = target.providerId;
      selectedModel = target.modelId;
      selectedReasoning = target.reasoningLevel ?? catalog.current?.reasoning_level ?? null;
    }

    db.updateRuntimeIdentity(task.task_id, {
      sessionId,
      providerId: selectedProvider,
      modelId: selectedModel,
      reasoningLevel: selectedReasoning,
    });

    desktopEntry = {
      databasePath: runtime.tasksIndexPath,
      workspaceKey: workspaceRoot,
      workspacePath: execDir,
      sessionId,
      taskId: task.task_id,
      title: task.task_id,
      model: selectedProvider && selectedModel ? `${selectedProvider}/${selectedModel}` : selectedModel,
      provider: "glm",
      mode: task.mode,
    };
    registerDesktopTaskSafe(desktopEntry);

    const runtimeObj = (snapObj["runtime"] && typeof snapObj["runtime"] === "object" ? snapObj["runtime"] : {}) as Record<string, unknown>;
    lastSeq = typeof runtimeObj["eventSeq"] === "number" ? runtimeObj["eventSeq"] : 0;
    awaitingTurnStart = lastSeq > 0;

    await client.request("session/subscribe", {
      sessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
      afterSeq: lastSeq,
    });

    await client.request("session/send", { sessionId, content: task.prompt_text });

    const timeoutTimer = setTimeout(() => {
      rejectTurn(Object.assign(new Error(`Task exceeded timeout (${timeoutMs} ms)`), { code: "task_timeout" }));
    }, timeoutMs);
    timeoutTimer.unref();

    const turnResult = await turnPromise.finally(() => clearTimeout(timeoutTimer));
    settled = true;

    const report = extractAgentReport(turnResult.response);
    db.finishCompleted(task.task_id, {
      resultText: turnResult.response,
      report,
      usage: turnResult.usage,
    });
    if (desktopEntry) updateDesktopTaskStatusSafe(desktopEntry, "completed");
  } catch (err) {
    settled = true;
    const code =
      err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : "worker_failed";
    const msg = err instanceof Error ? err.message : String(err);
    db.finishFailed(task.task_id, code, msg);
    if (desktopEntry) updateDesktopTaskStatusSafe(desktopEntry, "error");
  } finally {
    if (client) await client.close().catch(() => void 0);
    db.close();
  }
}

async function waitForInteractionReply(
  db: StateDb,
  taskId: string,
  requestId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + Math.min(timeoutMs, 1_800_000);
  while (Date.now() < deadline) {
    const task = db.getTask(taskId);
    if (!task || task.status === "cancelled" || task.status === "failed") {
      throw new Error("Task was cancelled or terminated while waiting for reply");
    }
    const rec = db.getInteraction(requestId);
    if (rec?.status === "replied" && rec.reply_json) {
      return JSON.parse(rec.reply_json) as Record<string, unknown>;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for interaction reply on ${requestId}`);
}

void main();
