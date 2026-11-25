export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export type ZCodeMode = "yolo" | "build" | "edit" | "plan" | "guarded";

export interface ModelSelection {
  provider_id?: string;
  model_id: string;
  reasoning_level?: string;
}

export interface TaskPackageInput {
  task_id: string;
  workspace: string;
  worktree_path?: string;
  mode: ZCodeMode;
  model?: ModelSelection;
  resume_session_id?: string;
  objective: string;
  requirements: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: string[];
  test_commands: string[];
  context?: string;
  context_files?: string[];
  timeout_sec?: number;
}

export interface AgentReport {
  summary: string;
  files_changed: string[];
  tests: Array<{
    command: string;
    status: "passed" | "failed" | "not_run";
    details?: string;
  }>;
  issues: string[];
  needs_master_decision: boolean;
}

export interface TaskRecord {
  task_id: string;
  status: TaskStatus;
  workspace: string;
  execution_dir: string;
  normalized_exec_dir: string;
  mode: ZCodeMode;
  provider_id: string | null;
  model_id: string | null;
  reasoning_level: string | null;
  session_id: string | null;
  worker_pid: number | null;
  worker_start_ticks: string | null;
  app_server_pid: number | null;
  app_server_start_ticks: string | null;
  attempt: number;
  last_operation_id: string | null;
  task_json: string;
  prompt_text: string;
  result_text: string | null;
  report_json: string | null;
  usage_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface InteractionRecord {
  request_id: string;
  task_id: string;
  method: string;
  params_json: string;
  status: "pending" | "replied" | "expired";
  reply_json: string | null;
  created_at: string;
  replied_at: string | null;
}

export interface ZCodeRuntimePaths {
  nodeExecutable: string;
  installDir: string;
  zcodeEntrypoint: string;
  builtinConfigFile: string;
  personalConfigFile: string;
  zcodeDataDir: string;
  cliDbPath: string;
  tasksIndexPath: string;
  rgBinary: string | null;
  ugrepBinary: string | null;
  appVersion: string | null;
  buildCommitId: string | null;
}

export interface ModelCatalogEntry {
  provider_id: string;
  model_id: string;
  label: string;
  provider_label?: string;
  context_window?: number;
  max_output_tokens?: number;
  reasoning_levels?: Array<{ value: string; label: string }>;
  reasoning_default_level?: string;
}
