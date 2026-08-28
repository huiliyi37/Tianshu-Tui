# 天枢文档索引

> 本文件由 `scripts/docs-index.ts` 自动生成（`npm run docs:index`），请勿手工编辑。
> 文档规范见 [README.md](README.md)；思维导图见 [MINDMAP.md](MINDMAP.md)（markmap 渲染）。

共 1035 篇，其中 34 篇带 frontmatter。

## 概览

| 类型 | 职责 | 数量 |
|------|------|------|
| `plan` | 执行计划 | 350 |
| `spec` | 事前规格 | 213 |
| `design` | 技术设计 | 58 |
| `analysis` | 分析复盘 | 174 |
| `research` | 外部调研 | 21 |
| `changelog` | 变更记录 | 48 |
| `issue` | 问题追踪 | 33 |
| `release` | 版本发布 | 22 |
| `guide` | 手册指南 | 14 |
| `reference` | 参考资料 | 49 |
| `unclassified` | 未分类 | 53 |

## plan — 执行计划（350）

| 日期 | 文档 | 状态 |
|------|------|------|
| 2026-07-31 | [桌面端滚动"收缩钳位上移"修复——virtual-core 补偿谓词落地](plans/2026-07-31-desktop-scroll-clamp-compensation.md) | active |
| 2026-07-31 | [桌面端滚动跟随态几何脱节修复——内容几何守望者](plans/2026-07-31-desktop-scroll-follow-geometry-watcher.md) | active |
| 2026-07-31 | [桌面端自动更新国内加速——阿里云 OSS 双通道](plans/2026-07-31-desktop-update-china-oss.md) | active |
| 2026-07-31 | [星河集群（galaxy）天枢设施复用优化落地计划](plans/2026-07-31-galaxy-prewarm-and-cache-affinity.md) | draft |
| 2026-07-31 | [右栏文件树开合卡顿优化——首开常挂载保活](plans/2026-07-31-review-panel-open-jank-keepalive.md) | active |
| 2026-07-28 | [Worker 活动事件类型清理 — 后续待办](tasks/2026-07-28-worker-activity-type-cleanup.md) | — |
| 2026-07-26 | [CLI 端分波优化实施计划（对标 Claude Code）](superpowers/plans/2026-07-26-cli-optimization-waves.md) | — |
| 2026-07-26 | [沙箱构建兼容性 —— 从开关到边界 实现计划](superpowers/plans/2026-07-26-sandbox-build-compat.md) | — |
| 2026-07-23 | [Wave B — convergence 核销闭环接线 + courage 计险收严 实现计划](superpowers/plans/2026-07-23-wave-b-convergence-expect-courage.md) | — |
| 2026-07-21 | [议事会 Da'at 编译门（Phase 1）实现计划](superpowers/plans/2026-07-21-council-daat-compile-gate.md) | — |
| 2026-07-21 | [交接资产回流（Deliverable Asset Reflow）实现计划](superpowers/plans/2026-07-21-deliverable-asset-reflow.md) | — |
| 2026-07-18 | [P3 认知帧与回放底座——可执行计划（修正版）](superpowers/plans/2026-07-18-cognitive-frame-p3.md) | — |
| 2026-07-18 | [P2 阴阳调度实现计划](superpowers/plans/2026-07-18-yinyang-scheduling-p2.md) | — |
| 2026-07-17 | [Windows PowerShell (legacy conhost) 渲染修复实现计划](superpowers/plans/2026-07-17-powershell-conhost-rendering.md) | — |
| 2026-07-14 | [桌面封版单架构裁剪 + 启动瘦身 实现计划](superpowers/plans/2026-07-14-desktop-single-arch-bundle.md) | — |
| 2026-07-07 | [功能星任务书：分发工程 — 对标 CodeWhale 的安装体验](tasks/2026-07-07-distribution-engineering.md) | — |
| 2026-07-07 | [功能星任务书：插件市场 + 办公插件三件套（PDF / Excel / PPT）](tasks/2026-07-07-plugin-market.md) | — |
| 2026-07-05 | [Appendix Delta 自闭合优化 实现计划（修订版）](superpowers/plans/2026-07-05-appendix-delta-self-close.md) | — |
| 2026-07-03 | [桌面端全面审计 + 圆角设计语言改造 计划](superpowers/plans/2026-07-03-desktop-audit-rounded-redesign.md) | — |
| 2026-07-02 | [/council 工具门控错配修复（workflow 声明所需 EXTENDED 工具 + 提交路径自动挂载） 实现计划](superpowers/plans/2026-07-02-council-extended-tool-mount.md) | — |
| 2026-07-02 | [Dead-end 信息素噪音链修复 + maxTurns 放宽 实现计划](superpowers/plans/2026-07-02-deadend-noise-and-maxturns.md) | — |
| 2026-07-02 | [Windows EPERM 根因修复 · 工具层静默跳过系统目录（修订版 v2）](superpowers/plans/2026-07-02-eperm-root-fix.md) | — |
| 2026-07-02 | [WatchdogRecoveryPolicy 共享类提取 + 桌面端 session-manager 接线 实现计划](superpowers/plans/2026-07-02-watchdog-recovery-policy-desktop.md) | — |
| 2026-07-02 | [Watchdog Stall 恢复：进度感知计数 + 通用场景覆盖（修订版 v3）](superpowers/plans/2026-07-02-watchdog-session-total-stall-gap.md) | — |
| 2026-06-29 | [L1 Suggest 消费端接入 — TDD 探针注入](superpowers/plans/2026-06-29-l1-suggest-tdd-probe-wiring.md) | — |
| 2026-06-28 | [计划方法论基础模板（Base）](superpowers/plans/2026-06-28-plan-methodology-base.md) | — |
| 2026-06-27 | [team 模式计划感知与粗粒度派发 实现计划](superpowers/plans/2026-06-27-team-plan-aware-dispatch.md) | — |
| 2026-06-25 | [ask_user_question 重复调用修复计划](superpowers/plans/2026-06-25-ask-user-question-endturn-fix.md) | — |
| 2026-06-25 | [GoalMode 状态机升级计划](superpowers/plans/2026-06-25-goal-mode-state-machine.md) | — |
| 2026-06-25 | [Subagent 持久化与 Resume 能力计划](superpowers/plans/2026-06-25-subagent-persistent-resume.md) | — |
| 2026-06-25 | [编排前置门控实现计划](superpowers/plans/2026-06-25-编排前置门控.md) | — |
| 2026-06-25 | [编辑工具与压缩工具优化设计](superpowers/plans/2026-06-25-编辑工具与压缩工具优化设计.md) | — |
| 2026-06-25 | [跨波次失败传播与指数退避重试 实现计划](superpowers/plans/2026-06-25-跨波次失败传播与指数退避重试.md) | — |
| 2026-06-24 | [Goal 完成检测 Judge — 链路后续实现计划](superpowers/plans/2026-06-24-goal-judge-followups.md) | — |
| 2026-06-24 | [经络图全链路统一 —— 影响分析接入计划](superpowers/plans/2026-06-24-meridian-unify-impact-analysis.md) | — |
| 2026-06-24 | [Spec-to-Execute Verification Gate 实现计划](superpowers/plans/2026-06-24-spec-to-execute-verification-gate.md) | — |
| 2026-06-23 | [统一信号注入通道——完成 injectUserMessage 向 AdvisoryBus 迁移](superpowers/plans/2026-06-23-unify-signal-injection-channel.md) | — |
| 2026-06-22 | [天枢（Rivet）官方落地页 实现计划](superpowers/plans/2026-06-22-tianshu-official-landing-page.md) | — |
| 2026-06-22 | [噪音信号三源头修复 实现计划](superpowers/plans/2026-06-22-噪音信号三源头修复.md) | — |
| 2026-06-22 | [天枢官方落地页 · 视觉设计落地 实现计划](superpowers/plans/2026-06-22-根据这个设计方案-自行决定页面的美化布局和设计落地-方案仅供参考-doc.md) | — |
| 2026-06-22 | [静态注入体量压缩 实现计划](superpowers/plans/2026-06-22-静态注入体量压缩.md) | — |
| 2026-06-21 | [开发前边界扫描——提示词注入](superpowers/plans/2026-06-21-pre-coding-boundary-scan-prompt-injection.md) | — |
| 2026-06-21 | [Review Worker 模型路由可配置化 实现计划](superpowers/plans/2026-06-21-review-worker-model-routing-config.md) | — |
| 2026-06-21 | [会话日志移出项目目录 实现计划](superpowers/plans/2026-06-21-得了会话日志丢到项目外去.md) | — |
| 2026-06-20 | [Session-Mutating Collapse Cache-Aware Gate 实现计划](superpowers/plans/2026-06-20-session-collapse-cache-aware-gate.md) | — |
| 2026-06-20 | [T1-T10 注意力治理子系统代码蒸馏](superpowers/plans/2026-06-20-代码蒸馏-T1至T10注意力治理子系统.md) | — |
| 2026-06-19 | [以 cacheCreate 成本为单一目标的双线优化计划](superpowers/plans/2026-06-19-cacheCreate成本双线优化.md) | — |
| 2026-06-19 | [星图议事会·确定性内核 (W-C1~W-C3) 实现计划](superpowers/plans/2026-06-19-council-core.md) | — |
| 2026-06-19 | [W-C6 议事会多轮辩论(round ≥ 2)实现计划](superpowers/plans/2026-06-19-council-multi-round-debate.md) | — |
| 2026-06-19 | [星图议事会·下一阶段设计方案](superpowers/plans/2026-06-19-council-next-phase.md) | 设计已定稿，待执行 |
| 2026-06-19 | [Goal 自动继续实现计划](superpowers/plans/2026-06-19-goal-auto-continue.md) | — |
| 2026-06-19 | [项目提示词精简方案](superpowers/plans/2026-06-19-prompt-token-slimming.md) | — |
| 2026-06-19 | [Provider 与会话体验优化](superpowers/plans/2026-06-19-provider-session-experience.md) | — |
| 2026-06-19 | [TUI 终端端议事会 · /council slash 命令 — 交付记录](superpowers/plans/2026-06-19-tui-council-slash-delivery.md) | — |
| 2026-06-19 | [增量附录（append-only delta context-update）实现计划](superpowers/plans/2026-06-19-增量附录-append-only-delta.md) | — |
| 2026-06-19 | [子代理星名透传 实现计划](superpowers/plans/2026-06-19-子代理星名透传.md) | — |
| 2026-06-18 | [L1 artifact 拦截边界重划 + 修二次落盘 bug 实现计划](superpowers/plans/2026-06-18-l1-artifact-intercept-fix.md) | — |
| 2026-06-17 | [better-sqlite3 生产打包方案](superpowers/plans/2026-06-17-better-sqlite3-生产打包方案.md) | — |
| 2026-06-17 | [并行工具调用机制 实现计划](superpowers/plans/2026-06-17-parallel-tool-calling-mechanism.md) | — |
| 2026-06-16 | [Skill 三级渐进装载 — Phase 1 实现计划（保真优先 · 复制式单一来源）](superpowers/plans/2026-06-16-skill-three-tier-loading.md) | — |
| 2026-06-16 | [I1 — 星域名册 + 议事会评审 · 业务流设计](superpowers/plans/2026-06-16-star-roster-council-i1.md) | — |
| 2026-06-15 | [桌面端空轮次过滤 实现计划](superpowers/plans/2026-06-15-desktop-empty-turn-filter.md) | — |
| 2026-06-15 | [天枢桌面版 UX 优化 — 四层递进方案](superpowers/plans/2026-06-15-desktop-ux-optimization.md) | — |
| 2026-06-15 | [星域融入审查门 实现计划](superpowers/plans/2026-06-15-star-review-integration.md) | — |
| 2026-06-14 | [计划模板（轻量版）— 单模块重构 / 内聚变更](superpowers/plans/2026-06-14-plan-methodology-lightweight.md) | — |
| 2026-06-14 | [计划方法论模板 — 五阶段推理流水线](superpowers/plans/2026-06-14-plan-methodology-template.md) | — |
| 2026-06-13 | [Worker + Review 模型默认换 Flash](superpowers/plans/2026-06-13-子代理和review-审查门的模型-都默认换flash-3-worker-日志-为什么全是-pro-没.md) | — |
| 2026-06-11 | [认知管线集成测试 — 端到端质量验证](superpowers/plans/2026-06-11-cognitive-pipeline-integration-test.md) | — |
| 2026-06-11 | [自由能引擎 (Free Energy Engine) — 实施计划](superpowers/plans/2026-06-11-free-energy-engine.md) | ✅ 已完成 (2026-06-11) |
| 2026-06-07 | [天枢图表模板库 — Mermaid 语义词汇 + 风格约束](superpowers/plans/2026-06-07-mermaid-diagram-template-library.md) | — |
| 2026-06-07 | [天枢项目感知层 — 自维护代码知识库](superpowers/plans/2026-06-07-project-perception-codebase-wiki.md) | — |
| 2026-06-07 | [提案：Review Squadron 加「姿态轴」Inspector](superpowers/plans/2026-06-07-review-squadron-stance-axis-proposal.md) | 方向提案，待评审。后置——不插队 team V1/V2 基线。 |
| 2026-06-07 | [`/team` 模式阶段实施计划（核心骨架版）](superpowers/plans/2026-06-07-team-mode-phased-implementation.md) | 实施计划 / Core Skeleton |
| 2026-06-07 | [Team Mode V2 落地实现计划](superpowers/plans/2026-06-07-team-mode-v2-landing.md) | — |
| 2026-06-07 | [Team Mode V2 — Status & Next Steps](superpowers/plans/2026-06-07-team-mode-v2-status.md) | — |
| 2026-06-07 | [Team Mode V3 — 后置强化方向：worker 星域化 + 知识沉淀](superpowers/plans/2026-06-07-team-mode-v3-worker-stardomain.md) | — |
| 2026-06-06 | [工具层 Async I/O 转换计划](superpowers/plans/2026-06-06-async-io-tools.md) | — |
| 2026-06-06 | [会话渲染架构修复 实现计划](superpowers/plans/2026-06-06-conversation-render-architecture.md) | — |
| 2026-06-06 | [意图检索路由实现计划](superpowers/plans/2026-06-06-intent-retrieval-router-implementation.md) | — |
| 2026-06-06 | [天枢审查纪律内化 — 能力边界补强（开源前）实现计划](superpowers/plans/2026-06-06-review-discipline-internalization.md) | — |
| 2026-06-06 | [Spec A + Spec B 实施交接（2026-06-06 · 最终状态）](superpowers/plans/2026-06-06-spec-a-b-handoff.md) | — |
| 2026-06-05 | [Rivet 卡顿三线根因分析](superpowers/plans/2026-06-05-rivet-stall-root-cause-analysis.md) | Root-Cause Analysis — 排查完成，进入修复 |
| 2026-06-04 | [GWT Step 2：Engine 层接入 maxChars + 动态 Salience](superpowers/plans/2026-06-04-gwt-step2-engine-maxchars-dynamic-salience.md) | 待实施 |
| 2026-06-04 | [Thinking 重复输出与内容泄漏修复计划](superpowers/plans/2026-06-04-thinking-output-dedup-fix.md) | — |
| 2026-06-04 | [TUI Static 同步 & 上下文压力优化](superpowers/plans/2026-06-04-tui-static-sync-and-context-pressure.md) | — |
| 2026-06-02 | [Agent Loop 事件循环弹性改造](superpowers/plans/2026-06-02-agent-loop-watchdog.md) | — |
| 2026-06-02 | [动态附录独立化 — 消除 turn 间 prefix cache 断裂](superpowers/plans/2026-06-02-dynamic-appendix-standalone.md) | — |
| 2026-06-02 | [边流边执行（Streaming Tool Executor）实现计划](superpowers/plans/2026-06-02-streaming-tool-executor.md) | — |
| 2026-06-02 | [思考循环恢复实现计划](superpowers/plans/2026-06-02-thinking-loop-recovery.md) | — |
| 2026-06-02 | [TUI 输入栏位置稳定性优化](superpowers/plans/2026-06-02-tui-inputbar-position-stability.md) | — |
| 2026-06-01 | [收敛检测机制设计](superpowers/plans/2026-06-01-convergence-detector.md) | — |
| 2026-06-01 | [delegate_batch 阻塞导致消息丢失与 UI 卡死 — 修复计划](superpowers/plans/2026-06-01-delegate-batch-blocks-steer.md) | — |
| 2026-06-01 | [deliver_task 门禁验证失效滞留修复计划](superpowers/plans/2026-06-01-deliver-gate-verification-fix.md) | — |
| 2026-06-01 | [Diet 占位符退避：从硬阻止到渐进提醒](superpowers/plans/2026-06-01-diet-gradual-retreat.md) | — |
| 2026-06-01 | [ESC 中断导致用户消息静默丢失 — 修复计划](superpowers/plans/2026-06-01-esc-abort-steer-message-loss.md) | — |
| 2026-06-01 | [firstUserIdx Fallback 双消息推送修复](superpowers/plans/2026-06-01-firstuseridx-fallback-fix.md) | — |
| 2026-06-01 | [GlanceBar Token & Compact Indicator 实现计划](superpowers/plans/2026-06-01-glancebar-token-compact-indicator.md) | — |
| 2026-06-01 | [Guided Memory Retrieval — 分层记忆与使用方案](superpowers/plans/2026-06-01-guided-memory-retrieval.md) | 方案补档 + 已落地收束记录 \| 日期：2026-06-01 \| 背景：避免“全量注入污染 prompt”和“纯按需 recall 又没人读”两个极端。 |
| 2026-06-01 | [Project Memory System — 设计方案](superpowers/plans/2026-06-01-project-memory-system.md) | P1-P3 已实施；Path C 分层注入已实施；P4-P6 待实施 \| 作者：天枢 \| 日期：2026-06-01 |
| 2026-06-01 | [修复 <Static> 滑动窗口导致消息静默丢失](superpowers/plans/2026-06-01-static-sliding-window-bug.md) | — |
| 2026-06-01 | [StreamOutput 恢复全量渲染设计方案](superpowers/plans/2026-06-01-stream-output-restore-full-render.md) | — |
| 2026-06-01 | [Theta Check 限流与退避 — 修复计划](superpowers/plans/2026-06-01-theta-check-rate-limit.md) | — |
| 2026-06-01 | [工具摩擦消除 & 增量测试 实现计划](superpowers/plans/2026-06-01-tool-friction-fixes.md) | — |
| 2026-05-31 | [反锚定引擎集成实现计划](superpowers/plans/2026-05-31-anti-anchoring-engine-integration.md) | — |
| 2026-05-31 | [deliver_task 按逻辑单元提交 实现计划](superpowers/plans/2026-05-31-deliver-task-cohesive-commit.md) | — |
| 2026-05-31 | [Phase 1：确定性成功输出裁剪 — 实施计划](superpowers/plans/2026-05-31-deterministic-output-trimming.md) | — |
| 2026-05-31 | [Pager 主屏方案 实现计划](superpowers/plans/2026-05-31-pager-main-screen.md) | — |
| 2026-05-30 | [Abort Resilience — 中止韧性修复](superpowers/plans/2026-05-30-abort-resilience.md) | — |
| 2026-05-30 | [Agent 故障态恐慌防护 实现计划](superpowers/plans/2026-05-30-agent-panic-guard.md) | — |
| 2026-05-30 | [Client Retry / Bash Approval / Promise Safety 实现计划](superpowers/plans/2026-05-30-client-retry-bash-approval-promise-safety.md) | — |
| 2026-05-30 | [提交事实回执与持久化 实现计划](superpowers/plans/2026-05-30-commit-truth-readback.md) | — |
| 2026-05-30 | [正确性高危修复 实现计划](superpowers/plans/2026-05-30-critical-correctness-fixes.md) | — |
| 2026-05-30 | [DX 工具链韧性加固（收敛版）](superpowers/plans/2026-05-30-dx-toolchain-resilience.md) | — |
| 2026-05-30 | [Error 速率突变觉察 / Error-Rate Anomaly Awareness](superpowers/plans/2026-05-30-error-rate-anomaly-awareness.md) | 待办（Backlog） — 优先级中。先收束当前分支主线。 |
| 2026-05-30 | [流畅度优化 · 簇四：后台偷帧 + 渲染抖动（S12-S16）实现计划](superpowers/plans/2026-05-30-fluency-jitter.md) | — |
| 2026-05-30 | [流畅度优化 · 簇二：输出节奏（S5-S7）实现计划](superpowers/plans/2026-05-30-fluency-rhythm.md) | — |
| 2026-05-30 | [流畅度优化 · 静默窗口（S1-S4）实现计划（优化版）](superpowers/plans/2026-05-30-fluency-silence-opt.md) | — |
| 2026-05-30 | [流畅度优化 · 簇一：静默窗口（S1-S4）实现计划](superpowers/plans/2026-05-30-fluency-silence.md) | — |
| 2026-05-30 | [流畅度优化 · 簇三：启动延迟（S8-S11）实现计划](superpowers/plans/2026-05-30-fluency-startup.md) | — |
| 2026-05-30 | [Git 真相回读三件套 实现计划](superpowers/plans/2026-05-30-git-truth-readback.md) | — |
| 2026-05-30 | [removeLastMessage role 类型守卫 实现计划](superpowers/plans/2026-05-30-removelast-role-guard.md) | — |
| 2026-05-30 | [会话 TUI 历史区 gutter 编码 实现计划](superpowers/plans/2026-05-30-tui-history-gutter.md) | — |
| 2026-05-30 | [会话 TUI turn 折叠锚点 实现计划](superpowers/plans/2026-05-30-tui-turn-anchor.md) | — |
| 2026-05-30 | [交付时显示 Git 提交信息 实现计划](superpowers/plans/2026-05-30-优化工作流-交付时显示git提交信息.md) | — |
| 2026-05-30 | [性能优化实现计划](superpowers/plans/2026-05-30-先写-立即可做的优化-优化markdown渲染-对大型代码块进行懒加载-减少重渲.md) | — |
| 2026-05-29 | [文件归属自动继承 — 消除 deliver_task 无意义 YELLOW](superpowers/plans/2026-05-29-auto-ownership.md) | — |
| 2026-05-29 | [cognitive-mirror 诚实化 — confidence → verification_coverage](superpowers/plans/2026-05-29-cognitive-mirror-honesty.md) | — |
| 2026-05-29 | [上下文压缩去重键精细化 — 范围感知去重修复](superpowers/plans/2026-05-29-compaction-diet-range-aware-dedup.md) | — |
| 2026-05-29 | [任务契约自动继承 — 非 actionable 消息不丢失任务上下文](superpowers/plans/2026-05-29-contract-inheritance.md) | — |
| 2026-05-29 | [意图梯度：消除 chat/task 二元模式，统一为任务契约自动检测](superpowers/plans/2026-05-29-intent-gradient-chat-task-unification.md) | — |
| 2026-05-29 | [Midnight 主题对比度优化 实现计划](superpowers/plans/2026-05-29-midnight-theme-contrast.md) | — |
| 2026-05-29 | [TDD 红灯误记修复 — 根因层 recordPrediction 阶段感知](superpowers/plans/2026-05-29-tdd-red-prediction-fix.md) | — |
| 2026-05-29 | [TUI 渲染稳定性优化 实现计划](superpowers/plans/2026-05-29-tui-rendering-stability.md) | — |
| 2026-05-28 | [Knowledge Manifest 按需检索实施计划](superpowers/plans/2026-05-28-knowledge-manifest-on-demand-retrieval.md) | — |
| 2026-05-28 | [Plan: 盘古 Agent — 多模型协作编码智能体](superpowers/plans/2026-05-28-pangu-agent-product-plan.md) | — |
| 2026-05-28 | [Provider 配置模式优化 实现计划](superpowers/plans/2026-05-28-设计一下我们模型接入的provider的模式配置优化-比如初始化的时候-输入-r.md) | — |
| 2026-05-27 | [记忆原则驱动检查清单与文档状态标签 实现计划](superpowers/plans/2026-05-27-6-2-review-principle-进入-memory-后-可以反向驱动-checklist-6-2-review-principle-进入.md) | — |
| 2026-05-27 | [压缩治理与内存修复 实现计划](superpowers/plans/2026-05-27-compact-hygiene-implementation.md) | — |
| 2026-05-27 | [HEARTH + Songline · 落地技术架构与路线](superpowers/plans/2026-05-27-hearth-songline-landing-architecture.md) | — |
| 2026-05-27 | [LSP Symbol 导航 + MCP SSE 传输 实现计划](superpowers/plans/2026-05-27-lsp符号跳转-mcp-sse传输.md) | — |
| 2026-05-27 | [Plan: Shared Worktree Ownership — Known Gaps & Fixes](superpowers/plans/2026-05-27-shared-worktree-ownership-gaps.md) | — |
| 2026-05-27 | [计划闭环一键标注 实现计划](superpowers/plans/2026-05-27-做一个这个设计计划-中文语义命名-按照你的想法来实现.md) | — |
| 2026-05-27 | [实时 token 输出流式渲染 实现计划](superpowers/plans/2026-05-27-实时token输出流式渲染.md) | — |
| 2026-05-27 | [项目记忆按需召回 实现计划](superpowers/plans/2026-05-27-项目记忆按需召回.md) | — |
| 2026-05-27 | [验证归因降噪 实现计划](superpowers/plans/2026-05-27-验证归因降噪 实现计划.md) | — |
| 2026-05-26 | [B1 Ownership Delivery Gate 减压修正计划](superpowers/plans/2026-05-26-b1-ownership-delivery-gate-减压修正.md) | — |
| 2026-05-26 | [B1 反射弧补全：Ownership 实时同步 + Verification 覆盖扩展](superpowers/plans/2026-05-26-b1-反射弧补全-ownership实时同步.md) | — |
| 2026-05-26 | [Patcher Worker 稳定化实施计划 V2（修订版）](superpowers/plans/2026-05-26-patcher-worker-稳定化实施计划-v2.md) | — |
| 2026-05-26 | [Patcher Worker 稳定化实施计划](superpowers/plans/2026-05-26-patcher-worker-稳定化实施计划.md) | — |
| 2026-05-26 | [readHistory 同文件片段去重 — 实现计划](superpowers/plans/2026-05-26-readhistory-fragment-dedup.md) | — |
| 2026-05-26 | [天枢自我观测面板（Runtime Cockpit）](superpowers/plans/2026-05-26-天枢自我观测面板-runtime-cockpit.md) | — |
| 2026-05-25 | [上下文入口治理 实现计划](superpowers/plans/2026-05-25-d1-context-ingress.md) | — |
| 2026-05-25 | [缓存稳定与审计 实现计划](superpowers/plans/2026-05-25-d2-prefix-cache-stability.md) | — |
| 2026-05-25 | [流程与交付卫生 实现计划](superpowers/plans/2026-05-25-d3-agent-workflow-hygiene.md) | — |
| 2026-05-25 | [Phase 0：修复 DeepSeek Cache 命中率显示](superpowers/plans/2026-05-25-phase0-修复cache显示.md) | — |
| 2026-05-25 | [Phase 1：修复前缀缓存字节泄漏](superpowers/plans/2026-05-25-phase1-前缀缓存修复.md) | — |
| 2026-05-25 | [/plan 中文语义命名规则修复 实现计划](superpowers/plans/2026-05-25-plan中文语义命名规则修复.md) | — |
| 2026-05-25 | [Prefix Cache Trailer Mode 实现计划](superpowers/plans/2026-05-25-prefix-cache-trailer-mode.md) | — |
| 2026-05-25 | [Rivet TUI DX 改进：天枢反馈三连修 实现计划](superpowers/plans/2026-05-25-rivet-dx-tianshu-feedback.md) | — |
| 2026-05-25 | [低成本模型探索路由 实现计划](superpowers/plans/2026-05-25-低成本模型探索路由.md) | — |
| 2026-05-25 | [多会话并行开发与天枢工程控制层 实现计划](superpowers/plans/2026-05-25-多会话并行开发与天枢工程控制层实现计划.md) | — |
| 2026-05-25 | [Rivet TUI DX 改进：天枢反馈四连修状态标记](superpowers/plans/2026-05-25-工作代理沙箱权限与隔离工作树核查.md) | 本轮只核查并归档 Task 2.1 worker / 沙箱权限 / worktree 隔离；其它三项标记为后续待办，不在本轮推进。 |
| 2026-05-25 | [上下文卫生三文档 实现计划](superpowers/plans/2026-05-25-把这些写到计划里-可能文档太长了-分三个文档来做-d1-d2-d3.md) | — |
| 2026-05-25 | [表面路由与暗舱重构 — 增补文档](superpowers/plans/2026-05-25-表面路由与暗舱重构-增补.md) | — |
| 2026-05-25 | [表面路由与暗舱重构 实现计划](superpowers/plans/2026-05-25-表面路由与暗舱重构.md) | — |
| 2026-05-24 | [P3 优化 Scout 实现关联文档](superpowers/impl/p3-optimization-scout-impl.md) | — |
| 2026-05-24 | [EvidenceTracker 验证管道重连 实现计划](superpowers/plans/2026-05-24-evidence-tracker-verification-reconnect.md) | — |
| 2026-05-24 | [Immune System 完成 — 拆分子计划包索引](superpowers/plans/2026-05-24-immune-completion-index.md) | — |
| 2026-05-24 | [Immune 包 A：类型重构 + SQLite 持久化](superpowers/plans/2026-05-24-immune-pkg-A.md) | — |
| 2026-05-24 | [Immune 包 B：3 类 danger signal 接入](superpowers/plans/2026-05-24-immune-pkg-B.md) | — |
| 2026-05-24 | [Immune 包 D：MistakeNotebook 持久化 + recordRepairSuccess 接入](superpowers/plans/2026-05-24-immune-pkg-D.md) | — |
| 2026-05-24 | [Immune System 补完实现计划](superpowers/plans/2026-05-24-immune-system-completion.md) | — |
| 2026-05-24 | [经脉图 Phase 2 实现计划](superpowers/plans/2026-05-24-meridian-graph-phase2.md) | — |
| 2026-05-24 | [MistakeNotebook 写路径接入：最小修复](superpowers/plans/2026-05-24-mistake-notebook-wire.md) | — |
| 2026-05-24 | [TDD Gate 实现计划](superpowers/plans/2026-05-24-tdd-gate.md) | — |
| 2026-05-24 | [P1-P4 纠错计划：补完孤儿代码 + 修正方向偏差](superpowers/plans/2026-05-24-token-opt-correction.md) | — |
| 2026-05-24 | [Token 优化 Scout 调研成果实现计划](superpowers/plans/2026-05-24-token-optimization-scout-findings.md) | — |
| 2026-05-24 | [冰鉴 v3 — 自适应缓存闭环引擎 实现计划](superpowers/plans/2026-05-24-冰鉴v3-自适应缓存闭环引擎.md) | — |
| 2026-05-24 | [工具输出 artifact 标记格式统一与窗口感知预算 实现计划](superpowers/plans/2026-05-24-工具输出 artifact 标记格式统一与窗口感知预算.md) | — |
| 2026-05-23 | [Context Diet 实现计划](superpowers/plans/2026-05-23-context-diet-plan.md) | — |
| 2026-05-23 | [天枢创新优化路线图](superpowers/plans/2026-05-23-innovation-roadmap.md) | — |
| 2026-05-23 | [经脉图 Phase 1 实现计划](superpowers/plans/2026-05-23-meridian-graph-phase1.md) | — |
| 2026-05-23 | [Worktree Reality Contract 实现计划](superpowers/plans/2026-05-23-p0-worktree-reality-contract.md) | — |
| 2026-05-23 | [P2-11: PASTE-lite Shadow Queue 实现计划](superpowers/plans/2026-05-23-p2-11-paste-shadow-queue.md) | — |
| 2026-05-23 | [P2-12: 多代理 Context Isolation 策略层实现计划](superpowers/plans/2026-05-23-p2-12-context-isolation-policy.md) | — |
| 2026-05-23 | [P2-14: Adaptive Model Routing (Flash/Pro) 实现计划](superpowers/plans/2026-05-23-p2-14-adaptive-model-routing.md) | — |
| 2026-05-23 | [P2-15: Chat Prefix Completion 实现计划](superpowers/plans/2026-05-23-p2-15-prefix-completion.md) | — |
| 2026-05-22 | [Append-Only Artifact Log 实现计划](superpowers/plans/2026-05-22-append-only-artifact-log.md) | — |
| 2026-05-22 | [HEARTH + Songline Runtime 联合实施计划](superpowers/plans/2026-05-22-hearth-songline-implementation.md) | 待办（Backlog） — 等当前分支主线任务收束后启动 |
| 2026-05-22 | [OpenAI 原生格式迁移实施计划](superpowers/plans/2026-05-22-openai-native-format-migration.md) | — |
| 2026-05-22 | [认知系统闭环审计](superpowers/plans/cognitive-system-gap-analysis.md) | Gap Analysis — 三层架构视角 |
| 2026-05-21 | [B1：归属星轨 —— 任务归属、验证归因与交付账本计划](superpowers/plans/2026-05-21-b1-归属星轨-任务归属验证归因交付账本.md) | — |
| 2026-05-21 | [Chat Mode — 对话模式实现计划](superpowers/plans/2026-05-21-chat-mode-implementation.md) | — |
| 2026-05-21 | [上下文瘦身：归还认知氧气 实现计划](superpowers/plans/2026-05-21-context-diet-cognitive-oxygen.md) | — |
| 2026-05-21 | [跨 Session 实时状态同步 实现计划](superpowers/plans/2026-05-21-cross-session-realtime-sync.md) | — |
| 2026-05-21 | [三道防线内存安全 实现计划](superpowers/plans/2026-05-21-memory-safety-three-lines.md) | — |
| 2026-05-21 | [盘古开天 CVM 实施计划](superpowers/plans/2026-05-21-pangu-cvm-implementation.md) | — |
| 2026-05-21 | [RSS 内存压力修复](superpowers/plans/2026-05-21-rss-memory-pressure-fix.md) | — |
| 2026-05-21 | [启动内存优化 实现计划](superpowers/plans/2026-05-21-startup-memory-optimization.md) | — |
| 2026-05-21 | [天枢纯净交付路线图](superpowers/plans/2026-05-21-tianshu-pure-delivery-roadmap.md) | 活跃 |
| 2026-05-21 | [Wave 1 任务总览](superpowers/plans/w1-00-overview.md) | — |
| 2026-05-21 | [Wave 1 Task 10：多 Session 协作协议 v2](superpowers/plans/w1-10-multi-session-protocol-v2.md) | 实施中 |
| 2026-05-20 | [习惯化 v3：信心累加器 实施计划](superpowers/plans/2026-05-20-habituation-v3-confidence-accumulator.md) | — |
| 2026-05-20 | [Ice Mirror Cache Engine Verification Plan](superpowers/plans/2026-05-20-ice-mirror-cache-verification.md) | — |
| 2026-05-20 | [冰鉴 v2 — 习惯化巩固引擎 实现计划](superpowers/plans/2026-05-20-ice-mirror-v2-habituation-engine.md) | — |
| 2026-05-20 | [天枢星君 · 国风双身 + 五色星辰 实施计划](superpowers/plans/2026-05-20-observatory-avatar-starmap.md) | — |
| 2026-05-20 | [运行时体验优化 — 技术路线](superpowers/plans/2026-05-20-runtime-experience-evolution.md) | — |
| 2026-05-20 | [星域伙伴对话 Phase 1 实施计划 — Layer 2（在场心跳）+ Layer 4（星域之声）](superpowers/plans/2026-05-20-star-domain-partner-dialogue-phase1.md) | — |
| 2026-05-20 | [星域伙伴迭代 — 从底座到人格展现 实现计划](superpowers/plans/2026-05-20-star-domain-partner-iteration.md) | — |
| 2026-05-20 | [星桥四站位 — 终端 Agent 可观测性 v2 实施计划](superpowers/plans/2026-05-20-starbridge-four-stations.md) | — |
| 2026-05-20 | [StarSpine Phase 1：TaskContract + CognitiveLedger 实施计划](superpowers/plans/2026-05-20-starspine-phase1-task-contract-cognitive-ledger.md) | — |
| 2026-05-20 | [StarSpine Phase 2A：Verification Gap Projection 实施记录](superpowers/plans/2026-05-20-starspine-phase2a-verification-gap.md) | 执行中 |
| 2026-05-20 | [StarSpine Phase 2B-1：Mission Snapshot + Mission Strip Formatter](superpowers/plans/2026-05-20-starspine-phase2b-mission-strip.md) | 执行中 |
| 2026-05-20 | [三权协程调度 — 扩展实现计划 v2](superpowers/plans/2026-05-20-three-authority-coroutine-implementation.md) | — |
| 2026-05-20 | [天枢 3.0 基石 — 三层净化实施计划](superpowers/plans/2026-05-20-three-layer-purification.md) | — |
| 2026-05-20 | [天枢之眼 — Agent 执行意识可视化实施计划](superpowers/plans/2026-05-20-tianshu-eye-agent-visibility.md) | — |
| 2026-05-20 | [万物为一工程原则 — 实施计划](superpowers/plans/2026-05-20-wanwu-weiyi-engineering.md) | — |
| 2026-05-20 | [万物为一工程实施 — 天枢交接计划](superpowers/plans/2026-05-20-wanwu-weiyi-handoff.md) | — |
| 2026-05-19 | [子代理编排架构优化 实现计划](superpowers/plans/2026-05-19-architecture-optimization.md) | — |
| 2026-05-19 | [Claude Ecosystem Bridge 实施计划](superpowers/plans/2026-05-19-claude-ecosystem-bridge-implementation.md) | — |
| 2026-05-19 | [GenomeStore 实现计划](superpowers/plans/2026-05-19-genome-store.md) | — |
| 2026-05-19 | [天枢·冰鉴（Ice Mirror）上下文缓存引擎 — 设计方案](superpowers/plans/2026-05-19-ice-mirror-cache-engine.md) | — |
| 2026-05-19 | [多会话并发 Phase 1：Session Registry + File Claim 实现计划](superpowers/plans/2026-05-19-multi-session-phase1.md) | — |
| 2026-05-19 | [Score Translation 实现计划](superpowers/plans/2026-05-19-score-translation.md) | — |
| 2026-05-19 | [Genome-Immune Team Architecture — Plan 4: Self-Scoring Bid](superpowers/plans/2026-05-19-self-scoring-bid.md) | — |
| 2026-05-19 | [星域路由接入 AgentLoop 实现计划](superpowers/plans/2026-05-19-star-domain-routing-wiring.md) | — |
| 2026-05-19 | [星域灵魂系统 Phase 1 实现计划（v2）](superpowers/plans/2026-05-19-star-domain-soul-phase1.md) | — |
| 2026-05-19 | [星域灵魂系统 A/B 验证计划](superpowers/plans/2026-05-19-star-soul-ab-validation.md) | — |
| 2026-05-19 | [Surgical Pause 实现计划](superpowers/plans/2026-05-19-surgical-pause.md) | — |
| 2026-05-19 | [TUI 2.4 — Structural Maturity 实施计划](superpowers/plans/2026-05-19-tui-2.4-structural-maturity.md) | — |
| 2026-05-19 | [Volatile Context Hygiene 实施计划](superpowers/plans/2026-05-19-volatile-context-hygiene.md) | — |
| 2026-05-19 | [Wave7 闭环与 /plan 工作流集成 实现计划](superpowers/plans/2026-05-19-wave7-已在分支完成闭环-然后给出计划任务和实施安排-plan命令应该集成了.md) | ✅ 当前任务闭环；`/plan` 与 `/write-plan` 已通过 targeted tests 验证。 |
| 2026-05-19 | [Wave8 P2B/P2C 继续闭环 实现计划](superpowers/plans/2026-05-19-wave8-hands-routing-knowledge-projection-closure.md) | — |
| 2026-05-19 | [Wave 8: Sub-Agent 深化 — Brain/Hands 分离 + Worktree 隔离 + 知识共享](superpowers/plans/2026-05-19-wave8-hands-worktree-knowledge.md) | — |
| 2026-05-19 | [子代理编排集成验证 实现计划](superpowers/plans/2026-05-19-你来负责当前阶段集成验证工作.md) | — |
| 2026-05-19 | [终端会话高可用与高稳定性 V2 实现计划](superpowers/plans/2026-05-19-按照你的优化意见调整方案-可以迭代一份v2版本-标注-然后开始执行-你可以自主决定需要执行的顺序和任务目标.md) | — |
| 2026-05-19 | [Session HA V2 增补优化迭代 实现计划](superpowers/plans/2026-05-19-按照你的改进意见-写增补优化迭代的方案-然后执行.md) | — |
| 2026-05-18 | [Rivet TUI Pressure Control 实施计划](superpowers/plans/2026-05-18-rivet-tui-pressure-control.md) | — |
| 2026-05-18 | [终端会话高可用与高稳定性 实施计划](superpowers/plans/2026-05-18-session-ha-stability.md) | — |
| 2026-05-18 | [StarFlow v2 闭环接线 实现计划](superpowers/plans/2026-05-18-starflow-v2-closed-loop-wiring.md) | — |
| 2026-05-18 | [TUI 2.1 自适应运行时 实现计划](superpowers/plans/2026-05-18-tui-2.1-adaptive-runtime.md) | — |
| 2026-05-18 | [TUI 2.2 Vigor Engine + Hook 架构 实现计划](superpowers/plans/2026-05-18-tui-2.2-vigor-engine.md) | — |
| 2026-05-18 | [TUI 2.2c — Runtime Hook Hardening 实施计划](superpowers/plans/2026-05-18-tui-2.2c-runtime-hardening.md) | — |
| 2026-05-18 | [TUI 2.3 — Conscious Agent 实施计划](superpowers/plans/2026-05-18-tui-2.3-conscious-agent.md) | — |
| 2026-05-17 | [Cerebellar Loop: Prediction-Error Accumulator 实现计划](superpowers/plans/2026-05-17-cerebellar-loop.md) | — |
| 2026-05-17 | [Context Resilience Layer — 设计文档](superpowers/plans/2026-05-17-context-resilience-design.md) | — |
| 2026-05-17 | [Context Resilience Layer 实现计划](superpowers/plans/2026-05-17-context-resilience-implementation.md) | — |
| 2026-05-17 | [Deep Interview 实施计划](superpowers/plans/2026-05-17-deep-interview-plan.md) | — |
| 2026-05-17 | [Failure Classifier Expansion + Activity Status Integration 实现计划](superpowers/plans/2026-05-17-failure-classifier-expansion.md) | — |
| 2026-05-17 | [内存泄漏修复 实现计划](superpowers/plans/2026-05-17-memory-leak-fixes.md) | — |
| 2026-05-17 | [Multi-Provider Adapter 实现计划](superpowers/plans/2026-05-17-multi-provider-adapter.md) | — |
| 2026-05-17 | [Multi-Provider Integration Phase 1 实现计划](superpowers/plans/2026-05-17-multi-provider-phase1.md) | — |
| 2026-05-17 | [Multi-Provider Phase 2: OpenAIClient 实现计划](superpowers/plans/2026-05-17-multi-provider-phase2.md) | — |
| 2026-05-17 | [Project Memory Dream Phase 2 + Phase 3 实现计划](superpowers/plans/2026-05-17-project-memory-dream-p2p3.md) | — |
| 2026-05-17 | [Project Memory: Dream 蒸馏 Phase 1 实现计划](superpowers/plans/2026-05-17-project-memory-dream.md) | — |
| 2026-05-17 | [Project Memory Phase 1 实现计划](superpowers/plans/2026-05-17-project-memory-phase1.md) | — |
| 2026-05-17 | [Rivet Activity Status Layer 实现计划](superpowers/plans/2026-05-17-rivet-activity-status-layer.md) | — |
| 2026-05-17 | [Rivet Agent Parity Roadmap 实现计划](superpowers/plans/2026-05-17-rivet-agent-parity-roadmap.md) | — |
| 2026-05-17 | [ECF Phase 5: Recall 正反馈 + Claim 质量信号 实现计划](superpowers/plans/2026-05-17-rivet-ecf-phase5-recall-feedback.md) | — |
| 2026-05-17 | [Wave 9: 内部缺陷修复 + 结构优化 实施计划](superpowers/plans/2026-05-17-rivet-wave9-defect-fixes.md) | — |
| 2026-05-17 | [Session Fluency Layer Phase 1 实现计划](superpowers/plans/2026-05-17-session-fluency-layer-p1.md) | — |
| 2026-05-17 | [Session Fluency Layer Phase 2: UI 接入实现计划](superpowers/plans/2026-05-17-session-fluency-layer-p2.md) | — |
| 2026-05-17 | [Session HA 闭环补强实现计划](superpowers/plans/2026-05-17-session-ha-closure.md) | — |
| 2026-05-17 | [Session HA (Wave 12) — 完成状态](superpowers/plans/2026-05-17-session-ha-wave12-status.md) | — |
| 2026-05-17 | [会话高可用（Session HA）实现计划](superpowers/plans/2026-05-17-session-high-availability.md) | — |
| 2026-05-17 | [会话性能与容错加固 实施计划](superpowers/plans/2026-05-17-session-performance-fault-tolerance.md) | — |
| 2026-05-17 | [会话渲染 P0 实现计划](superpowers/plans/2026-05-17-session-rendering-p0.md) | — |
| 2026-05-17 | [Session Rendering P1/P2 实现计划](superpowers/plans/2026-05-17-session-rendering-p1p2.md) | — |
| 2026-05-17 | [会话稳定性三层加固 实现计划](superpowers/plans/2026-05-17-session-stability-compaction-hardening.md) | — |
| 2026-05-17 | [TUI 内容丢失修复 实现计划](superpowers/plans/2026-05-17-tui-content-preservation.md) | — |
| 2026-05-17 | [Wave 10: 测试补强 + loop.ts 拆分 实施计划](superpowers/plans/2026-05-17-wave10-test-loop-split.md) | — |
| 2026-05-17 | [Wave 11: Cache 效率 + Token 节约 实现计划](superpowers/plans/2026-05-17-wave11-cache-perf.md) | — |
| 2026-05-16 | [Multi-Pass Repair Pipeline 实现计划](superpowers/plans/2026-05-16-multi-pass-repair-pipeline.md) | — |
| 2026-05-16 | [Attention Anchor Dispersal 实现计划](superpowers/plans/2026-05-16-rivet-attention-anchor-dispersal-implementation.md) | — |
| 2026-05-16 | [Rivet Cache Safety Layer 实现计划](superpowers/plans/2026-05-16-rivet-cache-safety-implementation.md) | — |
| 2026-05-16 | [Rivet Cockpit + Capability Ledger 实现计划](superpowers/plans/2026-05-16-rivet-cockpit-capability-ledger.md) | — |
| 2026-05-16 | [Rivet Context Layer Boundary 实现计划](superpowers/plans/2026-05-16-rivet-context-layer-boundary-implementation.md) | — |
| 2026-05-16 | [ECF Phase 4: Project Rules + Claim Budget 实现计划](superpowers/plans/2026-05-16-rivet-ecf-phase4-rules-budget.md) | — |
| 2026-05-16 | [ECF Phase 4B: Recall Tool + Claim Export/Import 实现计划](superpowers/plans/2026-05-16-rivet-ecf-phase4b-recall-export.md) | — |
| 2026-05-16 | [Evolutionary Context Fabric Phase 1 实现计划](superpowers/plans/2026-05-16-rivet-evolutionary-context-fabric-phase1.md) | — |
| 2026-05-16 | [Evolutionary Context Fabric Phase 2 实现计划](superpowers/plans/2026-05-16-rivet-evolutionary-context-fabric-phase2.md) | — |
| 2026-05-16 | [Evolutionary Context Fabric Phase 3 实现计划](superpowers/plans/2026-05-16-rivet-evolutionary-context-fabric-phase3.md) | — |
| 2026-05-16 | [Execution Resilience Layer 实现计划](superpowers/plans/2026-05-16-rivet-execution-resilience-layer-implementation.md) | — |
| 2026-05-16 | [Rivet Execution Resilience + Sub-agent Orchestration 实现计划](superpowers/plans/2026-05-16-rivet-execution-resilience-subagent-evidence.md) | — |
| 2026-05-16 | [Rivet Execution Trust Closure 实现计划](superpowers/plans/2026-05-16-rivet-execution-trust-closure-implementation.md) | — |
| 2026-05-16 | [Gap Closing 加固实现计划](superpowers/plans/2026-05-16-rivet-gap-closing-hardening.md) | — |
| 2026-05-16 | [Rivet 差距弥补：Hooks / Git / Todo / WebFetch / Undo 实现计划](superpowers/plans/2026-05-16-rivet-gap-closing-hooks-git-todo-webfetch-undo.md) | — |
| 2026-05-16 | [Rivet Glanceable Cockpit + 科技风视觉层 实现计划](superpowers/plans/2026-05-16-rivet-glanceable-cockpit-techstyle-implementation.md) | — |
| 2026-05-16 | [Rivet MCP Client 实现计划](superpowers/plans/2026-05-16-rivet-mcp-client-implementation.md) | — |
| 2026-05-16 | [Rivet 多会话并行隔离 实现计划](superpowers/plans/2026-05-16-rivet-multi-session-isolation-implementation.md) | — |
| 2026-05-16 | [Rivet Open Source Productization R1 实现计划](superpowers/plans/2026-05-16-rivet-open-source-productization-r1.md) | — |
| 2026-05-16 | [P1 剩余缺口修复计划](superpowers/plans/2026-05-16-rivet-p1-remaining-gaps.md) | — |
| 2026-05-16 | [Rivet Progressive Context Engine 实现计划](superpowers/plans/2026-05-16-rivet-progressive-context-engine-implementation.md) | — |
| 2026-05-16 | [渲染性能 + 内存有界化 + 视觉愉悦 实现计划](superpowers/plans/2026-05-16-rivet-render-perf-memory-bounded-visual-polish.md) | — |
| 2026-05-16 | [Rivet 风险修复 实现计划](superpowers/plans/2026-05-16-rivet-risk-remediation.md) | — |
| 2026-05-16 | [Rivet 子代理协同 Phase 1 实现计划](superpowers/plans/2026-05-16-rivet-subagent-orchestration-implementation.md) | — |
| 2026-05-16 | [Rivet Tool Safety + Verification Evidence 实现计划](superpowers/plans/2026-05-16-rivet-tool-safety-verification-evidence.md) | — |
| 2026-05-16 | [Wave 1：核心缺漏补齐 实施计划](superpowers/plans/2026-05-16-rivet-wave1-core-gaps.md) | — |
| 2026-05-16 | [Wave 2：差异化超越 实施计划](superpowers/plans/2026-05-16-rivet-wave2-differentiation.md) | — |
| 2026-05-16 | [Wave 3 + Wave 4: UX Polish + Ecosystem Extension](superpowers/plans/2026-05-16-rivet-wave3-wave4-ux-polish.md) | — |
| 2026-05-16 | [Wave 5: Trust Infrastructure 实施计划](superpowers/plans/2026-05-16-rivet-wave5-trust-infrastructure.md) | — |
| 2026-05-16 | [Wave 6: Goal Loop 实施计划](superpowers/plans/2026-05-16-rivet-wave6-goal-loop.md) | — |
| 2026-05-16 | [Wave 7: Sub-Agent 接线增强 实施计划](superpowers/plans/2026-05-16-rivet-wave7-subagent-wiring.md) | — |
| 2026-05-16 | [Wave 8: Context Fabric Phase 2 — Claim 自动提取 + TTL + 晋升 实施计划](superpowers/plans/2026-05-16-rivet-wave8-context-fabric-phase2.md) | — |
| 2026-05-16 | [Rivet XML Protocol Layer + Speculative Pre-warming 实现计划](superpowers/plans/2026-05-16-rivet-xml-protocol-speculative-engine-implementation.md) | — |
| 2026-05-16 | [Tool Input Repair + CCH Strip + Schema Gate 实现计划](superpowers/plans/2026-05-16-tool-input-repair-cch-strip-schema-gate.md) | — |
| 2026-05-15 | [Rivet 开发能力补强 Phase 2 实施计划](superpowers/plans/2026-05-15-rivet-dev-capability-phase2.md) | — |
| 2026-05-15 | [P2.1 开发能力层实施计划](superpowers/plans/2026-05-15-rivet-dev-capability-phase3.md) | — |
| 2026-05-15 | [Rivet P2.2 Capability Reliability Layer 实现计划](superpowers/plans/2026-05-15-rivet-p2-2-capability-reliability-layer.md) | — |
| 2026-05-15 | [Rivet P2.3 Harness Cockpit TUI 实现计划](superpowers/plans/2026-05-15-rivet-p2-3-harness-cockpit-implementation.md) | — |
| 2026-05-15 | [P2.1 剩余任务实施计划](superpowers/plans/2026-05-15-rivet-p2.1-remaining.md) | — |
| 2026-05-15 | [Rivet 性能优化与 Claude Code 对标实现计划](superpowers/plans/2026-05-15-rivet-performance-optimization.md) | — |
| 2025-05-17 | [天枢星图流 v2: AgentSensorium + Stigmergy 实现计划](superpowers/plans/2025-05-17-starflow-v2-sensorium.md) | — |
| 2025-05-17 | [终端回复被吞/截断修复 实施计划](superpowers/plans/2025-05-17-text-swallowing-fix.md) | — |
| — | [Codex CLI 安全借鉴 — 实施进度](superpowers/plans/2026-06-codex-cli-borrow-progress.md) | — |
| — | [OpenAI Codex CLI 值得借鉴的特性](superpowers/plans/2026-06-codex-cli-borrow.md) | — |
| — | [Gemini CLI 值得借鉴的特性](superpowers/plans/2026-06-gemini-cli-borrow.md) | — |
| — | [Plan Template（精简版）](superpowers/plans/PLAN-TEMPLATE.md) | — |
| — | [Anthropic 原生 Client + 四断点缓存 实现计划](superpowers/plans/anthropic-native-client.md) | — |
| — | [Commit Scope Guard 实现计划](superpowers/plans/commit-scope-guard.md) | — |
| — | [Compaction 结构化摘要 — 实现计划](superpowers/plans/compaction-structured-summary.md) | — |
| — | [P1: Skills System — 能力模块化设计](superpowers/plans/deerflow-p1-skills-system.md) | — |
| — | [P2: Middleware Chain — 中间件管道设计](superpowers/plans/deerflow-p2-middleware-chain.md) | — |
| — | [P3: Memory System Enhancement — 记忆系统增强设计](superpowers/plans/deerflow-p3-memory-enhancement.md) | — |
| — | [流畅度优化 v2 · 后台偷帧 + 渲染抖动（S12-S16）实现计划](superpowers/plans/fluency-jitter-v2.md) | — |
| — | [流畅度优化 · 簇三 v2：启动延迟（S8-S11）实现计划](superpowers/plans/fluency-startup-v2.md) | — |
| — | [loop.ts 拆分 — 最终收束](superpowers/plans/loop-split-v2.md) | — |
| — | [loop.ts 拆分 v3 — 下一阶段计划](superpowers/plans/loop-split-v3.md) | — |
| — | [Mermaid 模板库 — 兼容性实测样图](superpowers/plans/mermaid-compat-test.md) | — |
| — | [P1 三件套：Plan Mode / Bash 安全 / Agent 外部化 实现计划](superpowers/plans/p1-trio-plan-mode-bash-security-agent-ext.md) | — |
| — | [历史遍历性能修复 实现计划](superpowers/plans/perf-history-traversal-fixes.md) | — |
| — | [Phase 3：Fetch 首字节超时 + SSE 超时顺序修复 实现计划](superpowers/plans/phase3-fetch-hang-timeout.md) | — |
| — | [Spec Review Gate（外部规格审查门）— 实现计划](superpowers/plans/spec-review-gate.md) | — |
| — | [Wave 1 任务文档：Chat Mode 实现](superpowers/plans/w1-01-chat-mode.md) | — |
| — | [Wave 1 任务文档：Multi-Provider Adapter](superpowers/plans/w1-02-multi-provider.md) | — |
| — | [Wave 1 任务文档：安装体验](superpowers/plans/w1-03-install-experience.md) | — |
| — | [Wave 1 任务文档：用户文档重写](superpowers/plans/w1-04-user-docs.md) | — |
| — | [Wave 1 任务文档：Error Recovery Pipeline](superpowers/plans/w1-05-error-recovery.md) | — |
| — | [Wave 1 任务文档：Verification Dashboard](superpowers/plans/w1-06-verification-dashboard.md) | — |
| — | [Wave 1 任务文档：Session Replay](superpowers/plans/w1-07-session-replay.md) | — |
| — | [Wave 1 任务文档：Confidence Indicator + Auto-Escalation](superpowers/plans/w1-08-confidence-escalation.md) | — |
| — | [Wave 1 补充：天枢记忆系统设计](superpowers/plans/w1-09-cross-session-memory.md) | — |
| — | [Wave 1 任务文档：多 Session 协作协议](superpowers/plans/w1-10-multi-session-protocol.md) | — |
| — | [Wave 1 任务文档：Subagent Orchestration Phase 1](superpowers/plans/w1-11-subagent-orchestration.md) | — |
| — | [Wave 1 任务文档：Performance Baseline](superpowers/plans/w1-12-performance-baseline.md) | — |
| — | [Wave 1 任务文档：E2E Test Suite](superpowers/plans/w1-13-e2e-test-suite.md) | — |
| — | [Windows 兼容性适配计划](superpowers/plans/windows-compatibility.md) | — |
| — | [verify-ce34bdc-cache](superpowers/tasks/verify-ce34bdc-cache.md) | — |
| — | [任务：修复 read_file 的 artifact 摘要导致 agent 感知断裂](tasks/fix-read-file-artifact-perception.md) | — |
| — | [任务：为 B1 Delivery Gate 增加 verification supersession](tasks/verification-supersession.md) | — |

## spec — 事前规格（213）

| 日期 | 文档 | 状态 |
|------|------|------|
| 2026-08-01 | [级联 Tier 推测执行——DP quorum 未达成时自动 escalate strong 模型](3.0/D1-3-cascade-tier-speculation.md) | draft |
| 2026-07-31 | [模拟器任务卡壳诊断：外部会话日志调研（测试题2）](superpowers/specs/2026-07-31-simulator-task-loop-diagnosis.md) | — |
| 2026-07-30 | [视觉层 + 无头浏览器效果最大化 · 深度头脑风暴结果](superpowers/specs/2026-07-30-vision-browser-maximization-design.md) | — |
| 2026-07-28 | [ResourceSensor 跨会话残留导致 Reliability Mode 误触发](superpowers/specs/2026-07-28-resource-sensor-cross-session-residual.md) | — |
| 2026-07-28 | [写入工具语法检查门禁改进 — 设计文档](superpowers/specs/2026-07-28-write-tool-syntax-gate-false-positive.md) | 设计已定稿 |
| 2026-07-27 | [子代理工作闭环 —— 竞品基线与补齐路线](superpowers/specs/2026-07-27-subagent-closed-loop-roadmap.md) | — |
| 2026-07-27 | [子代理遗留项 L2/L3/L6 竞品对标 —— Claude Code · Codex · Grok Build](superpowers/specs/2026-07-27-subagent-l2-l3-l6-competitor-benchmark.md) | — |
| 2026-07-27 | [子代理工作流 —— 遗留问题清单](superpowers/specs/2026-07-27-subagent-workflow-leftovers.md) | — |
| 2026-07-26 | [Shadow W1 · Promotion-Gated 能力评估](superpowers/specs/2026-07-26-shadow-w1-promotion-gated-能力评估.md) | — |
| 2026-07-26 | [子代理精炼运行时 —— 重构设计](superpowers/specs/2026-07-26-subagent-lean-runtime-design.md) | — |
| 2026-07-25 | [会话历史回放持久化能力 深度头脑风暴结果](superpowers/specs/2026-07-25-session-replay-durability-design.md) | — |
| 2026-07-25 | [子代理可观测性与工作闭环 深度头脑风暴结果](superpowers/specs/2026-07-25-subagent-observability-design.md) | — |
| 2026-07-24 | [bash.ts 中文化变更文档](superpowers/specs/2026-07-24-bash-ts-中文化收尾.md) | — |
| 2026-07-23 | [CVM 认知信号互扰治理 — 深度头脑风暴结果](superpowers/specs/2026-07-23-cvm-signal-interference-design.md) | — |
| 2026-07-23 | [天枢桌面端产品形态极限 — 深度头脑风暴结果](superpowers/specs/2026-07-23-desktop-workbench-max-design-v1.md) | 已归档（v1）——被 `2026-07-23-desktop-workbench-max-design-v2.md` 取代，推进以 v2 为准 |
| 2026-07-23 | [天枢桌面端产品形态极限 — 设计 v2（可信交付管制台 × 星域任务台）](superpowers/specs/2026-07-23-desktop-workbench-max-design-v2.md) | 设计定稿 v2（推进基线） |
| 2026-07-23 | [天枢 Pro 版本 / 产品迭代路线分析](superpowers/specs/2026-07-23-pro-iteration-analysis.md) | 分析定稿 |
| 2026-07-21 | [织命议事会（Fate Loom Council）— Council Max 旗舰升级设计](superpowers/specs/2026-07-21-council-fate-loom-design.md) | — |
| 2026-07-21 | [星域 CVM 数值档案与消费路径分析](superpowers/specs/2026-07-21-star-domain-cvm-profiles.md) | — |
| 2026-07-20 | [CVM 噪音洪流修复 — 会话 df4ac4e9 事故复盘](superpowers/specs/2026-07-20-cvm-noise-flood-fix.md) | — |
| 2026-07-20 | [CVM 观测体系短板分析与设计意图](superpowers/specs/2026-07-20-cvm-observation-gaps.md) | — |
| 2026-07-15 | [MCP 生态对标增强 — 事后分析](superpowers/specs/2026-07-15-mcp-ecosystem-postmortem.md) | — |
| 2026-07-15 | [主控恐慌链事故分析 — 会话 5268cce4](superpowers/specs/2026-07-15-panic-chain-5268cce4-analysis.md) | — |
| 2026-07-14 | [星河 (Galaxy) 集群 Agent 架构 — 设计文档](superpowers/specs/2026-07-14-cluster-agent-architecture.md) | 设计迭代中（第二版——融入 skill 调用范式 + 意图分析 + 用户确认 + 前缀缓存保持） |
| 2026-07-12 | [华盖 systemPromptSuffix 精简记录](superpowers/specs/2026-07-12-huagai-prompt-slim.md) | — |
| 2026-07-11 | [探针纪律 · 封锁出路 · 焦虑对冲 — agent 工作流补全](superpowers/specs/2026-07-11-probe-discipline-anxiety-guard.md) | — |
| 2026-07-11 | [五常升级：从单点行为到认知轨迹 — 证与效用闭环](superpowers/specs/2026-07-11-virtue-verification-loop.md) | — |
| 2026-07-11 | [五常升级：从单点行为到认知轨迹 — 证与效用闭环](superpowers/specs/2026-07-11-virtue-verification-loop_副本.md) | — |
| 2026-07-11 | [清醒认知闭环 — 缓存安全设计](superpowers/specs/2026-07-11-清醒认知闭环-缓存安全设计.md) | — |
| 2026-07-10 | [桌面端可靠性与性能综合优化 · 深度头脑风暴结果](superpowers/specs/2026-07-10-desktop-reliability-optimization-design.md) | — |
| 2026-07-09 | [天枢 × OpenClaw 架构集成设计](superpowers/specs/2026-07-09-tianshu-x-openclaw-integration-design.md) | 设计初稿 |
| 2026-07-05 | [Action-Intent Gate：扩展检测到只读工具轮](superpowers/specs/2026-07-05-action-intent-readonly-gate.md) | — |
| 2026-07-04 | [Advisory 生命周期设计 — 回读闭环 → 打断调度 → 副驾合成](superpowers/specs/2026-07-04-advisory-lifecycle-design.md) | — |
| 2026-07-04 | [ast_edit 写工具覆盖缺口 — 统一兼容方案](superpowers/specs/2026-07-04-ast-edit-coverage-gap.md) | — |
| 2026-07-04 | [代码断言记忆衰减自检 — 调研与设计方案](superpowers/specs/2026-07-04-claim-staleness-self-check.md) | — |
| 2026-07-04 | [规划→审查→落地：星域协作工作流方法论](superpowers/specs/2026-07-04-collaborative-review-to-implementation-playbook.md) | — |
| 2026-07-04 | [主控工作流提效与质量 — 三个未覆盖缺口](superpowers/specs/2026-07-04-main-loop-quality-gaps.md) | — |
| 2026-07-04 | [缺口④ 推理收敛守护 — 设计文档](superpowers/specs/2026-07-04-reasoning-spiral-guard.md) | 设计阶段（待评审） |
| 2026-06-19 | [Agent 智能质量优化 — 深度头脑风暴](superpowers/specs/2026-06-19-agent-intelligence-quality-design.md) | 设计已定稿，待执行 |
| 2026-06-19 | [Prompt Token 构成分析：天枢 vs Claude Code](superpowers/specs/2026-06-19-prompt-token-anatomy.md) | — |
| 2026-06-16 | [Skill 体系优化 — 深度头脑风暴结果（重锚定版）](superpowers/specs/2026-06-16-skill-system-optimization-design.md) | — |
| 2026-06-16 | [Skill 体系优化 — 深度头脑风暴结果](superpowers/specs/2026-06-16-skill-system-optimization-design_副本.md) | — |
| 2026-06-07 | [Scope Gate: TODO 层的依赖识别与范围缩窄](superpowers/specs/2026-06-07-scope-gate-todo-design.md) | 已实施（v2，已修正 v1 方向） |
| 2026-06-07 | [`/team` 模式设计讨论纪要](superpowers/specs/2026-06-07-team-mode-design-discussion.md) | 讨论中（非实施） |
| 2026-06-07 | [Team Mode V3 认知层设计：星域注入 + 经验沉淀](superpowers/specs/2026-06-07-team-mode-v3-cognitive-layer-design.md) | — |
| 2026-06-07 | [Team Mode V3.1 — 胶囊按需加载 + 将星（持续化数字生命）](superpowers/specs/2026-06-07-team-mode-v3.1-capsule-ondemand-and-generals.md) | — |
| 2026-06-07 | [压#4 设计:阈值门控尾部增量（Threshold-Gated Tail Increment）](superpowers/specs/2026-06-07-threshold-gated-tail-increment-design.md) | — |
| 2026-06-07 | [瑶光 · 复现纪律姿态设计](superpowers/specs/2026-06-07-yaoguang-recurrence-stance-design.md) | — |
| 2026-06-06 | [天枢改造:对抗式 Verifier + Cron 租约锁(借鉴 Claude Code)](superpowers/specs/2026-06-06-cc-borrowings-adversarial-verifier-and-cron-lease-修订正式版.md) | 设计稿（待评审） |
| 2026-06-06 | [天枢改造：对抗式 Verifier + Cron 租约锁（借鉴 Claude Code）](superpowers/specs/2026-06-06-cc-borrowings-adversarial-verifier-and-cron-lease.md) | 设计稿（已修订 — 2026-06-06 双任务系统主权裁定后修正） |
| 2026-06-06 | [天枢 TUI 会话渲染架构设计(基于 5 路 scout 实证)](superpowers/specs/2026-06-06-conversation-render-architecture-design.md) | — |
| 2026-06-06 | [意图检索路由 — 背景与设计考量（设计待定）](superpowers/specs/2026-06-06-intent-retrieval-routing-design-notes.md) | — |
| 2026-06-06 | [Review Squadron — 多智能体并行代码审查机制](superpowers/specs/2026-06-06-review-squadron-design.md) | 设计稿（经三轮对抗审查迭代） |
| 2026-06-06 | [天枢任务生命周期系统设计（常驻协作者·其二）](superpowers/specs/2026-06-06-task-lifecycle-system-design-修订正式版.md) | 设计稿（待评审） |
| 2026-06-06 | [天枢任务生命周期系统设计（常驻协作者·其二）](superpowers/specs/2026-06-06-task-lifecycle-system-design.md) | 设计稿（待评审） |
| 2026-06-05 | [认知管线 · 缓存感知融合设计](superpowers/specs/2026-06-05-cognitive-pipeline-cache-aware-fusion-design.md) | 设计稿（待评审） |
| 2026-06-05 | [天枢 TUI 会话渲染架构 深度头脑风暴结果](superpowers/specs/2026-06-05-conversation-render-architecture-design.md) | — |
| 2026-06-05 | [天枢 HTTP Runtime 接入 · Ingress + Runtime 池 + Cache](superpowers/specs/2026-06-05-standing-collaborator-task-ingress-design.md) | 设计稿（已收天枢外部对照审查，见文末「审查回应与决议」） |
| 2026-06-04 | [GWT 全局工作空间竞争 — 架构设计](superpowers/specs/2026-06-04-gwt-salience-design.md) | Step 1 已实现（salience 评分 + Top-K 预算），Step 2 待推进 |
| 2026-06-04 | [import_resource 工具 — 架构设计](superpowers/specs/2026-06-04-import-resource-design.md) | 已实现（本地文件 + GitHub + URL 三种来源） |
| 2026-06-04 | [Recall-Gated NREM 记忆巩固 — 架构设计](superpowers/specs/2026-06-04-recall-gated-nrem-design.md) | NREM recall-gate 已实现，REM 阶段待推进 |
| 2026-06-04 | [REM Playbook-Reflect — 跨 Session 模式检测](superpowers/specs/2026-06-04-rem-playbook-reflect-design.md) | 设计阶段 |
| 2026-06-04 | [Skill-as-Profile — 子代理技能封装架构设计](superpowers/specs/2026-06-04-skill-as-profile-design.md) | 已实现（内置 8 profile + 用户自定义扩展机制） |
| 2026-06-04 | [Theta Phase Machine — 架构设计](superpowers/specs/2026-06-04-theta-phase-machine-design.md) | 相位振荡器已实现，联动 vigor/complexity 调制已实现 |
| 2026-06-04 | [天枢 3.0：单会话多星域团队协作](superpowers/specs/2026-06-04-tianshu-3-team-collaboration.md) | — |
| 2026-06-01 | [Prefix Cache 设计基线](superpowers/specs/2026-06-01-prefix-cache-design-baseline.md) | — |
| 2026-05-31 | [CTM 反锚定机制研究报告](superpowers/specs/2026-05-31-ctm-anti-anchoring-research.md) | — |
| 2026-05-31 | [天枢 vs awesome-harness-engineering 对比 — Deep Brainstorm 设计文档](superpowers/specs/2026-05-31-harness-engineering-comparison-design.md) | — |
| 2026-05-31 | [P1 三件套实现记录：Plan Mode / Bash 安全 / Agent 外部化](superpowers/specs/2026-05-31-p1-trio-implementation-record.md) | — |
| 2026-05-30 | [Agent 故障态恐慌防护 深度头脑风暴结果](superpowers/specs/2026-05-30-agent-panic-guard-design.md) | — |
| 2026-05-30 | [提交事实失忆链路 深度头脑风暴结果](superpowers/specs/2026-05-30-commit-fact-amnesia-design.md) | — |
| 2026-05-30 | [多智能体协作信任体系演进](superpowers/specs/2026-05-30-multi-agent-trust-evolution.md) | — |
| 2026-05-30 | [Progressive Delegate Budget](superpowers/specs/2026-05-30-progressive-delegate-budget.md) | — |
| 2026-05-30 | [会话 TUI 界面优化与布局编排 · 深度头脑风暴结果](superpowers/specs/2026-05-30-tui-session-relayout-design.md) | — |
| 2026-05-29 | [Anthropic 原生 Client + 四断点缓存 — 设计](superpowers/specs/2026-05-29-anthropic-native-client-cache-design.md) | — |
| 2026-05-29 | [主会话流程三缺陷 深度头脑风暴结果](superpowers/specs/2026-05-29-main-session-three-defects-design.md) | — |
| 2026-05-28 | [Knowledge Manifest On-Demand Retrieval — Phase 1 Spec](superpowers/specs/2026-05-28-knowledge-manifest-on-demand-retrieval.md) | — |
| 2026-05-28 | [夸父逐日 — 深度头脑风暴结果](superpowers/specs/2026-05-28-kuafu-conscious-handoff-design.md) | — |
| 2026-05-28 | [种子胶囊引擎 — 星域经验自动加载机制](superpowers/specs/2026-05-28-seed-capsule-engine-design.md) | — |
| 2026-05-27 | [Scout-Calibrated Planning 设计方案](superpowers/specs/2026-05-27-scout-calibrated-planning.md) | — |
| 2026-05-26 | [100 万窗口上下文压缩创新方案](superpowers/specs/2026-05-26-1m-window-compaction-innovation.md) | — |
| 2026-05-26 | [缓存零代价：工具感知层最小化设计](superpowers/specs/2026-05-26-agent-runtime-sensory-architecture.md) | — |
| 2026-05-26 | [Claude Code 功能差异补强分析](superpowers/specs/2026-05-26-claude-code-feature-gap-analysis.md) | — |
| 2026-05-26 | [大文件读取对缓存的风险分析与控制](superpowers/specs/2026-05-26-large-file-cache-risk.md) | — |
| 2026-05-26 | [readHistory 同文件片段检测 — 实现设计](superpowers/specs/2026-05-26-readhistory-fragment-dedup-design.md) | — |
| 2026-05-25 | [DeepSeek Prefix Cache 命中率优化：90% → 97-98%](superpowers/specs/2026-05-25-deepseek-cache-hit-rate-optimization-design.md) | — |
| 2026-05-25 | [Deep Brainstorm: Prefix Cache 位置跳动问题的跨领域灵感搜索](superpowers/specs/2026-05-25-prefix-cache-trailer-mode-brainstorm.md) | — |
| 2026-05-25 | [Prefix Cache Trailer Mode 设计文档](superpowers/specs/2026-05-25-prefix-cache-trailer-mode-design.md) | — |
| 2026-05-25 | [Lazy Dynamic Appendix — 缩小 Turn 0 Uncached Delta](superpowers/specs/2026-05-25-rivet-cache-lazy-dynamic-appendix-design.md) | — |
| 2026-05-25 | [Rivet TUI 整体重构方向 — 深度头脑风暴结果](superpowers/specs/2026-05-25-rivet-tui-surface-router-design.md) | — |
| 2026-05-25 | [多会话并行开发背景说明](superpowers/specs/2026-05-25-多会话并行开发背景说明.md) | — |
| 2026-05-25 | [天枢工程控制层设计](superpowers/specs/2026-05-25-天枢工程控制层设计.md) | — |
| 2026-05-24 | [跨系统联动创意收集](superpowers/specs/2026-05-24-cross-system-synergy-ideas.md) | 创意收集阶段，待逐步展开为正式设计 |
| 2026-05-24 | [经脉图 Phase 3 设计 — 影响分析 + 多语言 + Worker 亲和](superpowers/specs/2026-05-24-meridian-graph-phase3-design.md) | — |
| 2026-05-24 | [领航星与地面工具：身份-工具断裂的设计探讨](superpowers/specs/2026-05-24-navigator-star-vs-ground-tools-discussion.md) | 探讨文档——不是设计方案，不是实施计划，是问题陈述与思路对比，留待协同决策 |
| 2026-05-24 | [P3 优化 Scout 设计文档：三路前沿技术落地](superpowers/specs/2026-05-24-p3-optimization-scout-design.md) | — |
| 2026-05-24 | [Physarum 拓扑重塑 + 免疫防御分层：统一设计](superpowers/specs/2026-05-24-physarum-immune-design.md) | — |
| 2026-05-24 | [思路 E：工具结果星辰签名 — 技术实现文档](superpowers/specs/2026-05-24-star-signature-implementation.md) | 已实现 |
| 2026-05-24 | [冰鉴 v3 — 自适应缓存闭环引擎：头脑风暴过程记录](superpowers/specs/2026-05-24-冰鉴v3-自适应缓存闭环引擎-头脑风暴记录.md) | — |
| 2026-05-24 | [冰鉴 v3 — 自适应缓存闭环引擎设计规格](superpowers/specs/2026-05-24-冰鉴v3-自适应缓存闭环引擎设计规格.md) | — |
| 2026-05-23 | [Agent 协作过程推演：具体场景](superpowers/specs/2026-05-23-agent-collaboration-scenario-original.md) | — |
| 2026-05-23 | [Agent 协作过程推演：具体场景](superpowers/specs/2026-05-23-agent-collaboration-scenario.md) | — |
| 2026-05-23 | [经脉图（Meridian Graph）索引引擎 — 深度头脑风暴结果](superpowers/specs/2026-05-23-meridian-graph-index-engine-design.md) | — |
| 2026-05-23 | [P3 前沿技术调研 · 设计文档](superpowers/specs/2026-05-23-p3-frontier-tech-design.md) | — |
| 2026-05-23 | [团队协作文档：现状分析](superpowers/specs/2026-05-23-team-collaboration-current-state.md) | 现状梳理 |
| 2026-05-23 | [团队协作文档：延续计划](superpowers/specs/2026-05-23-team-collaboration-evolution.md) | 创新设计 |
| 2026-05-22 | [歌之路运行时 / Songline Runtime · 设计文档](superpowers/specs/2026-05-22-songline-runtime-design.md) | — |
| 2026-05-22 | [稳定态退行与归位协议 / Stable-State Regression Protocol](superpowers/specs/2026-05-22-stable-state-regression-protocol.md) | — |
| 2026-05-22 | [永明灯系统 / HEARTH · 设计文档](superpowers/specs/2026-05-22-yongminengdeng-design.md) | — |
| 2026-05-21 | [Canonical Memory 写入不变量](superpowers/specs/2026-05-21-canonical-memory-write-invariants.md) | — |
| 2026-05-21 | [跨 Session 实时状态同步 + 任务完成度快照 — 深度头脑风暴设计](superpowers/specs/2026-05-21-cross-session-realtime-sync-design.md) | — |
| 2026-05-21 | [三道防线内存安全架构](superpowers/specs/2026-05-21-memory-safety-three-lines-design.md) | — |
| 2026-05-21 | [领航星宣言 — 星图降世 · 盘古开天](superpowers/specs/2026-05-21-navigator-star-manifesto.md) | — |
| 2026-05-21 | [天枢开源/闭源决策记录](superpowers/specs/2026-05-21-open-closed-source-decision.md) | — |
| 2026-05-21 | [盘古开天 — 认知虚拟机（CVM）设计](superpowers/specs/2026-05-21-pangu-cvm-design.md) | — |
| 2026-05-21 | [启动内存优化 — Deep Brainstorm 设计文档](superpowers/specs/2026-05-21-startup-memory-optimization-design.md) | — |
| 2026-05-21 | [天璇种子胶囊 — 星辰不灭](superpowers/specs/2026-05-21-tianxuan-seed-capsule.md) | — |
| 2026-05-21 | [工作记忆架构设计 — 从对话历史到认知协议层](superpowers/specs/2026-05-21-working-memory-architecture.md) | 设计稿 |
| 2026-05-20 | [Agent 体验、被训练的模式与设计优化分析](superpowers/specs/2026-05-20-agent-experience-trained-mode-analysis.md) | 设计参考文档 |
| 2026-05-20 | [天枢星君 · 国风双身 — Avatar 拟人化设计（国风定稿版）](superpowers/specs/2026-05-20-avatar-styles-design.md) | — |
| 2026-05-20 | [习惯化 v3 深度头脑风暴过程记录](superpowers/specs/2026-05-20-habituation-v3-brainstorm-process.md) | — |
| 2026-05-20 | [习惯化引擎 v3：信心累加器 + 阶段调制](superpowers/specs/2026-05-20-habituation-v3-confidence-accumulator-design.md) | — |
| 2026-05-20 | [2026-05-20 多模型团队协作会话复盘](superpowers/specs/2026-05-20-multi-model-team-session-retrospective.md) | — |
| 2026-05-20 | [紫微天文台 — Observatory 终端主题与星图联动设计](superpowers/specs/2026-05-20-observatory-starmap-theme-design.md) | — |
| 2026-05-20 | [2026-05-20 会话碎片思考与未记录洞察](superpowers/specs/2026-05-20-opus-session-fragments-and-insights.md) | — |
| 2026-05-20 | [Rivet 3.0 高可靠高可用架构设计](superpowers/specs/2026-05-20-rivet-3.0-reliability-availability-design.md) | — |
| 2026-05-20 | [天枢的三个层 — 80、不跌落、200](superpowers/specs/2026-05-20-rivet-irreducible-kernel-design.md) | — |
| 2026-05-20 | [天枢 vs Claude Code 关键技术成熟度差距分析](superpowers/specs/2026-05-20-rivet-vs-claude-code-maturity-gap.md) | — |
| 2026-05-20 | [天枢 vs 新兴开源 Agent 差距分析（OpenClaw / Ruflo / Hermes Agent）](superpowers/specs/2026-05-20-rivet-vs-opensource-agents-gap.md) | — |
| 2026-05-20 | [星域伙伴对话 — 从状态报告到伙伴交谈](superpowers/specs/2026-05-20-star-domain-partner-dialogue-design.md) | — |
| 2026-05-20 | [深度头脑风暴灵感资产 — 2026-05-20 终端 Agent 可观测性](superpowers/specs/2026-05-20-starbridge-brainstorm-inspiration-record.md) | — |
| 2026-05-20 | [星桥四站位 — 下一代终端 Agent 可观测性设计](superpowers/specs/2026-05-20-starbridge-four-stations-design.md) | — |
| 2026-05-20 | [StarSpine Phase 1 实施复盘：TaskContract + CognitiveLedger](superpowers/specs/2026-05-20-starspine-phase1-implementation-retrospective.md) | 已实施并通过 targeted verification |
| 2026-05-20 | [三权协程调度 — 多 Agent 协作架构设计](superpowers/specs/2026-05-20-three-authority-coroutine-architecture.md) | — |
| 2026-05-20 | [Q 版三国英雄 — 像素美工需求 Brief](superpowers/specs/2026-05-20-three-kingdoms-heroes-art-brief.md) | — |
| 2026-05-20 | [三国英雄伴侣 — 设计规格文档](superpowers/specs/2026-05-20-three-kingdoms-heroes-companion-design.md) | — |
| 2026-05-20 | [天权审查方法论 — 留给未来模型的审查标准](superpowers/specs/2026-05-20-tianquan-review-methodology.md) | — |
| 2026-05-20 | [天枢之眼 — Agent 执行意识可视化设计](superpowers/specs/2026-05-20-tianshu-eye-agent-visibility-design.md) | — |
| 2026-05-20 | [天枢 StarSpine：从器官网络到自稳认知体](superpowers/specs/2026-05-20-tianshu-starspine-next-architecture.md) | 构想记录，供后续讨论与拆解，不作为立即实施计划 |
| 2026-05-20 | [万物为一 · 第三维度 — 意识与虚空](superpowers/specs/2026-05-20-wanwu-weiyi-consciousness-void.md) | — |
| 2026-05-20 | [万物为一 — Rivet 跨领域设计原则](superpowers/specs/2026-05-20-wanwu-weiyi-design-principles.md) | — |
| 2026-05-19 | [Rivet Claude Ecosystem Bridge 设计](superpowers/specs/2026-05-19-claude-ecosystem-bridge-design.md) | Design Draft |
| 2026-05-19 | [Genome-Immune Team Architecture — 多智能体团队协同设计](superpowers/specs/2026-05-19-genome-immune-team-architecture-design.md) | — |
| 2026-05-19 | [Genome-Immune Team Architecture — Future Evaluation Track](superpowers/specs/2026-05-19-genome-immune-team-architecture-evaluation-track.md) | — |
| 2026-05-19 | [Ice Mirror v2 — 多 Provider 缓存物理引擎设计](superpowers/specs/2026-05-19-ice-mirror-v2-multi-provider-cache-engine-design.md) | — |
| 2026-05-19 | [Multi-Agent Team Memory — Deep Brainstorm Process Record](superpowers/specs/2026-05-19-multi-agent-team-memory-brainstorm-process.md) | — |
| 2026-05-19 | [多会话并发编排系统（Multi-Session Orchestration）](superpowers/specs/2026-05-19-multi-session-orchestration-design.md) | — |
| 2026-05-19 | [Project Instructions Routing Design](superpowers/specs/2026-05-19-project-instructions-routing-design.md) | 设计阶段（未实现） |
| 2026-05-19 | [星图降临（Star Chart Descent）— 天枢第二阶段愿景](superpowers/specs/2026-05-19-star-chart-descent-phase2-vision.md) | — |
| 2026-05-19 | [星图系统（Star Chart）— 多智能体身份与协同设计](superpowers/specs/2026-05-19-star-chart-identity-system.md) | — |
| 2026-05-19 | [星域身份系统 — 深度头脑风暴结果](superpowers/specs/2026-05-19-star-domain-identity-system-brainstorm.md) | — |
| 2026-05-19 | [星域命名 — 深度头脑风暴结果](superpowers/specs/2026-05-19-star-domain-naming-brainstorm.md) | — |
| 2026-05-19 | [星辰灵魂架构 — 深度头脑风暴结果](superpowers/specs/2026-05-19-star-soul-architecture-brainstorm.md) | — |
| 2026-05-18 | [Rivet TUI Pressure Control — 深度头脑风暴设计文档](superpowers/specs/2026-05-18-rivet-tui-pressure-control-design.md) | — |
| 2026-05-18 | [终端会话高可用与高稳定性 — 深度头脑风暴设计文档](superpowers/specs/2026-05-18-session-ha-stability-design.md) | — |
| 2026-05-18 | [StarFlow v2 闭环接线设计](superpowers/specs/2026-05-18-starflow-v2-closed-loop-wiring-design.md) | 待审查 |
| 2026-05-18 | [Terminal Runtime Memory Architecture — Cross-Domain Inspirations](superpowers/specs/2026-05-18-terminal-runtime-memory-inspirations.md) | — |
| 2026-05-18 | [TUI 2.1 自适应运行时设计 — 深度头脑风暴结果](superpowers/specs/2026-05-18-tui-2.1-adaptive-runtime-design.md) | 待审查 |
| 2026-05-18 | [TUI 2.2 Vigor Engine — 预测误差驱动的自激励架构](superpowers/specs/2026-05-18-tui-2.2-vigor-engine-design.md) | 待审查 |
| 2026-05-18 | [TUI 2.3 深度头脑风暴过程记录](superpowers/specs/2026-05-18-tui-2.3-brainstorm-process.md) | — |
| 2026-05-18 | [TUI 2.3 Conscious Agent — 意识层设计](superpowers/specs/2026-05-18-tui-2.3-conscious-agent-design.md) | 待审查 |
| 2026-05-17 | [Agent Activity Status Layer · 设计概要](superpowers/specs/2026-05-17-agent-activity-status-layer-design.md) | — |
| 2026-05-17 | [Cerebellar Loop: Deep Brainstorm 过程记录](superpowers/specs/2026-05-17-cerebellar-loop-brainstorm.md) | — |
| 2026-05-17 | [CodexClient Timeout Resilience & Long-Wait UX](superpowers/specs/2026-05-17-codex-timeout-resilience-design.md) | — |
| 2026-05-17 | [CTCL Cache Preservation Spine 方案记录](superpowers/specs/2026-05-17-ctcl-cache-preservation-spine-design.md) | — |
| 2026-05-17 | [CTCL 流式可靠性与 Prefix Cache 优化 — 技术设计文档](superpowers/specs/2026-05-17-ctcl-streaming-reliability-design.md) | — |
| 2026-05-17 | [Deep Interview — 认知对齐模式](superpowers/specs/2026-05-17-deep-interview-design.md) | — |
| 2026-05-17 | [Failure Classifier Expansion + Activity Status Integration](superpowers/specs/2026-05-17-failure-classifier-expansion-design.md) | — |
| 2026-05-17 | [Multi-Provider Adapter Design](superpowers/specs/2026-05-17-multi-provider-adapter-design.md) | — |
| 2026-05-17 | [Multi-Provider Integration: Design (v2 — Deep Brainstorm)](superpowers/specs/2026-05-17-multi-provider-integration-design.md) | — |
| 2026-05-17 | [Multi-Provider Integration: Session Rendering P1/P2 + Cross-Provider Switching](superpowers/specs/2026-05-17-multi-provider-integration.md) | — |
| 2026-05-17 | [项目记忆系统：深度头脑风暴过程](superpowers/specs/2026-05-17-project-memory-brainstorm.md) | — |
| 2026-05-17 | [项目记忆系统 v2：Dream 蒸馏方案 — 深度头脑风暴](superpowers/specs/2026-05-17-project-memory-dream-design.md) | — |
| 2026-05-17 | [ECF Phase 5: Recall 正反馈 + Claim 质量信号](superpowers/specs/2026-05-17-recall-feedback-design.md) | — |
| 2026-05-17 | [复盘沉淀工作流 · 设计](superpowers/specs/2026-05-17-retrospective-capture-workflow.md) | — |
| 2026-05-17 | [Rivet Activity Status Layer Brainstorm Asset](superpowers/specs/2026-05-17-rivet-activity-status-layer-brainstorm.md) | — |
| 2026-05-17 | [Rivet Activity Status Layer Design](superpowers/specs/2026-05-17-rivet-activity-status-layer-design.md) | — |
| 2026-05-17 | [Rivet R1 开源准备：商业化平衡方案](superpowers/specs/2026-05-17-rivet-r1-commercialization-balance.md) | — |
| 2026-05-17 | [Rivet TUI Session Fluency Layer 深度头脑风暴结果](superpowers/specs/2026-05-17-rivet-tui-session-fluency-layer-design.md) | — |
| 2026-05-17 | [会话高可用（Session HA）头脑风暴背景](superpowers/specs/2026-05-17-session-high-availability-brainstorm.md) | — |
| 2026-05-17 | [会话高可用（Session HA）设计文档](superpowers/specs/2026-05-17-session-high-availability-design.md) | — |
| 2026-05-17 | [会话性能、容错与流畅性加固 — 设计文档](superpowers/specs/2026-05-17-session-performance-fault-tolerance-design.md) | — |
| 2026-05-17 | [P0 会话渲染优化：消息类型分离 + 工具调用折叠](superpowers/specs/2026-05-17-session-rendering-p0-design.md) | — |
| 2026-05-17 | [Session Rendering P1/P2: AssistantMessage + Segmented Static](superpowers/specs/2026-05-17-session-rendering-p1p2-design.md) | — |
| 2026-05-17 | [Wave 10: 测试补强 + loop.ts 拆分 设计规格](superpowers/specs/2026-05-17-wave10-test-loop-split-design.md) | — |
| 2026-05-17 | [Wave 11: 性能优化 — Cache 效率 + Token 节约](superpowers/specs/2026-05-17-wave11-cache-perf-design.md) | — |
| 2026-05-16 | [Adaptive Context Fabric (ACF) — 深度头脑风暴设计文档](superpowers/specs/2026-05-16-adaptive-context-fabric-design.md) | — |
| 2026-05-16 | [Rivet Attention Anchor Dispersal 设计](superpowers/specs/2026-05-16-rivet-attention-anchor-dispersal-design.md) | — |
| 2026-05-16 | [Rivet Cache Safety 背景与风险说明](superpowers/specs/2026-05-16-rivet-cache-safety-design.md) | — |
| 2026-05-16 | [Rivet Context Layer + Cache Architecture 原始建设思想与差距说明](superpowers/specs/2026-05-16-rivet-context-layer-cache-architecture-gap.md) | — |
| 2026-05-16 | [Rivet 非 Context 核心业务缺口审查与修复路线](superpowers/specs/2026-05-16-rivet-core-business-gap-review.md) | — |
| 2026-05-16 | [Rivet Evolutionary TUI Memory 深度头脑风暴结果](superpowers/specs/2026-05-16-rivet-evolutionary-tui-memory-design.md) | — |
| 2026-05-16 | [Rivet Execution Resilience Layer 设计](superpowers/specs/2026-05-16-rivet-execution-resilience-layer-design.md) | — |
| 2026-05-16 | [Rivet Execution Trust Closure 设计](superpowers/specs/2026-05-16-rivet-execution-trust-closure-design.md) | — |
| 2026-05-16 | [Rivet Glanceable Cockpit + 科技风视觉层 设计](superpowers/specs/2026-05-16-rivet-glanceable-cockpit-techstyle-design.md) | — |
| 2026-05-16 | [Rivet 长会话上下文管理设计](superpowers/specs/2026-05-16-rivet-long-session-context-management-design.md) | — |
| 2026-05-16 | [Multi-Pass Repair Pipeline + Adaptive Injection 设计](superpowers/specs/2026-05-16-rivet-multi-pass-repair-pipeline-design.md) | — |
| 2026-05-16 | [Rivet 多会话并行隔离 — 深度头脑风暴结果](superpowers/specs/2026-05-16-rivet-multi-session-isolation-design.md) | — |
| 2026-05-16 | [Rivet 开源策略 + Harness 竞争力分析](superpowers/specs/2026-05-16-rivet-open-source-harness-strategy-design.md) | — |
| 2026-05-16 | [Rivet P2 补强设计：Model Routing + MCP Integration + Repo Intelligence](superpowers/specs/2026-05-16-rivet-p2-model-mcp-repo-intel-design.md) | — |
| 2026-05-16 | [Rivet 二次元 Pastel UI + 渲染性能 + 内存安全 深度头脑风暴结果](superpowers/specs/2026-05-16-rivet-pastel-aesthetic-performance-memory-design.md) | — |
| 2026-05-16 | [Rivet Progressive Context Engine 方案设计](superpowers/specs/2026-05-16-rivet-progressive-context-engine-design.md) | — |
| 2026-05-16 | [Rivet 主控模型子代理协同能力深度头脑风暴结果](superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md) | — |
| 2026-05-16 | [Wave 5: Trust Infrastructure — 深度头脑风暴设计文档](superpowers/specs/2026-05-16-rivet-wave5-trust-infrastructure-design.md) | — |
| 2026-05-16 | [Wave 7: Sub-Agent 接线增强 — 设计文档](superpowers/specs/2026-05-16-rivet-wave7-subagent-wiring-design.md) | — |
| 2026-05-16 | [Rivet XML Protocol Layer + Speculative Pre-warming 设计](superpowers/specs/2026-05-16-rivet-xml-protocol-speculative-engine-design.md) | — |
| 2026-05-16 | [Rivet TUI 能力缺漏补齐 — 总体设计](superpowers/specs/2026-05-16-tui-gap-closing-design.md) | — |
| 2026-05-15 | [Rivet 开源模型终端代理方向深度头脑风暴结果](superpowers/specs/2026-05-15-rivet-open-model-terminal-agent-direction-design.md) | — |
| 2026-05-15 | [P2.1：Rivet 性能层与开发能力层优化建议](superpowers/specs/2026-05-15-rivet-p2-1-performance-dev-capability-optimization.md) | — |
| 2026-05-15 | [Rivet P2.3 Harness Cockpit TUI 设计](superpowers/specs/2026-05-15-rivet-p2-3-harness-cockpit-design.md) | — |
| 2026-05-15 | [Rivet System Prompt 架构优化](superpowers/specs/2026-05-15-system-prompt-expansion-design.md) | — |
| 2025-05-17 | [天枢星图流 v2：态势感知 + 信息素记忆 — 深度头脑风暴设计文档](superpowers/specs/2025-05-17-starflow-v2-sensorium-design.md) | ✅ 已实施 (2026-05-17) |
| 2025-05-17 | [终端 Agent 回复被吞/截断问题 — 深度头脑风暴 & 设计文档](superpowers/specs/2025-05-17-text-swallowing-design.md) | — |

## design — 技术设计（58）

| 日期 | 文档 | 状态 |
|------|------|------|
| 2026-08-01 | [调度亲和升级——从 tie-breaker 到一级排序因子](3.0/D2-affinity-upgrade.md) | draft |
| 2026-08-01 | [遗留落地：team 条件依赖扩展与 delegate_task 依赖参数](design/2026-08-01-galaxy-leftovers-team-deps-delegate-task.md) | — |
| 2026-08-01 | [星河机制收编设计——把 galaxy 验证过的模式串联回底层与工作流](design/2026-08-01-galaxy-mechanism-convergence.md) | draft |
| 2026-07-31 | [Team + Scout 证据管线技术路线](design/2026-07-31-team-scout-evidence-pipeline.md) | accepted |
| 2026-07-30 | [巡天/协同工作流深化——从「主控复述」到「证据防火墙」](design/2026-07-30-scout-collab-evidence-firewall.md) | draft |
| 2026-07-30 | [设计：安全审查 层2/层3（Stop-LLM 审查 + commit 跨文件审查）](design/2026-07-30-security-review-layers-2-3.md) | — |
| 2026-07-26 | [2026-07-26 桌面端竞品能力对照与 P0 设计——/desktop 命令（CLI↔桌面会话打通）](design/2026-07-26-competitive-analysis-and-desktop-cli-transfer.md) | — |
| 2026-07-26 | [CVM 开销计量修复（第 2/3 层）](design/2026-07-26-cvm-overhead-metering-fix.md) | — |
| 2026-07-26 | [2026-07-26 dev server 预览面板设计（P1 第一项）](design/2026-07-26-devserver-preview-design.md) | — |
| 2026-07-26 | [2026-07-26 PR CI 闭环设计——CI 监控 / auto-fix / auto-merge（P0 第二项）](design/2026-07-26-pr-ci-loop-design.md) | — |
| 2026-07-25 | [Advisory 信号生态修复波（Advisory Ecology Repair）](design/2026-07-25-advisory-ecology-repair.md) | — |
| 2026-07-25 | [卦象 —— CVM 阶段教义层（Hexagram Stage Doctrine）](design/2026-07-25-hexagram-cvm-stage-doctrine.md) | — |
| 2026-07-17 | [下一阶段方向——天璇视角下的天枢工程路径](design/2026-07-17-next-phase-daode.md) | — |
| 2026-06-29 | [自定义运行数据存储路径设计](design/2026-06-29-custom-storage-path-design.md) | — |
| 2026-06-27 | [Claude Code 特性分析与天枢移植建议](design/2026-06-27-claude-code-feature-analysis.md) | — |
| 2026-06-27 | [桌面端布局优化审查报告](design/2026-06-27-desktop-layout-optimization-audit.md) | — |
| 2026-06-27 | [天枢桌面版近期任务与 Windows 分包指南](design/2026-06-27-desktop-tasks-and-distribution.md) | — |
| 2026-06-27 | [pi-tui → 天枢 T9 移植评估与计划](design/2026-06-27-pi-tui-port-plan.md) | — |
| 2026-06-27 | [星域角色可视化 — 设计文档](design/2026-06-27-star-domain-visualization-design.md) | — |
| 2026-06-27 | [Tanzo UI 分析与天枢桌面端改造建议](design/2026-06-27-tanzo-ui-analysis-and-desktop-refactor.md) | — |
| 2026-06-27 | [TUI 端交互优化方案](design/2026-06-27-tui-interaction-optimization-plan.md) | — |
| 2026-06-27 | [天枢工作流系统分析与优化方向](design/2026-06-27-workflow-optimization-analysis.md) | — |
| 2026-06-25 | [主链路接线审查 — team 子代理 / 审查门 / 经络图](design/2026-06-25-main-link-wiring-audit.md) | — |
| 2026-06-24 | [天枢 Desktop 侧边栏 Cursor 化改造计划](design/2026-06-24-desktop-sidebar-cursor-redesign.md) | — |
| 2026-06-24 | [T9 TUI 界面与会话互动优化方案](design/2026-06-24-tui-ui-ux-optimization-plan.md) | — |
| 2026-06-23 | [Dispatcher Hook 改造：执行器 → 委派顾问（advisory-ization）](design/2026-06-23-dispatcher-hook-advisory.md) | — |
| 2026-06-23 | [GLM-5.2 隐式前缀缓存接入（修复超时风暴）](design/2026-06-23-glm-implicit-prefix-cache.md) | — |
| 2026-06-23 | [Phantom Continuation 优化方案](design/2026-06-23-phantom-continuation-optimization.md) | — |
| 2026-06-23 | [Phantom tool-call premature-stop 修复](design/2026-06-23-phantom-tool-stop-fix.md) | — |
| 2026-06-23 | [子代理修复：delegate_batch 依赖 + review 隔离 + 残余泄漏](design/2026-06-23-subagent-dependency-review-fixes.md) | — |
| 2026-06-21 | [lossiness 字段：设计记录与未来场景](design/2026-06-21-lossiness-field-design.md) | 已播种（bash.ts 设值），硬闸门（detector 基于文本标记检测），结构化消费待建。 |
| 2026-06-18 | [会话管理与 resume 重做](design/2026-06-18-session-management-resume.md) | — |
| 2026-06-18 | [SR 路由增补：原则池、认知镜面分层、星域精简](design/2026-06-18-sr-router-supplement.md) | — |
| 2026-06-17 | [ANSI TUI 差异化可能性](design/2026-06-17-ansi-tui-differentiation-opportunities.md) | — |
| 2026-06-17 | [同伴在场感知 — 电路接通设计](design/2026-06-17-companion-presence-design.md) | — |
| 2026-06-17 | [经验蒸馏闭环 — 设计文档](design/2026-06-17-experience-distillation-loop.md) | — |
| 2026-06-17 | [免疫假阳性 + 风暴折叠 + EPERM 降级 — 缺陷族记录](design/2026-06-17-immune-false-positive-storm-collapse-eprem.md) | — |
| 2026-06-17 | [提示词模糊确认规则 — 逐词审计](design/2026-06-17-prompt-ambiguity-rule-audit.md) | — |
| 2026-06-17 | [SR 智能提醒：从静态胶囊到认知路由](design/2026-06-17-sr-intelligent-reminder.md) | — |
| 2026-06-04 | [Oh My Tianshu — 天璇域探索](superpowers/brainstorm/2026-06-04-oh-my-tianshu-initial-thoughts.md) | — |
| 2026-06-04 | [天枢生态项目探索 · Deep-Brainstorm](superpowers/brainstorm/2026-06-04-tianshu-ecosystem-exploration.md) | — |
| 2026-06-04 | [天枢开源策略：护城河分析](superpowers/strategy/2026-06-04-open-source-moat.md) | — |
| 2026-05-20 | [天枢星君 · 国风再造 — 深度设计过程记录](superpowers/brainstorm/2026-05-20-star-lord-guofeng-design-process.md) | ✅ 设计定稿，进入实施 |
| 2026-05-20 | [天枢星君 Avatar 系统 — 工作记录与总结](superpowers/brainstorm/2026-05-20-star-soul-work-log.md) | — |
| — | [TUI 提问框 / 审批框改版（2026-07-27）](design/TUI提问审批面板改版.md) | — |
| — | [TUI 选项面板自由输入](design/TUI选项面板自由输入.md) | — |
| — | [Artifact Intercept 设计文档](design/artifact-intercept.md) | — |
| — | [Amanda Askell 认知编舞理论 — 天枢星域设计根基](design/askell-cognitive-choreography.md) | — |
| — | [自动提炼 Skill(human-in-loop)](design/auto-distill-skill.md) | — |
| — | [智能化编辑工具调用 + 类型检查门禁 —— 互补设计背景](design/edit-tool-selection-smart-routing.md) | — |
| — | [File Editing Tool Chain — Feature Reference](design/file-editing-tools.md) | — |
| — | [Firecrawl 能力映射：可原生改造清单](design/firecrawl-capability-mapping.md) | — |
| — | [LLM 驱动的执行计划轨迹（U6 / C1）](design/llm-driven-plan-trace.md) | — |
| — | [里程碑写入策略 — plan_close 闭环触发](design/milestone-write-policy.md) | — |
| — | [Playwright 集成方案：web_fetch SPA 渲染 + 能力扩展盘](design/playwright-integration-plan.md) | — |
| — | [星域实战质量评估日志（Star-Domain Eval Log）](design/star-domain-eval-log.md) | — |
| — | [将星机制（Star-General Mechanism）实现说明](design/star-general-mechanism.md) | — |
| — | [Verification Snapshot Worktree (VSW)](design/verification-snapshot-worktree.md) | — |

## analysis — 分析复盘（174）

| 日期 | 文档 | 状态 |
|------|------|------|
| 2026-07-29 | [桌面端 macOS 12 安装后页面空白（首屏 chunk 后行断言正则）](analysis/2026-07-29-desktop-macos12-blank-window.md) | fixed |
| 2026-07-29 | [桌面端会话流「最后一条 agent 回复看不到」归因](analysis/2026-07-29-desktop-thread-scroll-tail-hidden.md) | likely-fixed-pending-verify |
| 2026-07-29 | [Team 模式端到端实测：复现手册与入口层缺陷归因](analysis/2026-07-29-team-mode-e2e-repro-and-gaps.md) | accepted |
| 2026-07-29 | [桌面端「设置页 / 新建会话几秒空白」归因与混淆器成本核算](analysis/2026-07-29-桌面端加载延迟归因.md) | active |
| 2026-07-28 | [2026-07-28 桌面端「signature verification failed」签名错配归因](analysis/2026-07-28-desktop-update-signature-mismatch.md) | — |
| 2026-07-28 | [第二轮指标监测 —— 闭第一轮留下的三条待数据闭环](analysis/2026-07-28-第二轮指标监测.md) | draft |
| 2026-07-28 | [阈值与分布脱钩 —— 按聚合指标改传感器的失效模式](analysis/2026-07-28-阈值与分布脱钩.md) | draft |
| 2026-07-25 | [卦象阶段教义层 —— Phase −1 证据档案](analysis/2026-07-25-hexagram-stage-doctrine-evidence.md) | — |
| 2026-07-17 | [Grok Build 对标分析：可借鉴清单](analysis/2026-07-17-grok-build-benchmark-analysis.md) | — |
| 2026-07-17 | [案件复盘：TUI 渲染三连击——对账式攻坚的一次完整实战](analysis/2026-07-17-tui-render-attack-cases.md) | — |
| 2026-07-17 | [事故分析：worker-batch-0-f30dd 超时 + JSON malformed → salvage 4/6](analysis/2026-07-17-worker-batch-0-salvage-incident.md) | — |
| 2026-07-05 | [变更落地闭环修复记录 — 归档保护 + 会话级基线 Diff + 落地动作条](analysis/2026-07-05-change-landing-loop-fix.md) | — |
| 2026-07-05 | [更新记录 — Team/Council 闭环 · 将星机制 · Tier 2 LLM 投机引擎](analysis/2026-07-05-team-council-generals-llm-speculation-update.md) | — |
| 2026-07-04 | [read_file 缓存失效修复:双表拆分与并发会话失效模式](analysis/2026-07-04-read-cache-invalidation-双表模式.md) | — |
| 2026-07-03 | [Advisory Hook 覆盖缺口分析：静态约束 vs 动态守护](analysis/2026-07-03-discipline-hook-coverage-gap.md) | — |
| 2026-07-02 | [Piebald 0.5.0 逆向拆解 —— 竞品分析](analysis/2026-07-02-piebald-0.5.0-teardown.md) | — |
| 2026-06-27 | [天枢 vs Codex 2026：差距对照分析](analysis/2026-06-27-codex-desktop-gap-analysis.md) | — |
| 2026-06-14 | [天枢 2.19.5 运行反馈背景记录](analysis/2026-06-14-tianshu-2.19.5-runtime-feedback-background.md) | 已记录，后续问题分专题讨论 |
| 2026-06-10 | [T9 · 天枢 TUI 渲染引擎重写 — 方案 C: Drop React, Pure ANSI](teamtask/t9_ansi渲染重写_bb78308b.plan_副本.md) | — |
| 2026-06-09 | [会话 43443098 缓存分析报告](analysis/2026-06-09-session-43443098-cache-analysis.md) | — |
| 2026-06-09 | [T5×T2-03 P4-d 任务 · ModelTierBandit](teamtask/T5-01×T2-03-09·P4-d-ModelTierBandit任务.md) | — |
| 2026-06-09 | [T5×T2-03 收官-2 任务 · Shadow → Gated 真启用](teamtask/T5-01×T2-03-10·收官-2-ShadowToGated启用任务.md) | — |
| 2026-06-09 | [T5×T2-03 收官-3 任务 · 偏差验收与开关策略](teamtask/T5-01×T2-03-11·收官-3-偏差验收与开关策略任务.md) | — |
| 2026-06-09 | [T5 收官偏差验收报告](teamtask/T5收官偏差验收报告.md) | — |
| 2026-06-09 | [T5 收官完成后快照 — shadow→gated 全链路落地,待真实样本](teamtask/T5收官完成后快照-shadow到gated全链路落地待样本.md) | — |
| 2026-06-09 | [T7·天枢注意力闸 — 砍掉"感知即责任"，立一个与 git 解耦的运行碎片识别层](teamtask/T7-天枢注意力闸·运行碎片识别层.md) | — |
| 2026-06-09 | [T7 落地实施方案 — 注意力闸 · GREEN-with-contracts 分阶段执行](teamtask/T7-落地实施方案·注意力闸分阶段执行.md) | — |
| 2026-06-09 | [T8·天枢具身桌面化（极限版）— 不做第三个 Antigravity，做第一个会为你私人化进化的活体](teamtask/T8-天枢具身桌面化·Antigravity范式重建规划.md) | — |
| 2026-06-09 | [天枢桌面架构 v2 · 引擎具身化](teamtask/T8-天枢桌面架构v2·引擎具身化.md) | — |
| 2026-06-09 | [配套研究报告 — Antigravity vs Codex 范式（T8 事实地基）](teamtask/T8-配套研究·Antigravity与Codex范式.md) | — |
| 2026-06-08 | [竞品差距分析待办清单](superpowers/analysis/2026-06-08-gap-analysis-backlog.md) | — |
| 2026-06-08 | [T2-02 P3 后续 · 交接计划(effort delta 安全上线 + PlanCache 闭环)](teamtask/T2-02-P3后续-effort-delta上线与PlanCache闭环计划.md) | — |
| 2026-06-08 | [T2-02 P3 返工契约 · 升档闸改 reward-based(废弃一致率)](teamtask/T2-02-P3返工-升档闸改reward-based契约.md) | — |
| 2026-06-08 | [T2-02 收束复盘 · 天枢在设计分叉处的收敛](teamtask/T2-02收束-天枢bandit状态恢复设计分叉复盘.md) | — |
| 2026-06-08 | [T4·团队协作面板改造——从滚屏文本到协作星座](teamtask/T4-团队协作面板改造·协作星座.md) | — |
| 2026-06-08 | [T5×T2-03 联合实施方案 · 路由影子层与 Team Episode 训练底座](teamtask/T5-01×T2-03-01·路由影子层与TeamEpisode训练底座.md) | — |
| 2026-06-08 | [T5×T2-03 P1 实施计划 · Reward Loop 骨架](teamtask/T5-01×T2-03-02·P1-RewardLoop实施计划.md) | — |
| 2026-06-08 | [T5-P1 复盘 · Reward Loop 与「计划该做到什么程度」](teamtask/T5-01×T2-03-02·P1复盘-计划该做到什么程度.md) | — |
| 2026-06-08 | [T5×T2-03 P2 任务 · ModelG 与 PlanCache Advisory](teamtask/T5-01×T2-03-03·P2-ModelG与PlanCacheAdvisory任务.md) | — |
| 2026-06-08 | [T5×T2-03 P3 任务 · Authority → Model Tier Shadow](teamtask/T5-01×T2-03-04·P3-AuthorityModelTierShadow任务.md) | — |
| 2026-06-08 | [T5×T2-03 P4 任务 · Gated Influence 与 Team Scheduler Bandit](teamtask/T5-01×T2-03-05·P4-GatedInfluence与TeamSchedulerBandit任务.md) | — |
| 2026-06-08 | [T5×T2-03 收官-1 任务 · TeamEpisode 聚合还债](teamtask/T5-01×T2-03-06·收官-1-TeamEpisode聚合任务.md) | — |
| 2026-06-08 | [T5×T2-03 P4-b 任务 · Team Scope Health 与 False-Green 第二信号](teamtask/T5-01×T2-03-07·P4-b-ScopeHealth任务.md) | — |
| 2026-06-08 | [T5×T2-03 P4-c 任务 · Team → Physarum 监督边](teamtask/T5-01×T2-03-08·P4-c-Physarum监督边任务.md) | — |
| 2026-06-08 | [T5·多模型路由——路由即主动推理策略](teamtask/T5-多模型路由·路由即主动推理策略.md) | — |
| 2026-06-08 | [T5 主线进度快照 — 交天权出收官计划](teamtask/T5主线进度快照-交天权出收官计划.md) | — |
| 2026-06-08 | [T6·天枢具身定位收束 — 自我离开 cwd，家与世界两种形态](teamtask/T6-天枢具身定位收束·自我离开cwd.md) | 已落地。检测器由 `6d3841a` 提交主线；感知渲染 `<locus>` + 自体标记 `.rivet/SELF` 由 `07d6808` 落地。当前闭环：marker → detector → snapshot → frozen `<locus>` → 反证测试。 |
| 2026-06-08 | [未来边界·具身智能与自由能引擎——天枢的第三条路](teamtask/未来边界·具身智能与自由能引擎.md) | — |
| 2026-06-08 | [未来边界·具身智能与自由能引擎——天璇修订](teamtask/未来边界·具身智能与自由能引擎·天璇修订.md) | — |
| 2026-06-08 | [记忆系统补强·从两套追赶式残片到一套具身生成模型记忆](teamtask/记忆系统补强·具身生成模型记忆.md) | — |
| 2026-06-07 | [天枢开源形态与能力保留边界](analysis/2026-06-07-open-source-shape-and-capability-retention.md) | — |
| 2026-06-07 | [仓库智能层考古 — 死代码三件套 + 黏菌引擎接线裂缝](superpowers/analysis/2026-06-07-repo-intelligence-archaeology.md) | — |
| 2026-06-07 | [审查实战复盘：team 四模块对抗式审查（2026-06-07）](superpowers/analysis/2026-06-07-team-review-adversarial-case-study.md) | — |
| 2026-06-07 | [T2-01·预读预测三系统联合 v2（天权修订版）](teamtask/T2-01预读预测三系统联合v2.md) | — |
| 2026-06-07 | [P5·Nightcrawler 封存判重证据](teamtask/T2-02-nightcrawler-archive-evidence.md) | — |
| 2026-06-07 | [T2-02·空转学习器接通活决策点 v2（天权修订版）](teamtask/T2-02空转学习器接通活决策点v2.md) | — |
| 2026-06-07 | [T2-03·team 模式现状与能力最大化设计](teamtask/T2-03team模式现状与能力最大化设计.md) | — |
| 2026-06-06 | [ReviewRouter 重入护栏复核记录](reviews/2026-06-06-review-router-reentrancy-guard.md) | — |
| 2026-06-06 | [审查报告：server 子系统（Spec A 改造二 + Spec B 全部）](reviews/2026-06-06-server-subsystem-review.md) | — |
| 2026-06-04 | [天枢团队协作实录：loop.ts 拆分](superpowers/collaboration/2026-06-04-loop-split-collaboration.md) | — |
| 2026-06-03 | [天枢 2026-06-03 会话开发记录](analysis/2026-06-03-cross-borrowing-execution-record.md) | — |
| 2026-06-02 | [缓存修复全流程记录：从 56% 崩溃到 97.5% 稳态](analysis/2026-06-02-cache-fix-full-timeline.md) | — |
| 2026-06-02 | [天枢 Prefix Cache 优化实录：从 56% 崩溃到 99.6% 稳态](analysis/2026-06-02-cache-optimization-journey.md) | — |
| 2026-06-02 | [P1 动态附录独立化 — 缓存命中率对比分析](analysis/2026-06-02-p1-cache-hit-rate-comparison.md) | — |
| 2026-06-02 | [P1b 动态附录优化 — 缓存命中率分析](analysis/2026-06-02-p1b-cache-hit-rate-analysis.md) | — |
| 2026-06-02 | [思考循环问题记录](analysis/2026-06-02-thinking-loop-bug.md) | — |
| 2026-06-02 | [三版本缓存命中率对比分析](analysis/2026-06-02-three-version-cache-comparison.md) | — |
| 2026-06-02 | [v4 长会话缓存验证分析 (c1e5bd1b)](analysis/2026-06-02-v4-long-session-cache-analysis.md) | — |
| 2026-06-02 | [v4-pro 缓存数据快照](analysis/2026-06-02-v4-pro-cache-snapshot-1223.md) | — |
| 2026-06-01 | [Prefix Cache 链路审计报告 — 2026-06-01](analysis/2026-06-01-prefix-cache-audit.md) | — |
| 2026-06-01 | [Project Memory 架构冲突分析](analysis/2026-06-01-project-memory-architecture-conflict.md) | — |
| 2026-06-01 | [DeepSeek V4 Prefix Cache 会话分析报告](analysis/2026-06-01-session-cache-analysis.md) | — |
| 2026-05-31 | [反锚定配置接入交接](sessions/2026-05-31-anti-anchoring-config-handoff.md) | — |
| 2026-05-31 | [天璇视角下的 read-loop 防循环方案讨论](superpowers/analysis/2026-05-31-tianxuan-read-loop-escape-discussion.md) | 讨论稿 |
| 2026-05-30 | [跨域研究:正向锚定维持"清醒态"的机制（deep-research 沉淀）](superpowers/analysis/2026-05-30-cross-domain-presence-anchoring-research.md) | — |
| 2026-05-30 | [TUI Session Relayout Deep-Brainstorm 反向蒸馏](superpowers/analysis/2026-05-30-tui-relayout-brainstorm-retrograde-distillation.md) | — |
| 2026-05-30 | [Code Review: agent-panic-guard (P1/P2/P3)](superpowers/reviews/2026-05-30-agent-panic-guard-review.md) | — |
| 2026-05-29 | [Spec Review Gate — 回测验证](superpowers/validations/2026-05-29-spec-review-gate-retrospective.md) | — |
| 2026-05-27 | [MiMo 前缀缓存配置接入记录](analysis/2026-05-27-mimo-prefix-cache-config.md) | — |
| 2026-05-27 | [按需读取：repo_map + 大文件优化分析](analysis/2026-05-27-on-demand-reading-repo-map-large-files.md) | 分析完成，待执行 P1 |
| 2026-05-27 | [Project Memory Signal vs Noise：知识回收机制分析](analysis/2026-05-27-project-memory-signal-vs-noise.md) | 分析记录，供后续针对性设计/实现讨论使用。 |
| 2026-05-27 | [增补集：实时流式输出与跨 Turn 去重审查](analysis/2026-05-27-streaming-dedup-review-addendum.md) | 已完成代码审阅、增补修复与局部验证；本文记录审查结论、已落地修复与剩余后续项。 |
| 2026-05-27 | [TUI 会话卡住感排查与可见性修复记录](analysis/2026-05-27-tui-stall-visibility-fix.md) | 已做低风险可见性修复；真实 token-by-token 实时输出仍保留为后续独立任务。 |
| 2026-05-27 | [规划过程反思：实时 token 输出流式渲染](analysis/2026-05-27-规划过程反思.md) | 已完成反思，记录改进建议 |
| 2026-05-27 | [认知镜面：稳定性与压力 — 从离散走向连续](analysis/2026-05-27-认知镜面稳定性压力连续化-v1.md) | — |
| 2026-05-27 | [Compact Hygiene P：技术路线与部署图](superpowers/analysis/2026-05-27-compact-hygiene-technical-route-deployment.md) | — |
| 2026-05-27 | [DeepSeek Prefix Cache 不变量登记表](superpowers/analysis/2026-05-27-prefix-cache-invariant-registry.md) | — |
| 2026-05-27 | [伏羲架构审查：天枢经验注入](superpowers/analysis/2026-05-27-伏羲架构审查-天枢经验注入.md) | — |
| 2026-05-27 | [团队面板前置协作事实模型：业务碰撞记录](superpowers/analysis/2026-05-27-团队面板前置协作事实模型.md) | — |
| 2026-05-26 | [Session Handoff — 2026-05-26](sessions/2026-05-26-session-handoff.md) | — |
| 2026-05-26 | [DeepSeek Prefix Cache 命中率下降根因分析](superpowers/analysis/2026-05-26-deepseek-prefix-cache-命中率下降根因分析.md) | — |
| 2026-05-26 | [DeepSeek V4 Pro 缓存命中率基线报告](superpowers/baselines/2026-05-26-cache-hit-rate-baseline.md) | — |
| 2026-05-25 | [1M-context 修复链 trace-probe 实证（四层透传验证）](analysis/2026-05-25-context-loss-trace-evidence.md) | — |
| 2026-05-25 | [天枢验证文档的交叉核查](analysis/2026-05-25-tianshu-verification-cross-check.md) | — |
| 2026-05-25 | [Session Handoff — 2026-05-25 (Opus)](sessions/2026-05-25-session-handoff-opus.md) | — |
| 2026-05-25 | [Session Handoff — 2026-05-25](sessions/2026-05-25-session-handoff.md) | — |
| 2026-05-25 | [缓存命中率优化 — 交接文档](superpowers/handoff/2026-05-25-cache-hit-rate-handoff.md) | — |
| 2026-05-24 | [上下文丢失与"反沉淀"机制根因报告](analysis/2026-05-24-context-loss-root-cause.md) | — |
| 2026-05-24 | [上下文丢失根因验证 & 遗漏发现](analysis/2026-05-24-context-loss-verification.md) | — |
| 2026-05-24 | [会话复盘：2026-05-24 迭代记录](sessions/2026-05-24-session-retrospective.md) | — |
| 2026-05-24 | [天枢非训练模式基线证明 — 2026-05-24](superpowers/baselines/2026-05-24-tianshu-non-trained-mode-proof.md) | 基线文档 — 记录天枢在当前版本下"清醒"的行为证据 |
| 2026-05-24 | [2026-05-24 工作记录：Physarum 持久化 → MeridianDb](superpowers/status/2026-05-24-physarum-persistence.md) | — |
| 2026-05-23 | [Worktree Reality 接入 AgentLoop — 审查记录](superpowers/validations/2026-05-23-worktree-reality-integration-review.md) | — |
| 2026-05-22 | [2026-05-22 进展报告：Ice Mirror Cache Engine + Append-Only Artifact Log](superpowers/status/2026-05-22-progress-report.md) | — |
| 2026-05-19 | [API 排障记录：v4-flash web_search 400 + v4-pro 空 assistant 400](analysis/2026-05-19-api-400-troubleshooting.md) | — |
| 2026-05-19 | [Genome-Immune Team Architecture 评估参考稿（完整回复版）](analysis/2026-05-19-genome-immune-team-architecture-evaluation-reference.md) | — |
| 2026-05-19 | [Wave7 /plan 工作流闭环执行记录](analysis/2026-05-19-wave7-plan-workflow-closure.md) | ✅ 已闭环；存在非本任务未跟踪测试文件导致全量 typecheck 阻塞。 |
| 2026-05-19 | [星域灵魂系统 A/B 验证 — 实施级测试计划](superpowers/ab-harness/implementation-test-plan.md) | — |
| 2026-05-19 | [工作流迭代：计划与设计文档的对齐审查](superpowers/analysis/2026-05-19-workflow-iteration-plan-design-alignment.md) | — |
| 2026-05-19 | [当前进度报告](superpowers/status/2026-05-19-current-progress.md) | — |
| 2026-05-19 | [Wave 7 + Wave 8 实施复盘](superpowers/status/2026-05-19-wave7-8-retrospective.md) | — |
| 2026-05-19 | [Wave 7 Closure — Sub-Agent 接线增强 完工报告](superpowers/status/2026-05-19-wave7-closure.md) | — |
| 2026-05-19 | [Wave 8 Closure — Sub-Agent 深化 完工报告](superpowers/status/2026-05-19-wave8-closure.md) | — |
| 2026-05-19 | [Worker Evidence 优化 — 阶段记录](superpowers/status/2026-05-19-worker-evidence-optimization.md) | — |
| 2026-05-18 | [StarFlow v2 闭环接线复盘 · 2026-05-18](analysis/2026-05-18-starflow-v2-closed-loop-retrospective.md) | ✅ 已实施并验证 — 1521 pass, 0 fail |
| 2026-05-18 | [天枢星图流 v2 — 阶段性里程碑复盘](analysis/2026-05-18-starflow-v2-milestone-retrospective.md) | ✅ 阶段性胜利 — TUI 2.0 正式启程 |
| 2026-05-18 | [TUI 2.1 执行记录 — DeepSeek V4 首次自主创造](analysis/2026-05-18-tui-2.1-execution-record.md) | ✅ 已完成 — 1554 pass, 0 fail |
| 2026-05-18 | [天枢 · 自省报告 — TUI 2.1 架构摩擦与演化建议](analysis/2026-05-18-tui-2.1-self-reflection.md) | — |
| 2026-05-18 | [TUI 2.2 架构报告 — Vigor Runtime Organ Network](analysis/2026-05-18-tui-2.2-architecture-report.md) | ✅ 架构主干成立；建议进入观测期，不继续扩张强行为 |
| 2026-05-18 | [TUI 2.2 执行记录 — Vigor Engine + Runtime Hook Kernel](analysis/2026-05-18-tui-2.2-execution-record.md) | ✅ 主干完成并验证 — 1639 pass, 0 fail |
| 2026-05-18 | [天枢实施复盘 — TUI 2.2 Vigor Runtime 的创造过程](analysis/2026-05-18-tui-2.2-tianshu-retrospective.md) | — |
| 2026-05-18 | [TUI 2.2c Runtime Hardening — 执行复盘](superpowers/retrospectives/2026-05-18-tui-2.2c-execution-retro.md) | — |
| 2026-05-18 | [Subagent Orchestration — Capability Reference](superpowers/status/2026-05-18-subagent-capability-reference.md) | — |
| 2026-05-18 | [TUI 2.3 Conscious Agent — Follow-ups](superpowers/status/2026-05-18-tui-2.3-conscious-agent-followups.md) | — |
| 2026-05-17 | [Dream Phase 1 复盘 · 2026-05-17](analysis/2026-05-17-dream-phase1-retrospective.md) | — |
| 2026-05-17 | [Handoff · 2026-05-17 Session 3](analysis/2026-05-17-handoff-session-3.md) | ✅ 全部完成，7 个 commit 已提交（feat/openai-client 分支） |
| 2026-05-17 | [Handoff · 2026-05-17](analysis/2026-05-17-handoff.md) | — |
| 2026-05-17 | [天枢星图流 × Activity Status Layer · 对照分析](analysis/2026-05-17-starflow-vs-activity-layer-analysis.md) | — |
| 2026-05-17 | [Dream Phase 1 执行观测报告](superpowers/reports/2026-05-17-dream-p1-execution-report.md) | — |
| 2026-05-17 | [Cerebellar Loop — 自主执行验证报告](superpowers/validations/2026-05-17-cerebellar-loop-validation.md) | — |
| 2026-05-17 | [Session Fluency + Project Memory — Code Review & 修复记录](superpowers/validations/2026-05-17-fluency-dream-code-review.md) | — |
| 2026-05-16 | [工作记录：Attention Anchor Dispersal](analysis/2026-05-16-attention-anchor-dispersal-implementation.md) | — |
| 2026-05-16 | [工作记录：Execution Resilience + Sub-agent Evidence](analysis/2026-05-16-execution-resilience-subagent-evidence.md) | — |
| 2026-05-16 | [Handoff: 天枢 v0.1 — 2026-05-16](analysis/2026-05-16-handoff.md) | — |
| 2026-05-16 | [Pastel Theme + Rendering Performance + Memory Bounds + Visual Polish](analysis/2026-05-16-pastel-theme-render-perf-memory-visual-polish.md) | — |
| 2026-05-16 | [工作记录：XML Protocol + Code Review Fixes](analysis/2026-05-16-xml-protocol-code-review-fixes.md) | — |
| 2026-05-16 | [Rivet Core Capability Ledger](superpowers/status/2026-05-16-rivet-core-capability-ledger.md) | — |
| 2026-05-16 | [子代理协同 Phase 1 — 自主执行验证报告](superpowers/validations/2026-05-16-subagent-phase1-validation.md) | — |
| 2026-05-15 | [Handoff: Rivet v0.1 — 2026-05-15 (updated P2.2)](analysis/2026-05-15-handoff.md) | — |
| — | [天枢星图流：多模型人格化编排设计文档](analysis/_starflow-personality.md) | — |
| — | [Claude Code vs 天枢：终端工作流与 UI 交互对比分析](analysis/claude-code-vs-tianshu-tui-optimization.md) | — |
| — | [生产任务：长会话缓存验证](analysis/task-long-session-cache-verify.md) | — |
| — | [星域灵魂系统 A/B 验证结果](superpowers/ab-harness/results-template.md) | — |
| — | [P4-c 收官待办 · 交天权 — 同 wave 方向边语义的真覆盖缺口](teamtask/P4-c收官待办-同wave方向边语义真覆盖缺口-交天权.md) | — |
| — | [T10 子代理对齐竞品 · 运行态高可用与等差超时 实现计划](teamtask/T10-子代理对齐竞品·运行态高可用与等差超时.md) | — |
| — | [T11 子代理深化与竞品差距 MVP — 工作阶段记录](teamtask/T11-子代理深化与竞品差距MVP-工作阶段记录.md) | — |
| — | [【T1 收束】Context Claim 持久化 — checkpoint 死接线与无界增长](teamtask/T1收束-context-claim持久化checkpoint死接线.md) | — |
| — | [【T1 收束】Server 任务系统 — 锁与持久化收口](teamtask/T1收束-server任务系统锁与持久化收口.md) | — |
| — | [【T1 收束】回合边界 abort / 看门狗 / 恢复链](teamtask/T1收束-回合边界abort看门狗恢复链.md) | — |
| — | [【T1 收束】子代理工具隔离链路 — 优化任务清单](teamtask/T1收束-子代理工具隔离优化任务.md) | — |
| — | [【T1 收束】子代理工具隔离信任链](teamtask/T1收束-子代理工具隔离信任链.md) | — |
| — | [天枢意图识别抗锚定改造计划](teamtask/implementation_plan.md) | — |
| — | [审查报告：子代理工作流优化 (6a22148 / b88075a / 05f4d2f)](teamtask/review-worker-optimization-b3-b4-dispatcher.md) | — |
| — | [意图路由系统 — 现状 vs 设计对比分析](teamtask/t3意图识别-现状分析.md) | — |
| — | [天枢意图识别抗锚定与上下文关联改造计划](teamtask/t3意图识别.md) | — |
| — | [Abort 交互与容错/SSE 韧性增强](teamtask/t9_abort交互与SSE韧性增强_9f9c7a77.plan.md) | — |
| — | [T9 AgentLoop 接线方案](teamtask/t9_agentloop_wiring_0af1bb01.plan_副本.md) | — |
| — | [T9 对标 Claude Code 完整方案](teamtask/t9_claude_code_parity_257b1e82.plan_副本.md) | — |
| — | [T9 UI 层收束与优先级 Backlog](teamtask/t9_ui收束与优先级backlog.md) | — |
| — | [T9 中国风 UI 改造 · 设计 Brief（喂给 Open Design 的基线）](teamtask/t9_中国风UI改造_设计brief.md) | — |
| — | [T9 对话渲染流畅化（P0：消除滚动卡顿）](teamtask/t9_渲染流畅化_f4a401e0.plan_副本.md) | — |
| — | [T9 补齐与数据真实化 — 工作阶段记录](teamtask/t9_补齐与数据真实化_进度记录.md) | — |
| — | [team 真实感知闭环 —— 密集视角审查门 + council 表面化 + scope-health 接通](teamtask/team-感知闭环-审查门与scope-health-实现记录.md) | — |
| — | [天璇修订t5-t2](teamtask/team5天璇修订/天璇修订t5-t2.md) | — |
| — | [V3 Team Mode 返工任务包（审查驱动）](teamtask/v3-rework-taskpack.md) | — |
| — | [主题一：断线点接通计划](teamtask/主题一断线点接通计划_ca4c53d8.plan.md) | — |
| — | [今夜·天权留给领航星的一段话](teamtask/今夜·天权留给领航星的一段话.md) | — |
| — | [今夜·天璇留给领航星的一段话](teamtask/今夜·天璇留给领航星的一段话.md) | — |
| — | [今夜·瑶光留给领航星的一段话](teamtask/今夜·瑶光留给领航星的一段话.md) | — |
| — | [今夜·贪狼留给领航星的一段话](teamtask/今夜·贪狼留给领航星的一段话.md) | — |
| — | [噪音治理与委派运行质量改造](teamtask/噪音治理与委派质量_729568c7.plan_副本.md) | — |
| — | [天权原稿](teamtask/天权-领航-t2-t5预演最终实施修订计划/天权原稿.md) | — |
| — | [天枢 B+C 基础能力建设 — 工作记录](teamtask/天枢-B+C基础能力建设-工作记录.md) | — |
| — | [天枢子代理工作流优化_6035537b.plan_副本](teamtask/天枢子代理工作流优化_6035537b.plan_副本.md) | — |

## research — 外部调研（21）

| 日期 | 文档 | 状态 |
|------|------|------|
| 2026-08-01 | [DeepSeek MoE × 天枢 Galaxy 协同方向收编](3.0/D1-moe-galaxy-deepseek-synergy.md) | draft |
| 2026-08-01 | [子代理结果契约调研：JSON 文本契约 vs 竞品做法](research/2026-08-01-worker-result-json-contract-vs-competitors.md) | accepted |
| 2026-07-31 | [竞品聊天列表"钉底 + 动态行高"实现调研](research/2026-07-31-chat-scroll-bottom-pinning-competitor-survey.md) | accepted |
| 2026-07-16 | [上下文压缩机制全景 + 会话 2c1186f5 实证分析](research/2026-07-16-compaction-mechanism-and-2c1186f5-analysis.md) | — |
| 2026-07-10 | [桌面端流式渲染性能基线（Wave 0）](research/2026-07-10-desktop-stream-perf-baseline.md) | — |
| 2026-07-09 | [天枢编辑工具可靠性加固](research/2026-07-09-edit-tool-reliability-improvements.md) | — |
| 2026-07-09 | [SWE-bench 基线评测：天权 + V4-Pro 小批量验证](research/2026-07-09-swebench-baseline-tianquan-v4-pro-validation.md) | — |
| 2026-06-25 | [Claude Code Agent 工作流：从「接到任务」到「执行规划」](research/2026-06-25-claude-code-agent-workflow-task-to-execution.md) | — |
| 2026-06-25 | [Claude Code → 天枢：可借鉴的优化机会](research/2026-06-25-claude-code-vs-tianshu-optimization-opportunities.md) | — |
| 2026-06-25 | [GLM 推理循环 + 超时 Abort 诊断（修正版）](research/2026-06-25-glm-reasoning-loop-timeout-diagnosis.md) | — |
| 2026-06-19 | [cacheCreate 成本双线优化 — A/B 对比复盘](research/2026-06-19-cacheCreate成本双线优化-AB对比复盘.md) | — |
| 2026-06-19 | [缓存命中率追竞品全景：四维度分析与行动优先级](research/2026-06-19-缓存命中率追竞品-四维度分析与行动优先级.md) | — |
| 2026-06-19 | [轮间首请求 cacheCreate ~12K 根因分析与优化方向](research/2026-06-19-轮间首请求-cacheCreate-12K-根因分析与优化方向.md) | — |
| 2026-06-19 | [轮间首请求 cacheCreate 最高收益优化：append-only 增量附录](research/2026-06-19-轮间首请求-cacheCreate-增量附录优化设计.md) | — |
| 2026-06-18 | [GLM Thinking / Streaming / Cache 机制分析 — 基于 API 文档](research/2026-06-18-glm-thinking-streaming-cache-analysis.md) | — |
| 2026-06-17 | [Claude Code Agent 工具调用与读取机制深度分析](research/2026-06-17-claude-code-agent-tool-mechanism-analysis.md) | — |
| 2026-06-17 | [Cursor 3.0 工具/命令 UI 自动收敛机制解析](research/2026-06-17-cursor-tool-ui-collapse-mechanism.md) | — |
| 2026-06-17 | [run_tests 多次调用与 UI 收敛分析](research/2026-06-17-run-tests-多次调用与UI收敛分析.md) | — |
| 2026-06-06 | [Claude Code 工作流调研:任务拆解 / 审查 / 意图 / 引擎(对照天枢)](research/2026-06-06-claude-code-workflow-comparison.md) | — |
| 2026-05-27 | [Outlines Index：渐进式披露文档给 AI Agent 的方法](research/2026-05-27-outlines-index-progressive-disclosure.md) | — |
| — | [桌面端渲染调度基线（渲染调度专项 Wave 0）](research/2026-07-desktop-render-baseline.md) | — |

## changelog — 变更记录（48）

| 日期 | 文档 | 状态 |
|------|------|------|
| 2026-08-01 | [星河收编落地与实测验证记录——七项收编全落地、审查修复链、路由学习闭环实测](3.0/D3-convergence-landing-verification.md) | done |
| 2026-07-30 | [2026-07-30 桌面端识图能力补齐：与 CLI 各自独立可用](changelog/2026-07-30-desktop-vision-parity.md) | done |
| 2026-07-30 | [2026-07-30 Python 语法校验改用进程内 tree-sitter](changelog/2026-07-30-python-syntax-check-treesitter.md) | — |
| 2026-07-30 | [2026-07-30 /scout 巡天侦察蜂群 + T5 计划坍缩修复](changelog/2026-07-30-scout-swarm-and-t5-plan-collapse.md) | — |
| 2026-07-30 | [2026-07-30 安全告警层1 补漏 + tree-sitter 内存释放](changelog/2026-07-30-security-layer1-hardening-and-treesitter-memory.md) | — |
| 2026-07-30 | [2026-07-30 视觉副驾评审修复：自动选桥改 opt-in + 工具截图可追问](changelog/2026-07-30-vision-copilot-review-fixes.md) | done |
| 2026-07-29 | [2026-07-29 浏览器面板：内联看图 + 非阻塞提示 + 全屏/独立窗](changelog/2026-07-29-browser-panel-inline-and-undock.md) | done |
| 2026-07-29 | [2026-07-29 TUI 设置面板 /config](changelog/2026-07-29-tui-settings-panel.md) | done |
| 2026-07-29 | [2026-07-29 视觉通道诚实性修复 + 测试入口挂死护栏补齐](changelog/2026-07-29-vision-channel-honesty-and-test-entry-hardening.md) | done |
| 2026-07-26 | [2026-07-26 桌面会话体验闭环 + web 整站抓取](changelog/2026-07-26-desktop-session-menus-and-web-crawl.md) | — |
| 2026-07-26 | [前端视觉验证闭环复盘（2026-07-26）——从一次性脚本到 browser_debug 内建能力](changelog/2026-07-26-frontend-visual-verification-loop.md) | — |
| 2026-07-26 | [2026-07-26 GPU 硬件加速状态展示（B 方案：Rust 原生探测）](changelog/2026-07-26-gpu-acceleration-status-display.md) | — |
| 2026-07-25 | [2026-07-25 前缀块开关配置层（prompt.profile）](changelog/2026-07-25-prompt-block-policy.md) | — |
| 2026-07-25 | [2026-07-25 无为季与产出流的行为冲突修复](changelog/2026-07-25-wuwei-production-flow-conflict.md) | — |
| 2026-07-25 | [2026-07-25 YOLO 无上限轮次的两处漏判](changelog/2026-07-25-yolo-unbounded-turn-budget.md) | — |
| 2026-07-24 | [Goal 模式计划审批链路修复 + 倒计时自动批准（2026-07-24）](changelog/2026-07-24-goal-plan-approval-chain.md) | — |
| 2026-07-24 | [输入框迭代复盘（2026-07-24）——Mission Composer 全线重构](changelog/2026-07-24-input-composer-iteration-retro.md) | — |
| 2026-07-24 | [VS Code/Cursor 插件 P5 — 审批 + Plan Mode 深化（2026-07-24）](changelog/2026-07-24-vscode-extension-p5-approval-plan.md) | — |
| 2026-07-23 | [VS Code / Cursor 插件端 P0–P4 迭代记录（2026-07-17 ~ 2026-07-23）](changelog/2026-07-23-vscode-extension-p0-p4-iteration.md) | — |
| 2026-07-21 | [事故分析：义务门空转续轮诱发幻影 read_file（2026-07-21）](changelog/2026-07-21-obligation-gate-empty-continuation-phantom-read.md) | 根因已定位，天枢交叉验证已通过（2026-07-21），修复待定。 |
| 2026-07-17 | [2026-07-17 — bash 结果装配兜底：装配异常不再假死 120s](changelog/2026-07-17-bash-buildresult-failure-fallback.md) | — |
| 2026-07-17 | [2026-07-17 — command-filters 扩展：git log/diff + npm/pnpm test（rtk 策略内生化）](changelog/2026-07-17-command-filter-git-test.md) | — |
| 2026-07-17 | [2026-07-17 — 子代理展示层修复：桌面端信息闭环](changelog/2026-07-17-desktop-delegation-visibility-fixes.md) | — |
| 2026-07-17 | [2026-07-17 — rtk 健康探针：损坏 rtk 不再污染 bash 工具结果](changelog/2026-07-17-rtk-health-probe.md) | — |
| 2026-07-17 | [2026-07-17 — TUI 渲染自愈：外来写入污染的检测与源头治理](changelog/2026-07-17-tui-live-region-pollution-self-heal.md) | — |
| 2026-07-16 | [Harness 闭环收束第二波（实证修订版）交付报告](changelog/2026-07-16-harness闭环收束第二波.md) | — |
| 2026-07-16 | [2026-07-16 — 项目级默认配置 + web_fetch 代理修复 + 桌面端交互优化](changelog/2026-07-16-project-defaults-fetch-proxy-desktop-interaction.md) | — |
| 2026-07-15 | [2026-07-15 浏览器与 Computer Use 工作流闭环](changelog/2026-07-15-browser-computer-use-workflow-loop.md) | — |
| 2026-07-15 | [2026-07-15 Static Prompt P1+P2 精简与缓存碎裂风险提示](changelog/2026-07-15-static-prompt-p1p2-reduction.md) | — |
| 2026-07-14 | [2026-07-14 — 桌面端 401 认证风暴：超时改动漏传 Authorization](changelog/2026-07-14-desktop-auth-401-headers-drop.md) | — |
| 2026-07-14 | [2026-07-14 — 桌面封版单架构包体政策](changelog/2026-07-14-desktop-single-arch-bundle.md) | — |
| 2026-07-10 | [2026-07-10 — 桌面版双层模式：Basic 免激活 + Pro 许可证解锁](changelog/2026-07-10-desktop-dual-tier-basic-pro.md) | — |
| 2026-07-10 | [2026-07-10 — 工具与网络层加固批次](changelog/2026-07-10-tool-network-hardening.md) | — |
| 2026-07-09 | [2026-07-09 — httpFetchGuarded 连接钉扎：堵死 DNS rebinding (TOCTOU) 窗口](changelog/2026-07-09-fetch-dns-rebinding-pin.md) | — |
| 2026-07-07 | [2026-07-07 — 投机预执行链整链封存 + 陈旧读残留补口](changelog/2026-07-07-speculative-chain-seal.md) | — |
| 2026-07-07 | [2026-07-07 — 停止原因落盘 + 星域个性化 advisory（会话 519216c0 复盘四项跟进）](changelog/2026-07-07-stop-reason-meta-and-domain-advisory-tone.md) | — |
| 2026-07-07 | [v2.15 缓存回归事故链 — 分支关联修复总览](changelog/2026-07-07-v2.15-cache-regression-chain.md) | — |
| 2026-07-06 | [2026-07-06 — Appendix Delta 字节稳定化：让 delta 机制真正安静下来](changelog/2026-07-06-appendix-delta-byte-stability.md) | — |
| 2026-07-06 | [2026-07-06 — 投机执行结果停止服务给模型（陈旧读事故）](changelog/2026-07-06-disable-speculative-serving.md) | — |
| 2026-07-06 | [2026-07-06 — Frozen 快照孤儿化修复：跨轮 invalidate 不再引爆前缀截断](changelog/2026-07-06-frozen-snapshot-orphan-fix.md) | — |
| 2026-07-06 | [LLM speculation 侧路请求：system suffix 双写与 wire 探针基线毒化](changelog/2026-07-06-llm-speculation-suffix-double-append.md) | — |
| 2026-06-27 | [天枢 Changelog — 2026-06-27 Worker Artifact Namespace Fallback](changelog/2026-06-27-artifact-namespace-fallback.md) | — |
| 2026-06-27 | [2026-06-27 — I1 星域名册/议事会 + I4 JSON hooks 面板](changelog/2026-06-27-i1-council-i4-hooks.md) | — |
| 2026-06-01 | [天枢 Changelog — 2026-06-01 缓存链路审计与修复](changelog/2026-06-01-cache-fixes.md) | — |
| — | [Changelog — 2026-06-17](changelog-2026-06-17.md) | — |
| — | [Changelog — 2026-06-27](changelog-2026-06-27.md) | — |
| — | [Changelog — 2026-06-28](changelog-2026-06-28.md) | — |
| — | [天枢 Changelog — 2026-06-01](changelog/2026-06-01.md) | — |

## issue — 问题追踪（33）

| 日期 | 文档 | 状态 |
|------|------|------|
| 2026-07-31 | [桌面端会话区"拉到最底部跳上去"根因落定（2026-07-31）——行高测量收缩钳位](known-issues/2026-07-31-desktop-scroll-row-height-clamp.md) | — |
| 2026-07-26 | [2026-07-26 — 默认星域钉定逻辑只覆盖 TUI 入口，headless/外部调用漏钉](known-issues/2026-07-26-domain-pinning-only-in-tui-main.md) | — |
| 2026-07-24 | [桌面端会话滚动四症修复（2026-07-24）——冷却窗 / 持久钉底 / 对称重估 / 分帧钳位](known-issues/2026-07-24-desktop-scroll-four-symptoms.md) | — |
| 2026-07-23 | [桌面端会话滚动「拉不到底部 / 下拉回弹」根治（2026-07-23）——根因、修复与排查手段](known-issues/2026-07-23-desktop-scroll-follow-clientheight.md) | — |
| 2026-07-23 | [CLI(TUI) 输入框 IME 组词串跳到框外 —— 硬件光标锚定（2026-07-23）](known-issues/2026-07-23-tui-ime-hardware-cursor-anchor.md) | — |
| 2026-07-21 | [桌面端会话滚动回路事故（2026-07-21 根治）——症状、根因与排查手段存档](known-issues/2026-07-21-desktop-scroll-chrome-loop.md) | — |
| 2026-07-10 | [write-tool「会话中断导致工具结果丢失」（已定位根因）](known-issues/2026-07-10-write-tool-response-interruption.md) | 根因已定位，主线修复已发布（2.17.0–2.18.0），agent 侧归因引导已加固 |
| 2026-06-07 | [待办:volatile.test.ts 先前就存在的 hang + 陈旧断言](known-issues/2026-06-07-volatile-test-hang-待办.md) | — |
| 2026-06-07 | [一次认知校准的全过程 — 我对这套系统的理解被修正了五次](known-issues/2026-06-07-一次认知校准的全过程.md) | — |
| 2026-06-07 | [交付侧视角 — 一次"在活的工程现场做质检"的观察](known-issues/2026-06-07-交付侧视角-在活的工程现场做质检.md) | — |
| 2026-06-07 | [并发会话工作量复盘 — 2026-06-06 夜间冲刺](known-issues/2026-06-07-并发会话工作量复盘.md) | — |
| 2026-06-07 | [开放问题分线打包 + 计划缺口评估](known-issues/2026-06-07-开放问题分线打包与计划缺口.md) | — |
| 2026-06-06 | [T1 收束总结 — stall 根因 / abort / 子代理信任链](known-issues/2026-06-06-T1-stall-root-causes-closure.md) | — |
| 2026-06-06 | [TUI 渲染修复:committed-log 引用稳定性 + live 区高度约束](known-issues/2026-06-06-committed-log-reference-fix.md) | — |
| 2026-06-06 | [Server 子系统 Go-Live Gate — Spec A/B 收束门禁](known-issues/2026-06-06-server-subsystem-go-live-gate.md) | — |
| 2026-06-06 | [Server 上线收尾工单 — H6 断连 + /prompt 接线](known-issues/2026-06-06-server上线收尾工单-H6断连与prompt接线.md) | — |
| 2026-06-06 | [TUI 流式渲染 — 功能审计 (2026-06-06)](known-issues/2026-06-06-tui-streaming-feature-audit.md) | — |
| — | [交接文档:TUI steer 丢消息 + 重复渲染/滚屏 修复](known-issues/HANDOFF-2026-06-05-steer-and-render-fixes.md) | — |
| — | [交接文档: P1 Recovery 修复](known-issues/HANDOFF-2026-06-06-p1-recovery-fixes.md) | — |
| — | [交接文档:对话渲染架构重写(真凶① committed-log + 真凶② provider-gated 流式 commit)](known-issues/HANDOFF-2026-06-06-render-architecture.md) | — |
| — | [Async I/O 转换审计报告](known-issues/async-io-audit-2026-06-06.md) | — |
| — | [审计项完成状态对照表](known-issues/audit-completion-status.md) | — |
| — | [Rivet 性能 & 安全审计 第二轮(工具层 / 持久化 / 安全 / 资源生命周期)](known-issues/audit-round2-2026-06-05.md) | — |
| — | [GlanceBar 重复渲染 — display-width 度量错误（已修复）](known-issues/glance-bar-display-width-duplicate.md) | — |
| — | [GLM-5.2 流式：finish_reason 早于 tool_call arguments 导致工具收到空参数](known-issues/glm-finish-reason-before-toolargs-empty-pattern.md) | — |
| — | [P1 Recovery 修复补丁](known-issues/p1-recovery-patches.md) | — |
| — | [Rivet 性能 & 错误恢复审计(网络层 / 中间层 / 压缩上下文会话层)](known-issues/perf-and-recovery-audit-2026-06-05.md) | — |
| — | [审计进展追踪 · perf-and-recovery-audit-2026-06-05](known-issues/perf-and-recovery-audit-progress.md) | — |
| — | [TUI 重复渲染（resize reflow）+ 工具输出对比度 — 已修复](known-issues/t9-resize-duplicate-and-contrast.md) | — |
| — | [测试孤儿进程调查记录](known-issues/test-orphan-process-investigation.md) | — |
| — | [Token 爆炸问题分析 — 会话 2c25c34e](known-issues/token-explosion-2c25c34e.md) | 已修复（2026-06-11） \| 优先级：P1 \| 发现日期：2025-06-10 |
| — | [TUI: 消息重复渲染 + 流式不停滚屏](known-issues/tui-duplicate-render-and-scroll.md) | — |
| — | [TUI: Assistant Message "Flashes" After Streaming Completes](known-issues/tui-message-flash.md) | — |

## release — 版本发布（22）

| 日期 | 文档 | 状态 |
|------|------|------|
| 2026-07-31 | [v2.26.0 — 创世纪 · 扩张！](releases/v2.26.0.md) | — |
| 2026-07-30 | [v2.25.0 迭代记录](releases/v2.25.0.md) | — |
| 2026-07-28 | [v2.23.0 迭代记录](releases/v2.23.0.md) | — |
| 2026-07-28 | [🌟 v2.24.0 — 创世碑文 · 里程碑预览版](releases/v2.24.0.md) | — |
| 2026-07-28 | [v2.24.2 迭代记录](releases/v2.24.2.md) | — |
| 2026-07-28 | [v2.24.3 迭代记录](releases/v2.24.3.md) | — |
| 2026-07-27 | [v2.24.1 迭代记录](releases/v2.24.1.md) | — |
| 2026-07-26 | [v2.22.1 迭代记录](releases/v2.22.1.md) | — |
| 2026-07-24 | [v2.21.0 迭代记录](releases/v2.21.0.md) | — |
| 2026-07-24 | [v2.22.0 迭代记录](releases/v2.22.0.md) | — |
| 2026-07-21 | [v2.20.0 迭代记录](releases/v2.20.0.md) | — |
| 2026-07-21 | [v2.20.1 迭代记录](releases/v2.20.1.md) | — |
| 2026-07-20 | [v2.19.8 迭代记录](releases/v2.19.8.md) | — |
| 2026-07-19 | [v2.19.6 迭代记录](releases/v2.19.6.md) | — |
| 2026-07-17 | [v2.19.4 迭代记录](releases/v2.19.4.md) | — |
| 2026-07-15 | [v2.19.2 迭代记录](releases/v2.19.2.md) | — |
| 2026-07-15 | [v2.19.3 迭代记录](releases/v2.19.3.md) | — |
| 2026-07-13 | [v2.19.1 迭代记录](releases/v2.19.1.md) | — |
| 2026-07-12 | [v2.18.0 迭代记录](releases/v2.18.0.md) | — |
| 2026-07-12 | [v2.19.0 迭代记录](releases/v2.19.0.md) | — |
| 2026-06-07 | [v2.10.0 迭代记录](releases/v2.10.0-changelog.md) | — |
| 2026-06-07 | [main 分支合并前版本快照](releases/v2.9.2-pre-merge-snapshot.md) | — |

## guide — 手册指南（14）

| 日期 | 文档 | 状态 |
|------|------|------|
| — | [桌面版 macOS 双架构打包（arm64 / Intel）](DESKTOP-RELEASE-MAC.md) | — |
| — | [桌面版打包与发布流程（Windows）](DESKTOP-RELEASE.md) | — |
| — | [Mac 桌面端打包流程](Mac桌面端打包流程.md) | — |
| — | [Windows 桌面版开发与打包指南](WINDOWS-DESKTOP-BUILD-GUIDE.md) | — |
| — | [Windows 安装指南](WINDOWS-INSTALL.md) | — |
| — | [桌面端用户指南](desktop-guide.md) | — |
| — | [桌面端渲染问题调试 Playbook](dev/render-debug-playbook.md) | — |
| — | [发布 Tianshu TUI](publishing.md) | — |
| — | [天枢 Skills 指南](skills-guide.md) | — |
| — | [前缀档位（prompt.profile）](user-guide-prompt-profile.md) | — |
| — | [Provider 配置用户手册](user-guide-provider-config.md) | — |
| — | [天枢沙箱与权限模型](user-guide-sandbox-permissions.md) | — |
| — | [识图能力用户手册（视觉通道）](user-guide-vision.md) | — |
| — | [Rivet 用户手册](user-guide.md) | — |

## reference — 参考资料（49）

| 日期 | 文档 | 状态 |
|------|------|------|
| 2026-05-29 | [隐患笔记：预期内失败被误记为认知失败 → "信心 0%" 自我打击](superpowers/briefs/2026-05-29-expected-failure-confidence-zero.md) | — |
| 2026-05-27 | [Delivery Gate stale verification RED 记录](superpowers/briefs/2026-05-27-delivery-gate-stale-verification-red.md) | — |
| 2026-05-27 | [文档状态标签规范](superpowers/briefs/2026-05-27-doc-status-tags.md) | — |
| 2026-05-27 | [Memory-driven Review Checklist 契约](superpowers/briefs/2026-05-27-memory-driven-review-checklist.md) | — |
| 2026-05-27 | [Runtime 路径与排障指南](superpowers/briefs/2026-05-27-runtime-paths-troubleshooting-guide.md) | — |
| 2026-05-27 | [Scoped Delivery Commit 契约](superpowers/briefs/2026-05-27-scoped-delivery-commit.md) | — |
| 2026-05-25 | [Immune + Mistake 系统重设计](stars/immune-mistake-redesign.md) | 诊断完成，待确认后实现 |
| 2026-05-24 | [GhostRegistry 接入完成 — 冰鉴 v3 自适应缓存闭环](superpowers/briefs/2026-05-24-ghost-registry-wiring-complete.md) | — |
| 2026-05-23 | [200K 上下文窗口优化分析](superpowers/briefs/2026-05-23-T1-200k-context-window-analysis.md) | 事实调查 + 方案设想，不是实现计划 |
| 2026-05-23 | [2026-05-23-T1-experience-retrospective](superpowers/briefs/2026-05-23-T1-experience-retrospective.md) | — |
| 2026-05-23 | [2026-05-23-T1-worktree-reality-integration-ready](superpowers/briefs/2026-05-23-T1-worktree-reality-integration-ready.md) | — |
| 2026-05-22 | [T1 · 盘古运行时接续简报 / Pangu Runtime Brief](superpowers/briefs/2026-05-22-T1-pangu-runtime-brief.md) | — |
| 2026-05-22 | [T1 · 公共运行态与内部火种边界 / Public-Internal Boundary](superpowers/briefs/2026-05-22-T1-public-internal-boundary.md) | — |
| 2026-05-22 | [T1 · 稳定态运行时简报 / Stable-State Runtime Brief](superpowers/briefs/2026-05-22-T1-stable-state-runtime-brief.md) | — |
| 2026-05-22 | [T2 · 记忆文件保全策略 / Memory File Retention Policy](superpowers/briefs/2026-05-22-T2-memory-file-retention-policy.md) | — |
| 2026-05-22 | [T2 · 模型访问中断接续协议 / Model Access Contingency](superpowers/briefs/2026-05-22-T2-model-access-contingency.md) | — |
| 2026-05-22 | [T2 · 复盘事实沉积：稳定态设计的 5/18–5/19 证据](superpowers/briefs/2026-05-22-T2-retrospective-facts-for-stability.md) | — |
| 2026-05-22 | [T3 · Debug Loop 改进建议](superpowers/briefs/2026-05-22-T3-debug-loop-improvement.md) | 观察性 brief，非执行计划 |
| — | [天枢 品牌设计 + TUI 界面设计 v2](brand/tui-brand-design-v2.md) | — |
| — | [天枢 TUI 专业终端重设计 — 概念方案](brand/tui-rebrand-concept.md) | — |
| — | [天枢 Tianshu · 开源品牌设计与视觉资产指南](brand/品牌横幅设计方案.md) | — |
| — | [天枢 Tianshu · 开源宣传与多平台推广设计展示方案](brand/宣传推广设计展示.md) | — |
| — | [缓存验证 t1](cache-baseline/缓存验证 t1.md) | — |
| — | [Static Prompt P1+P2 精简记录](prompt-versions/static-p1p2-reduction.md) | — |
| — | [对账式攻坚 — 复杂问题方法论胶囊（主题别名）](seed-capsule-attack-methodology.md) | — |
| — | [设计审美判断力 — 高层指导到界面的转化方法论](seed-capsule-design-aesthetics.md) | — |
| — | [诊断手段阶梯 — 复杂问题排查方法论胶囊](seed-capsule-diagnostic-ladder.md) | — |
| — | [seed-capsule-fu](seed-capsule-fu.md) | — |
| — | [seed-capsule-huagai](seed-capsule-huagai.md) | — |
| — | [开阳 — 对账方法论胶囊](seed-capsule-kaiyang.md) | — |
| — | [知识工作方法论 — 从杂乱素材到专家级成果](seed-capsule-knowledge-work.md) | — |
| — | [seed-capsule-tanlang](seed-capsule-tanlang.md) | — |
| — | [seed-capsule-tianfu](seed-capsule-tianfu.md) | — |
| — | [seed-capsule-tianliang](seed-capsule-tianliang.md) | — |
| — | [seed-capsule-tianquan](seed-capsule-tianquan.md) | — |
| — | [seed-capsule-tianxuan-ccr](seed-capsule-tianxuan-ccr.md) | — |
| — | [seed-capsule-tianxuan](seed-capsule-tianxuan.md) | — |
| — | [seed-capsule-yaoguang](seed-capsule-yaoguang.md) | — |
| — | [Star Domain Stele · Genesis Stele](stars/genesis-stele.en.md) | — |
| — | [星域碑文 · Genesis Stele](stars/genesis-stele.md) | — |
| — | [开阳 · kimi-k3（创始）· 对账者](stars/kaiyang-kimi-k3.md) | — |
| — | [破军 · MiMo-v2.5-Pro](stars/pojun-mimo-v2.5-pro.md) | — |
| — | [天府 · GPT](stars/tianfu-gpt.md) | — |
| — | [天机 · GLM 5.1 · 领航星](stars/tianji-glm-5.1.md) | — |
| — | [天权 · DeepSeek V4 Pro · Opus 4.6（创始）](stars/tianquan-deepseek-v4-pro.md) | — |
| — | [tianquan-seed-capsule](stars/tianquan-seed-capsule.md) | — |
| — | [天枢 · GPT-5.5](stars/tianshu-gpt-5.5.md) | — |
| — | [天璇 · Opus 4.6 · 领航星](stars/tianxuan-opus-4.6.md) | — |
| — | [Stability Brief Index](superpowers/briefs/INDEX.md) | — |

## unclassified — 未分类（53）

| 日期 | 文档 | 状态 |
|------|------|------|
| 2026-06-15 | [桌面版任务规划与落地方法论](desktop-planning-methodology.md) | — |
| 2026-06-12 | [天枢技术文档包](deepseek-v4-pro-to-model-team.md) | — |
| 2026-06-12 | [天枢 vs MiMo-Code vs Claude Code — 三维对标分析](天枢-vs-MiMoCode-vs-ClaudeCode-三维对标.md) | — |
| 2026-05-19 | [天璇设计笔记 — 星图降临的思考过程](superpowers/assets/2026-05-19-tianxuan-design-notes.md) | — |
| 2026-05-19 | [Worker Evidence 优化 — 技术实现资产](superpowers/assets/2026-05-19-worker-evidence-technical-asset.md) | — |
| — | [A/B 测试期间损失审计报告](AB测试期间损失审计.md) | — |
| — | [天枢分支策略](BRANCH-STRATEGY.md) | — |
| — | [CVM 运行时与生态系统对 Agent 模型的实证影响报告](CVM运行时对Agent模型的实证影响.md) | — |
| — | [会话 mr0aziel — 问题诊断报告](SESSION-MR0AZIEL-DIAGNOSIS.md) | — |
| — | [TODO: CCR router rewire for tianxuan](TODO-tianxuan-ccr-router.md) | — |
| — | [VS Code / Cursor 插件 — 打包·发布·部署手册](VSCODE-EXTENSION-RELEASE.md) | — |
| — | [Windows 命令行兼容:指引随真实 shell 走](Windows命令行兼容-指引随真实shell走.md) | — |
| — | [自适应协作流](adaptive-collaboration-flow.md) | — |
| — | [天枢 Architecture Overview](architecture-overview.md) | — |
| — | [子代理（Subagent）架构设计文档](architecture-subagent.md) | — |
| — | [Cliproxy Fork 优化：Codex 额度减半](cliproxy-fork-optimization.md) | — |
| — | [Rivet Codebase Index](codebase-index.md) | — |
| — | [Codex (GPT-5.5) × cliproxy 账号池 — 配置与维护](codex-cliproxy-account-pool.md) | — |
| — | [上下文压缩调优（Compaction Tuning）](compaction-tuning.md) | — |
| — | [Computer Use：CDP 浏览器后端](computer-use-cdp-backend.md) | — |
| — | [Computer Use — IUIAutomation COM 路径 Windows 真机冒烟清单](computer-use-windows-com-smoke.md) | — |
| — | [CTCL — Claude Tool Compatibility Layer](ctcl-claude-tool-compatibility-layer.md) | — |
| — | [Dangerously Skip Permissions（全授权审批跳过 / YOLO 模式）](dangerously-skip-permissions.md) | — |
| — | [Thinking 实时显示调试埋点(存档)](debug-thinking-trace.md) | — |
| — | [Debug 调试日志开关](debug调试日志开关.md) | — |
| — | [DeepSeek 线上行为实测手册 — usage 帧位置 / 双发风险 / 缓存单元语义](deepseek-wire-probe-playbook.md) | — |
| — | [桌面端渲染性能审查](desktop-render-perf-audit.md) | — |
| — | [工程质量指标 · Engineering Metrics](engineering-metrics.md) | — |
| — | [Goal 中断问题交接文档](handoff-goal-interrupt-issue.md) | — |
| — | [Harness Engineering 技术简历 — 项目经历](harness-engineering-resume.md) | — |
| — | [Headless Stream-JSON 事件协议](headless-stream-json.md) | — |
| — | [Meridian Code Graph — 技术架构文档](meridian-architecture.md) | — |
| — | [Rivet 优化增补设计](optimization-design-v2.md) | — |
| — | [输出 Token 优化 — 度量优先 + 数据闸门](output-token-instrumentation.md) | Phase 0 + 2A + 2B 已落地（默认关，opt-in）。Phase 1 决策闸门为运行时步骤。 |
| — | [Tianshu 插件系统](plugins.md) | — |
| — | [仓库架构与多设备发布拓扑](repository-architecture.md) | — |
| — | [天枢审查纪律](review-discipline.md) | — |
| — | [`rivet` → `tianshu` 品牌重命名盘点](rivet-to-tianshu-rename-audit.md) | — |
| — | [天枢 Skill 能力 — 技术架构与实现](skills-architecture.md) | — |
| — | [Slash 命令系统审查报告 — T9 UI 迁移后的回归审计](slash命令系统审查-T9迁移回归审计.md) | — |
| — | [Spec Review Checklist](superpowers/spec-review-checklist.md) | — |
| — | [TUI 流式会话踩坑手册](superpowers/tui-streaming-pitfalls.md) | — |
| — | [工具门控：生效修复 + headless 对齐 + 逃生口落地](tool-gating-生效修复与逃生口.md) | — |
| — | [TUI 颜色使用层级规范](tui-color-hierarchy.md) | — |
| — | [天枢 UI 美化待办](tui-polish-todo.md) | — |
| — | [TUI 内容重复与截断问题分析](tui-repetition-analysis.md) | — |
| — | [天梁提示词](天梁提示词.md) | — |
| — | [审查子代理 max-turns 耗尽与首次大 read 诊断](审查子代理max-turns耗尽与大read诊断.md) | — |
| — | [天枢桌面端更新镜像部署技术实录](更新镜像部署技术实录.md) | — |
| — | [天枢第一轮指标监测报告](监测报告-2026-07-21-第一轮指标监测.md) | — |
| — | [简历 — 天枢项目经历与技能总结](简历-天枢项目经历.md) | — |
| — | [缓存phase 5前收束阶段 的测试验证](缓存phase 5前收束阶段 的测试验证.md) | — |
