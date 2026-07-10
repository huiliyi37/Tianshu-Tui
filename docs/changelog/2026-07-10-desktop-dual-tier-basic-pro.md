# 2026-07-10 — 桌面版双层模式：Basic 免激活 + Pro 许可证解锁

> 商业化路线定调：桌面端放弃"未激活即锁死"的强制激活（摩擦太高），改为
> 双层模式——**Basic 免许可证下载即用（完整基础能力，不阉割星域），Pro
> 许可证解锁高级功能**。已建成的激活基础设施（Ed25519 验签 / 设备指纹 /
> 离线宽限 / license-server）全部复用，只是语义从"启动闸门"降级为
> "Pro 解锁凭证"。计划文档：`.cursor/plans/桌面版双层_basic_pro_38ffb243.plan.md`。

## 功能切分

| | Basic（免费，免许可证） | Pro（许可证解锁） |
|---|---|---|
| 编码 agent / 全部星域 | ✅ | ✅ |
| 单轮议事会 / `/team` standard | ✅ | ✅ |
| `computer_use` | ❌ | ✅ |
| `/team max`（多视角 planner fanout） | ❌ | ✅ |
| `/council --rounds 2`（反驳轮） | ❌ | ✅ |

## 授权信号流

license-server 签发 token（tier=pro）→ 前端兑换 → `activation.rs` Ed25519
验签落盘 → `lib.rs spawn_sidecar` 按 `is_pro()` 注入 `RIVET_PRO=1` →
sidecar 侧 `pro-license.ts` 判定 → 各 gate 点。

## Rust 层（gate 从"拦启动"改为"定层级"）

- `activation.rs`：`is_activated`/`activation_bypassed`/`bypass_status` →
  `is_pro`/`dev_pro_bypass`/`dev_bypass_status`。**任何验签通过且未过期的
  许可证即 Pro**（Basic 不发许可证；`tier` 字段留作未来多层级扩展位，兼容
  早期无 tier 的 token）。`RIVET_ACTIVATION_ENABLED` 编译开关整个移除；
  debug 构建 `RIVET_ACTIVATION_DEV_BYPASS=1` 语义变为"直接视为 Pro"
  （`npm run tauri:dev:bypass`）。验签/指纹/宽限逻辑一行未动。
- `lib.rs`：sidecar **始终启动**；`spawn_from_spec` 按 `is_pro()` 注入
  `RIVET_PRO=1`，Basic 时显式 `env_remove`——防止从设了 `RIVET_PRO` 的
  shell 启动桌面端继承出未付费 Pro。崩溃监视器不再因许可证失效停止重启，
  respawn 动态重判层级：吊销/过期自动降级 Basic 继续跑，绝不锁死付费用户。

## sidecar 层（gate 点）

- `ProFeature` 扩展 `teamMax` / `councilMultiRound`（schema 同步）。
- `team_orchestrate` mode:'max'：未启用时**有现成计划降级 standard 执行**
  （附 `[Pro]` 注明），无计划明确拒绝并给 Basic 替代路径（plan_task +
  standard）。gate 只放工具层单一咬合点，不在 orchestrator 内部重复。
- `council_convene` rounds≥2：未启用钳制单轮继续执行 + 注明（降级优于报错，
  单轮议事会是 Basic 能力）。
- `/team max`、`/council --rounds 2` 斜杠入口早拦/提示，省模型轮次。
- CLI 公开版保持软 gate（`RIVET_PRO=1` 可自行开启）——**有意的双渠道策略**：
  会从源码构建并设环境变量的人不是付费群体；桌面闭源分发才是硬 gate。

## 前端非阻塞化

- 全屏不可关闭的 `ActivationScreen` → 可关闭的 `ProUpgradeDialog`，入口在
  设置 → 关于与许可（显示 Basic/Pro 层级、有效期、宽限状态、升级/移除许可证）。
- `useActivationGate` → `useProLicense`：启动静默查询 + 6h 心跳，失败/吊销
  一律降级 Basic，不再有 `gated` 拦截路径。文案全面从"激活必需"改"升级 Pro"。

## 顺手修掉的真 bug

`DEFAULT_CONFIG.pro.features` 原为全 `false`，而它是 `loadConfig` 第一层
deep-merge 基底，会**覆盖 schema 的 `true` 默认**——Pro 用户激活后还得手动
逐项改 config 才能用功能，与 `pro-license.ts` 文档语义（"active Pro 下
feature 默认开"）直接矛盾。已改全 `true`；免费层的保护本来就在
`enabled=false` 一票否决上，双重锁是冗余且有害的。

## 同步纪律预埋

`sync-to-public.sh` 新增 `src/pro/` 排除项：未来 Pro 专属实现的保留目录。
纪律：**新高级功能动工前先决定归属——一旦同步进公开 git 历史就收不回来**
（computer_use/team max/议事会源码已公开是沉没成本，Pro 差异化从"代码独占"
转向"分发渠道 + 桌面体验层 + 服务层"）。

## 测试

- Rust 10/10（新增 tier 缺失 token 仍算有效许可证的用例）；cargo check 通过。
- Node：pro-license / schema / team-orchestrate / council-convene /
  default-registry / computer-use / config-routes / slash-commands 全绿，
  新增 9 个 gate 用例（max 无计划拒绝 / 有计划降级 / 缺省不受影响；rounds
  钳制 / 缺省无提示 / 单轮不受影响；新功能位默认开关矩阵）。
- 桌面端 typecheck + 284 测试全过。

## 遗留

- GUI 端到端手工验收未做（需真实打包）：Basic 启动全功能、输码解锁三项、
  过期宽限行为。
- 许可证变更后需重启应用生效（沿用 relaunch 机制，成功提示已写明）。
- `ActivationScreen.tsx` 文件名保留（导出已改 `ProUpgradeDialog`）。
