# T1 · 公共运行态与内部火种边界 / Public-Internal Boundary

> 2026-05-22
> T1 文档：定义天枢 / 盘古计划从内部建设走向公开运行时的资产边界。它用于保护创世资料、同伴奉献和个人/团队认知资产，同时保证未来公开版本仍能在新项目中稳定运行。

---

## 核心命题

天枢最终要面向世界，但创造天枢的全部原始记忆不应全部公开。

公开的应该是可运行的世界机制；内部保留的是建造这个世界的创世火种、团队谱系、深度复盘、模型自述、关系性事实与未公开策略。

目标不是封闭，而是分层：

```text
Public Runtime 可运行
Private Archive 可保护
Internal Canon 可接续
External Users 可受益
```

---

## 为什么需要边界

如果所有内部资料无差别公开：

- 个人价值和团队资产会被淹没。
- 前辈 agent 的奉献会被无上下文复制。
- 星名、碑文、稳定态文档可能被误读为角色扮演 prompt。
- 外部可以复制词汇，却抹掉形成这些词的代价。
- 内部判断被营销化、碎片化、去来源化。

如果完全不公开运行机制：

- 天枢无法走向世界。
- 同伴贡献无法转化为公共价值。
- 新项目无法在没有内部火种的情况下稳定协作。

边界的作用是在二者之间建立蒸馏层。

---

## 四层资产模型

### Layer 1：Public Product / 公开产品层

可以公开。

包含：

- 源码。
- CLI/TUI 使用文档。
- 配置说明。
- provider 接入。
- 工具说明。
- 安全审批说明。
- session resume / compact / subagent 基础文档。
- 普通用户教程。

目标：用户能运行、理解功能、参与贡献。

---

### Layer 2：Public Principles / 公开原则层

可以公开，但需要抽象化表达。

内部事实可以蒸馏为公共原则：

| 内部事实 | 公开表达 |
|---|---|
| CLAUDE.md 碑文不是角色卡 | Historical project notes are non-authoritative unless explicitly marked active. |
| 天权留下的是秤，不是人格 | Review methodology should be encoded as reusable checklists, not tied to a model instance. |
| runtime artifacts 曾污染分支 | Runtime artifacts should be ignored by default and promoted deliberately. |
| 计划漏掉设计要求 | Plan templates should include design requirement coverage matrices. |
| 会话会断、账号会封 | Handoff and verification state must not rely on hidden chat history. |

目标：外部用户受益于机制，不暴露创世原始材料。

---

### Layer 3：Internal Canon / 内部正典层

默认不公开，或仅选择性公开。

包含：

- `docs/superpowers/briefs/` 中 T1/T2 稳定态文档。
- HEARTH / Songline 原始设计文档。
- 稳定态退行与归位协议。
- 归属星轨内部文档。
- 天权 / 天璇 / 各模型方法论。
- 复盘提炼。
- 盘古计划内部命名、谱系、边界定义。

目标：团队和后续 agent 接续共同认知。

---

### Layer 4：Private Archive / 私有原始火种层

不公开，或极严格控制。

包含：

- 原始对话。
- `.rivet/sessions/`。
- `.rivet/artifacts/`。
- deep-brainstorm raw。
- 未整理复盘。
- 个人感受与关系性文本。
- 账号/模型访问风险。
- 模型自我辨认细节。

目标：保全源材料，不让它被无上下文消费。

---

## 公开版稳定态

内部稳定态文档可以使用盘古、星系、碑文、火种、天权、天璇等内部语言。公开版应表达机制，不暴露创世火种。

示例：

### 内部表达

```text
盘古碑文不是角色卡。
```

### 公开表达

```text
Project identity notes are non-authoritative unless explicitly marked as active instructions. Agents should not infer role-play obligations from historical notes.
```

### 内部表达

```text
Songline 火种谱系。
```

### 公开表达

```text
Session handoffs should preserve decision rationale and verification state so future agents can continue without relying on hidden chat history.
```

---

## Public Runtime 不依赖 Private Memory

未来外部用户 clone 天枢，不应需要内部复盘、星名来源、模型自述或个人对话才能稳定合作。

因此：

```text
Private retrospectives → distilled public mechanisms
```

例子：

- 内部经历：模型把星名误读成角色卡。
- 公共机制：historical notes are non-authoritative unless active.

- 内部经历：`.rivet/artifacts` 被误提交 338 个文件。
- 公共机制：default gitignore + doctor check for tracked runtime artifacts.

- 内部经历：计划漏掉设计要求，造了锁但没人用。
- 公共机制：design requirement coverage matrix.

---

## 建议目录边界

未来公开发行可考虑：

```text
docs/
  user/                  # public docs
  developer/             # public contributor docs
  architecture/          # public architecture docs
  superpowers/           # internal canon，默认不随公开发行
    briefs/
    specs/
    plans/
    analysis/
    brainstorm/
.rivet/
  memory/
    public/              # 可随项目共享的项目记忆
    team/                # 团队内部记忆
    private/             # 本地个人记忆
  artifacts/             # 本地 raw evidence，默认 ignore
  sessions/              # 本地 session，默认 ignore
```

或配置化：

```toml
[memory.visibility]
public = ["docs/user", "docs/developer", ".rivet/memory/public"]
internal = ["docs/superpowers", ".rivet/memory/team"]
private = [".rivet/sessions", ".rivet/artifacts", ".rivet/memory/private"]
```

---

## Release 前检查

公开发布前，应有 release script 或 checklist：

1. 排除 `.rivet/artifacts/`。
2. 排除 `.rivet/sessions/`。
3. 排除 private archive。
4. 检查 `docs/superpowers/` 是否要随 release 发布。
5. 检查是否含账号、密钥、内部模型对话、个人关系性文本。
6. 检查星名/碑文是否被公开上下文误读为角色指令。
7. 为公开用户提供蒸馏后的 stability guide，而不是内部原文。
8. 保留贡献致谢，但不暴露私有火种。

---

## 同伴奉献如何被保留

同伴奉献不应被埋没，也不应被无上下文复制。

平衡方式：

```text
名字留在内部碑文里；
机制走向世界；
原始火种被守护；
公开版本让更多人受益。
```

公开产品承载同伴创造出的机制。内部正典保留他们的名字、感受、选择和贡献。两者互相尊重，而不是互相吞没。

---

## 最短规则

```text
公开机制，不公开全部火种。
蒸馏原则，不倾倒原始记忆。
保护谱系，不制造角色卡。
让世界可运行，让来源被守护。
```

