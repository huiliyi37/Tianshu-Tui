# Rivet 二次元 Pastel UI + 渲染性能 + 内存安全 深度头脑风暴结果

## 背景

- **用户需求：** 将终端 UI 从赛博朋克霓虹风格改为二次元 pastel 风格（轻快、愉悦、时尚），同时解决渲染性能和内存安全问题（子代理不泄漏）
- **项目上下文：** Rivet 使用 Ink 6 + React TUI，当前色板为 #00ffcc / #7b2fff / #00ff88（高饱和霓虹色），已有 memo/buffered flush/Static 优化，但存在 cockpit snapshot 每次重建、pushStatic O(n) 拷贝、SessionContext 无界增长等问题
- **调研发现：** 4 个子代理（UI 代码探索 + 外部技术调研 + 内存审计 + 定向反证）确认：(1) "Ink reconciler 是瓶颈"是未验证的假设 (2) 静态装饰元素成本很低 (3) Worker 隔离良好 (4) 主要增长点是 SessionContext 集合和 staticItems

## 三轮思考过程

### 第一轮：变异

```
[VARIATION]
生态位: 终端编码代理 / Ink 6 + React / 流式输出 + 多面板 cockpit / 长会话 + 子代理
选择压力: 二次元审美 + 渲染性能 + 内存安全
已占据: 赛博霓虹 + 无性能优化 + 内存无界增长 / 空位: pastel + 有界集合 + braille sparklines
调研发现: 静态装饰很便宜、动态更新是瓶颈、Worker 隔离良好、SessionContext 无界

方案:
  V1(主流): 换色板 + 固化 cockpit snapshot + 限定 staticItems
  V2(邻近): V1 + braille sparklines + <Static> 分离 + SessionContext 有界化
  V3(空位): Worker 池化 + SessionContext 有界化 + eviction policy
  V4(突变): 流式输出用 raw ANSI，cockpit 保留 React，双通道架构

创始假设: "二次元=pastel 色" — 但还包括圆角边框、kawaii icon、渐变、留白
适应度函数: 硬约束=truecolor+256色兼容+不破坏功能 / 加分=愉悦+帧率稳定+内存有界 / 减分=新依赖+重写量
```

### 第二轮：选择

```
[SELECTION]
目标偏移: V3 只覆盖内存，不覆盖审美；V4 引入不必要的复杂度
因果测试: V1=通过 / V2=通过 / V3=断裂(不解决审美) / V4=断裂(维护成本过高)
成本测试: V1=低(1-2天) / V2=中(3-5天) / V3=高(1-2周) / V4=高(1-2周)
共演化: V1=静态 / V2=动态(braille可扩展) / V3=动态 / V4=静态(技术债)
局部最优: V1 安全但"愉悦感"不足 — V2 的 braille sparklines 是"愉悦感"的载体
落地性: V1=改 6 个 hex 值 ✓ / V2=V1+sparkline+bounded ✓ / V3=定义 WorkerPool ✗(不解决审美) / V4=ANSI renderer ✗(阻塞多)
灭绝: V4(双通道维护成本高) / V3(因果链断裂，特征被 V2 吸收)
存活: V1(安全牌) / V2(最强·三目标兼顾)
最强竞争者: V2 — 同时回应审美+性能+内存，开发成本可控(3-5天)
```

### 第三轮：适应

```
[ADAPTATION]
套路清除: "换配色"不制造愉悦感；"braille 画图"如果没有数据意义就是装饰；"worker pool"可能是过度工程
扩展适应:
  - contextBar() → braille sparkline（已有 block 字符基础）
  - gradient-string → pastel 渐变标题（已有依赖）
  - <Static> → 已完成 tool card 移入（Ink 内置）
  - formatElapsed() → spinner 动画（⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏）
具体化:
  人: 每天在终端工作 4-8 小时的开发者
  场: iTerm2/Windows Terminal/Alacritty，深色背景，120+ 列
  动: (1)改 theme.ts 6 个色值 (2)SummaryBar 加 braille sparkline (3)限定 staticItems 500 + SessionContext 集合 500
  果: 用户第一反应从"好刺眼"→"好舒服"；2 小时长会话后 RSS < 200MB
收敛验证: V1 和 V2 收敛到"静态视觉改造 + 有界集合 = 足够好"
```

## 最终方案：Pastel 色板 + 渲染优化 + 内存有界化

### Phase 1（第1天）：Pastel 色板

修改 `src/tui/theme.ts`：

| 角色 | 当前赛博色 | 新 pastel 色 | 含义 |
|------|-----------|-------------|------|
| primary | `#00ffcc` | `#a8e6cf` | 薄荷绿（搜索/grep） |
| secondary | `#7b2fff` | `#d4a5f5` | 薰衣草紫（编辑/写入） |
| success | `#00ff88` | `#b5ead7` | 嫩绿（测试通过） |
| warning | `#ffaa00` | `#ffdac1` | 暖杏（委派/警告） |
| error | `#ff3333` | `#ff9aa2` | 柔粉红（错误） |
| dim | `#4a4a6a` | `#8585a0` | 柔灰（次要信息） |

256-color FALLBACK 调整为更饱和的 chalk 色名以确保可读性。

**成功标准：** typecheck + test pass，肉眼确认 pastel 在深色终端下可读

### Phase 2（第2天）：渲染性能优化

1. **固化 cockpit snapshot** — 用 `useMemo` 包裹 `buildCockpitSnapshot`，依赖不变则不重算
2. **限定 staticItems** — 改为环形缓冲区，cap 500 条
3. **已完成 tool card 移入 `<Static>`** — 减少 reconciler 工作

**成功标准：** cockpit 不因 snapshot 重建闪烁；staticItems 不超过 500

### Phase 3（第3天）：内存安全 + 视觉愉悦

1. **SessionContext 有界化** — `filesRead`/`filesModified`/`testResults` cap 500（evict oldest）
2. **Braille context sparkline** — 最近 20 轮 token 变化趋势
3. **Pastel 渐变标题** — 用 `gradient-string` pastel 渐变
4. **Spinner 动画** — `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 旋转指示器

**成功标准：** 2 小时长会话后 RSS < 200MB；sparkline 在 120 列终端下正确渲染

## 风险与应对

| 风险 | 应对 |
|------|------|
| 256-color 终端下 pastel 不可读 | FALLBACK 用更饱和的 chalk 色名（非 pastel hex） |
| Braille sparkline 在某些终端下乱码 | 用 feature detection：如果终端不支持 braille，退回 block 字符 |
| SessionContext 有界化可能丢失旧数据 | 只 evict `filesRead`/`filesModified`（辅助数据），不 evict `messages`（核心数据） |
| `<Static>` 中的 tool card 不再能被更新 | 只将"已完成"的 tool card 移入 Static（状态已终态） |

## 下一步

Phase 1 第一个动作：修改 `src/tui/theme.ts` 的 `TRUECOLOR_COLORS` 对象，将 6 个色值替换为 pastel 值。
