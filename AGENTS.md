# 天枢 (Tiānshū) — Architecture Map

> 这是一张地图，不是手册。详细设计见 docs/。

## 模块导航

```
src/
├── agent/           核心智能体循环与编排
│   ├── loop.ts      AgentLoop — 主循环：LLM 调用 → 工具执行 → 迭代
│   ├── tool-pipeline.ts  工具调用流水线（执行、重试、诊断、artifact 拦截）
│   ├── coordinator.ts    多模型协调器（路由、回退、能力卡）
│   ├── compaction-controller.ts  上下文压缩控制器
│   ├── worker-session.ts 子智能体（delegate）独立会话
│   ├── recovery-trigger.ts  错误恢复与策略切换
│   ├── verification.ts  交付验证门禁
│   └── delivery-gate-v2.ts  文件所有权与归属判定
│
├── tools/           工具实现（每个工具 = definition + execute）
│   ├── read-file.ts      文件读取（动态容量、去重、artifact）
│   ├── edit.ts           编辑文件（精确字符串替换）
│   ├── write-file.ts     创建/覆写文件
│   ├── bash.ts           Shell 执行（spawn，非 execSync）
│   ├── grep.ts / glob.ts 搜索与查找
│   ├── repo-map.ts       项目目录树（支持 path/depth 按需聚焦）
│   ├── repo-graph.ts     代码图探索（依赖/影响分析）
│   ├── delegate-task.ts  子智能体委派
│   ├── apply-patch.ts    统一 diff 应用
│   └── registry.ts       ToolRegistry — 所有工具的注册与执行入口
│
├── api/             API 客户端层
│   ├── openai-client.ts  OpenAI 兼容协议客户端
│   ├── codex-client.ts   Codex (OAuth) 客户端
│   ├── provider-profile.ts  Provider 缓存特性档案
│   └── stream-client.ts  流式响应处理
│
├── prompt/          系统提示词工程
│   ├── static.ts    静态上下文（注入 .rivet.md + 工具描述）
│   ├── engine.ts    PromptEngine — 组装完整 system prompt
│   └── volatile-snapshot.ts  动态上下文（cwd、session memory）
│
├── tui/             终端 UI（Ink 6 / React）
│   ├── app.tsx      根组件
│   ├── stream.tsx   流式消息渲染
│   └── glance-bar.tsx  底部状态栏
│
├── compact/         上下文压缩策略
│   ├── prune.ts     过期工具结果修剪
│   ├── micro.ts     微压缩（请求级截断）
│   └── constants.ts 阈值与策略配置
│
├── cache/           前缀缓存管理
│   └── advisor.ts   CacheAdvisor — 缓存命中诊断
│
├── repo/            代码仓库分析
│   ├── import-graph.ts  导入依赖图
│   └── meridian-*.ts    Meridian 持久化索引
│
├── config/          配置管理
│   ├── default.ts   内置默认配置
│   ├── schema.ts    Zod 验证模式
│   └── manager.ts   多层配置加载（默认 → ~/.rivet → 项目）
│
└── artifact/        大输出持久化
    └── store.ts     ArtifactStore — 超阈值工具输出存磁盘
```

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
- **prefix cache 对静态提示词敏感**：改 static.ts = 下回合 cache miss
