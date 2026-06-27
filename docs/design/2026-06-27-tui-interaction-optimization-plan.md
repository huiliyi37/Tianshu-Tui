# TUI 端交互优化方案

> 2026-06-27 · 借鉴桌面端改造经验,设计 TUI 端的交互与展示优化

## 1. 现状分析

### 已有且做得好的(不动)

| 能力 | 文件 | 评价 |
|------|------|------|
| 任务列表三态 | `task-list.ts` | ☐/◐/☒ + 智能窗口折叠,已完成 |
| GlanceBar 四区 | `glance-bar.ts` | domain/model/cache/tokens/cost/elapsed,信息密度高 |
| 审批交互 | `approval-intent-controller.ts` | y/n/e/veto 四键,双触发防护已修 |
| ChoicePanel | `overlay.ts` | 通用选项弹窗(刚做) |
| 委派舰队面板 | `worker-fleet.ts` | 状态 glyph + elapsed + activity |
| 委派 streaming 预览 | `tool-card.ts` | tasks[] 实时增长(刚做) |

### 现有问题

1. **任务列表无分组** — 所有任务平铺,跨 phase 的任务混在一起,无视觉分隔
2. **任务无进度百分比** — 只有 done/total 计数,无直观的"完成度"条
3. **任务列表无交互** — 不能跳过/重排/编辑任务,只能看
4. **审批提示太简陋** — 只有 `y/n` 文字,无操作预览(改了什么文件/跑了什么命令)
5. **子代理面板无展开** — 舰队面板只显示一行摘要,无法展开看某个 worker 的详细输出
6. **GlanceBar 无 phase 指示** — agent 当前在"搜索/编码/验证"哪个阶段,用户不知道
7. **无加载进度条** — 长任务(压缩/大文件读)无进度反馈,只有 spinner 旋转
8. **工具组折叠后无摘要** — read/search 工具组折叠了,但折叠后看不到"读了几个文件/搜了几个结果"

---

## 2. 优化方案(按 ROI 排序)

### P0 — 立即做

#### 2.1 任务列表 phase 分组 + 进度条

**问题**:任务列表平铺,跨 phase 任务混在一起。`formatTaskList` 只输出 `◇ 任务 2/5` + 扁平条目列表,无分组、无进度可视化。

**方案**:在 `task-list.ts` 的 `formatTaskList` 里:
1. **按 phase 分组**:如果 `TodoItem` 有 `phase` 字段(或从 content 推断),渲染分组分隔线 `── Phase: 实现 ──`。无 phase 字段则保持原样。
2. **进度条**:标题行 `◇ 任务 2/5` 改为 `◇ 任务 [████░░░░] 2/5` — 8 格 block character,已完成比例可视化。
3. **当前任务高亮增强**:`in_progress` 行加 `▸ ` 前缀(与 pending 的空格对齐),视觉焦点更明确。

```
当前:
  ◇ 任务 2/5
    ◐ 实现用户认证模块
    ☐ 编写单元测试
    ✓ 2 done

改进后:
  ◇ 任务 [██░░░░░░] 2/5
    ▸ ◐ 实现用户认证模块        ← 当前焦点,▸ 前缀
      ☐ 编写单元测试
      ✓ 2 done
```

**工作量**:1.5 小时。**收益**:任务进度一目了然。

#### 2.2 审批提示增加操作预览

**问题**:审批提示只显示 `y/n`,用户不知道 approve 后会发生什么。对比桌面端 ChangesTab 有完整 diff 预览。

**方案**:在审批态的渲染函数(`app.ts` 的 `renderApproval` 或 `format-utils` 的 summary line)里,增加操作摘要:
- **bash 工具**:显示命令前 60 字符(已有,保留)
- **write_file/edit_file**:显示文件路径 + 改动行数(`+12 -3`)
- **delegate_task**:显示目标(objective 前 50 字符)
- 在 `y/n` 下方增加一行操作预览:`  → 写入 src/auth.ts (+12 -3)` 或 `  → 执行: rm -rf node_modules`

```
当前:
  ⚠ APPROVAL: bash rm -rf /tmp/test
  [y] approve  [n] deny

改进后:
  ⚠ APPROVAL: bash
    → rm -rf /tmp/test
  [y] approve  [n] deny  [e] edit
```

**工作量**:1 小时。**收益**:审批决策更有依据,减少误 approve。

#### 2.3 工具组折叠摘要

**问题**:read/search 工具组折叠后只剩标题,看不到"读了几个文件"。用户需要展开才知道工作量。

**方案**:在 `tool-group-controller.ts` 的折叠渲染路径里,给标题追加计数:
- `▸ read (3 files)` — 读了 3 个文件
- `▸ search (5 results)` — 搜到 5 个结果
- `▸ bash (2 commands)` — 跑了 2 个命令

计数来自工具组的 children 数量(已有数据,只需在渲染时 append)。

**工作量**:30 分钟。**收益**:折叠态也有信息量,减少展开操作。

### P1 — 短期做

#### 2.4 子代理面板可展开

**问题**:舰队面板(`worker-fleet.ts`)只显示一行摘要 + worker 列表,无法看某个 worker 的详细输出/进度。

