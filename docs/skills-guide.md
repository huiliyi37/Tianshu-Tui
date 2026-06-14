# 天枢 Skills 指南

> 技能（Skill）是可复用的工作流模板。天枢采用与 Claude Code / Codex 同款的**渐进式披露（progressive disclosure）**两层模型：
> 默认只把所有 skill 的 **name + description** 放进上下文（Tier-1 发现层，极小、cache-safe），**完整正文按需加载**（Tier-2，模型用 `skill` 工具 / 用户用 `/skill`）。
> 因此**不再有任何截断**——大型 skill 的正文要么没进上下文（仅占用一行描述），要么被完整加载。
> 本文档涵盖安装、使用、格式规范、已知限制和竞品对比。

---

## 快速开始

### 创建你的第一个 Skill

在项目根目录下创建 `.rivet/skills/code-review.md`：

```markdown
---
name: code-review
description: 系统化代码审查清单——安全/性能/正确性三轴
triggers: [review, 审查, CR, code review]
---

## 审查三轴

### 1. 正确性
- 变更是否做了它声称做的事？
- 边界条件是否覆盖（空值、并发、超大输入）？

### 2. 安全
- 路径穿越、注入、密钥暴露？
- 权限校验是否在正确位置？

### 3. 性能
- 是否引入了 O(n²) 循环？
- 大文件读写是否用了流？
```

保存后重启天枢（或新开会话）。此后这个 skill 的**描述**会出现在「可用 skill 清单」中；当你的输入命中 `triggers` 时它会被标记为 `relevant`，模型即可调用 `skill` 工具加载它的完整正文。

### 验证是否加载成功

启动时查看 stderr 输出：
```
[skills] Loaded 1 skill(s) from .rivet/skills/
```

或使用命令查看：
```
/skill list
```

---

## 两层模型（渐进式披露）

天枢把「知道某 skill 存在」与「加载它的全文」彻底分开。三个来源目录（见下）统一加载进同一个 `skillRegistry`，发现层与加载层都读它。

### Tier-1 — 发现层（常驻、极小、cache-safe）

**机制**：每轮对话把**所有** skill 的 `name + description` 渲染成一个 `<available-skills>` 块，注入到 dynamic appendix（volatile prompt 区，cache-safe）。命中 `triggers` 正则的 skill 会排在前面并标记 `relevant="true"`。

- **只放描述，绝不放正文**——每条描述截断到约 200 字符，整块预算约 1500 字符。
- 因为只有描述，几乎不可能超预算；即便超了，丢弃的也只是最不相关的描述行，**没有任何正文会丢失**（这里本来就没有正文）。

```
用户输入 "帮我 review 一下这段代码"
    ↓
<available-skills> 块：列出所有 skill 的 name+description
  命中 triggers 的（code-review）标记 relevant="true" 排在最前
    ↓
模型看到"有哪些 skill 可用"，决定是否调用 skill 工具
```

### Tier-2 — 按需加载完整正文（无截断）

两条入口，都从 `skillRegistry` 取**完整 body**，零截断：

**A. 模型自助 —— `skill` 工具**

模型看到发现清单后，按名调用 `skill(name="code-review")`，工具返回该 skill 的完整正文作为 tool_result（append-only 进历史，整个会话可见）。超大正文由工具流水线既有的 artifact intercept 兜底，与任何其他大输出一致。

**B. 用户手动 —— `/skill` 命令**

```
/skill list              → 列出所有可用 skill（读 skillRegistry）
/skill code-review       → 把该 skill 的完整正文一次性追加进会话
```

`/skill <name>` 以 append-only 的方式把完整 body 注入会话（不再用持久锚点反复渲染，也不再 `slice` 截断）。

**默认只扫描 `.rivet/skills/`。** Claude 目录（`.claude/skills/`）按需导入——在配置中声明你要的 skill 名称，避免一次性加载全部 Claude skills。

| 目录 | 格式 | 默认 | 说明 |
|------|------|------|------|
| `.rivet/skills/*.md` | Rivet frontmatter | **始终扫描** | 项目级 Rivet 原生格式 |
| `.claude/skills/*/SKILL.md` | Claude 格式 | 需配置 | 项目级 Claude Code 兼容 |
| `~/.claude/skills/*/SKILL.md` | Claude 格式 | 需配置 | 全局 Claude Code 兼容 |

> **从 Claude Code 导入 skill**：在 `~/.rivet/config.json` 或项目 `.rivet-config.json` 中配置 `skills.importFromClaude`，列出需要导入的 skill 名称（目录名）。只有列出的 skill 会被加载，不是全量扫描。
>
> ```json
> {
>   "skills": {
>     "importFromClaude": ["pdf-extract", "git-flow", "code-review"]
>   }
> }
> ```
>
> 不配置 = 只用 `.rivet/skills/`，不碰 Claude 目录。

---

## Skill 文件格式

### Rivet 格式（`.rivet/skills/*.md`）

