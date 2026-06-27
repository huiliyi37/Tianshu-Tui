# omp 回流 P6 — AST 语义编辑工具 · 遗留项 & 后续安排

> P6 核心交付完成日期: 2026-07-01
> 最后更新: 2026-07-01 (状态刷新)
> 涉及 commits: 45a9bf29, 4cd1f6dc, 9faa7ccb, 7db6ad2d, bc4a7349, 654acc4e, 82312671, ddca90dc, 284e3e43

## 已完成（本周期）

| 交付物 | 状态 |
|--------|:----:|
| `src/tools/ast-grep.ts` — AST 语义搜索（pattern/rule object、ERROR 检测、meta-variable 提取） | ✅ |
| `src/tools/ast-edit.ts` — AST 语义替换（dryRun 默认 true、多 op、meta-var 模板插值、原子写） | ✅ |
| `src/tools/ast-shared.ts` — 共享模块（语言推断、文件收集、meta-var 解析、LANG_MAP、EXCLUDE_DIRS 扩展） | ✅ |
| `src/tools/default-registry.ts` — 注册两工具 | ✅ |
| `onFileWrite` 回调 — evidence/filesModified 追踪内部文件写入 | ✅ |
| `collectFiles` 修复 — 显式排表 + MAX_FILES/MAX_DEPTH 上限 | ✅ |
| `LANG_MAP` 运行时断言 + `buildLangMap` 去重 | ✅ |
| `writeFileAtomicAsync` — ast-edit 改用项目标准原子写 | ✅ |
| agent workflow 接入 — profile-registry + static.ts + review-coordinator | ✅ `654acc4e` |
| ast 工具加固 8 项 — post-edit 语法检查、meta-var 截断、diff 预览、pattern 预解析等 | ✅ `82312671` |
| `hash_edit` 加入 pipeline evidence 追踪 | ✅ `ddca90dc` |
| read-ref stats per-session | ✅ `284e3e43` (R2-4) |
| 测试: 41 用例 (ast-grep 9 / ast-edit 12 / ast-shared 20) | ✅ |

## 遗留项（按优先级排列）

### P1 — 影响面小，收益明确

1. ~~扫描其他内部写文件工具接入 `onFileWrite`~~ **已完成**。扫描结果：只有 `hash_edit` 漏了追踪（已修 `ddca90dc`）；`write_file`/`edit_file` 被 pipeline 后置钩子覆盖；`apply_patch` 写 temp patch 非用户源文件；`plan.ts`/`path-grants.ts` 写元数据/内部状态。无其他遗漏。

2. **`ast-edit` 重叠编辑去重保护**
   - 行动: 在 op 循环中检测重叠范围，跳过或 warn
   - 计划: 未写，约 0.5 天

### P2 — 中等复杂度，提升实用性

3. **多语言支持（Python/Rust/Go/JSON）**
   - `@ast-grep/napi` 内置仅 5 语言（Html/JavaScript/Tsx/Css/TypeScript）
   - 行动: 先支持 Python + JSON（天枢高频场景），扩展 `LANG_BY_EXT` + 动态加载
   - 计划: 未写，约 1 天

4. ~~`ast-edit` 大文件性能优化（单 op 跳过 re-parse）~~ **划掉**。`82312671` commit 调查确认单 op 场景从不 re-parse，多 op 必须 re-parse（commitEdits 根失效）。此遗留项基于误读。

5. **`ast-grep` includeMeta 输出增强**
   - 当前 meta-variables 在 match 行尾展示 `[NAME=foo, ARGS=a: number]`
   - meta-var 已截断到 120 字符（`82312671` #1），信息密度改善
   - 行动: 对多节点 meta-var 展示截断行数、首行预览（可选）
   - 计划: 未写，约 0.5 天

### P3 — 较大变更，需独立计划

6. **完整的 `onToolComplete` 回调（替代最小 `onFileWrite`）**
   - 含 status、target、duration、toolName 等完整字段
   - 行动: 扩展 `ToolCallParams` + 在 `executeToolUse` 的 finally 块统一调用
   - 计划: 未写，需独立计划（约 2-3 天）

7. **`collectFiles` 排除列表可配置**
   - 当前硬编码 `EXCLUDE_DIRS`（已扩展至 node_modules/.git/.rivet/dist/build/out/.next/.turbo/coverage/.nyc_output）
   - 行动: 从 config 或环境变量读取可自定义排除列表
   - 计划: 未写

8. **端到端集成测试**
   - 当前仅单元测试（工具 execute 直接调用）
   - 缺少: 模型 → tool call → execute → 验证 完整链路
   - 行动: 添加 scripted-model 集成测试
   - 计划: 未写

## 无遗留的设计决策（保持不变）

- **`collectFiles` 不共享 `glob.ts` 的 walkDir**：glob 的 walkDir 是 async + realpath 循环检测，ast 工具用 sync 更简单
- **`interpolateTemplate` 手动 regex 替换**：`@ast-grep/napi` 的 `replace()` 不内插 meta-variables
- **工具层 hooks 追踪不在 `onFileWrite` 范围**：完整 `onToolComplete` 需框架层变更
- **单 op 不 re-parse**：多 op 必须 re-parse（commitEdits 根失效），无法优化
