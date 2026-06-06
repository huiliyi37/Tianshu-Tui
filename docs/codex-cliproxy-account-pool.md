# Codex (GPT-5.5) × cliproxy 账号池 — 配置与维护

> 运维文档。记录 Rivet 的 `codex` provider 如何经由本地 **cliproxy** 使用一组 ChatGPT
> OAuth 账号池来跑 GPT-5.5，以及日常维护、排障、踩坑点。
>
> 最后核对：2026-06-06。

---

## 1. 架构总览

```
Rivet (codex provider, OpenAI 协议)
   │  POST http://127.0.0.1:8891/v1/chat/completions   model=claude-opus-4-5
   │  Authorization: Bearer <cliproxy 本地 key>
   ▼
cliproxy (cliproxyapi, :8891)
   │  oauth-model-alias.codex:  gpt-5.5  →  claude-opus-4-5
   │  从 auth-dir 的 codex-*.json 账号池里挑一个「活」账号（round-robin + 冷却 + 自动刷新）
   │  注入该账号的 OAuth 凭据，socks5://127.0.0.1:7890 出网
   ▼
ChatGPT 后端 (codex Responses)  → 真正的 GPT-5.5
```

要点：

- **真正的账号池在 cliproxy，不在 Rivet。** cliproxy 持有多个 codex OAuth 账号并自动轮换 /
  刷新 / 冷却。Rivet 只是一个普通的 OpenAI 协议客户端，拿本地 key 调 cliproxy。
- Rivet 侧**不再**直连 `chatgpt.com`，也不再用任何 OAuth token 文件。早期那条直连
  oauth 链路（`~/.rivet/auth/codex.json`）已废弃，见 §6。

---

## 2. 关键文件与位置

| 用途 | 路径 |
|------|------|
| cliproxy 进程 | `~/bin/cliproxyapi -config ~/.cli-proxy-api/config.yaml`（监听 `:8891`） |
| cliproxy 配置 | `~/.cli-proxy-api/config.yaml`（**支持热加载**，改完自动生效） |
| codex 账号池 | `~/.cli-proxy-api/codex-*.json`（每个文件一个 OAuth 账号） |
| Rivet 用户配置 | `~/.rivet/config.json`（**权限 600**，含明文 key；非源码 `default.ts`） |
| effort 映射源码 | `src/api/openai-client.ts`（`max → xhigh`，见 §5.3） |

---

## 3. Rivet 侧配置（`~/.rivet/config.json` 的 `codex` 块）

```jsonc
"codex": {
  "name": "codex",
  "apiKey": "<cliproxy 本地 key，与 cliproxy provider 同一个>",
  "auth": null,                       // 关键：删掉继承自预设的 oauth 块，见 §5.1
  "baseUrl": "http://127.0.0.1:8891/v1",
  "protocol": "openai",
  "capabilities": {
    "cacheControl": false,
    "stripParams": ["top_k", "metadata", "service_tier", "cache_control"],
    "prefixCache": "none"
  },
  "models": [
    {
      "id": "claude-opus-4-5",        // 关键：cliproxy 用这个别名服务 gpt-5.5，见 §5.2
      "alias": "gpt-5.5",             // 界面上显示的名字
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "reasoningEffort": "max"        // Rivet 规范最高档；出站时被映射成 xhigh，见 §5.3
    }
  ],
  "thinking": "enabled",
  "maxTokens": 128000,
  "unsupported": ["stream_options"]
}
```

> 本地 key 在本文件里以明文存在（`codex` 与 `cliproxy` 两个 provider 共用同一个），
> 所以该文件应保持 **chmod 600**。

<!-- APPEND-MARKER -->

---

## 4. cliproxy 侧配置（`~/.cli-proxy-api/config.yaml`）

相关片段：

```yaml
api-keys:
  - sk-...            # 本地 key，Rivet 用它鉴权到 cliproxy
auth-dir: /Users/banxia/.cli-proxy-api   # codex-*.json 账号池所在目录

oauth-model-alias:
  codex:
    - name: gpt-5.5         # 上游真实模型
      alias: claude-opus-4-5   # 对外暴露的名字 ← Rivet 必须用这个
    - name: gpt-5.4-mini
      alias: claude-hiku-4-5

routing:
  strategy: round-robin     # 账号池轮换策略
  session-affinity: true    # 同一会话尽量黏同一账号
  session-affinity-ttl: 1h
disable-cooling: true       # 全局冷却开关
max-retry-credentials: 3    # 单次请求最多换 3 个账号重试
```

> **绝对不要 `kill` / 重启 cliproxy 进程。** 它支持配置热加载，改完 `config.yaml` 自动生效；
> 验证改动用 curl 测 API 即可（见 §7）。

---

## 5. 三个关键点（为什么这样配）

### 5.1 `"auth": null` 是必须的

Rivet `loadConfig` 从源码 `DEFAULT_CONFIG` 起步（其 codex 预设带 `auth:{type:'oauth'}`），
再把 `~/.rivet/config.json` **deepMerge** 上去。如果用户配置里只是「省略」`auth`，
deepMerge 不会删除继承来的 oauth 块 → `factory.ts` 仍判定 `auth.type==='oauth'` →
选用 `CodexClient`（直连 chatgpt.com 的 Responses 客户端，**忽略 apiKey**）→ 401 Missing API key。

deepMerge 把 **`null` 当作「删除该键」**，所以 `"auth": null` 才能真正去掉 oauth，
让 factory 落到通用 `OpenAIClient`（它会把 `apiKey` 当 Bearer 发出去）。

### 5.2 model id 必须是 `claude-opus-4-5`，不能是 `gpt-5.5`

