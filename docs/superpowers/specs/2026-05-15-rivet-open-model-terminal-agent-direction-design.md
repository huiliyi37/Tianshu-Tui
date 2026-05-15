# Rivet 开源模型终端代理方向深度头脑风暴结果

## 背景

- **用户需求：** 你已经安排其他智能体按性能优化实施文档协作开发；当前需要更上层的方向性建议。
- **项目目标：** 推广开源，并提高开源/开放模型在终端开发代理中的能力上限，让 Rivet 在开发能力与高可用能力上不弱于 Claude Code、opencode 等主流工具。
- **项目上下文：** Rivet 已有 TypeScript + Ink TUI、DeepSeek Anthropic-compatible SSE、provider capability 抽象、prefix fingerprint、cache hit 展示、approval gate、session persistence、compaction 与工具执行主链路。
- **我先假设：** 目标不是做一个“低价 Claude Code 复刻”，而是做一个能让开源模型在真实 repo editing 中更可靠、更可验证、更易恢复的本地终端代理。

## 调研发现摘要

1. **本项目代码资产：** 现有代码已经把 provider capabilities、prefix fingerprint、cache-hit 可视化、streaming callback、approval gate、session persistence 分成了相对独立的模块；这说明 Rivet 适合向“可观察、可恢复、可验证”的工程体验演进。
2. **相邻项目启发：** Aider 证明 repo editing + git-native test/diff/commit loop 成熟；Tabby 证明自托管与隐私部署有市场；ECA 证明协议化扩展强但配置成本会变高；Clay 证明 TUI workflow polish 有价值。空位不是“再做一个编辑器助手”，而是持续可见的 agent intent、tool queue、diff、test status 与 rollback point。
3. **外部可靠性类比：** 航空 checklist、SRE incident command、数据库 quorum 的共同点不是“更聪明”，而是让系统在操作者犯错、证据不完整、局部失败时仍然拒绝假成功。
4. **反证发现：** “信任座舱”可能变成仪式感 UI；cache-first 可能只是实现细节；role boundary 可能拖慢用户；evidence quorum 可能制造两个弱证据的假信心。因此最终方案必须是默认轻量、风险时展开、证据强相关，而不是把所有流程都变成审批。

---

## 三轮思考过程

### 第一轮：变异

[VARIATION]

**生态位：** 本地终端中的 repo editing 代理；面向开源/开放模型；需要长上下文、工具调用、多文件修改、测试验证、失败恢复和低成本运行。

**选择压力：**
- 用户会用主流工具的 raw task success 来比较 Rivet。
- 开源模型在 tool-use、长上下文、稳定输出、恢复策略上更需要产品层补强。
- 终端产品必须低摩擦，不能把每次编辑都变成流程仪式。
- 开源推广需要可贡献、可复现、可解释，而不是只有作者本机能跑。

**已占据：**
- 主流编码代理：强调端到端任务成功率、模型能力和工具生态。
- repo editing 工具：强调 git diff/test/commit loop。
- 自托管助手：强调隐私、部署和多模型。

**空位：**
- 面向开源模型的“能力实验室”：清楚展示不同模型在读代码、改代码、工具调用、长上下文、成本和失败恢复上的能力边界。
- 本地“信任座舱”：让 agent 的计划、证据、动作、成本、回滚点持续可见，但只在风险上升时增加摩擦。

**方案：**

- **V1（主流 / parity baseline）：** 让开发者在已有 repo 中用 Rivet 完成与主流工具接近的多文件修改、测试、提交和恢复。
- **V2（邻近 / open-provider lab）：** 让维护者用任务矩阵评估和路由开源/开放模型，知道哪个模型适合读代码、改代码、跑工具和总结。
- **V3（空位 / trust cockpit）：** 让开发者在高风险修改前看到计划、证据、工具队列、diff、测试和回滚点，再决定是否放行。
- **V4（突变 / plugin ecosystem first）：** 让工具作者先围绕 Rivet 发布 provider、tool、hook、skill pack，用户按工作流组装自己的编码代理。

**创始假设：**
- 假设“能力不弱于主流工具”必须通过完全复刻主流工具实现；这个假设会关闭差异化空间。
- 假设“开源推广”主要靠插件生态；但没有核心用户场景时，生态会先变成空市场。
- 假设“高可用”是后端系统问题；在本地开发代理里，高可用更具体地表现为可恢复、可审计、可中断、可继续、可解释失败。
- 假设用户愿意看 cockpit；这个假设未验证，必须设计成风险触发、按需展开。

