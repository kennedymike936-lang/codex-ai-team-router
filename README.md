# Codex AI Team Router

让 Codex 做项目经理和最终审稿人，把大范围搜索、初步分析、重复脚本、测试草稿和部分实现工作交给 Qwen / DeepSeek。

项目通过一个轻量 MCP Router 自动选择副手，并用本地 PowerShell 脚本完成项目侦查、受控执行和验收报告。完整过程保存在磁盘中，Codex 只接收紧凑摘要，避免命令输出和长日志持续撑大主对话上下文。

> 目标不是追求最低 token，而是以合理成本稳定交付 90～95 分的结果；低于质量底线时，Codex 立即接管。

## 工作模式

```mermaid
flowchart LR
    U[用户任务] --> C[Codex\n项目经理 / 架构师]
    C --> R[AI Team MCP Router]
    R -->|文档、整理、宽泛初稿| Q[Qwen]
    R -->|代码、排错、实现思路| D[DeepSeek]
    R -->|复杂交叉任务| B[Qwen + DeepSeek]
    C --> S[Scout\n文件与日志侦查]
    C --> W[Worker\n受控实现]
    S --> A[磁盘完整报告 + 紧凑摘要]
    W --> A
    A --> C
    C --> G[Gate\n构建 / 测试 / 类型 / lint / diff / secrets]
    G --> E{质量决策}
    E -->|90～100| O[接受并交付]
    E -->|80～89 / 首次| W
    E -->|低于 80 / 硬失败 / 已返工| T[Codex 全盘接管]
```

角色划分：

- **Codex**：拆任务、做架构判断、整合结果、最终回复。
- **Qwen**：整理、总结、文档、测试草稿、宽泛第一遍调查。
- **DeepSeek**：代码分析、bug 假设、实现草稿、diff 审查。
- **Scout / Worker / Gate**：本地机械工作，完整记录落盘，只把必要摘要交给 Codex。

## 为什么只保留一个 MCP

为 Qwen 和 DeepSeek 各加载一套 MCP，会让每个 Codex 会话都携带更多工具定义和参数说明。本项目只暴露两个工具：

- `delegate_task`：自动路由任务；`dry_run=true` 时只预览路由，不调用模型。
- `worker_gate_review`：对结构化结果做确定性质量决策，也兼容原有的 diff 轻量审查。

Qwen 和 DeepSeek 仍然是两条独立模型线路，只是通过一个入口调度。

## 主要特性

- 自动路由至 Qwen、DeepSeek 或双轨并行。
- 默认从服务商 `/models` 接口发现账号当前可用模型，并按代际与 `Flash / Plus / Pro` 档位自动选择。
- 模型列表缓存一小时；新一代稳定别名上线后无需修改配置，模型不可用时同服务商最多回退一次。
- `dry_run` 路由预览，不消耗模型 API。
- 三档输出预算：`low`、`normal`、`deep`。
- MCP 返回结果有字符上限，避免异常长回复进入 Codex 上下文。
- Worker 完整输出写入磁盘，默认仅返回最多 30 行 / 3000 字符摘要。
- Scout 专门处理大目录、日志、文件定位和第一遍项目调查。
- Gate 检查构建、测试、类型检查、lint、diff 大小、依赖变化和密钥痕迹。
- 质量策略固定为：90 分以上接受、80～89 分只返工一次、低于 80 分由 Codex 接管。
- 构建/测试失败、密钥痕迹、越界修改等硬故障会跳过返工，立即要求 Codex 接管。
- Worker 和 Gate 都生成 JSON 交接文件，Codex 接手时无需重新扫描整个项目。
- API key 只从环境变量读取，不写入代码或 Codex 配置示例。
- Router 基于 Node.js；本地 worker 脚本面向 Windows PowerShell。

## 自动模型选择

默认 `AI_TEAM_MODEL_MODE=auto`，固定的模型名称不是必填配置。MCP 和 PowerShell Worker 都会先读取账号可见的 `/models` 列表，然后：

| 预算 | Qwen | DeepSeek |
|---|---|---|
| `low` | 最新稳定 `flash` | 最新稳定 `flash` |
| `normal` | 最新稳定 `plus` | 最新稳定 `pro` |
| `deep` | 最新稳定 `plus` | 最新稳定 `pro` |

选择器按模型家族和数字代际判断，不把某个版本号永久写死。例如未来出现 `qwen3.8-plus` 或 `deepseek-v5-flash`，只要它出现在账号可用列表中，就会优先于旧代稳定模型。`preview`、实时、语音、视觉等不适合当前文本/代码 Worker 的变体会被排除。

