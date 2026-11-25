import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContinuePrompt, buildTaskPrompt, extractAgentReport } from "./task-prompt.js";
import type { TaskPackageInput, TaskRecord } from "../types.js";

describe("task-prompt", () => {
  it("buildTaskPrompt formats full structured contract", () => {
    const input: TaskPackageInput = {
      task_id: "p4-demo",
      workspace: "D:/repo",
      worktree_path: "D:/repo-wt",
      mode: "yolo",
      model: { provider_id: "new-provider", model_id: "deepseek-v4.1-flash:1017", reasoning_level: "max" },
      objective: "Refactor check service",
      requirements: ["Remove check_status", "Keep tests green"],
      allowed_paths: ["apps/backend/agent-ebom"],
      forbidden_paths: ["apps/web"],
      acceptance_criteria: ["No check_status references remain"],
      test_commands: ["./gradlew :agent-ebom:test"],
      context: "Existing P3 already committed",
      context_files: ["docs/plan.md"],
    };

    const prompt = buildTaskPrompt(input);
    assert.match(prompt, /TASK ID: p4-demo/);
    assert.match(prompt, /EXECUTION WORKTREE: D:\/repo-wt/);
    assert.match(prompt, /- Remove check_status/);
    assert.match(prompt, /FORBIDDEN PATHS[\s\S]*- apps\/web/);
    assert.match(prompt, /REFERENCE FILES[\s\S]*- docs\/plan\.md/);
    assert.match(prompt, /FINAL REPORT FORMAT/);
  });

  it("buildContinuePrompt includes attempt, session_id and feedback", () => {
    const task = {
      task_id: "p4-demo",
      attempt: 2,
      execution_dir: "D:/repo",
      session_id: "sess_abc",
    } as TaskRecord;

    const prompt = buildContinuePrompt(task, "Fix remaining lint error", ["Run checkstyle"]);
    assert.match(prompt, /TASK ID: p4-demo \(ATTEMPT 2\)/);
    assert.match(prompt, /session sess_abc/);
    assert.match(prompt, /Fix remaining lint error/);
    assert.match(prompt, /- Run checkstyle/);
  });

  it("extractAgentReport tolerates prose and fenced json blocks", () => {
    const text = [
      "I finished the edits and ran the tests.",
      "Ignore earlier debug object: {\"foo\": 123}",
      "```json",
      JSON.stringify({
        summary: "Completed P4 refactor",
        files_changed: ["src/A.java", "src/B.java"],
        tests: [{ command: "gradle test", status: "passed" }],
        issues: [],
        needs_master_decision: false,
      }),
      "```",
    ].join("\n\n");

    const report = extractAgentReport(text);
    assert.ok(report);
    assert.equal(report.summary, "Completed P4 refactor");
    assert.deepEqual(report.files_changed, ["src/A.java", "src/B.java"]);
    assert.equal(report.tests[0]?.status, "passed");
    assert.equal(report.needs_master_decision, false);
  });

  it("extractAgentReport handles raw JSON without fences and returns null for invalid payloads", () => {
    const raw =
      'Done. {"summary":"ok","files_changed":[],"tests":[],"issues":["minor"],"needs_master_decision":true}';
    const report = extractAgentReport(raw);
    assert.ok(report);
    assert.equal(report.summary, "ok");
    assert.equal(report.needs_master_decision, true);

    assert.equal(extractAgentReport("plain response without json"), null);
    assert.equal(extractAgentReport("{\"not_a_summary\": true}"), null);
  });
});