```markdown
---
name: my-skill
description: 一句话描述，显示在 /skill list 中
triggers: [关键词1, 关键词2, "带空格的正则"]
tierLock: balanced
---

## 正文内容

这里是 skill 的实际指令内容。
支持标准 Markdown 语法。
会原样注入到模型上下文中。
```

**字段说明**：

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `name` | 否 | string | 技能名称，缺省时取文件名（去掉 .md） |
| `description` | 否 | string | 一句话描述，`/skill list` 中展示 |
| `triggers` | 否 | string[] | 正则数组，任意匹配即触发自动注入 |
| `tierLock` | 否 | `cheap`/`balanced`/`strong` | 锁定模型 tier（预留字段） |

### Claude Code 兼容格式（`.claude/skills/<name>/SKILL.md`）

```
.claude/skills/
  my-skill/
    SKILL.md       ← 必须叫这个名字
```

`SKILL.md` 内容同样是 YAML frontmatter + Markdown body。这种格式与 `.rivet/skills/*.md` 一样进入统一的 `skillRegistry`——既出现在发现清单里，也能被 `skill` 工具和 `/skill` 命令加载。

---

## Skill 安装位置

```
项目根目录/
├── .rivet/
│   └── skills/              ← 默认扫描（Rivet 原生，始终加载）
│       ├── code-review.md
│       ├── tdd.md
│       └── deploy-check.md
├── .claude/
│   └── skills/              ← 需配置 importFromClaude（项目级 Claude 兼容）
│       └── pdf-extract/
│           └── SKILL.md
~/.claude/
    └── skills/              ← 需配置 importFromClaude（全局 Claude 兼容）
        └── git-flow/
            └── SKILL.md
```

**默认行为**：只加载 `.rivet/skills/` 下的 skill。

**导入 Claude skill**：在配置文件中添加 `skills.importFromClaude`，按名称（目录名）选择性导入：

```json
// ~/.rivet/config.json 或 .rivet-config.json
{
  "skills": {
    "importFromClaude": ["pdf-extract", "git-flow"]
  }
}
```

配置后，天枢会从 `.claude/skills/` 和 `~/.claude/skills/` 中只加载列出的 skill。名称冲突时 `.rivet/skills` 优先。

---

## 实际示例

### 示例 1：TDD 技能

`.rivet/skills/tdd.md`：
```markdown
---
name: tdd
description: 测试驱动开发流程——先红后绿再重构
triggers: [TDD, test-first, "write.*test", 先写测试]
---

## TDD 三步循环

1. **Red**：写一个会失败的测试，描述期望行为
2. **Green**：写最少代码让测试通过
3. **Refactor**：改善代码结构，保持测试绿色

## 规则
- 不跳过 Red 阶段——先确认测试真的会失败
- 每步只解决一个问题
- 重构时不改变行为
```

### 示例 2：部署前检查

`.rivet/skills/deploy-check.md`：
```markdown
---
name: deploy-check
description: 部署前必检清单——环境变量/迁移/回滚
triggers: [deploy, 部署, publish, release, 上线]
---

## 部署前检查清单

- [ ] 环境变量与生产环境一致
- [ ] 数据库迁移已执行且可回滚
- [ ] 回滚方案已确认（版本号/镜像 tag）
- [ ] 日志级别设为生产级（非 debug）
- [ ] 秘钥未硬编码在代码中
```

### 示例 3：Git Commit 规范

`.rivet/skills/commit-convention.md`：
```markdown
---
name: commit-convention
description: 约定式提交规范——feat/fix/refactor/breaking
triggers: [commit, 提交, "git log"]
---

## Commit Message 格式

<type>(<scope>): <description>

type: feat | fix | refactor | docs | test | chore | perf | ci
scope: 可选，影响的模块
description: 祈使句，小写，不加句号

## Breaking Change
在 footer 中用 BREAKING CHANGE: 前缀标注
```

---

## 已知限制

| # | 限制 | 影响 | 临时规避 |
|---|------|------|---------|
| 1 | 发现层 `relevant` 标记用正则匹配，非语义匹配 | "帮我看看代码" 不会把 "review" skill 标 relevant（但它仍在清单里可被加载） | 在 `triggers` 中加更多同义词 |
| 2 | 发现清单在会话内稳定，不热加载 | 会话中途新增的 skill 本会话不可见 | 新开会话或重启天枢 |
| 3 | 无 skill 内文件引用 | 不能在 skill 中引用同目录的其他文件 | 将所有内容写在一个 .md 中 |
| 4 | skill 文件内 `` !`cmd` `` 动态 shell 注入暂未实现 | 不能在 skill 里内联执行命令 | 等后续 wave（须走沙箱/审批门） |

> **截断问题已根除**：渐进式披露下，正文要么不进上下文（仅占一行描述），要么被完整加载——不再存在 4000/8000 字符的静默丢弃或硬截断。

### 遇到 skill 不生效时的排查

1. **确认文件存在**：`ls .rivet/skills/*.md`（或 `.claude/skills/*/SKILL.md`）
2. **确认格式正确**：frontmatter 必须以 `---` 开头和结尾
3. **确认启动加载**：stderr 应显示 `[skills] Loaded N skill(s)`
4. **确认出现在清单**：`/skill list` 应列出它（发现层只需 `name`/`description`，无字符预算焦虑）
5. **确认 triggers 匹配**：若想让它在某轮被标 `relevant`，检查输入是否命中 trigger 关键词
6. **尝试手动加载**：`/skill <name>` 看是否能加载完整正文