**方案**:新增 overlay 类型 `'fleet-detail'`:
- 在舰队面板的 worker 行上按 Enter → 展开 fleet-detail overlay
- overlay 显示该 worker 的:objective 全文 + 最近 N 条 activity log + elapsed + token 用量
- Esc 关闭,回到舰队面板
- 数据来自 `FleetRegistry.getWorker(id)`(已有)

```
舰队面板:                    展开后 overlay:
  ◐ 子代理 · 2 执行中         ┌─────────────────────────┐
     ● AuthLoader  grep auth  │ ◐ AuthLoader            │
     ● DbMigrator migrate     │   objective: 扫描 auth  │
                              │   模块并报告依赖         │
  [Enter 展开]                │                         │
                              │   activity log:         │
                              │   ⎿ grep -r "auth"      │
                              │   ⎿ found 12 files       │
                              │   ⎿ reading auth.ts     │
                              │                         │
                              │   elapsed: 4.2s         │
                              │   tokens: 8.2k          │
                              └─────────────────────────┘
```

**工作量**:2 小时。**收益**:子代理工作透明化,不黑盒。

#### 2.5 GlanceBar 增加 phase 指示

**问题**:用户不知道 agent 当前在搜索/编码/验证哪个阶段。PhaseTracker 已有数据但没显示在 GlanceBar。

**方案**:在 `glance-bar.ts` 的 `formatGlanceLeft` 里,domain 名后面追加 phase glyph:
- searching → `🔍`
- coding → `✎`
- reviewing → `✓`
- idle → 无

```
当前:  ◇ 天枢 (main)  deepseek-v4  ⚡95%  ◧12k/128k
改进:  ◇ 天枢 🔍 (main)  deepseek-v4  ⚡95%  ◧12k/128k
```

PhaseTracker 已经在追踪(`phase-tracker.ts`),只需把 `current()` 传给 GlanceBar input。

**工作量**:30 分钟。**收益**:用户实时感知 agent 工作阶段。

#### 2.6 任务列表交互操作

**问题**:任务列表只能看,不能跳过/重排。

**方案**:新增 `/todo` 命令的交互模式:
- `/todo skip <id>` — 跳过任务(标记为 skipped,不显示 ☒ 而是显示 ⊘)
- `/todo move <id> <up|down>` — 重排任务顺序
- `/todo add <content>` — 追加任务
- `/todo done <id>` — 手动标记完成

这些是 `todo-store.ts` 已有能力的 slash 命令封装。

**工作量**:1 小时。**收益**:用户可干预任务规划。

### P2 — 中期做

#### 2.7 长任务进度条

**问题**:大文件读取/上下文压缩/长搜索无进度反馈,只有 spinner。

**方案**:在 `spinner-status.ts` 里,为已知进度的长操作渲染进度条:
- 压缩: `◐ compacting [████████░░] 80%`
- 大文件读: `◐ reading [██████░░░░] 6/10 files`
- 搜索: `◐ searching [████░░░░░░] 4/10 dirs`

需要工具在执行时上报进度(通过 `onProgress` callback)。目前工具不报进度,这需要后端支持。

**工作量**:后端改动较大,工具需加 progress reporting。**收益**:长任务不焦虑。

#### 2.8 消息区时间戳

**问题**:长会话里消息无时间戳,不知道哪条是刚才的、哪条是很久前的。

**方案**:在消息行渲染时,左侧追加相对时间:
- 1 分钟内:无时间戳
- 1-60 分钟:`12m`
- 1+ 小时:`2h`
- 跨天:`昨天`/`3天前`

需要消息携带 timestamp(已有 `updatedAt`)。

**工作量**:1 小时。**收益**:长会话时间感知。

#### 2.9 多会话 tab 切换

**问题**:同时只能看一个会话,切换会话需要 `/session switch`。

**方案**:底部 tab 栏,显示当前打开的 N 个会话,Ctrl+Tab 切换:
```
 ┌─────────┬─────────┬─────────┐
 │ auth-fix │ api-ref │ ●new    │
 └─────────┴─────────┴─────────┘
```

**工作量**:较大,需要 session 管理改造。**收益**:多任务并行。

---

## 3. 优先级总结

| 优先级 | 优化 | 工作量 | 核心收益 |
|--------|------|--------|---------|
| **P0** | 2.1 任务列表分组+进度条 | 1.5h | 进度可视化 |
| **P0** | 2.2 审批操作预览 | 1h | 审批更有依据 |
| **P0** | 2.3 工具组折叠摘要 | 30min | 折叠也有信息 |
| **P1** | 2.4 子代理面板可展开 | 2h | 子代理透明化 |
| **P1** | 2.5 GlanceBar phase | 30min | 实时感知阶段 |
| **P1** | 2.6 任务列表交互 | 1h | 可干预规划 |
| **P2** | 2.7 长任务进度条 | 大 | 长任务不焦虑 |
| **P2** | 2.8 消息时间戳 | 1h | 时间感知 |
| **P2** | 2.9 多会话 tab | 大 | 多任务并行 |

## 4. 不建议做的

| 不做 | 原因 |
|------|------|
| TUI 加动画过渡 | 终端动画性能差,闪烁严重,不值得 |
| TUI 消息气泡 | 终端无圆角/阴影,气泡退化为缩进,效果差 |
| TUI 壁纸/毛玻璃 | 终端不支持透明度(除非特殊终端),不可行 |
