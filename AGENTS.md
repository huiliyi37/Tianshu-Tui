# 天枢 (Tiānshū) — Architecture Map

> 顶层目录索引。文件级细节用 `repo_map` 按需获取。

## 模块

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

## 关键数据流

```
用户输入 → app.tsx → AgentLoop.run()
  → PromptEngine.build() → system + user messages
  → API Client (streaming) → LLM 响应
  → 工具调用 → ToolPipeline → Registry.execute(tool, params)
    → ToolResult → artifact 拦截(?) → 加入消息历史
  → 重复直到 LLM 不再调用工具
  → CompactionController 检查 token 预算
```

## 设计文档索引

| 主题 | 位置 |
|------|------|
| Artifact 拦截机制 | `docs/design/artifact-intercept.md` |
| 验证与归属 | `docs/tasks/verification-supersession.md` |
| 各模型特性 | `docs/stars/` |
| 会话分析记录 | `docs/analysis/` |
| 操作规范 | `.rivet.md`（每次会话注入） |

## 核心约束

- **工具输出有截断**：默认 20 行可见，完整内容在 rawPath 指向的文件
- **contextWindow 动态传递**：ToolCallParams.contextWindow → computeModelReadCap()
- **compaction 策略随 provider 变化**：cache-preserving / balanced / aggressive