---

## 与竞品对比

| 维度 | 天枢 (Rivet) | Claude Code | Cursor Rules |
|------|-------------|-------------|--------------|
| **文件格式** | `.rivet/skills/*.md`（+ 可选导入 `.claude/skills/*/SKILL.md`） | `.claude/skills/*/SKILL.md` | `.cursor/rules/*.mdc` |
| **披露模型** | 两层：描述常驻 + 正文按需 | 两层：描述常驻 + 正文按需 | 单层（按 glob 注入） |
| **发现机制** | 全部 skill 的 name+desc 常驻；正则命中标 relevant | 模型语义判断 | glob 匹配文件路径 |
| **加载机制** | `skill` 工具 / `/skill` 取完整正文 | 模型自动加载 SKILL.md | — |
| **发现层位置** | dynamic appendix (cache-safe) | system context | system prompt |
| **Claude 兼容** | 按需导入（配置 `importFromClaude`） | 原生支持 | 不支持 |
| **字符限制** | 无（描述层只放 desc；正文按需完整加载，超大走 artifact 兜底） | 无固定限制 | 无固定限制 |
| **热加载** | 不支持（需重启/新会话） | 支持 | 支持 |
| **语义匹配** | 不支持（纯正则标 relevant） | 原生支持 | 不支持 |
| **内置 skills** | 无 | 有若干预置 | 有模板 |
| **用户自定义难度** | 低（放 .md 文件即可） | 低 | 中（需了解 glob 语法） |

### 天枢的优势

- **渐进式披露**：与 Claude Code / Codex 对齐——描述层极小常驻，正文按需加载，根除截断
- **格式简单**：`.rivet/skills/*.md` 放文件即可，零配置
- **Claude skill 按需导入**：不盲目全量加载 70+ skill，只导入用户选定的
- **cache-safe**：发现清单只进 volatile dynamic appendix，`skill` 工具定义字节稳定，不破坏前缀缓存

### 天枢的劣势

- **relevant 标记靠正则**：不如 Claude Code 的语义理解灵活（但不影响 skill 可被加载）
- **无热加载**：修改/新增 skill 需要重启或新开会话
- **无内置 skills**：开箱无预置技能

---

## 技术实现细节

### 数据流（Tier-1 发现）

```
bootstrap.ts          loadProjectSkills(cwd)
                       → 统一扫描 .rivet/skills/*.md + 项目/全局 .claude/skills/*/SKILL.md
                       → 解析 frontmatter 到 skillRegistry（记录 source / bodyPath）
                              ↓
loop.ts                skillRegistry.renderDiscoveryBlock(userInput)
                       → 渲染所有 skill 的 name+description（命中 triggers 标 relevant）
                       → 仅描述，预算 ~1500 字符 / 单条 ~200 字符；绝不含正文
                              ↓
engine.ts              promptEngine.setSkillAdvisoryBlock(block)
                              ↓
volatile.ts            if (ctx.skillAdvisoryBlock) parts.push(ctx.skillAdvisoryBlock)
                       → 写入 dynamic appendix（cache-safe）
```

### 数据流（Tier-2 按需加载）

```
模型路径：model 调用 skill(name)            用户路径：/skill <name>
        ↓                                          ↓
src/tools/skill.ts                          slash-commands.ts
  skillRegistry.get(name).body （无截断）      skillRegistry.get(name).body （无截断）
        ↓                                          ↓
  返回 tool_result（append-only）             session.addUserMessage（append-only 一次性）
        ↓                                          ↓
  超大 → 工具流水线 artifactIntercept 兜底     完整正文进入会话历史，整会话可见
```

### 源码索引

| 文件 | 职责 |
|------|------|
| `src/skills/skill-loader.ts` | Skill 解析、统一三目录加载、发现层渲染（`renderDiscoveryBlock`） |
| `src/tools/skill.ts` | `skill` 工具：按名返回完整正文（Tier-2 模型入口） |
| `src/bootstrap.ts` | 启动时 `loadProjectSkills(cwd)` 加载三目录 |
| `src/agent/loop.ts` | 每轮调用 `renderDiscoveryBlock` 注入发现清单 |
| `src/prompt/engine.ts` | `setSkillAdvisoryBlock` 存储发现块 |
| `src/prompt/volatile.ts` | 渲染发现块到 dynamic appendix |
| `src/tui/slash-commands.ts` | `/skill` 命令（Tier-2 用户入口，收敛到 skillRegistry） |
| `src/skills/__tests__/skill-loader.test.ts`、`discovery.test.ts` | 加载/发现单元测试 |
| `src/tools/__tests__/skill-tool.test.ts` | `skill` 工具反证测试 |
| `src/prompt/__tests__/skill-cache-safety.test.ts` | 缓存安全断言（静态 prompt 不含正文） |
