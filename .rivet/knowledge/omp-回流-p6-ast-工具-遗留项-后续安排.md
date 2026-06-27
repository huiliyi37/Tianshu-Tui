# omp 回流 P6 — AST 语义编辑工具 · 遗留项 & 后续安排

> P6 核心交付完成日期: 2026-07-01
> 涉及 commits: 45a9bf29, 4cd1f6dc, 9faa7ccb, 7db6ad2d, bc4a7349
> 相关计划: `.rivet/plans/omp-回流-p6-ast-语义编辑工具-ast-grep-napi-路径.md`

## 已完成

| 交付物 | 状态 |
|--------|:----:|
| `src/tools/ast-grep.ts` — AST 语义搜索（pattern/rule object、ERROR 检测、meta-variable 提取） | ✅ |
| `src/tools/ast-edit.ts` — AST 语义替换（dryRun 默认 true、多 op、meta-var 模板插值、原子写） | ✅ |
| `src/tools/ast-shared.ts` — 共享模块（语言推断、文件收集、meta-var 解析） | ✅ |
| `src/tools/default-registry.ts` — 注册两工具 | ✅ |
| `onFileWrite` 回调 — evidence/filesModified 追踪内部文件写入 | ✅ |
| `collectFiles` 修复 — 从 `startsWith('.')` 改为显式排表 `node_modules/.git/.rivet` | ✅ |
| `LANG_MAP` 运行时断言 — 防 napi API 变更静默 break | ✅ |
| `writeFileAtomicAsync` — ast-edit 改用项目标准原子写 | ✅ |
| 测试: 39 用例 (ast-grep 9 / ast-edit 10 / ast-shared 20) | ✅ |

## 遗留项（按优先级排列）

### P1 — 影响面小，收益明确

1. **扫描其他内部写文件工具接入 `onFileWrite`**
   - `src/tools/apply-patch.ts` 等直接使用 `writeFileSync` 的工具同样绕过 evidence 追踪
   - 行动: `grep writeFileSync` / `grep writeFileAtomic` 全量扫描 → 逐个接入 `params.onFileWrite?.()`
   - 计划: 未写，约 0.5 天

2. **`ast-edit` 重叠编辑去重保护**
   - 当前 `findAll` 默认不重叠，但若用户传入的多个 op 产生交叉匹配，`commitEdits` 可能产生非预期结果
   - 行动: 在 op 循环中检测重叠范围，跳过或 warn
   - 计划: 未写，约 0.5 天

### P2 — 中等复杂度，提升实用性

3. **多语言支持（Python/Rust/Go/JSON）**
   - `@ast-grep/napi` 内置仅 5 语言（Html/JavaScript/Tsx/Css/TypeScript）
   - 其他语言需 `registerDynamicLanguage` + `tree-sitter-<lang>.wasm`
   - 行动: 先支持 Python + JSON（天枢高频场景），扩展 `LANG_BY_EXT` + 动态加载
   - 计划: 未写，约 1 天

4. **`ast-edit` 大文件性能优化**
   - 多 op 场景下每轮 re-parse，大文件（>100KB）可能有明显延迟
   - 行动: 单 op 场景跳过 re-parse（同一次 root 上连续 findAll 即可）；多 op 场景可选批合并 edit
   - 计划: 未写，约 0.5-1 天

5. **`ast-grep` includeMeta 输出增强**
   - 当前 meta-variables 在 match 行尾展示 `[NAME=foo, ARGS=a: number]`
   - 对多节点 meta-var（`$$$BODY`）只 join 为逗号分隔文本，信息密度低
   - 行动: 对多节点 meta-var 展示截断行数、首行预览
   - 计划: 未写，约 0.5 天

### P3 — 较大变更，需独立计划

6. **完整的 `onToolComplete` 回调（替代最小 `onFileWrite`）**
   - 含 status、target、duration、toolName 等完整字段
   - 行动: 扩展 `ToolCallParams` + 在 `executeToolUse` 的 finally 块统一调用
   - 所有工具自动受益（不只是 ast-edit），可替代当前的 ad-hoc `recordToolHistory`
   - 计划: 未写，需独立计划（约 2-3 天）

7. **`collectFiles` 排表可配置**
   - 当前硬编码 `EXCLUDE_DIRS = Set(['node_modules', '.git', '.rivet'])`
   - 行动: 从 config 或环境变量读取可自定义排除列表
   - 计划: 未写

8. **端到端集成测试**
   - 当前仅单元测试（工具 execute 直接调用）
   - 缺少: 模型 → tool call → execute → 验证 完整链路
   - 行动: 添加 scripted-model 集成测试（参考 `src/agent/__tests__/trace-integration.test.ts`）
   - 计划: 未写

## 无遗留的设计决策

- **`collectFiles` 不共享 `glob.ts` 的 walkDir**: glob 的 walkDir 是 async + realpath 循环检测，ast 工具用 sync 更简单，且文件量小（不像 glob 要扫全项目）
- **`interpolateTemplate` 手动 regex 替换**: `@ast-grep/napi` 的 `replace()` 不内插 meta-variables 到模板，手动实现是正确的（也是 omp Rust 端的做法）
- **工具层 hooks 追踪不在 `onFileWrite` 范围**: 完整的 `onToolComplete` 需要框架层变更，将其与临时的 `onFileWrite` 分离是合理的分步策略
