# Skill 体系优化 — 深度头脑风暴结果（重锚定版）

> 2026-06-16 · deep-brainstorm（变异→选择→适应）· 5 scout 调研
> **设计目标 = 开源后下游用户的大型异构技能池**，不是本仓库自身的技能使用。

## 第一优先级（用户拍板）：保真 > 上下文洁净

主控模型**必须严格按 SKILL 内容处理任务**。丢失精度 / 残缺内容**不可接受**——会导致整会话返工。因此：

- **保真是 #1 硬约束，上下文污染控制是 #2。** 二者冲突时，选保真。
- **无损渐进装载**：用到某子文件就把它**完整**读入主上下文，**绝不摘要、绝不截断**。
- **`fork`（子代理隔离）被降级**：它只回摘要 = 有损，**不得用于质量关键技能**。fork 仅作"明确非关键的超重技能"的可选项；默认走主上下文无损 lazy。
- **artifact-intercept 不得静默截断 skill 内容**：技能 body / 子文件超大时，模型**分页完整读取**，而非被截断成残缺。
- **召回优先于收窄**：相关技能宁可多surface也不可漏——scope/过滤永远 additive，绝不硬删 registry。

## 装载模型（定稿·用户拍板）

**单一运行时来源 = `.rivet/skills/`（+ 内置）。运行时绝不扫描、绝不读取任何外部技能目录。**

- **默认不扫外部**：不再在运行时 in-place 扫 `~/.claude/skills` 或项目 `.claude/skills`。外部技能目录不与本仓技能混用。
- **外部技能 = 先复制进 `.rivet/skills/` 再装载**：用户/agent 把指定的那几个技能（目录型连同整个文件夹）拷进 `.rivet/skills/`，只装用户**显式指定**需要的。用户 Claude 开发目录里有 70 个技能、很多用不到甚至不知哪些没用——天枢绝不全量吃进来。
- **`.rivet/skills/` 同时支持两种形态**：扁平 `name.md`（Rivet 原生）+ 目录 `name/SKILL.md`（带 `references/`/`scripts/`/`assets/` 子文件夹，复制进来的 Claude 格式技能）。
- **`importFromClaude` 配置语义改为「复制」而非「扫描」**：bootstrap 时把列表中的技能名从 `.claude` 目录**拷贝**进 `.rivet/skills/`（幂等：已存在则跳过，保护本地修改），随后统一从 `.rivet/skills/` 装载。这就是"通过 claude 目录装到 rivet"。
- **agent 手动装载路径**：agent 用 bash `cp -r ~/.claude/skills/<name> .rivet/skills/<name>` 复制；当场即可用 `read_file .rivet/skills/<name>/SKILL.md` 立即使用（已在 workspace 内，无需授权）；下次会话 `loadProjectSkills` 自动纳入发现层。
- **无需跨 workspace 读授权**：技能永远在 workspace 内，本就可读——旧设计的 `grantSkillDirReads`（穿越 workspace 边界授权）**作废**，安全面更小。

## 背景

### 用户需求（澄清后）
开源后其他开发者/用户会装很多技能。要保证：
1. 大量 skill 装载**不污染 agent 上下文**；
2. agent 在用户使用技能时能**增量、渐进装载**；
3. 短技能可随便进上下文；**长/复杂/跨领域语言**技能不能一次全量进，要按需；
4. 有些技能是**多文件夹**结构（不同文件夹内容不同），要**正确按需读取后再使用**。

> 本仓库不装 Claude skill，是因为建设期靠 agent 自身能力——所以**本仓不是设计基准，下游用户才是**。（旧版文档误把"本仓只加载 1 个 skill"当作 overflow 是幻影的证据，已纠正。）

### 现状机制
两层渐进披露：Tier-1 发现层（`name+desc` 常驻 volatile，预算 1500 字符，`triggers` 正则排序 `relevant`）+ Tier-2 激活层（`skill` 工具 / `/skill` 取**完整 body**，零截断）。`src/skills/skill-loader.ts` + `src/tools/skill.ts`。

**关键缺口（相对下游需求）**：
- **缺第三级**：Claude 格式的多文件夹技能（`references/`、`scripts/`、`assets/`）被 `loadFromClaudeDirectory` **flatten 成单 body**，子文件丢失，无法按需读取。
- **Tier-2 一次性全量**：长技能 body 整块进上下文，无增量。
- **发现层不抗规模**：池大时 1500 预算溢出丢尾。
- **无按体量差异化**：短 / 长 / 超重技能一视同仁。

