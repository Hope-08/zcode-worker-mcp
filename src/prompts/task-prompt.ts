import type { AgentReport, TaskPackageInput, TaskRecord } from "../types.js";

function renderSection(title: string, items: string[], emptyLabel: string): string {
  if (items.length === 0) return `${title}\n- ${emptyLabel}`;
  return `${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

export function buildTaskPrompt(input: TaskPackageInput): string {
  const execDir = input.worktree_path || input.workspace;
  const sections: string[] = [
    `TASK ID: ${input.task_id}`,
    "You are an autonomous coding worker executing one complete task inside the target working directory. Implement all required changes, run applicable checks, and verify results before finishing.",
    `PROJECT WORKSPACE: ${input.workspace}`,
    ...(input.worktree_path ? [`EXECUTION WORKTREE: ${execDir} (apply edits here, not in another worktree)`] : []),
    `OBJECTIVE\n${input.objective}`,
    renderSection("REQUIREMENTS", input.requirements, "(none)"),
    renderSection("ALLOWED PATHS (modify only inside these when specified)", input.allowed_paths, "(unspecified; keep edits strictly inside the workspace)"),
    renderSection("FORBIDDEN PATHS (never create, modify, or delete)", input.forbidden_paths, "(none)"),
    renderSection("ACCEPTANCE CRITERIA (verified independently by the caller)", input.acceptance_criteria, "(none)"),
    renderSection("TEST COMMANDS (run applicable commands and report actual results)", input.test_commands, "(none)"),
  ];

  if (input.context_files && input.context_files.length > 0) {
    sections.push(renderSection("REFERENCE FILES (read these first)", input.context_files, "(none)"));
  }
  if (input.context && input.context.trim()) {
    sections.push(`CONTEXT\n${input.context.trim()}`);
  }
  sections.push(REPORT_GUIDANCE);
  return sections.join("\n\n");
}

export function buildContinuePrompt(
  task: TaskRecord,
  feedback: string,
  additionalRequirements: string[],
): string {
  const sections: string[] = [
    `TASK ID: ${task.task_id} (ATTEMPT ${task.attempt})`,
    `Continue working in ${task.execution_dir} (session ${task.session_id ?? "resumed"}). Do not revert completed valid work unless explicitly requested below.`,
    `FOLLOW-UP FEEDBACK\n${feedback.trim()}`,
  ];
  if (additionalRequirements.length > 0) {
    sections.push(renderSection("ADDITIONAL REQUIREMENTS", additionalRequirements, "(none)"));
  }
  sections.push(REPORT_GUIDANCE);
  return sections.join("\n\n");
}

const REPORT_GUIDANCE = [
  "FINAL REPORT FORMAT",
  "At the very end of your final message, include a JSON summary block (fenced ```json ... ``` or raw JSON object) with these keys:",
  '{"summary":"concise summary of changes","files_changed":["relative/path"],"tests":[{"command":"cmd","status":"passed|failed|not_run","details":"optional"}],"issues":["any remaining blocker or assumption"],"needs_master_decision":false}',
  "Report only commands you actually ran; never claim unrun checks passed.",
].join("\n");

/**
 * Tolerantly extracts the last valid AgentReport JSON object from ZCode's response text.
 * Unlike rigid raw-JSON parsers, markdown code fences or prose before the JSON do NOT fail the task.
 */
export function extractAgentReport(responseText: string): AgentReport | null {
  if (!responseText.trim()) return null;
  const candidates: string[] = [];

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of responseText.matchAll(fenceRegex)) {
    if (match[1]) candidates.push(match[1].trim());
  }

  for (let i = responseText.length - 1; i >= 0; i -= 1) {
    if (responseText[i] !== "{") continue;
    const slice = extractBalancedJsonObject(responseText, i);
    if (slice) candidates.push(slice);
  }

  for (let idx = candidates.length - 1; idx >= 0; idx -= 1) {
    const raw = candidates[idx];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const report = normalizeReport(parsed);
      if (report) return report;
    } catch {
      // keep scanning earlier candidates
    }
  }
  return null;
}

function extractBalancedJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

function normalizeReport(value: unknown): AgentReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj["summary"] !== "string" || !obj["summary"].trim()) return null;
  if (!Array.isArray(obj["files_changed"])) return null;
  const testsRaw = Array.isArray(obj["tests"]) ? obj["tests"] : [];
  const issuesRaw = Array.isArray(obj["issues"]) ? obj["issues"] : [];
  const needsDecision = obj["needs_master_decision"];
  if (typeof needsDecision !== "boolean") return null;

  const tests: AgentReport["tests"] = [];
  for (const item of testsRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const t = item as Record<string, unknown>;
    if (typeof t["command"] !== "string") continue;
    const st = t["status"];
    if (st !== "passed" && st !== "failed" && st !== "not_run") continue;
    tests.push({
      command: t["command"],
      status: st,
      ...(typeof t["details"] === "string" ? { details: t["details"] } : {}),
    });
  }

  return {
    summary: obj["summary"].trim(),
    files_changed: obj["files_changed"].filter((x): x is string => typeof x === "string"),
    tests,
    issues: issuesRaw.filter((x): x is string => typeof x === "string"),
    needs_master_decision: needsDecision,
  };
}
