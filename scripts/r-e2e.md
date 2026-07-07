# R 阶段端到端验证脚本（星域硬化）

`scripts/r-e2e.mjs` —— 针对一个真实 git 仓库启动 `rivet serve` sidecar，用**真实模型**
驱动 agent，端到端验证 R 阶段（并发安全 + 决策外显）的关键能力。

## 用法

```bash
# 1. 先构建 sidecar（脚本依赖 dist/main.js）
npm run build

# 2. 跑验证（默认目标仓库：/Users/banxia/app/deepseek-tui/cangzhe）
node scripts/r-e2e.mjs

# 或指定任意干净的 git 仓库
node scripts/r-e2e.mjs /path/to/some/git/repo
```

退出码 `0` 表示全部通过，非 `0` 表示有失败项。

## 前置条件

- `~/.rivet/config.json` 已配置可用的模型 provider + key（脚本直接复用，不另配）。
- 目标路径是一个 git 仓库，且工作区相对干净（脚本只新建/清理自己的 scratch 文件）。
- 已在 `opencode-tui` 跑过 `npm run build`，存在 `dist/main.js`。

## 验证项

| 项 | 含义 | 做法 |
|----|------|------|
| **R1** | 会话登记进 `SessionRegistry` | 建会话后查 `registry.db` 的 `sessions` 表，断言有该会话且 `role=standalone` |
| **R1'** | 终态释放 claim | 会话跑完后查 `claims` 表，断言该会话残留 claim 为 0 |
| **R3** | 回滚 preview/execute + git 还原 | 让 agent 新建一个 scratch 文件 → 预览（available + 文本含该文件）→ 执行回滚 → 断言文件被移除 |
| **R2** | 并发写冲突阻断 | 向 `registry.db` 注入「他会话」对某文件的独占 claim → 让本会话写同名文件 → 断言被 fail-closed 阻断且文件未落盘 |
| **S** | 自治档无审批闭环 | 建 `dangerously-skip-permissions` 会话写项目内文件 → 断言全程无 `approval_required` |
| **T3** | 运行中 Steer | 抓 running 窗口 `POST /steer` → 断言入队回显 `steer_queued`；idle 后再 steer → 断言 `409` |
| **T1/T2/T4** | 过程外显事件 | 扫描事件流统计 `thinking_delta`/`turn_complete`/`checkpoint`/`todo_state`/per-worker `delegation`（依赖模型行为，信息性） |
| **R4/R5** | `decision_shift` 改道事件 | 扫描事件流，统计是否出现改道事件（简单任务通常不触发，仅信息性报告，不计入成败） |

## 隔离与清理

- **状态隔离**：sidecar 的 desktop 状态（`registry.db` / sessions）写到临时目录
  （`RIVET_DESKTOP_DIR`），跑完删除，**不污染** `~/.rivet`。
- **模型配置**：仍读 `~/.rivet/config.json`，所以用的是你当前的真实 key/模型。
- **自动应答**：轮询事件时自动 `approve` 审批、`continue` 意图预览，无需人工干预。
- **仓库清理**：结尾用 rollback + `git checkout` 还原，目标仓库不留 scratch 文件。

## 上游卡顿时：临时切 provider 跑

脚本默认走 `~/.rivet/config.json` 的 `provider.default`。如果默认 provider 的上游
（例如某代理后的 `qwen3.7-max`）抽风卡在「waiting for first token」，**不用改全局配置**——
用 `RIVET_CONFIG_PATH` 指向一份临时副本，只把 `provider.default` 改成一个 key 健康的
provider（如 `deepseek` → `deepseek-v4-pro`），跑完即删：

```bash
# 1. 生成临时配置（复制全局，只改 default）
python3 -c '
import json,os
c=json.load(open(os.path.expanduser("~/.rivet/config.json")))
c["provider"]["default"]="deepseek"   # 换成任一 key=True 的 provider
json.dump(c,open("/tmp/r-deepseek-config.json","w"),indent=2)
'

# 2. 用临时配置跑（脚本用 {...process.env} 启 sidecar，会继承该变量）
RIVET_CONFIG_PATH=/tmp/r-deepseek-config.json node scripts/r-e2e.mjs

# 3. 跑完清理
rm -f /tmp/r-deepseek-config.json
```

注：`glm` 直连若未配 key（`provider setup` 没填），换它没用；优先选 `~/.rivet/config.json`
里 `apiKey`/`auth` 已就绪的 provider。判断哪个 provider 有 key 可用一行 python 扫
`config.provider.providers[*].apiKey`。

## 注意

- 用真实模型，单次运行约 1–2 分钟，会产生少量 token 消耗。
- 端口固定 `3199`，令牌每次随机；如端口被占用，改脚本顶部 `PORT` 常量。
- `decision_shift`（R4/R5）只有在 agent 真陷入停滞被星域纠偏时才发出，简单任务扫描为
  0 属正常；要专门验证它需要构造会触发 kick/收敛检测的任务。
- 脚本也覆盖 **S 阶段自治档**（创建 `dangerously-skip-permissions` 会话，断言项目内写
  全程无 `approval_required`）。