### 调研发现（5 scout）
- **竞品（scout1 + scout5）**：业界收敛于 **三级渐进披露**——L1 metadata 常驻（name ≤64 / description ≤1024 字符，~100 token）；L2 SKILL.md body（<500 行，触发时**整体**读入并持久化，作者写短作"路由"）；L3 子文件**仅通过作者在 body 里手写的链接**触达——**Claude 不自动暴露文件树**，也**不按体量分策略**：加载是统一机器，差异全靠作者约定。唯一真正的系统级污染杠杆是 **`context:fork`**（重技能在子上下文执行，只回摘要）。scripts 经 Bash + `allowed-tools` 预批 + workspace 信任门控。多文件标准 = agentskills.io（Claude Code/Copilot/Amp/Codex 共用）。
  > 注意：`context:fork` 是 Claude 专有；`allowed-tools` 实验性；15k 字符发现预算为社区来源。
- **跨域（scout2）**：① scope 作显式收窄对象；② **索引/桩与实体分离、首次引用才解析**（惰性绑定）；③ 声明式触发，判断下放给数据。
- **本仓（scout3）**：工具有 scope（域 toolWhitelist × profile × authority），skill 没有；子代理体系（coordinator/work-order/worker-session）已成熟，可复用做隔离执行。
- **反证（scout4）**：cache-safe = 事实（discovery 在 volatile，已 per-turn 变化，scope/过滤零新增缓存成本）；star-domain 是 persona 轴、session 内只绑一次，**不是 skill 的 scope 轴**。

---

## 三轮思考结论

### 第一轮：变异（5 方案）
| 方案 | 生态位 | 一句话 |
|------|--------|--------|
| V1 | 主流·Claude 三级披露 | 支持目录技能；L1 desc 常驻、L2 SKILL.md（短路由）、L3 子文件按需用 read_file/grep/glob 读 |
| V2 | 邻近·search 索引发现 | 池超阈值时 L1 只列 top-N + `search_skills(query)` 工具，池可上千不污染 |
| V3 | 空位·机器拆分 manifest | 预计算文件树+节标题+体量+语言+hash，L2 先给 TOC 再按节/文件拉 |
| V4 | 突变·子代理隔离执行 | 超重/跨语言技能委派 worker 装全量执行，主 agent 只收蒸馏结果（对齐 context:fork）|
| V5 | 空位·按体量装载策略 | 每技能 loadPolicy：inline / lazy / fork，系统按体量选 V1 还是 V4 |

### 第二轮：选择
- **灭绝 V3**：机器拆分早于需求；V1 用"作者把 SKILL.md 写短 + references/ 放重料"的**约定**即可达到同效，代价低一个量级（Claude 选约定不选机器）。**回收特征**：①manifest 的"文件树/节标题/语言"→ 嫁接 V1（`skill` 工具加载 body 时附带返回文件树，让 agent 知道有哪些子文件可读，否则盲探）；②hash → 子文件读取缓存稳定。
- **存活**：V1（骨干）/ V5（策略层）/ V4（隔离层）/ V2（规模层）。
- **最强竞争者 = V1 + V5 + V4 三层栈**，V2 在池极大时叠加。
- **收敛洞察**：V1 与 V4 收敛到 **粒度即纪律——能不进主上下文就不进；轻技能按级懒入，重技能整体卸载到子代理。**

### 第三轮：适应
扩展适应（复用，几乎不新造基础设施）：
1. **Tier-3 子文件读取 = 直接复用 read_file/grep/glob**，只需把解析出的 `skillDir` 暴露给 agent。
2. **V4 fork = 复用 coordinator/work-order/worker-session**，把"加载并执行某重技能"做成一类委派。
3. **scripts 执行 = 复用 bash 工具的审批/沙箱**（fail-closed），不新造执行通道。
4. **PlusMenu skill 开关 = 复用**为 per-session 启用/禁用大池技能。
5. **artifact-intercept = 复用**为超大子文件兜底。

---

## 最终方案：三级披露 + 按体量策略 + 子代理隔离（三相）

### Phase 1 — 三级披露底座（解决多文件夹按需读 + 发现层抗规模）
- **`.rivet/skills/` 支持目录技能**：`loadFromDirectory` 在扫扁平 `*.md` 之外，同时识别 `<name>/SKILL.md` 目录技能，不 flatten；`SkillDefinition` 新增 `skillDir` + 解析文件树（保留现有 `.rivet/skills/*.md` 扁平加载）。
- **运行时单一来源 + 复制式导入**：`loadProjectSkills` 只装内置 + `.rivet/skills/`；`importFromClaude` 改为 bootstrap 期把指定技能从 `.claude` 目录**拷进** `.rivet/skills/`（幂等），不再 in-place 扫外部。
- **`skill` 工具升级**：返回 SKILL.md 正文 **+ 该技能的文件树清单**（告诉 agent 有哪些 references/scripts/assets 可读），但**不自动读子文件**。
  > ⚠️ 这是**我们的增强，非 Claude 对齐**——Claude 只靠作者在 body 里手写链接。文件树作为"安全网"叠加在作者链接之上：作者链接是主路径，文件树兜底防止作者漏写链接时 agent 盲探。风险：树太大反而污染——超阈值时只列顶层目录 + 计数。
