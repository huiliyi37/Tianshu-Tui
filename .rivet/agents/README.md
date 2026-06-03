# Agent Profiles（子代理技能定义）

每个 `.md` 文件定义一个子代理 profile（技能）。
Profile 通过 `delegate_task` / `delegate_batch` 分发，不会注入主 agent 的 system prompt —— 因此不破坏 exact-prefix cache。

## 格式

```markdown
---
name: profile_name       # 唯一标识（不能覆盖内置 profile）
role: readonly | hands | brain
tools: ["tool1", "tool2"]
maxTokens: 16384         # 可选，默认 4096（readonly）/ 16384（hands）
defaultKind: verify      # 可选
---
Expertise prompt — 教 worker 如何做它的 job。
This becomes the worker's system prompt.
```

## 角色说明

| role | 说明 | 典型工具 |
|------|------|----------|
| `readonly` | 只读探索（code_scout, reviewer 等） | read_file, grep, glob, repo_graph |
| `hands` | 可写执行（patcher, verifier） | + edit_file, write_file, bash, run_tests |
| `brain` | 规划分发（planner） | delegate_task, delegate_batch |

## 内置 profiles

- `code_scout` — 代码探索与定位
- `doc_scout` — 文档搜索与分析
- `planner` — 任务分解与规划
- `reviewer` — 代码审查
- `verifier` — 测试验证
- `patcher` — 精确代码编辑
- `architect` — 系统架构分析
- `troubleshooter` — 根因诊断

## 示例

见同目录下的 `research.md` 和 `security-auditor.md`。
