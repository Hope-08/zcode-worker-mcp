import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "index.js");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zwm-smoke-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

class StdioRpcHarness {
  readonly #child: ReturnType<typeof spawn>;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #nextId = 1;

  constructor(dataRoot: string) {
    this.#child = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, ZCODE_WORKER_MCP_DATA_DIR: dataRoot },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const rl = readline.createInterface({ input: this.#child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id !== undefined && this.#pending.has(msg.id)) {
        const call = this.#pending.get(msg.id)!;
        clearTimeout(call.timer);
        this.#pending.delete(msg.id);
        if (msg.error) call.reject(new Error(JSON.stringify(msg.error)));
        else call.resolve(msg.result);
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, 10_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.#child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<number | null> {
    this.#child.stdin!.end();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2000);
      this.#child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

describe("MCP server stdio protocol smoke check", () => {
  it("initializes, lists 9 tools, serves read-only tools, and rejects invalid arguments", async () => {
    const dataRoot = makeTempDir();
    const rpc = new StdioRpcHarness(dataRoot);
    try {
      const init = (await rpc.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mcp-smoke", version: "1.0.0" },
      })) as { instructions?: string };
      assert.ok(init.instructions && init.instructions.includes("zcode-worker-mcp wait"));
      rpc.notify("notifications/initialized");

      const listRes = (await rpc.request("tools/list")) as { tools: Array<{ name: string }> };
      assert.deepEqual(
        listRes.tools.map((t) => t.name).sort(),
        [
          "zcode_cancel",
          "zcode_continue",
          "zcode_doctor",
          "zcode_inspect_session",
          "zcode_list_sessions",
          "zcode_models",
          "zcode_reply",
          "zcode_start",
          "zcode_watch_session",
        ],
      );

      const doctor = (await rpc.request("tools/call", { name: "zcode_doctor", arguments: {} })) as {
        isError?: boolean;
        structuredContent?: { ok?: boolean; state_db_path?: string };
      };
      assert.ok(!doctor.isError);
      assert.equal(doctor.structuredContent?.ok, true);

      const sessions = (await rpc.request("tools/call", {
        name: "zcode_list_sessions",
        arguments: { limit: 3, offset: 0 },
      })) as {
        isError?: boolean;
        structuredContent?: { total?: number; count?: number; offset?: number; has_more?: boolean; sessions?: unknown[] };
      };
      assert.ok(!sessions.isError);
      assert.equal(typeof sessions.structuredContent?.total, "number");
      assert.equal(typeof sessions.structuredContent?.has_more, "boolean");
      assert.equal(sessions.structuredContent?.offset, 0);

      // Strict schema validation rejects unknown properties
      const extraField = (await rpc.request("tools/call", {
        name: "zcode_start",
        arguments: {
          task_id: "valid-id",
          workspace: dataRoot,
          objective: "Test",
          unknown_param: 123,
        },
      })) as { isError?: boolean };
      assert.equal(extraField.isError, true);

      // Pattern validation rejects spaces in task_id
      const badId = (await rpc.request("tools/call", {
        name: "zcode_start",
        arguments: {
          task_id: "bad id!",
          workspace: dataRoot,
          objective: "Test",
        },
      })) as { isError?: boolean };
      assert.equal(badId.isError, true);

      // Missing target returns actionable error
      const missing = (await rpc.request("tools/call", {
        name: "zcode_inspect_session",
        arguments: { task_id: "nonexistent-task" },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      assert.equal(missing.isError, true);
      assert.match(missing.content[0]!.text, /zcode_list_sessions/);
    } finally {
      const code = await rpc.close();
      assert.equal(code, 0);
    }
  });
});
