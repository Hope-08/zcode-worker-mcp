# zcode-worker-mcp

[English](./README.md) | 简体中文

一个轻量、透明的 MCP Server，用于把编码与分析任务安全派发给本机 **ZCode**（`zcode` CLI / ZCode Desktop），原生解决**按任务独立指定模型、MCP 重启掉线、Windows PID 复用死锁、跨客户端黑盒失明以及高频轮询空转**五大痛点。

## 为什么做 `zcode-worker-mcp`？

| 能力维度 | 常见桥接方案痛点 | `zcode-worker-mcp` 的做法 |
| --- | --- | --- |
| **按任务指定模型与推理等级** | 只能走全局默认模型，或修改工作区配置导致串台 | `zcode_models` 实时探测可用列表；`zcode_start` / `zcode_continue` 支持为单次会话设置 `provider_id` / `model_id` / `reasoning_level`（`persistAsWorkspaceLastUsed: false`），不影响全局默认 |
| **MCP 重启 / `stdin EOF` 存活** | 客户端重载 MCP 时关闭管道，直接连带杀掉在跑的 Worker | Worker 以 `detached` 方式运行，stdout/stderr 重定向至独立日志文件；MCP 重连后从 SQLite 无缝接回任务状态 |
| **Windows PID 复用防误杀** | 仅靠 PID 树检查，遇到系统复用 PID（如常驻后台进程）会误判甚至导致取消死锁 | 采集操作系统进程创建时间戳（`StartTime.ToUniversalTime().Ticks` / `ps lstart`），识别 PID 复用时不误杀、不阻塞取消并自动清理任务状态 |
| **全端联合实时观测** | MCP 状态库与 ZCode 桌面端/CLI 库隔离，中途进展不可见 | 联合读取本地 `state.sqlite`、`~/.zcode/cli/db/db.sqlite` 与 `~/.zcode/v2/tasks-index.sqlite`，同时支持按 `task_id` 或 `session_id` 反查内部 Todo、工具调用与助手消息 |
| **接力已有桌面/CLI 会话** | 原生桌面会话无法在 MCP 中接管或续跑 | `zcode_start` 支持传入 `resume_session_id: "sess_..."` 直接接管现有 ZCode 会话 |
| **完成唤醒与低占用体积** | 只能反复短轮询烧 Token，且重度打包难审计 | 基于 TypeScript + `@modelcontextprotocol/server` v2 + Node 内置 `node:sqlite`（零 C++ 原生依赖），提供默认 `wait` CLI 完成阻塞唤醒 |

## 环境要求

- **Node.js `>= 22.18.0`**（已在 Node `24.x` 验证，直接使用内置 `node:sqlite`，无需额外原生编译）
- 本机已安装并登录 **ZCode Desktop** 或 ZCode CLI

## 快速开始

### 方式一：全局安装或源码链接（推荐，无需硬编码本地路径）

从 npm（或直接从 GitHub）全局安装：

```bash
npm install -g zcode-worker-mcp
# 尚未发布到 npm 前可直接从 GitHub 安装：
# npm install -g github:Hope-08/zcode-worker-mcp
```

或本地克隆编译并链接全局命令：

```bash
git clone https://github.com/Hope-08/zcode-worker-mcp.git
cd zcode-worker-mcp
npm install
npm run build
npm link
```

接着在 MCP 客户端配置中直接填写命令名即可（无需写死绝对路径）：

```json
{
  "mcpServers": {
    "zcode": {
      "command": "zcode-worker-mcp"
    }
  }
}
```

### 方式二：通过 `npx` 免安装运行

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

> **提示（GitHub 与 Windows 兼容性）：** 若包尚未发往 npm，可将 `"zcode-worker-mcp"` 替换为 `"github:Hope-08/zcode-worker-mcp"`。对于部分直接调用无 `shell` `spawn()` 的 Windows MCP 客户端，若报 `ENOENT`/`EINVAL`，请将 `"command"` 改为 `"npx.cmd"`（或使用 `"cmd"` + `["/c", "npx", "-y", ...]`）。

### 方式三：直接用 `node` 启动（冷启动最快，零 npm 包装开销）

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

#### Claude Code / Codex CLI 一键接入

```bash
claude mcp add zcode -- zcode-worker-mcp
# 或：
claude mcp add zcode -- npx -y zcode-worker-mcp
```

可选环境变量：

- `ZCODE_WORKER_MCP_DATA_DIR`：覆盖状态数据库与 Worker 日志存放目录（默认为 `~/.zcode-worker-mcp`）。
- `ZCODE_HOME` / `ZCODE_DATA_BASE_DIR`：若自定义了 ZCode 的 `cli/db/db.sqlite` 与 `v2/tasks-index.sqlite` 目录，可通过此项覆盖。
- `ZCODE_INSTALL_DIR` / `ZCODE_WINDOWS_APP_INSTALL_DIR`：ZCode 安装在非默认路径时用于显式指定安装根目录。

## MCP 工具清单（共 9 个）

全部工具入参均通过 Zod v4 `strictObject` 严格校验未知字段与类型边界，同时返回人类可读文本与 `structuredContent`。

### 环境与模型探测

