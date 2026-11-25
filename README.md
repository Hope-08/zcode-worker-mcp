# zcode-worker-mcp

English | [简体中文](./README.zh-CN.md)

A lightweight, transparent MCP server to delegate coding tasks to local **ZCode** (`zcode` / ZCode Desktop) with **per-task model selection**, **detached worker survival across MCP restarts**, **OS PID start-time verification**, and **unified real-time session observability**.

## Why `zcode-worker-mcp`?

| Capability | Legacy Bridge Setup | `zcode-worker-mcp` |
| --- | --- | --- |
| **Per-task model & reasoning** | Relies on global default or opaque overrides | `zcode_models` probes live ZCode catalog; `zcode_start` / `zcode_continue` sets `model` + `provider_id` + `reasoning_level` scoped to that session (`persistAsWorkspaceLastUsed: false`) |
| **MCP restart / `stdin EOF` survival** | Child worker often dies or becomes orphaned on MCP reload | Workers run detached with logs redirected to disk; reconnecting MCP picks up state cleanly from SQLite |
| **Windows PID reuse safety** | Naive PID tree checks can misidentify recycled PIDs (e.g. `OneDrive`) and deadlock `cancel` | Captures OS process creation ticks (`StartTime.ToUniversalTime().Ticks` / `ps lstart`) and refuses to kill or block on recycled PIDs |
| **Mid-run observability** | Isolated MCP SQLite DB hides ZCode Desktop/CLI sessions and internal progress | Unified observer joins `state.sqlite`, `~/.zcode/cli/db/db.sqlite`, and `~/.zcode/v2/tasks-index.sqlite` |
| **Existing session resume** | Usually starts from scratch or only by bridge task ID | `zcode_start(..., resume_session_id: "sess_...")` can attach directly to an existing Desktop/CLI session |
| **Runtime footprint** | Large monolithic bundled JS + heavy process coordination | Clean TypeScript + `@modelcontextprotocol/server` v2 + Node built-in `node:sqlite` |

## Requirements

- **Node.js `>= 22.18.0`** (tested on Node `24.x`, using built-in `node:sqlite` — zero native C++ addons)
- Local **ZCode Desktop** or ZCode runtime installed and signed in

## Quick Start

### Option 1: Install globally or link from source (recommended, no hardcoded paths)

If installed from npm (or directly from GitHub):

```bash
npm install -g zcode-worker-mcp
# Or before publishing to npm:
# npm install -g github:Hope-08/zcode-worker-mcp
```

Or from a local clone:

```bash
git clone https://github.com/Hope-08/zcode-worker-mcp.git
cd zcode-worker-mcp
npm install
npm run build
npm link
```

Then configure your MCP client with the global binary name (no local path needed):

```json
{
  "mcpServers": {
    "zcode": {
      "command": "zcode-worker-mcp"
    }
  }
}
```

### Option 2: Zero-install via `npx`

```json
{
  "mcpServers": {
    "zcode": {
      "command": "npx",
      "args": ["-y", "zcode-worker-mcp"]
    }
  }
}
```

> **Note (GitHub & Windows):** Before publishing to npm, replace `"zcode-worker-mcp"` with `"github:Hope-08/zcode-worker-mcp"`. On Windows hosts that invoke `spawn()` without `shell: true`, use `"command": "npx.cmd"` (or `"cmd"` with `["/c", "npx", "-y", ...]`) if `"npx"` fails with `ENOENT`/`EINVAL`.

### Option 3: Direct `node` invocation (fastest startup, zero npm wrapper overhead)

```json
{
  "mcpServers": {
    "zcode": {
      "command": "node",
      "args": ["/path/to/zcode-worker-mcp/dist/index.js"]
    }
  }
}
```

#### Claude Code / Codex CLI

```bash
claude mcp add zcode -- zcode-worker-mcp
# or:
claude mcp add zcode -- npx -y zcode-worker-mcp
```

Optional environment variables:

- `ZCODE_WORKER_MCP_DATA_DIR`: Override state DB and worker log directory (defaults to `~/.zcode-worker-mcp`).
- `ZCODE_HOME` / `ZCODE_DATA_BASE_DIR`: Override where ZCode's `cli/db/db.sqlite` and `v2/tasks-index.sqlite` live if customized.
- `ZCODE_INSTALL_DIR` / `ZCODE_WINDOWS_APP_INSTALL_DIR`: Override the ZCode desktop installation root if installed in a non-standard directory.

