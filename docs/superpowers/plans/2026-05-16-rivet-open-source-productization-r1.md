# Rivet Open Source Productization R1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Open Source Harness Strategy 从“策略设计”推进到 R1：开源产品化文档、仓库边界、贡献路径、benchmark 叙事和发布闸门全部定义清楚。

**架构：** R1 是文档与发布边界阶段，不重写 agent/harness 核心代码。CTCL 迁移计划和 Multi-pass Repair Pipeline 视为已完成的技术基础；本计划补齐开源仓库外部叙事、开源/服务边界、benchmark 能力矩阵、贡献治理和发布前安全闸门。

**技术栈：** Markdown 文档、Node/npm 验证命令、Git、现有 docs/superpowers 能力台账。

---

## 背景与分层关系

现有文档形成三层递进关系：

1. `docs/superpowers/plans/2026-05-16-tool-input-repair-cch-strip-schema-gate.md`：CTCL 迁移计划，已被 Multi-pass Repair Pipeline 架构吸收。
2. `docs/superpowers/specs/2026-05-16-rivet-open-source-harness-strategy-design.md`：开源策略与商业边界设计。
3. `docs/superpowers/plans/2026-05-16-multi-pass-repair-pipeline.md`：将 CTCL 核心 repair/schema-gate 能力落成可测试代码，已验证。

因此 R1 不再处理 CTCL 迁移本身。R1 处理“开源项目能否被外部用户理解、运行、贡献、信任、传播”。

## R1 范围

### R1 包含

- 明确 Rivet 开源层与未来服务层的边界。
- 设计外部仓库首页叙事和文档结构。
- 设计贡献路径：repair rule、provider、model profile、benchmark artifact。
- 设计 open model capability matrix 的数据结构与报告格式。
- 定义开源发布前安全与缓存边界闸门。
- 更新能力台账，反映 CTCL/multi-pass foundation 已完成，Open Source R1 是产品化阶段。

### R1 不包含

- 不新增 hosted API 服务代码。
- 不改 `src/prompt/*`、`src/context/*`、`src/compact/*`、`src/agent/prewarm*` 的缓存关键路径。
- 不发布远端仓库、不推送 GitHub、不创建线上服务。
- 不改变当前包名、命令名或 runtime 行为。

## 文件结构

本计划执行时创建或修改以下文件：

- 创建：`docs/superpowers/specs/2026-05-16-rivet-open-source-r1-design.md`
  - R1 总设计：目标、非目标、分层关系、交付物、验收标准。
- 创建：`docs/superpowers/specs/2026-05-16-rivet-open-source-boundary.md`
  - 开源层 / 服务层 / 不采集数据边界。
- 创建：`docs/superpowers/specs/2026-05-16-rivet-open-model-capability-matrix-design.md`
  - open model capability matrix 的 schema、报告字段、benchmark 分类。
- 创建：`docs/superpowers/specs/2026-05-16-rivet-open-source-repository-readiness.md`
  - repository readiness checklist：license、security、contributing、templates、metadata、secret scan。
- 修改：`docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md`
  - 将 Open Source Harness Strategy 从单一 Designed 状态拆成 strategy foundation 与 R1 productization 两条状态。
- 修改：`README.md`
  - 增加面向外部用户的 “Open Source R1 direction” 小节，不替换现有架构文档。
- 修改：`CHANGELOG.md`
  - 记录 R1 文档计划与 CTCL/multi-pass foundation 的状态归位。

---

### 任务 1：创建 R1 总设计文档

**文件：**
- 创建：`docs/superpowers/specs/2026-05-16-rivet-open-source-r1-design.md`

- [ ] **步骤 1：验证文档尚不存在**

运行：

```bash
test ! -f docs/superpowers/specs/2026-05-16-rivet-open-source-r1-design.md
```

预期：PASS。若文件已存在，先读取现有内容并合并，不覆盖已有设计。

- [ ] **步骤 2：创建 R1 总设计文档**

写入：