| 工具名 | 说明 |
| --- | --- |
| `zcode_doctor` | 检查本机 ZCode CLI/桌面端安装路径、SQLite 状态库、Node 运行时与活跃 Worker（自动核销已退出死进程，绝不泄露 API Key）。 |
| `zcode_models` | 通过临时非持久会话探测 ZCode `app-server`，返回当前默认模型及全部可用 `provider_id`、`model_id` 与支持的 `reasoning_levels`。 |

### 任务派发与生命周期控制

| 工具名 | 说明 |
| --- | --- |
| `zcode_start` | 在独立分离 Worker 中启动结构化任务；支持按任务指定 `mode`、`model`（`{ provider_id?, model_id, reasoning_level? }`）、隔离 `worktree_path` 与接力 `resume_session_id`。强制按规范化执行目录互斥锁定。 |
| `zcode_continue` | 沿着已有任务绑定的 `session_id` 发送后续反馈、补充需求或切换 `model` / `mode` 继续执行，支持 `operation_id` 幂等防重放。 |
| `zcode_reply` | 响应处于 `waiting_input` 状态任务的权限确认（`decision: "allow" \| "deny"`）、方案审批（`approve_plan`）或用户输入表单（`answers`）。 |
| `zcode_cancel` | 基于进程创建时间戳核验安全终止 `app-server` 与 `worker` 进程树，防范 Windows PID 复用误杀并释放工作区锁。 |

### 跨端联合实时观测

| 工具名 | 说明 |
| --- | --- |
| `zcode_list_sessions` | 联合分页查询（支持 `limit` / `offset`，返回 `total`、`has_more`、`next_offset`）`zcode-worker-mcp`、ZCode Desktop 与 ZCode CLI 的会话，含实时进程存活检查、模型/模式、Todo 计数与最近助手消息预览。 |
| `zcode_inspect_session` | 通过 **`task_id` 或 `session_id` 任意之一** 获取完整实时状态：`effective_state`、诊断结论、内部 Todo 列表、最近工具调用、最近助手输出、待答复交互与解析后的报告 JSON（内置 25,000 字符响应预算裁剪，超限优先保留尾部结果）。 |
| `zcode_watch_session` | 轻量短轮询（`<= 25s`，响应 `AbortSignal` 取消信号），适合需要定期进度播报或不支持后台命令唤醒的宿主环境。 |

## 等待机制：默认 `wait` 完成唤醒 & 可选巡检

调用 `zcode_start` 或 `zcode_continue` 后支持两种互补的等待方式，核心编排规范已直接内置于 MCP Server 的 `instructions` 中，任何客户端连上即可开箱生效：

1. **默认方案 — 零 LLM 消耗被动唤醒（`wait` CLI）：**
   由宿主后台执行本地等待命令并直接结束当前 Agent 回合，彻底避免轮询消耗 Token：

   ```bash
   zcode-worker-mcp wait <task_id_or_session_id> --timeout 3600 [--notify]
   ```

   - 本地静默检查 SQLite 与进程健康状态；一旦进入终态（`completed`、`failed`、`cancelled`、`stalled_or_exited`）或 `waiting_input`，立即向 stdout 输出单次 JSON 快照并退出 `0`（超时退出码 `124` 而不杀死后台任务，未找到退出码 `2`）。
   - 传入 `--notify`（或 `--toast`）可在任务完结或需要交互时顺带弹出系统桌面提醒。
2. **可选方案 — 定期巡检：**
   当用户明确需要阶段性播报，或运行在不具备后台命令行唤醒能力的客户端时，可通过轻量子 Agent / 定时调度调用 `zcode_watch_session` 与 `zcode_inspect_session`。

## 超时行为说明

- **`wait --timeout` 到点**：仅 `wait` 等待命令退出（退出码 `124`），后台 `worker` 与 ZCode 任务**继续运行**，可再次执行 `wait` 继续等待。
- **`zcode_start` 的 `timeout_sec` 到点**（默认 `3600` 秒，范围 `60..14400`）：Worker 触发 `task_timeout` 并关闭 ZCode RPC 连接，状态置为 `failed` 并释放工作区锁；**已修改的工作区文件保留不回滚**，之后仍可直接调用 `zcode_continue` 从同一 `session_id` 断点续跑。

## 架构概览

```
MCP 客户端（Antigravity / Claude Code / Codex / Cursor）
   ├── stdio JSON-RPC ──► zcode-worker-mcp（McpServer v2 + 内置 instructions）
   │     ├── 联合只读观测 ──► ~/.zcode/cli/db/db.sqlite + v2/tasks-index.sqlite + state.sqlite
   │     ├── 模型探测 ──────► zcode.cjs app-server（persistence: "deferred"）
   │     └── 派发 / 取消 ───► 分离进程 node dist/worker.js <dataRoot> <taskId>
   │                              ├── MCP 重启或断连时继续独立运行
   │                              ├── 持久化状态与交互请求到 state.sqlite（WAL）
   │                              └── 驱动 zcode.cjs app-server（--surface desktop）
   └── 后台唤醒等待 ────► zcode-worker-mcp wait <task_id> [--notify]（零 LLM 轮询，完结即退出）
```

## 本地开发与测试

```bash
npm run typecheck   # TypeScript 严格类型检查
npm run build       # 编译 src/ -> dist/
npm test            # 构建并运行全部单元测试与 MCP stdio 协议冒烟测试
```

## 开源协议

MIT — 详见 [LICENSE](./LICENSE)。
