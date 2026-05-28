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