```markdown
# Rivet Open Source Productization R1 Design

## 定位

R1 是 Rivet Open Source Harness Strategy 的产品化设计阶段。CTCL 迁移与 Multi-pass Repair Pipeline 已构成技术基础；R1 的目标是让外部用户和贡献者理解 Rivet 为什么存在、如何运行、如何贡献、哪些能力属于开源层、哪些能力属于未来服务层。

## 分层关系

| 层级 | 文档 | 当前状态 | R1 判断 |
|------|------|----------|---------|
| CTCL 迁移 | `docs/superpowers/plans/2026-05-16-tool-input-repair-cch-strip-schema-gate.md` | 被管线架构吸收 | 不重复执行 |
| 开源策略 | `docs/superpowers/specs/2026-05-16-rivet-open-source-harness-strategy-design.md` | 设计完成 | R1 继续产品化 |
| Multi-pass Repair | `docs/superpowers/plans/2026-05-16-multi-pass-repair-pipeline.md` | 已验证 | 作为 open-source proof point |

## R1 交付物

1. Open-source boundary：说明开源层、服务层、隐私边界。
2. Repository readiness：说明仓库发布前必须具备的文档和安全闸门。
3. Capability matrix design：说明如何用 benchmark 证明 harness 工程提升 open model coding 能力。
4. Contributor path：说明外部贡献者如何新增 repair rule、provider、model profile、benchmark artifact。
5. Ledger update：让 capability ledger 表达真实分层状态。

## R1 非目标

- 不新增 hosted service runtime。
- 不改 prompt/cache/prewarm 关键路径。
- 不把本地 `.wolf` 工作流包装成公共 API。
- 不把 benchmark 结果伪装成已运行数据；R1 只定义格式和流程。

## 验收标准

- R1 四份设计文档存在，并互相引用。
- README 中有外部用户能读懂的开源定位入口。
- capability ledger 不再把 CTCL foundation 与 open-source productization 混成同一个状态。
- 文档明确写出 cache-sensitive files 不在 R1 变更范围。
- `npm run typecheck` 和 `npm test` 仍通过。
```

- [ ] **步骤 3：验证关键章节存在**

运行：

```bash
grep -n "^## 定位\|^## 分层关系\|^## R1 交付物\|^## 验收标准" docs/superpowers/specs/2026-05-16-rivet-open-source-r1-design.md
```

预期：输出 4 行，分别命中四个二级标题。

- [ ] **步骤 4：Commit**

```bash
git add docs/superpowers/specs/2026-05-16-rivet-open-source-r1-design.md
git commit -m "docs: define open source productization R1"
```

---

### 任务 2：创建开源/服务边界文档

**文件：**
- 创建：`docs/superpowers/specs/2026-05-16-rivet-open-source-boundary.md`

- [ ] **步骤 1：验证文档尚不存在**

运行：

```bash
test ! -f docs/superpowers/specs/2026-05-16-rivet-open-source-boundary.md
```

预期：PASS。若文件已存在，合并现有内容。

- [ ] **步骤 2：创建边界文档**

写入：

