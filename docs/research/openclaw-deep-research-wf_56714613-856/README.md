# OpenClaw 深度调研 · 原始 Transcript

> 工作流 Run ID: `wf_56714613-856`
> 日期: 2026-06-05
> 状态: **中途停止**(跑到约 1/3,消耗约 2M token 后手动终止)

## 这是什么

deep-research 工作流对 **OpenClaw**(GitHub: `openclaw/openclaw`,前身 Clawdbot/Moltbot,作者 Peter Steinberger,TypeScript 自托管个人 AI agent)的 agent 架构内核调研。本目录是该工作流全部 subagent 的原始对话日志。

- `agent-*.jsonl` — 46 个 subagent 的完整 transcript(搜索/抓取/对抗验证各阶段)
- `agent-*.meta.json` — 45 个对应元数据

## 调研问题

围绕「能否从 OpenClaw 原生融合架构模式,让天枢 agent 更自然使用自己的本体」,分 5 个维度:

1. agent 主循环与会话/上下文管理
2. skills 系统与工具执行/权限/沙箱模型
3. 多 agent / 多 session 路由与隔离
4. 记忆/上下文持久化与 token/成本管理
5. 本体/人格/自我状态相关设计(SOUL.md 等)

## 核心发现(已收敛)

调研产出 321 条可证伪事实陈述,关键结论:

- **OpenClaw 架构**: Gateway(常驻 Node.js 进程,「只路由不思考」)+ 独立 agent runtime(包 `@mariozechner/pi-agent-core` 的 ReAct loop);per-agent tool policy;SOUL.md 把身份外化进 workspace 文件(可检视/可演化);session = JSONL transcript;file-grounded Markdown 记忆 + hybrid 检索。
- **对天枢的意义**: 代码级核实推翻了「天枢缺 gateway」的直觉——天枢已自建 server/router/coordinator/per-agent tool policy/sandbox/per-worker PromptEngine 全套零件。真缺口仅两个:**任务 ingress 拓扑接线** + **MCP**。

## 结论落在哪(看这两份,而非原始 jsonl)

- `docs/superpowers/specs/2026-06-05-standing-collaborator-task-ingress-design.md` — 常驻协作者/任务 ingress 拓扑设计(主产出)
- `docs/superpowers/specs/2026-06-05-cognitive-pipeline-cache-aware-fusion-design.md` — 认知管线缓存感知融合(前序会话产出)

## 注意

- 工作流**未完成**,验证阶段只跑了一部分,部分 claim 未经完整 3 票对抗验证。
- 这批日志含大量中间过程,体积 4.4M。结论已提炼进上述两份 spec;原始日志仅作溯源/审计用途保留。
- 教训:对「调研一个具体已知项目」,deep-research 工作流(数十 agent 对抗验证)是杀鸡用牛刀,几个 WebFetch 即可。
