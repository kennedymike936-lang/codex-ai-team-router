# AI Team Benchmark

这套训练场用于比较 Qwen、DeepSeek 和 Codex 的成本、成功率与接管率。每个任务都会复制一份新的小型 Node.js 项目并初始化独立 Git 仓库，不会修改真实项目。

只准备任务，不调用模型：

```powershell
.\benchmark\run-benchmark.ps1 -TaskId T3
```

执行任务并消耗对应模型 Token：

```powershell
.\benchmark\run-benchmark.ps1 -TaskId T3 -Execute
```

建议先依次执行 `T1` 到 `T8`，每项只跑一次。代码任务完成后会运行隐藏验收和 Gate；完整 worker 产物与 Gate 报告保存在 `%USERPROFILE%\.codex-ai-team\benchmark`。

MCP 精确 Token 账本保存在 `%USERPROFILE%\.codex-ai-team\usage\usage.jsonl`。Qwen Code / Claude Code CLI 当前不稳定提供统一的 Token 字段，因此 Worker 账本 `%USERPROFILE%\.codex-ai-team\usage\worker-runs.jsonl` 先记录模型、预算、耗时、成败和 DeepSeek 请求费用上限，不伪造实际 Token 或费用。