```markdown
# Rivet Open Source Boundary

## 目标

定义 Rivet 开源层、未来服务层和隐私边界，避免开源发布后出现“哪些能力免费、哪些能力依赖服务、哪些数据会离开本机”的误解。

## 开源层

| 能力 | 路径 | 边界 |
|------|------|------|
| Terminal TUI | `src/tui/*` | 本地运行，展示 agent 状态、工具结果、cockpit 面板 |
| Agent Loop | `src/agent/loop.ts` | 本地 orchestrator，执行工具、记录 trajectory、接入 repair pipeline |
| Tool Registry | `src/tools/*` | 本地工具执行，不依赖 hosted service |
| Multi-pass Repair | `src/agent/repair-pipeline.ts`, `src/agent/repair-passes.ts` | 基础 repair 规则开源，规则行为可测试 |
| Schema Gate | `src/api/client.ts` | 流式 tool_use 完整性校验在本地执行 |
| Sub-agent Coordination | `src/agent/coordinator.ts`, `src/agent/worker-session.ts` | 本地 worker orchestration |
| Cockpit Observability | `src/tui/cockpit/*` | 本地可观测 UI |
| Cache Safety Foundation | `src/prompt/*`, `src/agent/prewarm*`, `src/context/*` | 本地 prefix-cache 友好架构，R1 不改语义 |

## 未来服务层

| 能力 | 价值 | 客户端降级行为 |
|------|------|----------------|
| Model capability profile feed | 根据持续 benchmark 更新模型卡 | 无服务时使用本地静态 model cards |
| Provider cache behavior profile | 给不同 provider 推荐 cache-safe 设置 | 无服务时使用本地 fingerprint 检查 |
| Advanced routing policy | 基于真实任务结果调整模型路由 | 无服务时使用本地 TaskInferrer |
| Repair rule update feed | 分发模型特化 repair 规则 | 无服务时使用内置 repair passes |
| Enterprise telemetry dashboard | 团队级可靠性与成本分析 | 默认关闭，不影响本地 agent |

## 隐私边界

- 默认不上传源代码。
- 默认不上传 prompt 内容。
- 默认不上传 tool result 原文。
- benchmark artifact 只允许显式导出。
- hosted service 接入必须通过配置显式开启。
- 企业部署必须支持自托管或完全离线模式。

## R1 判定

R1 只设计边界，不实现 hosted service。任何服务层代码应在 R2 计划中单独设计，并要求隐私审查。
```

- [ ] **步骤 3：验证边界表存在**

运行：

```bash
grep -n "^## 开源层\|^## 未来服务层\|^## 隐私边界" docs/superpowers/specs/2026-05-16-rivet-open-source-boundary.md
```

预期：输出 3 行。

- [ ] **步骤 4：验证缓存关键路径没有变更**

运行：

```bash
git diff --name-only -- src/prompt src/context src/compact src/agent/prewarm.ts src/agent/prewarm-file.ts
```

预期：无输出。

- [ ] **步骤 5：Commit**

```bash
git add docs/superpowers/specs/2026-05-16-rivet-open-source-boundary.md
git commit -m "docs: define open source and service boundaries"
```

---

### 任务 3：创建 open model capability matrix 设计

**文件：**
- 创建：`docs/superpowers/specs/2026-05-16-rivet-open-model-capability-matrix-design.md`

- [ ] **步骤 1：验证文档尚不存在**

运行：

```bash
test ! -f docs/superpowers/specs/2026-05-16-rivet-open-model-capability-matrix-design.md
```

预期：PASS。若文件已存在，合并现有内容。

- [ ] **步骤 2：创建 capability matrix 设计文档**

写入：

```markdown
# Rivet Open Model Capability Matrix Design

## 目标

用公开、可复现的 benchmark artifact 说明 harness 工程如何提升 open model coding agent 能力。R1 定义 schema 和报告格式，不声称已有 benchmark 排名。

## Matrix 维度

| 维度 | 指标 | 数据来源 | 解释 |
|------|------|----------|------|
| Tool correctness | valid_tool_use_rate | tool execution trace | 工具名、required 字段、schema 类型是否正确 |
| Repair recovery | repair_success_rate | repair telemetry | repair pipeline 是否把失败输入修复为可执行输入 |
| Edit success | changed_file_verified_rate | evidence tracker | 修改文件后是否有相关验证 |
| Long-session stability | compact_resume_success_rate | context ledger + session metadata | compact/resume 后是否保持任务连续性 |
| Cache friendliness | prefix_drift_rate | prompt fingerprint | system/tools/stable volatile 是否稳定 |
| Cost/latency | median_turn_latency_ms, estimated_cost | provider telemetry | 响应速度与成本 |
| Sub-agent reliability | worker_verified_rate | worker evidence gate | worker 结果是否带验证证据 |

## Artifact JSON

```json
{
  "schemaVersion": 1,
  "rivetVersion": "0.1.0",
  "model": "deepseek-v4",
  "provider": "deepseek",
  "taskSuite": "r1-local-coding-smoke",
  "runStartedAt": "2026-05-16T00:00:00.000Z",
  "metrics": {
    "validToolUseRate": 1,
    "repairSuccessRate": 0.92,
    "changedFileVerifiedRate": 0.88,
    "compactResumeSuccessRate": 1,
    "prefixDriftRate": 0,
    "medianTurnLatencyMs": 1200,
    "workerVerifiedRate": 0.95
  },
  "evidence": {
    "typecheck": "passed",
    "tests": "passed",
    "testCount": 705
  }
}
```

## Markdown 报告格式

| Model | Provider | Tool correctness | Repair recovery | Edit verified | Cache drift | Notes |
|-------|----------|------------------|-----------------|---------------|-------------|-------|
| deepseek-v4 | deepseek | from artifact | from artifact | from artifact | from artifact | Generated from local benchmark artifact |

## R1 判定

R1 完成 schema 与报告格式。实际 benchmark runner 属于 R2，因为它会引入任务集、数据存储和报告生成代码。
```

- [ ] **步骤 3：验证 schema 字段可被搜索到**

运行：

```bash
grep -n "validToolUseRate\|repairSuccessRate\|prefixDriftRate\|workerVerifiedRate" docs/superpowers/specs/2026-05-16-rivet-open-model-capability-matrix-design.md
```

预期：输出包含 4 个字段名。

- [ ] **步骤 4：Commit**

```bash
git add docs/superpowers/specs/2026-05-16-rivet-open-model-capability-matrix-design.md
git commit -m "docs: design open model capability matrix"
```

---

### 任务 4：创建仓库就绪设计文档

**文件：**
- 创建：`docs/superpowers/specs/2026-05-16-rivet-open-source-repository-readiness.md`

- [ ] **步骤 1：验证文档尚不存在**

运行：

```bash
test ! -f docs/superpowers/specs/2026-05-16-rivet-open-source-repository-readiness.md
```

预期：PASS。若文件已存在，合并现有内容。

- [ ] **步骤 2：创建 repository readiness 文档**

写入：

```markdown
# Rivet Open Source Repository Readiness

## 目标

定义 Rivet 开源发布前的仓库文件、安全扫描、包元数据、贡献入口和发布闸门。R1 只设计这些要求，不发布远端仓库。

## 必需仓库文件

| 文件 | 目的 | R1 内容要求 |
|------|------|-------------|
| `LICENSE` | 明确授权 | 与 `package.json` license 保持一致 |
| `CONTRIBUTING.md` | 指导贡献 | 包含测试命令、cache-sensitive 变更规则、文档更新规则 |
| `SECURITY.md` | 漏洞报告 | 说明不要公开提交 secrets，并要求发布前配置私下漏洞报告渠道 |
| `CODE_OF_CONDUCT.md` | 社区行为准则 | 使用 Contributor Covenant 或项目自定义简版 |
| `.github/ISSUE_TEMPLATE/bug_report.md` | bug 报告 | 要求环境、复现步骤、期望行为、日志片段 |
| `.github/ISSUE_TEMPLATE/feature_request.md` | 功能请求 | 要求目标用户、任务场景、成功标准 |
| `.github/pull_request_template.md` | PR 审查 | 要求测试结果、cache-sensitive 文件声明、截图或日志证据 |

## 包元数据检查

R1 不修改 `package.json` 的远端 URL。开源发布前必须先确定真实 GitHub organization，然后在独立 release 计划中替换当前示例仓库元数据。

当前 release blocker：

```text
package.json homepage uses github.com/user/rivet
package.json repository.url uses github.com/user/rivet.git
package.json bugs.url uses github.com/user/rivet/issues
```

发布前验收标准：上述三项全部指向已确认的真实公开仓库。

## 发布前安全闸门

运行：

```bash
npm run typecheck
npm test
git diff --name-only -- src/prompt src/context src/compact src/agent/prewarm.ts src/agent/prewarm-file.ts
```

预期：typecheck 通过，测试通过，cache-sensitive diff 为空或有明确审查说明。

## Secret 扫描规则

发布前必须扫描以下模式：

- `sk-` 风格 API key。
- `AKIA` 风格 access key。
- 私有内网 URL。
- 个人绝对路径出现在 public docs 中。
- `.env`、credential、token 文件。

## `.wolf` 与内部记录边界

`.wolf` 是本地工程记忆与自动日志。开源发布前必须决定保留或剥离策略：

| 路径 | 建议 | 理由 |
|------|------|------|
| `.wolf/anatomy.md` | 不进入公开 release 分支 | 自动生成，包含本地扫描信息 |
| `.wolf/memory.md` | 不进入公开 release 分支 | 会混入会话历史 |
| `.wolf/buglog.json` | 仅保留脱敏摘要 | 可能包含内部修复细节 |
| docs/superpowers | 可保留精选文档 | 展示设计过程和能力路线 |

## R1 判定

R1 完成 readiness 设计。实际创建 public-facing 仓库模板文件属于单独执行计划。
```

- [ ] **步骤 3：验证 readiness 关键区块存在**

运行：

```bash
grep -n "^## 必需仓库文件\|^## 发布前安全闸门\|^## `.wolf` 与内部记录边界" docs/superpowers/specs/2026-05-16-rivet-open-source-repository-readiness.md
```

预期：输出 3 行。

- [ ] **步骤 4：Commit**

```bash
git add docs/superpowers/specs/2026-05-16-rivet-open-source-repository-readiness.md
git commit -m "docs: define open source repository readiness"
```

---

### 任务 5：更新 README 与 CHANGELOG 的 R1 状态入口

**文件：**
- 修改：`README.md`
- 修改：`CHANGELOG.md`

- [ ] **步骤 1：确认 README 当前状态入口**

运行：

```bash
grep -n "^## Status" README.md
```

预期：输出 README 的 Status 标题行。

- [ ] **步骤 2：在 README Status 后增加 R1 开源定位段落**

在 `README.md` 的 `## Status` 段落下追加：

```markdown

### Open Source R1 Direction

Rivet's CTCL-inspired repair foundation is implemented through the Multi-pass Repair Pipeline. R1 open-source work focuses on productization rather than rewriting the harness core: public positioning, repository readiness, contribution paths, open/service boundaries, and an open model capability matrix design.

R1 intentionally avoids changes to cache-sensitive prompt and prewarm paths. The current cache safety contract remains anchored in `src/prompt/*`, `src/context/*`, `src/compact/*`, and `src/agent/prewarm*`.
```

- [ ] **步骤 3：在 CHANGELOG 顶部增加 R1 文档记录**

在 `CHANGELOG.md` 顶部第一个版本段落前追加：

```markdown
## 2026-05-16 — Open Source Productization R1 Design

- Added R1 design docs for open-source productization: boundary, capability matrix, and repository readiness.
- Clarified that CTCL migration is represented by the verified Multi-pass Repair Pipeline foundation.
- Kept R1 scoped to documentation and release design; no prompt/cache/prewarm runtime paths changed.
```

- [ ] **步骤 4：验证 README/CHANGELOG 引用存在**

运行：

```bash
grep -n "Open Source R1 Direction\|Open Source Productization R1 Design" README.md CHANGELOG.md
```

预期：输出 README 与 CHANGELOG 各至少 1 行。

- [ ] **步骤 5：Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: add open source R1 status entrypoints"
```

---

### 任务 6：更新 capability ledger 状态分层

**文件：**
- 修改：`docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md`

- [ ] **步骤 1：确认现有 Open Source 行**

运行：

```bash
grep -n "Open Source Harness Strategy" docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md
```

预期：输出现有单行，状态为 `Designed`。

- [ ] **步骤 2：替换为分层状态**

将现有 `Open Source Harness Strategy` 行替换为两行：

```markdown
| Open Source Harness Strategy | **Designed** | `specs/...-open-source-harness-strategy-design.md` | `plans/...-open-source-productization-r1.md` | Strategy docs | CTCL foundation completed via verified Multi-pass Repair Pipeline; R1 productization docs planned | Hosted service not designed as runtime code | Execute R1 productization docs |
| Open Source Productization R1 | **Planned** | `specs/...-open-source-r1-design.md`, `specs/...-open-source-boundary.md`, `specs/...-open-model-capability-matrix-design.md`, `specs/...-open-source-repository-readiness.md` | `plans/...-open-source-productization-r1.md` | Docs only | R1 defines repository readiness, open/service boundary, capability matrix, and release gates | Public repository templates not created yet | Create public-facing repo docs |
```

- [ ] **步骤 3：更新 summary 计数**

在当前 capability ledger 中保留 `CTCL Migration (Tool Input Repair)` 与 `Open Source Harness Strategy` 两条 Designed 能力，并新增 `Open Source Productization R1` Planned 能力。因此 summary 调整为：

```markdown
- **Planned**: 1 capability (Open Source Productization R1)
- **Designed**: 2 capabilities (CTCL Migration historical plan, Open Source Harness Strategy)
```

- [ ] **步骤 4：验证 ledger 分层可搜索**

运行：

```bash
grep -n "Open Source Harness Strategy\|Open Source Productization R1" docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md
```

预期：输出两条能力行。

- [ ] **步骤 5：Commit**

```bash
git add docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md
git commit -m "docs: split open source strategy and R1 productization status"
```

---

### 任务 7：最终验证与缓存边界检查

**文件：**
- 检查：`docs/superpowers/specs/2026-05-16-rivet-open-source-r1-design.md`
- 检查：`docs/superpowers/specs/2026-05-16-rivet-open-source-boundary.md`
- 检查：`docs/superpowers/specs/2026-05-16-rivet-open-model-capability-matrix-design.md`
- 检查：`docs/superpowers/specs/2026-05-16-rivet-open-source-repository-readiness.md`
- 检查：`README.md`
- 检查：`CHANGELOG.md`
- 检查：`docs/superpowers/status/2026-05-16-rivet-core-capability-ledger.md`

- [ ] **步骤 1：验证四份 R1 spec 文件存在**

运行：

```bash
test -f docs/superpowers/specs/2026-05-16-rivet-open-source-r1-design.md
test -f docs/superpowers/specs/2026-05-16-rivet-open-source-boundary.md
test -f docs/superpowers/specs/2026-05-16-rivet-open-model-capability-matrix-design.md
test -f docs/superpowers/specs/2026-05-16-rivet-open-source-repository-readiness.md
```

预期：四条命令均 PASS。

- [ ] **步骤 2：验证 cache-sensitive 路径无变更**

运行：

```bash
git diff --name-only -- src/prompt src/context src/compact src/agent/prewarm.ts src/agent/prewarm-file.ts
```

预期：无输出。

- [ ] **步骤 3：运行项目验证**

运行：

```bash
npm run typecheck
npm test
```

预期：typecheck 通过，测试通过。

- [ ] **步骤 4：检查文档互链**

运行：

```bash
grep -R "2026-05-16-rivet-open-source-r1-design\|2026-05-16-rivet-open-source-boundary\|2026-05-16-rivet-open-model-capability-matrix-design\|2026-05-16-rivet-open-source-repository-readiness" docs/superpowers README.md CHANGELOG.md
```

预期：每个 R1 spec 文件名至少出现 1 次。

- [ ] **步骤 5：最终 commit**

如果步骤 1-4 发现遗漏，修正文档并提交：

```bash
git add docs/superpowers README.md CHANGELOG.md
git commit -m "docs: verify open source R1 documentation set"
```

如果没有变更，不创建空提交。

---

## 自检结果

1. **规格覆盖度：** R1 剩余工作已覆盖：开源/服务边界、仓库就绪、能力矩阵、README/CHANGELOG 入口、capability ledger 分层。
2. **占位符扫描：** 本计划所有任务均包含精确文件路径、命令、预期结果和可写入的 Markdown 内容。
3. **类型一致性：** 文档名在文件结构、任务步骤和验证命令中保持一致：`open-source-r1-design`、`open-source-boundary`、`open-model-capability-matrix-design`、`open-source-repository-readiness`。
4. **缓存边界：** R1 明确不修改 `src/prompt`、`src/context`、`src/compact`、`src/agent/prewarm*`，并在任务 2 与任务 7 中提供验证命令。
