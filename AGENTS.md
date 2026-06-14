# 天枢 (Tiānshū) — Architecture Map

> 顶层目录索引。文件级细节用 `repo_map` 按需获取。

| 目录 | 职责 |
|------|------|
| `src/agent/` | 核心智能体循环、工具流水线、多模型协调、压缩、子智能体、验证、交付门禁 |
| `src/tools/` | 工具实现（definition + execute）与注册 |
| `src/api/` | API 客户端层（OpenAI 兼容、Codex OAuth、流式处理） |
| `src/prompt/` | 系统提示词工程（static / volatile / engine） |
| `src/tui/` | 终端 UI（Ink 6 / React） |
| `src/compact/` | 上下文压缩策略（修剪、微压缩、阈值） |
| `src/cache/` | 前缀缓存管理与命中诊断 |
| `src/repo/` | 代码仓库分析（导入图、持久化索引） |
| `src/config/` | 配置管理（默认 → ~/.rivet → 项目多层加载） |
| `src/artifact/` | 大输出持久化 |

## 高危命令纪律（硬性闸门）

破坏性/不可逆命令在执行前**必须先用一条消息向用户说明「接下来要做什么·为什么·影响什么」，并等用户明确回话确认**（主动回复「确认/可以/执行」，不是点审批卡）才能执行。**未确认一律禁止。**

- **覆盖范围**：`git stash`（含 pop/apply/drop）、`git reset --hard/--mixed`、`git checkout -- ` / `git restore`、`git clean`、`git push -f/--force`、`git branch -D`、`rm -rf`、覆盖/删除已有文件、`DROP`/`TRUNCATE` 等。
- **「看看」≠「动手」**：用户让你查看/诊断（看 stash 内容、冲突、diff）时，只报告发现并等指令，**禁止顺手 stash/reset/还原**。刚才的事故正源于此。
- **验证失败别用 git 清场**：测试因外部改动/并发失败时，先定位根因（多为测试非隔离、共享固定临时路径），**不要用 stash/reset/checkout 清空工作区来骗过验证**。
- **多会话共享工作区**：本仓库常有并发 agent 会话，任何丢改动的操作都可能误伤别的会话——更要先确认。
- **例外**：rivet `goal` 长程自治任务已获授权，按既有审批体系自动执行。