**适应度函数：**
- **硬约束：** 必须提升真实 repo task success；必须保持终端低摩擦；必须支持本地恢复；必须让开源贡献者能复现问题和贡献修复。
- **加分：** 能复用现有 cache/session/provider/approval 架构；能产生公开 benchmark 或能力卡；能降低开源模型使用成本；能让失败样本变成社区资产。
- **减分：** 做成主流工具复刻；先做生态后做核心场景；用弱证据制造安全错觉；把所有操作都审批化。

---

### 第二轮：选择

[SELECTION]

**目标重注入：** 原始目标是“推广开源，提高开源模型在终端工具开发中的能力上限，使开发能力和高可用能力不弱于 Claude Code、opencode 等主流工具”。因此方案必须同时回答：能力上限、开源传播、高可用、主流可比性。

**因果测试：**
- **V1：通过但不够。** 复刻主流能力能提高可比性，但因果链只到“追上别人”，无法解释为什么用户要选 Rivet。
- **V2：通过。** 任务矩阵与能力卡能让开源模型短板显性化，进而指导 provider routing、prompt/tool 设计和社区贡献。
- **V3：通过。** 开源模型不稳定时，产品层的 preflight、证据、checkpoint、role boundary 可以直接降低失败代价，提高用户敢用的任务半径。
- **V4：断裂。** 先做插件生态并不能自然带来用户；没有高频核心场景时，插件作者也没有贡献动机。

**证据分层：**
- **事实：** Rivet 当前是 TypeScript + Ink 本地 TUI；真实 repo editing 必须面对 git 状态、文件修改、测试失败、工具错误和用户中断。
- **现状：** provider 默认 DeepSeek-first；session persistence 和 compaction 已有但还不足以支撑完整 checkpoint/replay；这些都可以改。
- **惯例：** repo map、git safety rails、role separation、preflight checklist 是相邻项目和可靠性领域惯例，可以借鉴但不能照搬成繁琐流程。
- **假设：** 用户重视 trust cockpit、cache 可视化、provider routing；这些需要 Phase 1/2 用真实任务验证。

**成本测试：**
- **V1：成本高，收益必要但不差异化。** 要追平主流工具需要补齐 repo map、MCP、子代理、hook、测试循环、恢复等能力；适合作为基线，不适合作为定位。
- **V2：成本中，收益高。** 需要构建 eval harness、model capability card、provider conformance tests；这会支撑开源推广，但用户每天打开产品不一定是为了看评测。
- **V3：成本中高，收益最高。** 需要 TUI 状态架构、checkpoint、evidence model、risk scoring；但它把高可用和能力上限直接变成用户可感知体验。
- **V4：成本高，收益后置。** 插件生态的维护、文档、版本兼容成本会先到，用户规模和贡献规模不会自动出现。

**共演化：**
- **V1：静态偏多。** 主流工具变强，Rivet 就被迫追；技术不主动驱动社区。
- **V2：动态。** 模型能力评测会反过来驱动 prompt、tool schema、provider adapter、benchmark 样本迭代。
- **V3：动态。** 用户失败样本会反过来驱动 evidence quorum、checkpoint、approval mode、tool UX 迭代。
- **V4：过早。** 生态需要核心场景喂养，否则插件机制与用户需求脱节。

**局部最优：** V1 是最安全但也是局部最优。它能让项目看起来更像主流工具，但会把战略问题变成“谁模型更强、谁生态更大”。Rivet 更应该把 V1 变成能力基线，把 V3 作为体验楔子，把 V2 作为开源模型上限提升的底座。

**落地性：**
- **V1 第一步：** 列 Claude Code/opencode/Aider 的能力基线矩阵，补齐最短板能力。可执行，但没有差异化。
- **V2 第一步：** 建一个 20 个真实 repo tasks 的 provider conformance suite。可执行，适合开源传播。
- **V3 第一步：** 在 TUI 中实现 preflight checklist + action log + rollback checkpoint 的最小闭环。可执行，直接提升高可用感知。
- **V4 第一步：** 定义 plugin/skill pack API。可执行但时机过早，缺少核心使用压力。

**灭绝：**
- **V1 作为核心定位灭绝。** 原因：它会把 Rivet 带入 head-on clone 竞争，短期被主流工具生态和模型能力压制。保留特征：能力基线矩阵、git-native safety rails、常用工具覆盖。
- **V4 作为第一阶段主线灭绝。** 原因：先做生态会在用户规模不足时变成空插件市场。保留特征：插件边界、provider recipe、workflow pack 分发。

