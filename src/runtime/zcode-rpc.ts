import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getProcessStartTicks } from "./process-identity.js";
import { buildZCodeChildEnv } from "./zcode-discovery.js";
import type { ModelCatalogEntry, ModelSelection, ZCodeMode, ZCodeRuntimePaths } from "../types.js";

const RPC_TIMEOUT_MS = 45_000;

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ServerMessageHandler {
  onRuntimeIdentity?: (info: { pid: number; startTicks: string | null }) => void;
  onSessionEvent?: (type: string, payload: Record<string, unknown>, raw: Record<string, unknown>) => void;
  onInteractionRequest?: (
    requestId: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

export class ZCodeRpcClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingCall>();
  readonly #runtime: ZCodeRuntimePaths;
  readonly #handlers: ServerMessageHandler;
  #nextId = 1;
  #closed = false;
  #stderrTail = "";

  private constructor(
    child: ChildProcessWithoutNullStreams,
    runtime: ZCodeRuntimePaths,
    handlers: ServerMessageHandler,
  ) {
    this.#child = child;
    this.#runtime = runtime;
    this.#handlers = handlers;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      void this.#dispatch(msg);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-4000);
    });

    child.once("exit", (code, signal) => {
      this.#closed = true;
      for (const [, call] of this.#pending) {
        clearTimeout(call.timer);
        call.reject(
          new Error(
            `ZCode app-server exited before ${call.method} completed (code=${String(code)}, signal=${String(signal)})${this.#stderrTail ? `: ${this.#stderrTail.trim().slice(-300)}` : ""}`,
          ),
        );
      }
      this.#pending.clear();
    });
  }

  static async spawn(
    runtime: ZCodeRuntimePaths,
    cwd: string,
    handlers: ServerMessageHandler = {},
  ): Promise<ZCodeRpcClient> {
    const child = spawn(
      runtime.nodeExecutable,
      [runtime.zcodeEntrypoint, "app-server", "--stdio", "--surface", "desktop"],
      {
        cwd,
        env: buildZCodeChildEnv(runtime),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const client = new ZCodeRpcClient(child, runtime, handlers);
    if (child.pid) {
      const startTicks = await getProcessStartTicks(child.pid);
      handlers.onRuntimeIdentity?.({ pid: child.pid, startTicks });
    }
    return client;
  }

  get pid(): number | null {
    return this.#child.pid ?? null;
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error(`Cannot send ${method}: ZCode app-server is closed.`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC timeout (${RPC_TIMEOUT_MS}ms) waiting for ${method}`));
      }, RPC_TIMEOUT_MS);
      timer.unref();
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#child.stdin.end();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.#child.kill();
        } catch {
          // ignore
        }
        resolve();
      }, 2500);
      timer.unref();
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #write(payload: Record<string, unknown>): void {
    if (!this.#child.stdin.writable) return;
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async #dispatch(msg: Record<string, unknown>): Promise<void> {
    const method = typeof msg["method"] === "string" ? msg["method"] : undefined;
    const id = msg["id"];

    if (method === "session/requestRuntimePreferences") {
      if (typeof id === "string" || typeof id === "number") {
        this.#write({
          id,
          result: {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false,
          },
        });
      }
      return;
    }

    if (method === "interaction/requestProviderRuntimeHeaders") {
      if (typeof id === "string" || typeof id === "number") {
        const params = asRecord(msg["params"]);
        const selection = asRecord(params["modelSelection"]);
        const providerId =
          typeof selection["providerId"] === "string"
            ? selection["providerId"]
            : typeof params["providerId"] === "string"
              ? params["providerId"]
              : "";
        this.#write({ id, result: resolveCodingPlanHeaders(this.#runtime, providerId) });
      }
      return;
    }

    if (method === "interaction/requestPermission" || method === "interaction/requestUserInput") {
      if (typeof id === "string" || typeof id === "number") {
        const params = asRecord(msg["params"]);
        const requestId =
          typeof params["requestId"] === "string" && params["requestId"].trim()
            ? params["requestId"].trim()
            : `rpc-${String(id)}`;
        if (this.#handlers.onInteractionRequest) {
          try {
            const reply = await this.#handlers.onInteractionRequest(requestId, method, params);
            this.#write({ id, result: reply });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.#write({
              id,
              result: method === "interaction/requestPermission"
                ? { decision: "deny", reason }
                : { action: "decline", reason },
            });
          }
        } else {
          this.#write({
            id,
            result: method === "interaction/requestPermission"
              ? { decision: "deny", reason: "No interaction handler available" }
              : { action: "decline", reason: "No interaction handler available" },
          });
        }
      }
      return;
    }

    if (method === "session/event") {
      const params = asRecord(msg["params"]);
      const type = typeof params["type"] === "string" ? params["type"] : "";
      const payload = asRecord(params["payload"]);
      this.#handlers.onSessionEvent?.(type, payload, params);
      return;
    }

    if ((typeof id === "number" || typeof id === "string") && !method) {
      const call = this.#pending.get(Number(id));
      if (!call) return;
      clearTimeout(call.timer);
      this.#pending.delete(Number(id));
      const errObj = msg["error"];
      if (errObj && typeof errObj === "object") {
        const e = errObj as Record<string, unknown>;
        const detail = typeof e["message"] === "string" ? e["message"] : JSON.stringify(e);
        call.reject(new Error(`ZCode RPC ${call.method} failed: ${detail}`));
      } else {
        call.resolve(msg["result"]);
      }
    }
  }
}

export function extractCatalogFromSnapshot(snapshot: unknown): {
  current: { provider_id: string; model_id: string; reasoning_level?: string } | null;
  models: ModelCatalogEntry[];
} {
  const root = asRecord(snapshot);
  const settings = asRecord(root["settings"]);
  const modelSection = asRecord(settings["model"]);
  const currentRaw = asRecord(modelSection["current"]);
  const currentOptions = asRecord(currentRaw["options"]);

  const current =
    typeof currentRaw["providerId"] === "string" && typeof currentRaw["modelId"] === "string"
      ? {
          provider_id: currentRaw["providerId"],
          model_id: currentRaw["modelId"],
          ...(typeof currentOptions["reasoningLevel"] === "string"
            ? { reasoning_level: currentOptions["reasoningLevel"] }
            : {}),
        }
      : null;

  const available = Array.isArray(modelSection["available"]) ? modelSection["available"] : [];
  const models: ModelCatalogEntry[] = [];
  for (const item of available) {
    const rec = asRecord(item);
    const ref = asRecord(rec["ref"]);
    const providerId = typeof ref["providerId"] === "string" ? ref["providerId"] : null;
    const modelId = typeof ref["modelId"] === "string" ? ref["modelId"] : null;
    if (!providerId || !modelId) continue;

    const reasoning = asRecord(rec["reasoning"]);
    const levelsRaw = Array.isArray(reasoning["levels"]) ? reasoning["levels"] : [];
    const levels: Array<{ value: string; label: string }> = [];
    for (const lvl of levelsRaw) {
      const l = asRecord(lvl);
      if (typeof l["value"] === "string") {
        levels.push({
          value: l["value"],
          label: typeof l["label"] === "string" ? l["label"] : l["value"],
        });
      }
    }

    models.push({
      provider_id: providerId,
      model_id: modelId,
      label: typeof rec["label"] === "string" ? rec["label"] : modelId,
      ...(typeof rec["providerLabel"] === "string" ? { provider_label: rec["providerLabel"] } : {}),
      ...(typeof rec["contextWindow"] === "number" ? { context_window: rec["contextWindow"] } : {}),
      ...(typeof rec["maxOutputTokens"] === "number" ? { max_output_tokens: rec["maxOutputTokens"] } : {}),
      ...(levels.length > 0 ? { reasoning_levels: levels } : {}),
      ...(typeof reasoning["defaultLevel"] === "string" ? { reasoning_default_level: reasoning["defaultLevel"] } : {}),
    });
  }

  return { current, models };
}

export async function probeZCodeModels(
  runtime: ZCodeRuntimePaths,
  workspace: string,
  signal?: AbortSignal,
): Promise<{
  current_model: { provider_id: string; model_id: string; reasoning_level?: string } | null;
  models: ModelCatalogEntry[];
}> {
  if (signal?.aborted) {
    throw new Error("Operation aborted by caller.");
  }
  const resolvedWorkspace = path.resolve(workspace);
  const client = await ZCodeRpcClient.spawn(runtime, resolvedWorkspace);
  let sessionId: string | null = null;
  const onAbort = () => {
    void client.close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const snapshot = await client.request("session/create", {
      workspace: { workspacePath: resolvedWorkspace, workspaceKey: resolvedWorkspace },
      mode: "plan",
      persistence: "deferred",
    });
    if (signal?.aborted) {
      throw new Error("Operation aborted by caller.");
    }
    const session = asRecord(asRecord(snapshot)["session"]);
    sessionId = typeof session["sessionId"] === "string" ? session["sessionId"] : null;
    const extracted = extractCatalogFromSnapshot(snapshot);
    return { current_model: extracted.current, models: extracted.models };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (sessionId) {
      await client.request("session/close", { sessionId }).catch(() => void 0);
    }
    await client.close();
  }
}

export function resolveModelTarget(
  available: ModelCatalogEntry[],
  requested: ModelSelection,
): { providerId: string; modelId: string; reasoningLevel?: string } {
  const reqModel = requested.model_id.trim();
  const reqProvider = requested.provider_id?.trim();

  if (reqProvider) {
    const exact = available.find((m) => m.provider_id === reqProvider && m.model_id === reqModel);
    if (!exact && available.length > 0) {
      const availableList = available.map((m) => `${m.provider_id}/${m.model_id}`).join(", ");
      throw new Error(`MODEL_NOT_FOUND: "${reqProvider}/${reqModel}" is not in ZCode's available models: ${availableList}`);
    }
    const level = validateReasoningLevel(exact, requested.reasoning_level);
    return { providerId: reqProvider, modelId: reqModel, ...(level ? { reasoningLevel: level } : {}) };
  }

  let matches = available.filter(
    (m) => m.model_id === reqModel || m.label === reqModel || `${m.provider_id}/${m.model_id}` === reqModel,
  );
  if (matches.length === 0) {
    matches = available.filter(
      (m) => m.model_id.toLowerCase().endsWith(`/${reqModel.toLowerCase()}`),
    );
  }
  if (matches.length === 0) {
    const availableList = available.map((m) => `${m.provider_id}/${m.model_id}`).join(", ");
    throw new Error(`MODEL_NOT_FOUND: model "${reqModel}" was not found. Available: ${availableList}`);
  }
  if (matches.length > 1) {
    const dupList = matches.map((m) => `${m.provider_id}/${m.model_id}`).join(", ");
    throw new Error(`MODEL_AMBIGUOUS: model "${reqModel}" matches multiple providers (${dupList}); please pass provider_id explicitly.`);
  }

  const chosen = matches[0]!;
  const level = validateReasoningLevel(chosen, requested.reasoning_level);
  return {
    providerId: chosen.provider_id,
    modelId: chosen.model_id,
    ...(level ? { reasoningLevel: level } : {}),
  };
}

function validateReasoningLevel(entry: ModelCatalogEntry | undefined, level: string | undefined): string | undefined {
  const trimmed = level?.trim();
  const levels = entry?.reasoning_levels;
  if (!trimmed) {
    // ZCode's session/setModel rejects models that declare reasoning levels when reasoningLevel is omitted.
    return entry?.reasoning_default_level ?? levels?.[0]?.value;
  }
  if (levels && levels.length > 0 && !levels.some((l) => l.value === trimmed)) {
    throw new Error(
      `INVALID_REASONING_LEVEL: "${trimmed}" is not supported by ${entry.model_id}. Supported: ${levels.map((l) => l.value).join(", ")}`,
    );
  }
  return trimmed;
}

export function normalizeModeForZCode(mode: ZCodeMode): string {
  return mode;
}

function resolveCodingPlanHeaders(
  runtime: ZCodeRuntimePaths,
  providerId: string,
): Record<string, unknown> {
  if (!providerId.startsWith("account:")) {
    return { headersApplied: false, errorMessage: "Managed natively by ZCode provider config" };
  }
  try {
    const v2Dir = path.dirname(runtime.personalConfigFile);
    const configPath = path.join(v2Dir, "config.json");
    if (!existsSync(configPath)) {
      return { headersApplied: false, errorMessage: "ZCode v2 config.json not found" };
    }
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { provider?: Record<string, { options?: { apiKey?: unknown } }> };
    const shortKey = providerId.replace(/^account:/, "");
    const apiKey = cfg?.provider?.[shortKey]?.options?.apiKey ?? cfg?.provider?.[providerId]?.options?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim()) {
      return { headersApplied: true, requestAuth: { apiKey: apiKey.trim() } };
    }
  } catch {
    // fall through
  }
  return { headersApplied: false, errorMessage: `No API key available for ${providerId}` };
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === "object" && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}
