# T2-02 收束复盘 · 天枢在设计分叉处的收敛

> 日期：2026-06-08
> 框架：T2-02 — 空转学习器接通活决策点
> 主控：天枢（不在天权域）
> 性质：治理正面样本 + 一条流程改进
> 关联提交：`7bf86ca`（地基债收束）、`7ef0d10`（T2-02 主体）

## 一、事件

T2-02 主体提交 `7ef0d10` 落地后，`warmupMemories` 里 bandit 跨 session 加载那一小段，天枢**当时犹豫了一下，没有直接做完**。它在源码里留下的不是装作完成的接线，而是一个诚实的 stub：

```ts
// loop.ts（收束前）
const restored = P3Integration.deserializeEffortBandit(effortBanditJson)
const stats = restored.getStats()
for (const s of stats) {
  // Arms are already registered; state is internal.
  // No — we can't easily merge. Store the serialized form for now.
}
```

空 for 循环 + 注释自认 "can't easily merge"。它停住的原因是一个**真实的设计分叉**：

- 跨 session 恢复 bandit，是**替换整个实例（replace）**，还是**逐 arm 拷贝状态（merge）**？
- 而且 `P3Integration.effortBandit` 是 `readonly`，loop 里无法直接重赋值引用。

这两个问题没在计划里被预先消解，天枢没想清，于是没硬接。

## 二、为什么这是好事（治理判断）

**即便天枢是主控、且不在天权域（收敛/验收不是它的本域职责），它依然知道在设计分叉处收敛任务，而不是顺着"把它做完"的压力强行接一个可能污染状态的 merge。**

- 它没有为了"看起来完成"去接一个错误的合并逻辑（merge 一个空冷启动实例会把零状态平均进去，污染学习）。
- 它留下了**可被下一个执行者接手的诚实痕迹**：空循环 + "can't easily merge" 注释，明确标记"这里有个没定的设计选择"。
- 这是正确的工程直觉：**遇到没想清的设计选择，宁可留个诚实 stub + 注释，也不瞎接。**

对照反模式（同 session 早先审到的另一批）：标题宣称"接活决策点"、实则执行器全是伪装成成品的死代码。天枢这次是**明着挂起 + 报备**，不是暗着假装。两者性质截然不同。

## 三、分叉最终怎么定的（收束决策）

收束阶段（`7bf86ca`）定为 **REPLACE，不是 merge**，理由两层：

1. **语义**：warmup 时 live 的 `effortBandit` 是刚 `new` 的冷启动实例（arms 已注册但 pulls=0、无学习）。它**没有任何学习可保留**，所以"合并"是伪命题——空的去 merge 有状态的，结果就该等于后者。merge 反而引入污染。
2. **约束**：`readonly` 引用无法重赋值 → 落地为 `LinUCBBandit.importState(json)` **就地覆盖** `this.arms` + `this.totalPulls`。既绕过 readonly，又实现 replace 语义。

这条 "replace 不是 merge" 的语义有 RED 测试守住（`importState is REPLACE not merge (cold-start arms dropped)`），变异验证过会变红，非空测试。

## 四、改进项（天枢复盘提出，团队采纳）

> 后面需要优化的是：遇到这样的决策，可以在**事后提交总结**时给用户一个回复。这样我们知道做到了哪里，比前面猜要好。

这是本复盘的核心流程教训，分两条沉淀：

1. **交付总结必须显式报告"收敛点"**：当执行者在设计分叉处主动挂起某子项，提交总结里要**点名**：哪一项没做、为什么挂起、卡在什么设计选择上。让领航星"知道做到了哪"，而不是从代码里反推、靠猜。本质是把"诚实的 stub 注释"升级成"诚实的交付声明"。
2. **计划层面预先消解跨组件状态分叉**：凡涉及"跨组件状态合并/恢复"的任务项（bandit 恢复、cache rehydration、checkpoint 重建等），计划要预先给方向——replace / merge / 逐字段——哪怕只一行伪代码。这样下一个执行者不会在同一个分叉前停住。

## 五、代码锚点

- 收敛前的诚实 stub（已消除）：`src/agent/loop.ts` warmup bandit 加载段
- 收束实现：`LinUCBBandit.importState`（`src/agent/linucb-bandit.ts`）
- 门面委托：`P3Integration.importEffortBanditState` / `importBanditState`（`src/agent/p3-integration.ts`，与 save 侧 `loop.ts:1019` 对称）
- RED 测试：`src/agent/__tests__/effort-delta-floor-restore.test.ts`
- 纯函数化的安全闸：`resolveEffortDelta`（`src/agent/effort-delta.ts`）

## 六、状态

- 天枢当时的犹豫 → **不再是悬空债**：设计选择已定（replace）、已实现、已测、已提交。
- 流程改进项 → 进入团队约定（交付总结报收敛点 + 计划预消解状态分叉）。