**存活：**
- **V3：最强。** 因为它把高可用、开源模型不稳定性、终端可视化、现有代码资产连成一条因果链。
- **V2：作为支撑底座存活。** 因为它能把开源模型能力上限变成可复现、可贡献、可比较的公开资产。

**最强竞争者：** V3 + V2 组合：Trust Cockpit + Open Model Capability Lab。

**新发现：** “不弱于主流工具”不应该理解成 UI 或功能逐项复刻，而应该拆成两个指标：
1. **任务完成能力不弱：** 用 V1 的能力基线和 V2 的任务矩阵衡量。
2. **失败恢复能力更强：** 用 V3 的 evidence、checkpoint、role boundary、rollback 衡量。

**discarded_trait 回收：**
- 从 V1 回收“能力基线矩阵”，用于定义与主流工具可比较的任务集。
- 从 V1 回收“git-native safety rails”，并入 V3 的 checkpoint/diff/rollback。
- 从 V4 回收“provider recipe / workflow pack”，等 V2/V3 稳定后作为社区贡献入口。

---

### 第三轮：适应

[ADAPTATION]

**套路清除：**
- 清除“做成 Claude Code 平替”的套路：这会让项目永远跟随。
- 清除“支持所有模型”的套路：没有 capability routing 和任务矩阵时，多模型只是配置表。
- 清除“做插件生态”的套路：没有高频核心场景时，生态不会自发生长。
- 清除“安全就是多确认”的套路：多确认会降低效率；真正的安全是有证据、有回滚、有边界、有失败解释。

**扩展适应：**
- 现有 prefix fingerprint 和 cache-hit 展示 → 扩展为 context stability / cost evidence，让用户知道为什么这轮请求便宜或昂贵。
- 现有 session persistence → 扩展为 checkpoint / replay / rollback 基础。
- 现有 provider capabilities → 扩展为 model capability card 和 task routing。
- 现有 approval modes → 扩展为 risk-triggered approval，而不是所有动作一刀切。
- 现有 tool stream callbacks → 扩展为 action log 和 evidence trail。

**具体化：**
- **人：** 使用开源/开放模型做真实 repo 修改的开发者、维护者、模型调优者和团队内部工具负责人。
- **场：** 本地终端、真实 git repo、长会话、多文件修改、需要测试/回滚/审查的任务。
- **动：** 用户输入开发目标后，Rivet 先生成可见 plan 和 preflight；执行时展示 tool queue、streaming evidence、diff preview、test result、cache/cost；风险上升时才要求确认。
- **果：** 不是抽象的“更可靠”，而是：失败后 2 分钟内恢复；高风险修改 100% 有 rollback path；关键结论带证据标签；同一任务能跨至少 3 个模型复现或解释失败原因。

**收敛验证：** V2 和 V3 收敛到同一洞察：开源模型能力上限不是单靠模型参数提升，而是靠“任务定义、上下文稳定、工具协议、证据反馈、失败样本”共同抬升。V1 的 baseline traits 也收敛到这里：能力必须可衡量，不能只靠 demo。

## 最终方案

**方向名称：Trust Cockpit + Open Model Capability Lab**

Rivet 的主方向应是：

> 面向开源/开放模型的本地 repo editing 信任座舱。它保持主流编码代理所需的核心能力基线，但把差异化放在可观察、可恢复、可验证、可复现上；同时用公开任务矩阵和 capability cards 持续提高开源模型在终端开发代理中的能力上限。

### Phase 1：Trust Cockpit MVP

**具体动作：**
1. 在每次高风险任务前生成 preflight checklist：branch、dirty files、target files、planned commands、rollback path。
2. 在 TUI 中展示 action log：agent 将要做什么、正在调用哪个工具、产出的证据是什么。
3. 每轮修改前创建轻量 checkpoint：至少能展示 diff、撤销本轮文件修改、恢复 session。
4. 给最终回答加 evidence badge：已读文件、已修改文件、已运行测试、未验证项。
5. cache/cost panel 默认折叠，只有上下文压力或费用异常时展开。

**预期产出：** 用户在真实 repo 中能看懂 agent 为什么要做某个动作，并在失败时快速恢复。

**成功标准：**
- 10 个真实 repo 任务中，每个高风险动作都有证据来源和回滚路径。
- 失败后可在 2 分钟内恢复到上一 checkpoint。
- 用户不需要为低风险读文件/搜索动作额外确认。