模型列表接口暂时不可用时，系统才使用内置保底名单；普通认证失败、限流或服务错误不会触发乱换模型。只有明确的“模型不存在/无权限”错误允许同服务商回退一次。

如确实需要锁定模型，可配置：

```toml
[mcp_servers.ai_team_mcp.env]
AI_TEAM_MODEL_MODE = 'fixed'
QWEN_MCP_MODEL = 'your-model-id'
DEEPSEEK_MCP_MODEL = 'your-model-id'
```

内置价格只用于估算，实际账单以服务商和地区为准。默认档位参考 [阿里云百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing) 和 [DeepSeek 官方模型价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)。

## 仓库结构

```text
codex-ai-team-router/
├─ mcp-server/
│  ├─ server.mjs          # Qwen / DeepSeek MCP 总控路由器
│  ├─ quality-policy.mjs  # 确定性质量评分和接管状态机
│  ├─ model-selector.mjs  # 动态模型发现与性价比选择
│  ├─ usage-ledger.mjs    # Token 与费用本地账本
│  ├─ smoke-test.mjs      # 不调用 API 的冒烟测试
│  ├─ quality-policy-test.mjs
│  └─ package.json
├─ scripts/
│  ├─ codex-scout.ps1     # 只读侦查，返回短结论
│  ├─ codex-worker.ps1    # Qwen Code / Claude Code-DeepSeek 执行器
│  ├─ codex-gate.ps1      # 本地验收与交接包生成器
│  └─ codex-gate-test.ps1
├─ examples/
│  ├─ AGENTS.md
│  └─ config.toml.example
├─ benchmark/             # 8 项隔离训练场和隐藏验收
├─ install.ps1
└─ README.md
```

## 前置条件

MCP Router：

- Node.js 20 或更高版本
- npm
- Codex Desktop 或支持本地 MCP server 的 Codex 环境
- 至少配置一个模型 API key

可选 Worker：

- Qwen Code CLI，用于 Qwen agent 模式
- Claude Code CLI，用于通过 Anthropic 兼容接口调用 DeepSeek agent 模式
- Git，用于 diff 与仓库检查
- 项目自身需要的 npm / Python / 编译工具

## 安装

```powershell
git clone https://github.com/kennedymike936-lang/codex-ai-team-router.git
cd codex-ai-team-router
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会：

1. 检查 Node.js 和 npm。
2. 在 `mcp-server` 中安装 MCP SDK。
3. 运行不调用 Qwen / DeepSeek API 的冒烟测试。
4. 输出 Node 和 MCP server 的绝对路径。

## API 环境变量

不要把密钥写入仓库、README、`config.toml` 或 worker prompt。

Qwen 按以下顺序读取：

```text
DASHSCOPE_API_KEY
OPENAI_API_KEY
QWEN_API_KEY
```

DeepSeek 按以下顺序读取：

```text
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
DEEPSEEK_API_KEY
```

Windows 用户级环境变量示例：

```powershell
[Environment]::SetEnvironmentVariable("DASHSCOPE_API_KEY", "YOUR_KEY", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "YOUR_KEY", "User")
```

设置后需要重启 Codex，使桌面进程重新读取环境变量。

## 接入 Codex

打开 `~/.codex/config.toml`，参考 [examples/config.toml.example](examples/config.toml.example) 添加 MCP server。

Windows 示例：

```toml
[mcp_servers.ai_team_mcp]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\absolute\path\codex-ai-team-router\mcp-server\server.mjs']
startup_timeout_sec = 60