cliproxy 通过 `oauth-model-alias.codex` 把 `gpt-5.5 → claude-opus-4-5`。
对外只认 `claude-opus-4-5`；直接请求 `gpt-5.5` 会得到
`502 unknown provider for model gpt-5.5`。Rivet 里用 `alias: "gpt-5.5"` 把界面名字显示对即可。

### 5.3 reasoningEffort：`max → xhigh` 的出站映射

两边的合法枚举不一样：

- Rivet schema（`src/config/schema.ts`）：`off | low | medium | high | max`
- cliproxy / codex：`low | medium | high | xhigh`（**没有 max**）

直接把 `max` 透传给 codex 会 `400 level "max" not supported`。解决办法**不是**给全局
枚举加 `xhigh`（那会让 auto-reasoning/vigor 给别的 provider 也发 xhigh 而报错），
而是在出请求那一层按 provider 名做映射，见 `src/api/openai-client.ts`：

```ts
// Codex (served via cliproxy) tops out at 'xhigh', not Rivet's canonical 'max'.
if (this.config.providerName === 'codex' && body.reasoning_effort === 'max') {
  body.reasoning_effort = 'xhigh'
}
```

于是配置里照常写 `"reasoningEffort": "max"`，只有 codex 的出站 body 变成 `xhigh`，
全局类型和其它 provider 不受影响。

---

## 6. 已废弃 / 不要再用

- **直连 OAuth 链路**：早期 codex provider 用 `auth:{type:oauth}` + `~/.rivet/auth/codex.json`
  直连 `https://chatgpt.com/backend-api/codex`。现已改走 cliproxy，该 token 文件 Rivet 不再读取。
- **`~/.codex/codex-pool.mjs` 的 104 账号 dump**：该 dump（全部 `@znb.kuns.edu.rs`，共享一个
  team account_id）已被服务端**全部吊销**——refresh 返回 `app_session_terminated`，
  直连 Responses 返回 `401 token_invalidated`。对 Rivet 无用。该工具的 `writeRivetAuth()`
  桥接也随直连链路一起废弃。

---

## 7. 维护手册

### 7.1 体检账号池（最常用）

```bash
cd ~/.cli-proxy-api && python3 - <<'PY'
import json, glob
for f in sorted(glob.glob('codex-*.json')):
    d=json.load(open(f))
    flag='✅' if not d.get('disabled') else '⛔'
    print(f"{flag} {d.get('email'):40} expired={d.get('expired')}")
PY
```

`disabled=True` 的账号 cliproxy 会跳过；`expired` 是该账号 token 的到期时间。

> **当前快照（2026-06-06）：9 个账号里只有 2 个是活的**
> （`fatinhanogueira396@gmail.com`、`gilsonallosia@gmail.com`），且都在
> **2026-06-12** 到期。池子很薄，到期前需补新账号，否则 codex 会失效。

### 7.2 端到端验证（不碰进程，只 curl）

```bash
cd ~/.cli-proxy-api && python3 - <<'PY'
import json, urllib.request, re
key=next(re.search(r'(sk-[\w.\-]+)', l).group(1) for l in open("config.yaml") if re.search(r'sk-[\w.\-]+', l))
body={"model":"claude-opus-4-5","messages":[{"role":"user","content":"say PONG"}],"max_tokens":20,"stream":False}
req=urllib.request.Request("http://127.0.0.1:8891/v1/chat/completions",
    data=json.dumps(body).encode(),
    headers={"Content-Type":"application/json","Authorization":f"Bearer {key}"})
try:
    r=urllib.request.urlopen(req,timeout=60); print("HTTP",r.status,"OK:",r.read()[:120].decode())
except urllib.error.HTTPError as e:
    print("HTTP",e.code,e.read()[:200].decode())
PY
```

预期 `HTTP 200`，body 里 `"model":"gpt-5.5"`。

常见非 200：

| 现象 | 含义 / 处理 |
|------|------|
| `401 Missing API key` | 本地 key 没带对，或 Rivet 侧 `auth` 没置 null（落到了 CodexClient） |
| `502 unknown provider for model gpt-5.5` | 用了 `gpt-5.5` 而非 `claude-opus-4-5` |
| `400 level "max" not supported` | §5.3 的映射没生效（源码改动丢了 / 没编译） |
| `502 unknown provider for model claude-opus-4-5` | 账号池里**没有活账号**了 → 见 §7.3 |

### 7.3 添加 / 续期 codex 账号

新增账号 = 在 `auth-dir` 放一个新的 `codex-<email>.json`（格式见现有文件：
`access_token / account_id / id_token / refresh_token / last_refresh / disabled / expired`）。
cliproxy 热加载，自动纳入轮换。具体获取新 OAuth 凭据的方式取决于 cliproxy 的登录流程，
不在本文范围。补完后用 §7.1 确认 `disabled=False`，再用 §7.2 验证。

### 7.4 改 Rivet 配置后

`~/.rivet/config.json` 改完无需重启 cliproxy；重开 Rivet 即可（它每次 `loadConfig`）。
若改了 `src/api/openai-client.ts` 之类源码，需 `npm run typecheck` 并重新构建 / 重启 Rivet。

---

## 8. 相关源码索引

- `src/api/factory.ts` — `createProviderClient`：`codex + auth.type==='oauth'` 才用 CodexClient，
  否则用 OpenAIClient（这就是 §5.1 `auth:null` 的判定点）
- `src/api/openai-client.ts` — `max → xhigh` 出站映射（§5.3）
- `src/config/manager.ts` — `loadConfig` 的 deepMerge 分层（defaults → 用户 → 项目 → session），
  `null` = 删除键
- `src/config/schema.ts` — `reasoningEffort` 枚举（`off|low|medium|high|max`）