**退出条件：** 如果 cockpit 明显增加输入阻力，把 cockpit 改成默认折叠，只在风险动作、失败、测试不通过、上下文压力升高时展开。

### Phase 2：Open Model Capability Lab

**具体动作：**
1. 建立 provider conformance tests：SSE、tool_use、tool_result、thinking、usage mapping、abort/retry、JSON recovery。
2. 建立 repo task matrix：读代码、单文件修复、多文件重构、测试失败修复、长会话恢复、工具错误恢复。
3. 为每个 provider/model 生成 capability card：上下文窗口、缓存经济性、tool-use 成功率、失败类型、推荐任务。
4. 将 capability card 接入 runtime routing：某类任务默认推荐更合适的模型或参数。

**预期产出：** 开源模型能力不再停留在口碑，而是有可复现的任务证据。

**成功标准：**
- 至少 3 个 provider/model 能跑同一任务矩阵。
- 每次失败能分类为模型输出问题、工具协议问题、上下文问题、项目实现问题或测试环境问题。
- 用户能看到“为什么这个任务推荐这个模型”。

**退出条件：** 如果用户不关心 provider 细节，只保留自动路由和失败解释，把 capability card 放到 docs/benchmark 页面。

### Phase 3：Community Distribution

**具体动作：**
1. 发布 model recipe：每个模型的参数、限制、推荐任务、已知坑点。
2. 发布 workflow pack：常见任务如 bugfix、refactor、test-repair、docs-update、release-check。
3. 发布 benchmark issue 模板：社区可以提交失败样本、复现命令、期望行为。
4. 将 provider recipe / workflow pack 变成无需改核心代码即可贡献的格式。

**预期产出：** 开源贡献不只发生在代码层，也发生在模型适配、任务样本、失败样本、工作流包。

**成功标准：**
- 外部贡献者能新增一个 provider recipe 或 workflow pack，不需要改核心代码。
- 失败样本能进入任务矩阵，下一轮 release 可看到是否修复。
- README 中能用真实任务指标说明 Rivet 如何提升开源模型开发代理能力。

**退出条件：** 如果贡献门槛太高，先维护官方 packs，延后插件市场。

## 最强适应点

Rivet 的最强适应点不是“也能调用工具”，而是把开源模型在 repo editing 中的弱点转化为产品机制：

- 模型不稳定 → evidence trail + failure classification。
- 长上下文昂贵 → prefix fingerprint + cache/cost visibility。
- 工具调用容易错 → provider conformance + tool protocol tests。
- 自动修改风险高 → checkpoint + diff + rollback。
- 开源推广难 → task matrix + capability card + reproducible failure samples。

## 脆弱点与应对

1. **脆弱点：trust cockpit 变成仪式感 UI。**
   - **应对：** 默认折叠，风险触发展开；低风险读/搜/解释不增加确认。

2. **脆弱点：能力不够时，方向再好也会被主流工具 raw task success 打败。**
   - **应对：** 保留 V1 的能力基线矩阵，优先补齐 repo map、测试循环、diff/checkpoint、恢复能力。

3. **脆弱点：evidence quorum 变成两个弱证据制造假信心。**
   - **应对：** 证据必须任务相关；例如“修改代码”至少需要 diff + typecheck/test，而不是“读了两个文件”。

4. **脆弱点：多 provider 抽象变成配置复杂度。**
   - **应对：** 用户默认只看到推荐模型；高级用户再展开 capability card 和 routing 原因。

5. **脆弱点：开源社区不知道如何贡献。**
   - **应对：** 把贡献入口拆成四类：provider recipe、workflow pack、failure sample、benchmark task；不要求所有贡献者都改核心代码。

## 下一步

Phase 1 的第一个具体动作：

> 在现有性能优化实施计划之外，新增一个“Trust Cockpit MVP”实施计划：先实现 preflight checklist、action log、evidence badge、checkpoint/diff/rollback 的最小闭环，并用 10 个真实 repo 任务验证它是否减少失败恢复时间，而不是增加操作负担。

## 规格自检

- **占位符扫描：** 未包含“待定”、“TODO”或未定义步骤。
- **内部一致性：** V1/V4 作为主线被淘汰，但其可迁移特征被 V2/V3 吸收。
- **范围检查：** 该方向可以拆成一个独立实施计划：Trust Cockpit MVP；V2/V3 的后续阶段可分计划推进。
- **模糊性检查：** “高可用”已具体化为 checkpoint、rollback、evidence、failure classification、resume；“能力上限”已具体化为 task matrix、capability card、provider conformance。