[mcp_servers.ai_team_mcp.env]
QWEN_MCP_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
DEEPSEEK_MCP_BASE_URL = 'https://api.deepseek.com/anthropic'
```

不填写模型名即使用自动模式。

用下面的命令查找 Node 绝对路径：

```powershell
(Get-Command node).Source
```

重启 Codex 后，工具列表中应出现：

```text
delegate_task
worker_gate_review
```

## MCP 使用示例

自动路由：

```json
{
  "task": "分析这个 TypeScript 报错并给出最小修复方案",
  "preferred": "auto",
  "budget": "low"
}
```

只看路由，不调用 API：

```json
{
  "task": "整理项目结构并起草 README",
  "preferred": "auto",
  "dry_run": true
}
```

强制双轨：

```json
{
  "task": "比较两种架构并检查代码风险",
  "preferred": "both",
  "budget": "normal"
}
```

确定性质量决策（不调用模型 API）：

```json
{
  "evaluation": {
    "task_id": "login-fix-001",
    "attempt": 1,
    "scores": {
      "functionality": 35,
      "requirements": 20,
      "code_quality": 10,
      "safety": 10,
      "maintainability": 10
    },
    "hard_failures": [],
    "summary": "核心流程已修复，但缺少一个边界测试。",
    "changed_files": ["src/login.ts", "test/login.test.ts"]
  }
}
```

该示例得到 85 分，第一次返回 `retry`；相同任务以 `attempt: 2` 再次得到 85 分时返回 `takeover`。

## 质量优先接管策略

质量分用于表达**交付置信度**，不是宣称可以用数学精确衡量代码。评分满分 100：

| 维度 | 分值 |
|---|---:|
| 核心功能、构建和测试 | 40 |
| 需求完成度 | 25 |
| 类型、lint 和代码质量 | 15 |
| 安全与修改范围 | 10 |
| 可维护性 | 10 |

决策规则：

- `90～100`：接受结果，停止无收益的精雕细琢。
- `80～89`：第一次只修失败项；第二次仍未达到 90 分，由 Codex 接管。
- `< 80`：不继续烧 worker token，Codex 直接接管。
- 任意硬故障：无视分数，立即接管。

硬故障包括构建/测试/类型/lint 失败、疑似密钥、禁止文件、超出允许路径、diff 失控和需求明确失败。接管顺序是先恢复可交付状态，再分析 worker 为什么失手；复盘不能阻塞修复。

## Scout：把大范围调查交给副手

Scout 不修改文件，适合：

- 搜索项目入口和关键模块
- 查找某段功能位于哪些文件
- 阅读大量日志并只返回相关行
- 给陌生项目做第一遍结构调查

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-scout.ps1 `
  -Task "查找登录流程、关键文件和相关测试，只返回路径和关键行" `
  -Cwd "C:\path\to\project" `
  -Worker auto
```

完整结果默认保存在：

```text
%USERPROFILE%\.codex-ai-team\runs
```

Codex 终端只接收紧凑摘要。

## Worker：受控执行任务

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-worker.ps1 `
  -Worker qwen `
  -Task "在 src/utils 中补齐重复的输入校验，并运行已有测试" `
  -Cwd "C:\path\to\project" `
  -TaskId "input-validation-001" `
  -Attempt 1 `
  -AllowedPath @("src/utils", "test") `
  -Budget low `
  -Approval auto `
  -MaxWallTime 8m
```

DeepSeek worker：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-worker.ps1 `
  -Worker deepseek `
  -Task "定位失败测试并提交最小修复" `
  -Cwd "C:\path\to\project" `
  -DeepSeekMaxBudgetUsd 0.10
```

`yolo` 会绕过更多确认，只应在低风险、可恢复的工作区使用。默认推荐 `auto`。

## Gate：轻量验收

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-gate.ps1 `
  -Cwd "C:\path\to\git-project" `
  -TaskId "input-validation-001" `
  -Task "补齐输入校验并运行测试" `
  -Attempt 1 `
  -RequirementStatus pass `
  -AllowedPath @("src/utils", "test")