- **Tier-3 按需读**：agent 按 SKILL.md 指引，用现有 read_file/grep/glob 读子文件；**路径校验限定在 `skillDir` 内**（防逃逸）。
- **发现层规模硬化**：超预算时 top-N 相关 +（可选）`search_skills` 雏形。
- **成功标准**：一个多文件夹技能，主上下文只进 SKILL.md + 实际读到的子文件；池大时发现层不溢出。
- **退出条件**：若目录技能解析破坏现有扁平加载 → 回退为仅暴露 `skillDir`。

### Phase 2 — 按体量策略 + 超重隔离
- **loadPolicy**：`inline`（微技能，甚至可在 discovery 直接给 body）/ `lazy`（默认：metadata→body→subfile）/ `fork`（超重/跨语言）。作者 frontmatter 声明 + 体量启发式兜底（不纯自动猜）。
  > ⚠️ 这也是**我们的设计赌注，非竞品对齐**——Claude 加载统一、不分体量策略，只用 `context:fork` 一个杠杆。我们押注"按体量分策略"能比统一机器更省主上下文，但需 Phase 1 数据验证；若收益不明显，`loadPolicy` 收敛回"默认 lazy + 重技能 fork"两档。
- **fork**：重/跨语言技能委派 worker 子代理装载执行，主 agent 收蒸馏结果（复用 coordinator）；worker 继承收窄的工具/技能子集。
- **scripts/ 执行**：经 bash 审批沙箱（fail-closed）。
- **成功标准**：标 `fork` 的技能其 body+子文件**不出现在主上下文**；短技能 `inline` 直接可用。
- **退出条件**：若 fork 蒸馏损失太多上下文连续性 → 降级为 lazy + 显式确认。

### Phase 3 — 规模（数据驱动，可选）
- `search_skills` 语义检索 + 技能包/scope，**仅当**用户池真的上百且发现层成为瓶颈。
- **成功标准**：上千技能池下 Tier-1 token 占用恒定。
- **退出条件**：池不大则不做。

---

## 风险与应对
| 风险 | 应对 |
|------|------|
| agent 不知道技能里有哪些子文件 → 盲探 | `skill` 工具加载 body 时**必须随附文件树**（回收自 V3） |
| fork 蒸馏丢上下文连续性 | 重技能保留 `lazy` 退路 + 显式确认 |
| scripts / 子文件安全 | scripts 强制 bash 审批；技能已复制进 `.rivet/skills/`（workspace 内），子文件读天然受 workspace 边界保护，无需跨界授权 |
| 破前缀缓存 | discovery 留 volatile（事实）；`skill` 工具定义字节稳定；目录解析在 bootstrap 期，不进 prompt 静态区 |
| 大池污染 Tier-1 | 超预算 top-N + Phase 3 search 检索，发现层 token 恒定 |

## 设计偏差（相对旧版文档 / 用户原框架）
- 旧版把"本仓只加载 1 skill"当 overflow 是幻影的证据——**错**。设计对象是下游大池，overflow 与多级装载是核心目标。本版已整体重锚定。
- 用户说的"增量渐进装载" = 业界三级披露 + 我们缺的**第三级（子文件按需）**；"复杂跨语言不能全进"的最优解不是机器切碎（V3），而是**卸载到子代理**（V4）。

## 下一步（Phase 1 第一个具体动作）
让 `.rivet/skills/` 的 `loadFromDirectory` 在扫扁平 `*.md` 之外识别 `<name>/SKILL.md` 目录技能并**保留目录而非 flatten**，给 `SkillDefinition` 加 `skillDir` 字段并解析其文件树；随后让 `src/tools/skill.ts` 在返回 SKILL.md body 的同时附上该技能的文件树清单（相对 `skillDir` 的路径列表），Tier-3 读取沿用现有文件工具（技能在 workspace 内，天然受边界保护）。外部技能先复制进 `.rivet/skills/`：
```text
.rivet/skills/pdf-extract/   ← 从 ~/.claude/skills/pdf-extract 复制而来
├── SKILL.md          ← L2: 短路由，载入主上下文
├── references/
│   ├── api.md        ← L3: 用到才 read_file
│   └── examples.md
├── scripts/
│   └── extract.py    ← L3: 经 bash 审批执行
└── assets/template.json
```
