import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ZCodeObserver } from "../observer/zcode-observer.js";
import { getProcessStartTicks } from "../runtime/process-identity.js";
import { StateDb } from "../store/state-db.js";
import type { TaskPackageInput } from "../types.js";
import { parseWaitArgs, waitForCompletion } from "./wait.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zwm-wait-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function sampleInput(taskId: string): TaskPackageInput {
  return {
    task_id: taskId,
    workspace: "D:/repo",
    mode: "yolo",
    objective: "Run check",
    requirements: [],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    test_commands: [],
  };
}

describe("wait CLI", () => {
  it("parses flags and rejects invalid options", () => {
    const basic = parseWaitArgs(["my-task", "--timeout", "120", "--interval", "500", "--notify"]);
    assert.deepEqual(basic, {
      help: false,
      taskId: undefined,
      sessionId: undefined,
      target: "my-task",
      timeoutSec: 120,
      intervalMs: 500,
      notify: true,
    });

    const explicit = parseWaitArgs(["--session", "sess_123", "--toast"]);
    assert.equal(explicit.sessionId, "sess_123");
    assert.equal(explicit.notify, true);

    assert.throws(() => parseWaitArgs([]), /required/);
    assert.throws(() => parseWaitArgs(["t1", "--timeout", "0"]), /--timeout/);
    assert.throws(() => parseWaitArgs(["t1", "--unknown"]), /Unknown option/);
  });

  it("returns exitCode 2 for missing targets and 0 immediately for completed/waiting_input", async () => {
    const db = new StateDb(makeTempDir());
    try {
      const observer = new ZCodeObserver(db);
      const missing = await waitForCompletion(observer, {
        help: false,
        target: "no-such-task",
        timeoutSec: 1,
        intervalMs: 200,
        notify: false,
      });
      assert.equal(missing.exitCode, 2);
      assert.equal(missing.reason, "not_found");

      await db.createTask(sampleInput("t-done"), "prompt");
      db.finishCompleted("t-done", { resultText: "ok", report: null, usage: null });

      const done = await waitForCompletion(observer, {
        help: false,
        target: "t-done",
        timeoutSec: 5,
        intervalMs: 200,
        notify: false,
      });
      assert.equal(done.exitCode, 0);
      assert.equal(done.reason, "completed");
      assert.equal(done.snapshot.result_text, "ok");

      const ticks = await getProcessStartTicks(process.pid);
      await db.createTask(sampleInput("t-wait-input"), "prompt2");
      db.markWorkerStarted("t-wait-input", process.pid, ticks);
      db.updateRuntimeIdentity("t-wait-input", { sessionId: "sess_wait_1" });
      db.createInteraction("req-w1", "t-wait-input", "interaction/requestPermission", { command: "rm" });

      // Wait by session_id positionally to confirm fallback matching
      const paused = await waitForCompletion(observer, {
        help: false,
        target: "sess_wait_1",
        timeoutSec: 5,
        intervalMs: 200,
        notify: false,
      });
      assert.equal(paused.exitCode, 0);
      assert.equal(paused.reason, "waiting_input");
      assert.equal(paused.snapshot.task_id, "t-wait-input");
    } finally {
      db.close();
    }
  });

  it("wakes on async completion and returns 124 on timeout while still running", async () => {
    const db = new StateDb(makeTempDir());
    try {
      const ticks = await getProcessStartTicks(process.pid);
      const observer = new ZCodeObserver(db);

      await db.createTask(sampleInput("t-async"), "prompt");
      db.markWorkerStarted("t-async", process.pid, ticks);

      setTimeout(() => {
        db.finishCompleted("t-async", { resultText: "async-done", report: null, usage: null });
      }, 150);

      const woke = await waitForCompletion(observer, {
        help: false,
        target: "t-async",
        timeoutSec: 3,
        intervalMs: 50,
        notify: false,
      });
      assert.equal(woke.exitCode, 0);
      assert.equal(woke.reason, "completed");
      assert.equal(woke.snapshot.result_text, "async-done");

      await db.createTask(sampleInput("t-slow"), "prompt2");
      db.markWorkerStarted("t-slow", process.pid, ticks);
      const timedOut = await waitForCompletion(observer, {
        help: false,
        target: "t-slow",
        timeoutSec: 0.15,
        intervalMs: 50,
        notify: false,
      });
      assert.equal(timedOut.exitCode, 124);
      assert.equal(timedOut.reason, "timeout");
      assert.equal(timedOut.snapshot.effective_state, "running_active");
    } finally {
      db.close();
    }
  });
});
