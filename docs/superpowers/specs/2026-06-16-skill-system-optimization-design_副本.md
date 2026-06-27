# Skill 体系优化 — 深度头脑风暴结果

> 2026-06-16 · deep-brainstorm（变异→选择→适应）· 4 scout 调研（竞品 / 跨域 / 本仓数据模型 / 反证）

## 背景

### 用户需求（原话）
> 需要单独对 SKILL 做一轮优化，比如按需加载、按 skill 范围装配技能范围；用深度思考 + 多个子代理去外部领域和竞品找最佳实现，然后设计优化我们的 skill 体系。

### 项目上下文（现状机制）
天枢已实现两层渐进式披露：
- **Tier-1 发现层**：每轮把所有已加载 skill 的 `name+description` 渲染成 `<available-skills>` 块，注入 dynamic appendix（volatile，cache-safe）。命中 `triggers` 正则的标 `relevant="true"` 排前。预算 1500 字符 / 单条 200。（`src/skills/skill-loader.ts:175`）
- **Tier-2 激活层**：模型调 `skill(name)` 工具 / 用户 `/skill <name>`，取完整正文，零截断。（`src/tools/skill.ts`）

数据模型 `SkillDefinition`：`name, description, triggers, body, tierLock?(未消费), source?, bodyPath?`。
加载源：`.rivet/skills/*.md`（始终扫）+ `.claude/skills/*/SKILL.md`（需 `config.skills.importFromClaude` 白名单）。

**已有的 scope 先例**：星域 `toolWhitelist` × profile `allowedTools` × authority 已构成成熟的**工具**范围装配（worker 侧），但 **skill 完全在这套抽象之外**。

### 调研发现摘要（4 个子代理）
- **竞品**：业界收敛于 SKILL.md 渐进披露（metadata 常驻、body 惰性）+ 模型按 `description` 自选 + glob/`applyTo` 路径 scope + 目录深度覆盖 + read-only 缓存标记。选择是**概率性**的，非硬门。
- **跨域（惰性装配）**：最强三原则 = ① scope 作为**显式、单调收窄的对象**（capability + lockfile）；② 索引/桩与实体分离、**首次引用才解析**（惰性绑定）；③ **声明式触发，判断下放给数据**（VSCode 激活事件 + ECS 查询）。
- **本仓数据模型**：工具有 scope，skill 没有；`tierLock` 与 profile 同枚举但 skill 侧未消费；profile/domain 与 `skillRegistry` 无连接。
- **反证（杀假设）**：见下「证据分层」。

### 证据分层（反证 scout 裁定）
| 前提 | 裁定 | 关键证据 |
|------|------|----------|
| A. Discovery overflow 是真问题 | **[假设] 不成立**（默认）/ 仅 opt-in 大量导入时部分成立 | 本仓 0 个 `.rivet/skills`，默认仅 1 个 builtin（`leave-ritual`）；`importFromClaude:[]`；实测 ~300–400 字符 vs 1500 预算 |
| B. 按 scope 变 discovery 是 cache-safe | **[事实] 成立** | skill block 仅在 `buildDynamicAppendix`（`volatile.ts:361`），从不进 frozen；且已 per-turn 随 userInput 变化 → scope 过滤零新增缓存成本 |
| C. Scoping 不伤 recall | **[现状] 部分成立** | 当前是「全量清单 + 模型自选」(Claude 哲学)；隐藏即不可见；**无任何激活/漏激活 telemetry**（trajectory 无 skill 项） |
| D. star-domain 是 skill 正确 scope 轴 | **[现状] 不成立** | domain 在 session 内只 bind 一次（`loop.ts:522`）、是 persona/methodology 轴（volatileBlock）；`toolWhitelist` 各域几乎相同；与 skillRegistry 无连接 |

**最弱前提 = A**：优化的首要动机（缓解 overflow）在本仓默认配置下是尚未发生的幻影。

**结论性反转**：用户被「scope/范围」一词带偏。真实内核不是「skill 太多需要筛」，而是「**池子加载得太少、没接进来、且零观测**」。正确顺序是 **populate + 度量 → compose + scope**。

---

## 三轮思考过程

### 第一轮：变异
生态位：Rivet skill 子系统 —— 渐进披露已实现，但池近空、零观测、范围/装配缺位。
创始假设（已被反证推翻）：用户隐含「skill 太多需按范围筛」；实测是「加载太少且未接入」，倒因为果。

| 方案 | 生态位 | 一句话核心 |
|------|--------|-----------|
| V1 | 主流·竞品对齐 | skill frontmatter 加 `globs/applyTo/alwaysApply` 声明式路径 scope |
| V2 | 邻近·搭车工具 scope | skill 带 domain/role 标签，复用 star-domain/profile 装配 |
| V3 | 空位·先度量再优化 | 精选默认 manifest（安全纳入 5 个高价值 skill）+ 激活埋点（shown/loaded/referenced/missed）|
| V4 | 突变·显式技能包 | skill-pack：命名+版本锁定的清单，一键装配一组 skill，子代理继承收窄子集 |
| V5 | 空位·语义激活 | 语义/同义词匹配替换纯正则 relevant |

适应度函数：硬约束 = cache-safe + fail-closed + 不回退 Tier-1/2；加分 = 解决已验证缺口 / 零代码可扩展 / 可组合 / 复用 PlusMenu skill 开关；减分 = 为未发生规模叠复杂度 / 隐藏伤 recall 无 baseline / 绑错轴。

