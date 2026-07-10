# 下版规划（2.19）：试用码增长线 + MAX 赞助层

> 前置：2.18 已落地双层模式（`docs/changelog/2026-07-10-desktop-dual-tier-basic-pro.md`）。
> 本版两条线：**A. 免费试用码拉新**（进群领码，Pro 体验 10 天）；**B. MAX 赞助层**
> （高级会员 = 赞助者：个人群 + 长期维护更新 + 个性化需求通道）。

## 定位

- **试用码**：tier=pro、限时（如 10 天）、单设备。用完整 Pro 体验换群成员增长，
  到期自动降级 Basic（2.18 已实现降级不锁死），转化正式 Pro。
- **MAX**：tier=max，价格高于 Pro，权益主要在**服务层**（个人群、个性化需求、
  更久的维护更新承诺），软件侧本版只做**身份透传 + 徽章展示**，不做 MAX 专属
  功能 gate（留扩展位）。赞助属性 > 功能属性。

## A. 试用码体系（license-server + 桌面端）

> 进度：A1/A2/A3 已完成（2026-07-10，含 23 个单测 + 端到端流程测试）。
> 剩余 A4 部分（生成结果导出、兑换率统计）与 A5。

### A1. 试用期从激活起算（关键缺口）✅

现状：`license_expires` 在**生成时**计算（`Date.now() + days`）。进群领码场景下，
码可能生成后第 9 天才被兑换，用户只剩 1 天——不可用。

- `codes` 表加 `trial_days INTEGER NULL` 列（D1 migration）。
- 生成 API：`trialDays` 参数与 `licenseDays` 互斥；试用码强制 `maxActivations=1`。
- `activate()`：命中 trial 码且首次激活时，回填
  `license_expires = now + trial_days * 86400000`（单设备约束保证回填只发生一次）。
- 已有的过期检查/token `lic` 字段链路不用动。

### A2. 防滥用：一台设备一次试用（关键缺口）✅

现状：`activate()` 只查 `(device_id, code)` 对，同一设备可以换码无限续试用。

- 兑换 trial 码时查该 `device_id` 是否已有**任何** trial 码激活记录（含已过期/
  已吊销）→ 有则拒 `trial_already_used`。
- 桌面端 `KNOWN_ERRORS` 加该错误码 + 中英文案（"本设备已使用过试用，升级正式 Pro"）。
- 设备指纹是 machine-uid，重装系统可绕——接受，试用滥用的经济损失为零（不含服务成本）。

### A3. verify 多码归属解析（正确性缺口）✅

现状：`verify()` 按 `WHERE a.device_id = ?` 取**任意第一行**。设备先试用后购买
（正常转化路径！）会有两行激活记录，心跳可能刷回已过期的 trial → 付费用户被降级。

- 改为选"最优有效授权"：未吊销且未过期优先；tier 权重 max > pro；
  `license_expires` NULL（永久）> 最晚。加回归测试覆盖"试用过期 + 正式码有效"序列。

### A4. 发码运营工具（admin 后台）

- 生成面板加"试用码"模式（trialDays 输入，默认 10，强制单设备）。
- 生成结果**一键复制/导出文本**（当前只弹 JSON）——进群发码的实际动作。
- 列表页补激活率汇总（已生成/已兑换/兑换率），试用码与正式码分开统计（按 note
  或 trial_days 区分）。

### A5. 桌面端试用体验

- 设置 → 关于与许可：licenseExpires 已展示；试用许可加"试用剩余 N 天"徽标。
- 心跳返回 `licenseExpires - now < 3 天` → toast 提醒一次/天（复用 sonner）。
- 到期降级后（reason=license_expired）：升级引导指向正式 Pro 购买（文案已在
  2.18 的 revoked 文案基础上微调）。

## B. MAX 赞助层

### B1. 签发与透传

- admin 下拉恢复多层级：`pro` / `max`（2.18 曾移除 standard，本次加回 max）。
- `lib.rs`：注入 `RIVET_PRO=1` 时同时注入 `RIVET_PRO_TIER=<tier>`（Rust
  `LicenseStatus.tier` 已有）。
- `pro-license.ts`：`ProLicenseInfo` 加 `tier?: 'pro' | 'max'`（env 来源读
  `RIVET_PRO_TIER`，缺省 'pro'）。本版无 MAX 专属功能位，仅身份透传；
  未来 per-tier 功能矩阵在 `isProFeatureEnabled` 上扩展。

### B2. UI 与权益呈现

- 设置 → 关于与许可：tier=max 显示"MAX · 赞助者"徽章 + 感谢文案 +
  **专属群入口**（URL 走配置/常量，不硬编码在 i18n）。
- 权益口径（写进购买页/群公告，软件内只陈述不强制）：
  - Pro：买断，含 12 个月功能更新，已有功能永久可用。
  - MAX：赞助价，**更长维护更新（如 3 年/永久）+ 个人群 + 个性化需求通道**。
- 更新期硬 gate（token 加 `upd` 字段 + updater 对比版本发布日期）**本版不做**，
  先靠承诺运营；列入 C 阶段。

## C. 后续版本（不进 2.19）

- `updatesUntil` 硬 gate（updater 提示层 → 拦截层）。
- 支付 webhook 自动发码（爱发电/Stripe → admin API）。
- `chatGateway`（托管推理档，融资后第二曲线）。

## 验证

- license-server：trial 回填/防重/verify 优选的单测（D1 可用 miniflare 或纯函数抽取）。
- Rust：`RIVET_PRO_TIER` 注入用例。
- Node：pro-license tier 解析用例。
- 手工：生成试用码 → 兑换 → 剩余天数显示 → 模拟过期 → 降级 + 转化引导 →
  输正式码 → verify 心跳不回退（A3 场景）。

## 排期建议

A1–A3 是一组（server 侧一次 migration + 逻辑改造），先做——没有它们发码活动
不能开。A4/A5 随后。B1/B2 独立，可并行。总量约 2–3 天工作量。
