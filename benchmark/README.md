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

MCP 精确 Token 账本保存在 `%USERPROFILE%\.codex-ai-team\usage\usage.jsonl`。使用 Qwen Code Agent 外壳的 Worker 会把精确 Token、缓存命中、回合数和价格估算写入 `%USERPROFILE%\.codex-ai-team\usage\worker-runs.jsonl`；旧版 Claude Code 兼容外壳无法稳定返回 Token 时保留空值，不伪造费用。

当前实测结论见 [RESULTS-2026-07-12.md](RESULTS-2026-07-12.md)。
