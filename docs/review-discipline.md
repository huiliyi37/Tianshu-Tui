# 天枢审查纪律

> 实证来源：2026-06-06 三轮对抗审查  
> 实现计划：[`docs/superpowers/plans/2026-06-06-review-discipline-internalization.md`](../superpowers/plans/2026-06-06-review-discipline-internalization.md)  
> 代码入口：`src/agent/review-discipline.ts`、`src/agent/review-router.ts`、`src/agent/review-coordinator-deps.ts`、`src/config/review-discipline-config.ts`

## 定位校准（2026-06-07）

外部 Claude Code Opus 的审查能力不能假设长期在场；本机制的目标是把它暴露出的客观、彻底、敢于不信绿灯的视角内化到天枢自己的工作流中。它不是替代交付侧 TDD 自闭环，而是辅助主控在「提交存在、测试绿、作者声称已修」之后继续做独立复核。

因此当前运行时策略是：有文件要交付时即进入 ReviewRouter。L1 文档/轻量数据改动仍只是 nudge；L2/L3 通过 adversarial verifier / squadron 提供阻断式独立证据。

## 四条纪律（实证驱动）

以下四条纪律来自 2026-06-06 的 Server 子系统对抗审查——18 个缺陷在三轮审查中被发现，其中 R2 和 R3 各自有一个假修复被独立 verifier 打破：

| 轮次 | 暴露的缺口 | 对应纪律 |
|------|-----------|----------|
| R1 | 首轮 18 缺陷全在正向数据流之外（安全/并发/失败模式被功能正确性挤占） | 纪律 1、2 |
| R2 | `51a26a3` H3 假修复（锁只包了 read），作者声称修复但无并发测试 | 纪律 2、4 |
| R3 | `411a51f` H4 删坏相邻行，作者声称"5 套件全过"但触发测试必红 | 纪律 3、4 |

### 纪律 1：不可同上下文自我审批

修复或交付前，须经一次独立验证 pass（换 agent/换上下文）。作者的自信不能顶替验证者的命令行。

### 纪律 2：修复提交前 spawn adversarial_verifier

拿命令+观察输出证据——不是读懂代码就盖 PASS。verifier 与 patcher 必须是不同子代理。

### 纪律 3：改 X 必跑覆盖 X 的既有测试；删除行同等审视

不只跑你为 X 新写的测试。审 diff 时删除行（`-`）与新增行同等审视——回归常长在编辑点的相邻行。

### 纪律 4："测试全过"声明 fail-closed

无"实际运行的命令+观察到的关键输出"的绿声明，一律按未验证处理。

---

## 审查工作流（三档自动路由）

`deliver_task` 对有文件的交付提交自动按变更规模路由到不同审查档位（可用 `RIVET_REVIEW_DISCIPLINE=0` 关闭）：

| 档位 | 触发条件 | 工作流 | 行为 |
|------|---------|--------|------|
| **L3 Squadron** | ≥4 文件 / 跨模块 / 架构改动 | 多 Inspector 并行审查 | RED 拦截 + 合议 |
| **L2 单对抗子代理** | 单/双文件代码/依赖/配置改动，包含但不限于 fix | 1 个 `adversarial_verifier` | RED 拦截 / GREEN 放行 |
| **L1 nudge** | 仅文档/轻量数据文件 | 提示注入 | 提醒但不阻塞 |

审查闭环有界（默认 3 轮），verifier 与 patcher 为不同子代理。

### 客观审查姿态

`src/agent/review-discipline.ts` 额外集中定义 `OBJECTIVE_REVIEW_STANCE`，并由 `src/agent/review-coordinator-deps.ts` 注入到 verifier / squadron objective：

1. 把自己当外部审查者，不替实现者补意图。
2. 区分亲自观察的证据与沿用他人声明。
3. 主动构造畸形输入、并发交错、错误路径、删除行相邻回归等反例。
4. 复核“定义”是否真的接入调用边界。

这部分来自外部 Opus 审查视角，但目标是让天枢在没有外部辅助时也能自带这把尺。

---

## 配置

### 开关

默认**开启**。可用环境变量关闭：

```bash
# 关闭审查纪律门禁
RIVET_REVIEW_DISCIPLINE=0

# 显式开启（也是默认值）
RIVET_REVIEW_DISCIPLINE=1
```

环境变量值 `0` / `false` / `off` / `no`（不区分大小写）均视为关闭。其他值或不设置均视为开启。

### 重入护栏

`reviewDepth` 数值穿过 `delegate` 边界结构化传播到子代理 `deliver_task` 上下文。子代理（verifier/patcher）调用 `deliver_task` 时 `reviewDepth > 0` → 结构性跳过 ReviewRouter，防止审查自我递归。不依赖 prompt 服从。

---

## 扩展

- 审查纪律文本集中定义在 `src/agent/review-discipline.ts`（`REVIEW_DISCIPLINES` 常量），prompt/hook/gate/router 统一引用。
- 修复上下文识别逻辑（`isFixContext`）和变更规模分级（`classifyChangeScale`）同文件。
- 跨模块判定默认按 `src/<module>/` 顶层目录跨度（`isCrossModule`），可替换为 import 图或 owner 口径。
- 要调整审查门槛（文件数、最大轮数），修改 `review-discipline.ts` 和 `review-router.ts` 中的常量。
