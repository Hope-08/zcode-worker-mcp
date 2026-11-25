import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { CHARACTER_LIMIT, ZCodeObserver } from "../observer/zcode-observer.js";
import { getProcessStartTicks } from "../runtime/process-identity.js";
import type { TaskPackageInput } from "../types.js";
import { StateDb } from "./state-db.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zcode-worker-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function sampleInput(overrides: Partial<TaskPackageInput> = {}): TaskPackageInput {
  return {
    task_id: "task-1",
    workspace: "D:/repo",
    mode: "yolo",
    objective: "Implement feature",
    requirements: [],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    test_commands: [],
    ...overrides,
  };
}

describe("StateDb and ZCodeObserver", () => {
  it("enforces normalized execution directory exclusivity while reconciling dead workers", async () => {
    const dataRoot = makeTempDir();
    const db = new StateDb(dataRoot);
    try {
      await db.createTask(sampleInput({ task_id: "t1", workspace: "D:/MyRepo/app" }), "prompt-1");

      await assert.rejects(
        () => db.createTask(sampleInput({ task_id: "t2", workspace: "d:\\myrepo\\app\\" }), "prompt-2"),
        /WORKSPACE_BUSY/,
      );

      db.markWorkerStarted("t1", 999_999_999, "123456");
      const t2 = await db.createTask(sampleInput({ task_id: "t2", workspace: "d:\\myrepo\\app" }), "prompt-2");
      assert.equal(t2.status, "queued");
      const t1After = db.getTask("t1");
      assert.equal(t1After?.status, "failed");
      assert.equal(t1After?.error_code, "worker_exited_unexpectedly");
    } finally {
      db.close();
    }
  });

  it("handles continue idempotency and interaction reply lifecycle", async () => {
    const dataRoot = makeTempDir();
    const db = new StateDb(dataRoot);
    try {
      await db.createTask(sampleInput({ task_id: "t-cont", workspace: "D:/RepoA" }), "p1");
      const myTicks = await getProcessStartTicks(process.pid);
      db.markWorkerStarted("t-cont", process.pid, myTicks);
      db.updateRuntimeIdentity("t-cont", { sessionId: "sess_test_1", providerId: "p1", modelId: "m1" });

      db.createInteraction("req-1", "t-cont", "interaction/requestPermission", { command: "npm test" });
      assert.equal(db.getTask("t-cont")?.status, "waiting_input");

      const observer = new ZCodeObserver(db);
      const inspected = await observer.inspectSession({ task_id: "t-cont" });
      assert.equal(inspected.found, true);
      assert.equal(inspected.effective_state, "waiting_input");
      assert.equal(inspected.pending_interactions.length, 1);

      const replied = db.replyInteraction("req-1", { decision: "allow" });
      assert.equal(replied.status, "replied");
      assert.throws(() => db.replyInteraction("req-1", { decision: "allow" }), /INTERACTION_NOT_PENDING/);

      db.finishCompleted("t-cont", { resultText: "All done", report: null, usage: null });

      const c1 = await db.prepareContinue({
        taskId: "t-cont",
        promptText: "p2",
        operationId: "op-1",
        modelId: "m2",
      });
      assert.equal(c1.deduplicated, false);
      assert.equal(c1.task.attempt, 2);
      assert.equal(c1.task.model_id, "m2");

      const c2 = await db.prepareContinue({
        taskId: "t-cont",
        promptText: "p2-again",
        operationId: "op-1",
      });
      assert.equal(c2.deduplicated, true);
      assert.equal(c2.task.attempt, 2);
    } finally {
      db.close();
    }
  });

  it("applies CHARACTER_LIMIT truncation, pagination, and AbortSignal cancellation cleanly", async () => {
    const dataRoot = makeTempDir();
    const db = new StateDb(dataRoot);
    try {
      const observer = new ZCodeObserver(db);
      const ticks = await getProcessStartTicks(process.pid);

      await db.createTask(sampleInput({ task_id: "t-huge", workspace: "D:/RepoBig" }), "prompt");
      const hugeBody = `${"x".repeat(35_000)}\nEND_TAIL_MARKER`;
      db.finishCompleted("t-huge", { resultText: hugeBody, report: null, usage: null });

      const inspected = await observer.inspectSession({ task_id: "t-huge" });
      assert.equal(inspected.result_truncated, true);
      assert.ok(inspected.result_text?.includes("END_TAIL_MARKER"));
      assert.ok(JSON.stringify({ ok: true, ...inspected }).length <= CHARACTER_LIMIT);

      await db.createTask(sampleInput({ task_id: "t-page-2", workspace: "D:/RepoPage2" }), "prompt");
      db.markWorkerStarted("t-page-2", process.pid, ticks);

      const page1 = await observer.listSessionsPage({ limit: 1, offset: 0 });
      assert.ok(page1.total >= 2);
      assert.equal(page1.count, 1);
      assert.equal(page1.has_more, true);
      assert.equal(page1.next_offset, 1);

      const page2 = await observer.listSessionsPage({ limit: 1, offset: 1 });
      assert.equal(page2.count, 1);
      assert.equal(page2.offset, 1);
      assert.notEqual(page2.sessions[0]?.task_id, page1.sessions[0]?.task_id);

      const ac = new AbortController();
      setTimeout(() => ac.abort(), 80);
      const watched = await observer.watchSession({
        task_id: "t-page-2",
        wait_seconds: 15,
        interval_ms: 1000,
        signal: ac.signal,
      });
      assert.ok(watched.waited_ms < 2000, `Expected early abort, waited ${watched.waited_ms}ms`);
    } finally {
      db.close();
    }
  });
});
