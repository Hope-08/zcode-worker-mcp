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
  it("parses flags with new defaults and rejects invalid options", () => {
    const defaults = parseWaitArgs(["my-task"]);
    assert.deepEqual(defaults, {
      help: false,
      taskId: undefined,
      sessionId: undefined,
      target: "my-task",
      timeoutSec: 3600,
      intervalMs: 1000,
      heartbeatSec: 60,
      quiet: false,
      notify: true,
    });

    const configured = parseWaitArgs([
      "--session",
      "sess_123",
      "--timeout",
      "120",
      "--interval",
      "500",
      "--heartbeat",
      "30",
      "--quiet",
      "--no-notify",
    ]);
    assert.equal(configured.sessionId, "sess_123");
    assert.equal(configured.timeoutSec, 120);
    assert.equal(configured.intervalMs, 500);
    assert.equal(configured.heartbeatSec, 30);
    assert.equal(configured.quiet, true);
    assert.equal(configured.notify, false);

    assert.throws(() => parseWaitArgs([]), /required/);
    assert.throws(() => parseWaitArgs(["t1", "--timeout", "0"]), /--timeout/);
    assert.throws(() => parseWaitArgs(["t1", "--heartbeat", "2"]), /--heartbeat/);
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
        heartbeatSec: 60,
        quiet: true,
        notify: false,
      });
      assert.equal(missing.exitCode, 2);
      assert.equal(missing.reason, "not_found");

      await db.createTask(sampleInput("t-done"), "prompt");
      db.finishCompleted("t-done", { resultText: "ok", report: null, usage: null });

      const doneLogs: string[] = [];
      const done = await waitForCompletion(
        observer,
        {
          help: false,
          target: "t-done",
          timeoutSec: 5,
          intervalMs: 200,
          heartbeatSec: 60,
          quiet: false,
          notify: false,
        },
        { onLog: (line) => doneLogs.push(line) },
      );
      assert.equal(done.exitCode, 0);
      assert.equal(done.reason, "completed");
      assert.equal(done.snapshot.result_text, "ok");
      assert.ok(doneLogs.some((l) => l.includes("[wait] target=t-done")));
      assert.ok(doneLogs.some((l) => l.includes("[done] reason=completed")));

      const ticks = await getProcessStartTicks(process.pid);
      await db.createTask(sampleInput("t-wait-input"), "prompt2");
      db.markWorkerStarted("t-wait-input", process.pid, ticks);
      db.updateRuntimeIdentity("t-wait-input", { sessionId: "sess_wait_1" });
      db.createInteraction("req-w1", "t-wait-input", "interaction/requestPermission", { command: "rm" });

      const paused = await waitForCompletion(observer, {
        help: false,
        target: "sess_wait_1",
        timeoutSec: 5,
        intervalMs: 200,
        heartbeatSec: 60,
        quiet: true,
        notify: false,
      });
      assert.equal(paused.exitCode, 0);
      assert.equal(paused.reason, "waiting_input");
      assert.equal(paused.snapshot.task_id, "t-wait-input");
    } finally {
      db.close();
    }
  });

  it("streams state transitions, heartbeats with idle warnings, respects quiet mode, and returns 124 on timeout", async () => {
    const db = new StateDb(makeTempDir());
    try {
      const ticks = await getProcessStartTicks(process.pid);
      const observer = new ZCodeObserver(db);

      await db.createTask(sampleInput("t-async"), "prompt");
      setTimeout(() => {
        db.markWorkerStarted("t-async", process.pid, ticks);
      }, 60);
      setTimeout(() => {
        db.finishCompleted("t-async", { resultText: "async-done", report: null, usage: null });
      }, 180);

      const streamLogs: string[] = [];
      const woke = await waitForCompletion(
        observer,
        {
          help: false,
          target: "t-async",
          timeoutSec: 3,
          intervalMs: 40,
          heartbeatSec: 60,
          quiet: false,
          notify: false,
        },
        { onLog: (line) => streamLogs.push(line) },
      );
      assert.equal(woke.exitCode, 0);
      assert.equal(woke.reason, "completed");
      assert.ok(streamLogs.some((l) => l.includes("[wait] target=t-async state=queued")));
      assert.ok(streamLogs.some((l) => l.includes("[state] queued -> running_active")));
      assert.ok(streamLogs.some((l) => l.includes("[done] reason=completed")));

      await db.createTask(sampleInput("t-heartbeat"), "prompt2");
      db.markWorkerStarted("t-heartbeat", process.pid, ticks);
      const hbLogs: string[] = [];
      const timedOut = await waitForCompletion(
        observer,
        {
          help: false,
          target: "t-heartbeat",
          timeoutSec: 2.2,
          intervalMs: 150,
          heartbeatSec: 0.2,
          quiet: false,
          notify: false,
        },
        { onLog: (line) => hbLogs.push(line), idleWarnSec: 1 },
      );
      assert.equal(timedOut.exitCode, 124);
      assert.equal(timedOut.reason, "timeout");
      assert.ok(hbLogs.some((l) => l.includes("[alive]") && l.includes("[WARN idle >= 1s]")), hbLogs.join("\n"));

      const quietLogs: string[] = [];
      const quietRes = await waitForCompletion(
        observer,
        {
          help: false,
          target: "t-heartbeat",
          timeoutSec: 0.08,
          intervalMs: 40,
          heartbeatSec: 0.02,
          quiet: true,
          notify: false,
        },
        { onLog: (line) => quietLogs.push(line) },
      );
      assert.equal(quietRes.exitCode, 124);
      assert.equal(quietLogs.length, 0);
    } finally {
      db.close();
    }
  });
});