### 第二轮：选择
- **灭绝 V2**：premise D 证伪 —— domain 是 persona 轴、session 内不切换、与 skillRegistry 无连接，domain≠capability，因果断裂。
- **降级 V5**：每轮语义匹配引入 embedding/LLM 代价，威胁「volatile 便宜」属性，且无 baseline 证明正则不足。回收廉价子集「同义词扩展」并入 V3。
- **V1 通过但动机弱**：glob scope 在本仓解决非问题（A），是典型局部最优；路径精度提升是真实次要收益，留作 Phase-3 备选。
- **存活**：V3（强·地基）/ V4（中·用户「范围装配」的成熟形态）/ V1（弱·备选）。
- **最强竞争者 = V3+V4**。
- **discarded_trait 回收**：V2 的「复用既有抽象而非新建子系统」→ 嫁接 V4（pack 复用 profile-registry 模式）；V5 的「同义词扩展」→ 廉价版并入 V3。

### 第三轮：适应
- **套路清除**：删「抄竞品 glob scope」条件反射（解决本仓不存在的 overflow）+ 删「scope 一切」高概念。
- **扩展适应（复用已有资产，几乎不新造基础设施）**：
  1. 复用刚交付的 PlusMenu skill 开关（`loop.ts _disabledSkills` / `session-manager setSkillEnabled` / SSE）作为 pack 选择运行时入口。
  2. 复用 profile-registry / star-domain 的 `loadFromDirectory` 模式做 skill-pack 加载。
  3. 复用 evidence-tracker / trajectory 通道挂 skill 激活埋点。
  4. 复用 work-order 的 attenuation 模式（profile ∩ authority）做子代理 skill 子集继承。
- **收敛洞察**：V3 与 V4 收敛到 **顺序即正确性：先 populate+度量，再 compose+scope**。

---

## 最终方案（三相，每相有数据退出条件）

### Phase 1 — 地基：populate + observe
- 审定默认 skill manifest：把高价值 skill（brainstorming、deep-brainstorm、writing-plans、executing-plans、subagent-driven-development）经**白名单**安全纳入默认加载（不是 70+ 全量）。
- skill 激活埋点：`shown / loaded / referenced / missed`，走现有 trajectory/evidence 通道。
- relevance 廉价增强：关键词同义词扩展（V5 回收特征），不引入 embedding。
- **成功标准**：trace 可见 skill 激活事件；5 个 skill 出现在 discovery。
- **退出条件**：若埋点显示 skill 无人用 → 停在 Phase 1，不做 pack。

### Phase 2 — 装配：用户的「范围装配」（显式对象）
- skill-pack schema + loader（`.rivet/skill-packs/*` 或 config），命名 + 版本锁定（lockfile 思想）。
- PlusMenu 增「切换 skill pack」入口（复用现有 toggle 基础设施）。
- 子代理 attenuated 继承：worker skill 集 ⊆ 父集（复用 work-order ∩ 模式）。
- **成功标准**：选一个 pack 后 discovery 只列该 pack 的 skill；子代理 skill 集 ⊆ 父集。
- **退出条件**：若 Phase 1 数据显示单一全局集已够用 → pack 降级为可选高级特性。

### Phase 3 — 精度：数据驱动（可选）
- glob/路径 scope（V1）+ 语义 relevance（V5），**仅当** Phase 1 埋点证明 mis-activation/overflow 真实存在。
- **成功标准**：mis-activation 率较 Phase 1 baseline 下降。
- **退出条件**：baseline 无问题则不做。

---

## 风险与应对
| 风险 | 应对 |
|------|------|
| 隐藏 skill 伤 recall（无 baseline） | scope 永远 **additive**：in-scope 优先排序 + out-of-scope 仍可被 `skill` 工具按名加载；**绝不从 registry 硬删**；Phase 3 必须用 Phase 1 baseline 把门 |
| 在幻影上叠复杂度 | 每相有数据退出条件；Phase 1 先建度量，无数据不进 Phase 2/3 |
| 破前缀缓存 | discovery 留 volatile appendix（事实 B）；skill 工具定义保持字节稳定；manifest/pack 解析在 bootstrap 期，不进 prompt 静态区 |
| 安全 footgun（误载 70+ / 任意执行） | 默认 manifest 走显式白名单；pack 不引入 skill 内联 shell 执行 |

## 设计偏差（相对用户原始框架）
用户以「按 skill 范围装配」为入口，隐含「skill 多到需要筛」。反证 scout 实测推翻：本仓默认仅 1 个 skill 加载、零观测。因此方案把「范围装配」从 Phase 1 后移到 Phase 2，先补「池子填实 + 可度量」这块用户未点名但更基础的缺口。「范围装配」本身保留为 Phase 2 的核心交付，并改用**显式 skill-pack 对象**（绕开被证伪的 star-domain 轴）。

## 下一步（Phase 1 第一个具体动作）
定义审定默认 skill manifest 的数据形态（在 `config.skills` 下新增 `defaultPack: string[]` 或内置 curated 列表），并在 `loadProjectSkills` 中按白名单加载——同时在 `renderDiscoveryBlock` 调用点挂第一个 `skill_shown` 埋点。