## MCP Tools (9 Total)

### Discovery & Environment

| Tool | Description |
| --- | --- |
| `zcode_doctor` | Inspect ZCode installation paths, SQLite stores, node runtime, and active workers (automatically reconciles dead workers; never exposes API keys). |
| `zcode_models` | Probe ZCode's `app-server` (via a deferred ephemeral session) and return the active model plus all available `provider_id`, `model_id`, and `reasoning_levels`. |

### Task Execution & Control

| Tool | Description |
| --- | --- |
| `zcode_start` | Start a structured task in a detached worker, optionally specifying `mode`, `model` (`{ provider_id?, model_id, reasoning_level? }`), `worktree_path`, and `resume_session_id`. Enforces one active task per normalized execution directory. |
| `zcode_continue` | Resume a finished or failed managed task on its bound ZCode `session_id` with follow-up feedback, extra requirements, or an updated `model` / `mode`. Supports `operation_id` idempotency. |
| `zcode_reply` | Respond to a `waiting_input` permission prompt (`decision: "allow" \| "deny"`), plan approval (`approve_plan`), or user-input form (`answers`). |
| `zcode_cancel` | Safely terminate verified `app-server` and `worker` process trees (guarding against OS PID reuse) and release the workspace lock. |

### Unified Observability

| Tool | Description |
| --- | --- |
| `zcode_list_sessions` | List paginated sessions (`limit`/`offset`, `total`, `has_more`, `next_offset`) across `zcode-worker-mcp`, ZCode Desktop, and ZCode CLI with live PID checks, model/mode info, todo counters, and assistant previews. |
| `zcode_inspect_session` | Inspect full live details by **either** `task_id` **or** `session_id`: `effective_state`, `diagnosis`, internal todos, recent tool calls, assistant messages, pending interactions, and parsed JSON report (protected by a 25,000-character response budget). |
| `zcode_watch_session` | Short-poll (<=25s, AbortSignal-aware) a task or session for periodic progress inspection or hosts without background command wakeup. |

## Waiting Modes: Notification-First (`wait`) & Periodic Inspection

After `zcode_start` or `zcode_continue`, two complementary workflows are supported:

1. **Default — Zero-polling completion wakeup (`wait` CLI):**
   Run the local blocker command in the background and end your agent turn so zero LLM polling tokens are burned while ZCode works:

   ```bash
   zcode-worker-mcp wait <task_id_or_session_id> --timeout 3600 [--notify]
   ```

   - Checks SQLite & OS process health quietly without touching `stdout` until the task reaches a terminal state (`completed`, `failed`, `cancelled`, `stalled_or_exited`) or `waiting_input`, then prints a single JSON snapshot and exits `0` (`124` on timeout, `2` if not found).
   - Pass `--notify` (or `--toast`) to also trigger a best-effort OS desktop notification.
2. **Optional — Periodic inspection:**
   Use `zcode_watch_session` / `zcode_inspect_session` (or delegate to a lightweight watcher subagent / schedule) when periodic progress updates are desired or when the MCP client has no background shell wakeup.

Best-practice workflow guidance (worktree isolation, per-task model scoping, `wait`-first notifications, safe interaction replies, and independent post-task verification) is built directly into the MCP server's `instructions` and tool descriptions, so any MCP client gets it out of the box without installing extra skills.

## Architecture Overview

```
MCP Client (Antigravity / Claude Code / Codex)
   ├── stdio JSON-RPC ──► zcode-worker-mcp (McpServer @modelcontextprotocol/server v2 + instructions)
   │     ├── Read-only Observability ──► ~/.zcode/cli/db/db.sqlite + v2/tasks-index.sqlite + state.sqlite
   │     ├── Model Probe ──────────────► zcode.cjs app-server (persistence: "deferred")
   │     └── Task Dispatch / Cancel ───► detached node dist/worker.js <dataRoot> <taskId>
   │                                            ├── survives MCP server restart / EOF
   │                                            ├── stores state & interactions in state.sqlite (WAL)
   │                                            └── drives zcode.cjs app-server (--surface desktop)
   └── background wait ─► zcode-worker-mcp wait <task_id> [--notify]  (0 LLM polling, exits on done/waiting_input)
```

## Development

```bash
npm run typecheck   # TypeScript strict check
npm run build       # Compile src/ -> dist/
npm test            # Build + run node --test suite
```

## License

MIT — see [LICENSE](./LICENSE).