```

Gate 会尽可能检查：

1. 代码能否构建或运行
2. 测试能否通过
3. 类型检查能否通过
4. lint 能否通过
5. 是否修改敏感或禁止文件
6. diff 是否过大
7. 是否改动依赖文件
8. diff 是否包含疑似 API key / private key

Gate 会在运行目录下写入：

- `gate.md`：供人阅读的检查报告。
- `handoff.json`：供 Codex 接管的精简状态包，包含任务、分数、失败项、修改文件和完整产物路径。

`RequirementStatus` 可设为 `pass`、`partial`、`unknown` 或 `fail`。只有确认核心需求已完成时才使用 `pass`；`unknown` 会降低置信度并触发一次定向返工。Gate 依赖 Git diff；非 Git 目录属于硬故障并要求 Codex 接管。

第二次返工时保持同一个 `TaskId`，将 `Attempt` 改为 `2`。如果仍低于 90 分，Gate 会输出 `takeover`，Codex 直接读取 `handoff.json` 和其中引用的 worker 产物继续工作。

## 成本账本

MCP 请求会记录服务商返回的准确 Token 用量、模型、耗时、是否回退和按公开单价计算的费用估算：

```text
%USERPROFILE%\.codex-ai-team\usage\usage.jsonl
```

Qwen Code / Claude Code CLI 没有稳定统一的 Token 输出格式，因此 Worker 账本只记录可验证信息，不编造实际 Token：

```text
%USERPROFILE%\.codex-ai-team\usage\worker-runs.jsonl
```

DeepSeek Worker 默认使用 Qwen Code 的 OpenAI-compatible Agent 外壳，并在每次运行目录中生成不含密钥的临时 Provider 配置，声明 DeepSeek V4 的上下文能力；这避免 Claude Code 对第三方模型费用的错误估算。需要兼容旧流程时可显式传入 `-DeepSeekHarness claude`。

可以手动执行极小的在线探针验证两个账号和自动选择。该命令会产生少量模型费用，不会被 `npm test` 自动执行：

```powershell
cd .\mcp-server
npm run probe:live
```

## 8 项训练场

训练场会为每项任务复制独立项目并初始化 Git，不碰真实工程。只准备任务不扣模型 Token：

```powershell
.\benchmark\run-benchmark.ps1 -TaskId T3
```

确认后执行：

```powershell
.\benchmark\run-benchmark.ps1 -TaskId T3 -Execute
```

任务清单、允许路径和验收目标见 [benchmark/tasks.json](benchmark/tasks.json)。代码任务会运行隐藏验收和 Gate，结果保存在 `%USERPROFILE%\.codex-ai-team\benchmark`。

每次代码任务的模型、隐藏验收、质量分、决策和交接路径汇总在：

```text
%USERPROFILE%\.codex-ai-team\benchmark\benchmark-results.jsonl
```

## Token 节省原理

项目主要减少的是 **Codex 对话上下文增长**，并不保证降低所有模型的总费用：

- 大目录和日志先由外部 worker 调查。
- 完整 worker 过程留在磁盘，不重复塞进 Codex。
- Codex 只拿结论、路径、行号和短摘要。
- 一个 MCP Router 代替两套重复的模型工具定义。
- 简单任务默认使用较小输出预算。
- 低风险结果不强制进行第二次模型审查。

在一次本地调试记录中，未限制输出时上下文曾从约 18k 增长到 153k；第一轮输出优化后，同类过程约增长到 63k。这个数字只用于说明长工具输出的影响，不是通用 benchmark，也不代表你的账户一定获得同样比例的节省。

## 安全说明

- 本项目不会把 API key 写入源代码。
- MCP 和脚本会读取用户环境变量中的 key。
- Worker 能运行工具并修改工作区，运行前应确认目标目录正确。
- 完整 worker 日志可能包含任务中出现的敏感信息，**项目不会自动保证日志脱敏**。
- 不要把 `.env`、私钥、支付数据、账号凭据或私人聊天内容交给外部模型。
- 建议在 Git 仓库或有备份的目录中运行 worker。
- 发布或分享 `runs` 目录前应人工检查内容。

## 可选路径变量

如果 Node、Git、Qwen Code 或 Claude Code 不在系统 PATH，可设置：

```text
AI_TEAM_NODE_DIR
AI_TEAM_GIT_DIR
AI_TEAM_TOOLS_DIR
```

脚本也会自动尝试 `%APPDATA%\npm`。

## 故障排查

### Codex 中看不到 MCP 工具

- 检查 `command` 和 `args` 是否都是绝对路径。
- 运行 `npm run smoke`。
- 修改 `config.toml` 后重启 Codex。

### Qwen 请求失败

- 检查 `DASHSCOPE_API_KEY`。
- 检查模型名和百炼兼容模式 endpoint。
- 确认账户所在地域与模型权限匹配。

### DeepSeek 请求失败

- 检查 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`。
- 确认接口支持 Anthropic Messages 兼容格式。
- 运行 `npm run probe:live` 检查账号可见模型和自动选择结果。
- 只有使用 `AI_TEAM_MODEL_MODE=fixed` 时才需要人工检查 `DEEPSEEK_MCP_MODEL`。

### Worker 卡住或输出过长

- 降低 `MaxWallTime`。
- 使用 Scout 先做只读调查。
- 检查 `%USERPROFILE%\.codex-ai-team\runs` 中的完整结果。
- 将 `SummaryLines` 和 `SummaryMaxChars` 保持在较小范围。

## 设计取舍

- MCP Router 尽量轻量，没有引入完整多 agent 框架。
- 路由规则是启发式，不会永远选中最合适的模型。
- PowerShell worker 主要面向 Windows；MCP Router 本身基于 Node.js，改造后可在其他系统运行。
- 工具描述和返回内容刻意保持短小，以降低长期上下文负担。

## License

[MIT](LICENSE)
