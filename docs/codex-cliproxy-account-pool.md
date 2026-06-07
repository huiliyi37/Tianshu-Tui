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

## 3.5 账号池更新记录（2026-06-07）

### 变更摘要

| 项目 | 旧值 | 新值 |
|------|------|------|
| 账号数量 | 9（5 可用 / 2 配额耗尽 / 2 死） | 1000（全部 team 计划） |
| 来源 | 手动收集 | 1000TEAM-sub2api-20260607.json（微信传输） |
| plan_type | free × 4 + plus × 3 + dead × 2 | team × 1000 |
| token 过期 | ~2026-06-16 | ~2026-06-13（JWT exp ≈ 10 天） |

### 新账号文件格式（cliproxy 兼容）

来源 JSON 格式（1000TEAM-sub2api）→ 转换为 cliproxy 格式：

```json
{
  "access_token": "eyJ...",
  "account_id": "a4e523ff-bf2f-4212-ba8d-f1028c79e07a",
  "disabled": false,
  "email": "xxx@edu.aiceo.dev",
  "expired": "2026-06-13T06:00:00+08:00",
  "id_token": "eyJ...",
  "last_refresh": "2026-06-07T...",
  "refresh_token": "rt.1.AAD...",
  "type": "codex"
}
```

文件名规则：`codex-{email}-team.json`

### 备份与恢复

**旧账号备份位置**：`~/.cli-proxy-api/backup-original-9-20260607/`

```
backup-original-9-20260607/
├── _manifest.json                              ← 标注文件（备份时间 + 9 个账号摘要）
├── codex-AlleneYundteq@outlook.com-plus.json   ← dead (refresh_token_reused)
├── codex-TobinJacobsubshw@outlook.com-plus.json← dead (refresh_token_reused)
├── codex-bromfieldplacido@gmail.com-free.json  ← 可用
├── codex-echo17years@163.com-free.json         ← 可用
├── codex-fatinhanogueira396@gmail.com-plus.json← 配额耗尽
├── codex-gilsonallosia@gmail.com-plus.json     ← 配额耗尽
├── codex-yishines@163.com-free.json            ← 可用
├── codex-yiyum037@163.com-free.json            ← 可用
└── codex-yuese096@163.com-free.json            ← 可用
```

**恢复旧账号**（如果 1000 个 team 账号全部失效）：

```bash
# 1. 备份当前 team 池（可选）
mkdir -p ~/.cli-proxy-api/backup-team-1000
cp ~/.cli-proxy-api/codex-*.json ~/.cli-proxy-api/backup-team-1000/

# 2. 恢复旧 9 账号
cp ~/.cli-proxy-api/backup-original-9-20260607/codex-*.json ~/.cli-proxy-api/

# 3. cliproxy 会在 ~10s 内热加载新文件
#    也可手动触发刷新：
/usr/bin/python3 ~/.cli-proxy-api/refresh-codex-tokens.py
```

**查看备份标注**：

```bash
python3 -c "
import json
m = json.load(open('$HOME/.cli-proxy-api/backup-original-9-20260607/_manifest.json'))
print(f\"备份时间: {m['backup_date']}\")
for a in m['accounts']:
    flag = '⛔' if a['disabled'] else '✅'
    print(f\"  {flag} {a['email']:40} expired={a.get('expired','?')}\")
"
```

### 注意事项

- **刷新脚本兼容性**：`refresh-codex-tokens.py` 处理 1000 个账号时，每轮会对每个账号发 1 次刷新 + 1 次探测。建议将 launchd 间隔从 6h 改为 12h，降低探测开销。
- **文件数量**：1000 个 `codex-*.json` 文件在目录中，`ls` 和 glob 仍可接受，但如果后续扩到 10000+ 需考虑目录性能。
- **token 过期**：新账号 JWT exp 约 10 天，需确保刷新脚本正常运行（§9）。

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

> **关键警告：`expired` 字段必须等于 access_token 的真实 JWT `exp`。**
> 如果 `expired` 写成未来时间但实际 JWT 已过期，cliproxy 会**误以为有效、不去刷新**，
> 一直发过期 token → 上游 401 → 标记 `auth unavailable` → 最终 `502 unknown provider`。
> 这是 2026-06-06 那次故障的根因。
>
> **快照（2026-06-07 更新）：1000 个 team 账号，全部来自 1000TEAM-sub2api 池。**
> - 旧 9 账号已备份至 `~/.cli-proxy-api/backup-original-9-20260607/`，详见 §3.5。
> - 新账号文件名格式：`codex-{email}-team.json`，全部 `disabled=false`。
> - token 约 **2026-06-13** 到期 → 刷新脚本 §9 必须正常运行。
>
> **历史快照（2026-06-06，已被替换）：**
> - 旧 9 账号：5 可用 / 2 配额耗尽 / 2 死
> - 5 可用：`bromfieldplacido / echo17years / yishines / yiyum037 / yuese096`
> - 2 配额耗尽(429 usage_limit)：`fatinhanogueira396 / gilsonallosia`，约 2026-07-06 重置
> - 2 死(refresh_token_reused)：`AlleneYundteq / TobinJacobsubshw`

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
| `502 unknown provider for model gpt-5.5` | 请求用了别名 `claude-opus-4-5`，但**账号池里没有可用账号**——cliproxy 把别名解析回真名 `gpt-5.5` 后找不到活账号。日志刷 `auth unavailable, reselected`。→ 补号见 §7.3 / §7.4 |
| `502 unknown provider for model claude-opus-4-5` | 请求里直接用了真名 `gpt-5.5`（应改用别名），或别名映射配错 |
| `400 level "max" not supported` | §5.3 的 `max → xhigh` 映射没生效（源码改动丢了 / 没编译） |
| `500 empty_stream: upstream stream closed before first payload` | **账号池耗尽在流式模式下的表现**：流式请求命中一个正在限流/掉线的账号，上游 ChatGPT 不回干净的 429、直接把 SSE 流掐断（0 payload），cliproxy 报 500。属**间歇性**——轮询转到活号即恢复，重试通常即可。`max-retry-credentials` 对这种「流级关闭」不触发自动换号。治本同样是补额度大的号。→ 见 §7.3 探活 / §7.4 补号 |

> 排障必看 cliproxy 日志：`tail -f ~/.cli-proxy-api/logs/main.log`。
> `auth unavailable, reselected` 把每个 codex 账号挨个试一遍都失败 = 池子空了。
> 单条错误详情在 `~/.cli-proxy-api/logs/error-*.log`。

### 7.3 账号失效恢复（2026-06-06 实战验证）

cliproxy 的 codex 账号会因两种原因变 `auth unavailable`：

1. **token 过期**——`access_token`(JWT) 到期。可用 `refresh_token` 刷新（见下脚本）。
2. **配额耗尽**——`429 usage_limit_reached`，cliproxy 冷却该账号。等 `resets_at`（通常约 1 个月）或换号。

诊断单个账号到底哪种（**bearer 是 `access_token`，不是 `id_token`！**）：

```bash
cd ~/.cli-proxy-api && python3 - <<'PY'
import json, urllib.request
d=json.load(open("codex-<email>.json"))   # 改成目标文件
body={"model":"gpt-5.5","instructions":"x","input":[{"type":"message","role":"user",
  "content":[{"type":"input_text","text":"hi"}]}],"stream":True,"store":False}
req=urllib.request.Request("https://chatgpt.com/backend-api/codex/responses",
  data=json.dumps(body).encode(), headers={"Content-Type":"application/json",
  "Authorization":f"Bearer {d['access_token']}","User-Agent":"codex_cli_rs/0.118.0",
  "Originator":"codex_cli_rs","Accept":"text/event-stream","chatgpt-account-id":d['account_id']})
try:
    urllib.request.urlopen(req,timeout=25); print("LIVE 有额度")
except urllib.error.HTTPError as e: print(e.code, e.read()[:200].decode())
PY
```

- `LIVE` → 有额度，只是文件里 token 过期/被禁，下面刷新+enable 即可
- `401 token_expired` → token 过期，刷新即可恢复
- `429 usage_limit_reached` → 配额耗尽，看 `resets_at`，只能等或换号
- `401 token_revoked` / refresh 报 `refresh_token_reused` → 账号死了，删除或换号

**批量刷新 + 重新启用有额度的账号**（这次把池子从 0 救回 5 个就是用它）：

```bash
cd ~/.cli-proxy-api && python3 - <<'PY'
import json, urllib.request, urllib.error, glob, datetime, base64
CLIENT_ID="app_EMoamEEZ73f0CkXaXp7hrann"; now=datetime.datetime.now().astimezone()
def claims(t):
    p=t.split(".")[1]; p+="="*(-len(p)%4); return json.loads(base64.urlsafe_b64decode(p))
for f in sorted(glob.glob("codex-*.json")):
    d=json.load(open(f))
    try:
        body=json.dumps({"client_id":CLIENT_ID,"grant_type":"refresh_token",
          "refresh_token":d["refresh_token"],"scope":"openid profile email"}).encode()
        j=json.loads(urllib.request.urlopen(urllib.request.Request(
          "https://auth.openai.com/oauth/token",data=body,
          headers={"Content-Type":"application/json"}),timeout=25).read())
    except urllib.error.HTTPError as e:
        print(f"⛔ {d['email']}: refresh 死 ({json.loads(e.read()).get('error')})"); continue
    at=j["access_token"]
    # quota probe
    q=urllib.request.Request("https://chatgpt.com/backend-api/codex/responses",
      data=json.dumps({"model":"gpt-5.5","instructions":"x","input":[{"type":"message",
      "role":"user","content":[{"type":"input_text","text":"hi"}]}],"stream":True,"store":False}).encode(),
      headers={"Content-Type":"application/json","Authorization":f"Bearer {at}",
      "User-Agent":"codex_cli_rs/0.118.0","Originator":"codex_cli_rs",
      "Accept":"text/event-stream","chatgpt-account-id":d["account_id"]})
    live=False
    try: urllib.request.urlopen(q,timeout=25); live=True
    except urllib.error.HTTPError as e: pass
    # 关键：写回字段，且 expired = access_token 真实 exp（别写未来假值！）
    d["access_token"]=at; d["id_token"]=j.get("id_token",d["id_token"])
    d["refresh_token"]=j.get("refresh_token",d["refresh_token"])   # refresh_token 会轮换
    d["expired"]=datetime.datetime.fromtimestamp(int(claims(at)["exp"])).astimezone().replace(microsecond=0).isoformat()
    d["last_refresh"]=now.replace(microsecond=0).isoformat()
    d["disabled"]=not live
    with open(f,"w") as fh: json.dump(d,fh,indent=2,ensure_ascii=False)   # 必须 in-place，见 §7.5
    print(("✅ enable " if live else "△ 无额度,禁用 ")+d["email"])
PY
```

刷完用 §7.2 验证；约 10s 内 cliproxy 会自动热加载。

### 7.4 添加新 codex 账号

往 `auth-dir` 放一个新的 `codex-<email>.json`（字段同现有文件）。cliproxy 热加载自动纳入轮换。
获取新 OAuth 凭据走 cliproxy 自己的登录流程，不在本文范围。补完用 §7.1 / §7.2 确认。

### 7.5 ⚠️ 三个踩过的大坑

1. **bearer 是 `access_token`，不是 `id_token`。** 两者都是 JWT、结构几乎一样，但
   Responses API 只认 `access_token`；拿 `id_token` 当 bearer 会 `401 could not parse`（误导性极强）。
2. **改 `codex-*.json` 必须 in-place 写（`open(f,'w')`），不能用 `os.replace()`/rename。**
   rename 会让 cliproxy 的文件监视器收到 **REMOVE** 事件 → 直接把账号**移出池子**且不重新加入。
   in-place 截断写产生 **WRITE** 事件 → 正常增量重载。
3. **cliproxy 不会按需自动刷新 codex token。** 它信任文件里的 `expired` 字段：若该字段是
   未来时间它就不刷新，哪怕真实 JWT 已过期 → 发过期 token → 401 → 池子空 → 502。
   所以刷新后 `expired` 必须写**真实 JWT exp**（§7.3 脚本已处理）。token 寿命约 10 天，
   到期需定期刷新 → **已用 launchd 定时器自动化，见 §9**。

### 7.6 改 Rivet 配置后

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

---

## 9. 自动刷新定时器（launchd，2026-06-06 实现）

token 寿命只有 ~10 天且 cliproxy 不自管（§7.5#3），所以用一个定时脚本维护账号池。

> **为什么是 launchd 而不是 crontab？** macOS 的 cron tabs 目录受 TCC 保护，修改它需要
> 「完全磁盘访问权限」，否则 `crontab` 报 `Operation not permitted`。launchd 的
> LaunchAgent 放在用户自己的 `~/Library/LaunchAgents`，无需该权限，且开机自启、重启存活，
> 是 macOS 推荐方式。

### 9.1 组成

| 文件 | 作用 |
|------|------|
| `~/.cli-proxy-api/refresh-codex-tokens.py` | 刷新脚本（独立、无三方依赖，用系统 `/usr/bin/python3`） |
| `~/Library/LaunchAgents/com.banxia.cliproxy.refresh-codex.plist` | launchd 定时器，每 6h（0/6/12/18 点）跑一次 + 加载时跑一次 |
| `~/.cli-proxy-api/logs/refresh-codex.log` | 运行日志（stdout/stderr 都进这里） |
| `~/.cli-proxy-api/.refresh-codex.lock` | flock 锁，防止两次运行重叠 |

### 9.2 脚本做什么（每个 `codex-*.json`）

1. 解析 access_token 的 JWT `exp`；距到期 < 2 天（`REFRESH_MARGIN`）或账号当前 disabled 时，
   才用 refresh_token 去 `https://auth.openai.com/oauth/token` 刷新（降低 refresh_token 轮换频率）。
2. 刷新失败（`refresh_token_reused` / `invalid_grant`）→ 标 `disabled=true`，记 `DEAD`，跳过。
3. 用（刷新后的）access_token 探测配额：向 Responses 端点发一个极小请求。
4. **in-place** 写回 access_token / id_token / 轮换后的 refresh_token / `expired`(=真实 JWT exp) /
   `last_refresh`，并按探测结果设 `disabled = not live`。

由此实现：续期临期 token、自动**重新启用**配额已重置的账号、自动**禁用**配额耗尽 / 失效的账号。
（三个关键约束——bearer 用 access_token、必须 in-place 写、expired 写真实 exp——都已内建，见 §7.5。）

> **代价提醒**：每次运行会对全部账号各发 1 个极小探测请求（含已禁用的——用于探测是否恢复）。
> 旧池 9 个账号时每轮 9 次探测，可忽略。新池 1000 个 team 账号时每轮 1000 次，建议
> 将 launchd 间隔从 6h 调至 12h（或对 disabled 账号降频探测）。
> 已死账号（`refresh_token_reused`）每轮会浪费 1 次刷新调用，无害。

### 9.3 运维命令

```bash
UID_=$(id -u)
PLIST=~/Library/LaunchAgents/com.banxia.cliproxy.refresh-codex.plist

# 查看状态（LastExitStatus 应为 0）
launchctl list com.banxia.cliproxy.refresh-codex

# 看日志
tail -f ~/.cli-proxy-api/logs/refresh-codex.log

# 手动立即跑一次（不等定时）
launchctl kickstart -k gui/$UID_/com.banxia.cliproxy.refresh-codex
#   或直接： /usr/bin/python3 ~/.cli-proxy-api/refresh-codex-tokens.py

# 改完 plist 后重新加载
launchctl bootout gui/$UID_/com.banxia.cliproxy.refresh-codex 2>/dev/null
launchctl bootstrap gui/$UID_ "$PLIST"

# 停用 / 移除
launchctl bootout gui/$UID_/com.banxia.cliproxy.refresh-codex
rm "$PLIST"
```

### 9.4 注意

- 改频率：编辑 plist 的 `StartCalendarInterval`，然后按 §9.3 重新 bootstrap。
- 脚本写 `~/.cli-proxy-api/codex-*.json`，是这些文件的**唯一**写入者（cliproxy 只自刷新 kim-*.json，
  不碰 codex），所以无写竞争；flock 仅防 launchd 运行重叠。
- 1000 个账号下刷新脚本次约 1000 次探测，建议将定时器间隔从 6h 调至 12h 降低开销。
- 这是个人本机运维脚本，不属于 Rivet 仓库构建链路；纳入文档仅为可维护与可复现。

---

## 10. 相关文档与路径速查

### 关联文档

| 文档 | 关系 |
|------|------|
| `docs/user-guide-provider-config.md` | Provider 配置用户手册。其中 `codex` 行描述的是**预设默认**（直连 ChatGPT OAuth PKCE）；本机已在 `~/.rivet/config.json` 里把 codex **改走 cliproxy**（本文 §3），属于用户覆盖，运维以本文为准。 |
| `docs/cliproxy-fork-optimization.md` | cliproxy 的 codex `fork:true` 会让每次请求产生两条 Codex 调用、**额度翻倍**。与本文 §7/§9 的「配额耗尽」直接相关——若账号掉得异常快，先查 cliproxy 配置里 codex 是否还开着 `fork`。 |
| 本文 §8 | Rivet 侧相关源码索引（factory / openai-client / manager / schema）。 |

### 全部路径速查

| 路径 | 作用 |
|------|------|
| `~/.rivet/config.json`（chmod 600） | Rivet 的 `codex` provider（指向 cliproxy）。§3 |
| `~/.cli-proxy-api/config.yaml` | cliproxy 配置（别名映射 / 路由 / payload）。§4，热加载 |
| `~/.cli-proxy-api/codex-*.json` | codex OAuth 账号池（每文件一账号）。§7。当前 1000 个 team 账号 |
| `~/.cli-proxy-api/backup-original-9-20260607/` | 旧 9 账号备份（含 `_manifest.json` 标注）。§3.5 |
| `~/.cli-proxy-api/logs/main.log` `error-*.log` | cliproxy 运行日志 / 单条错误详情。§7.2 |
| `~/.cli-proxy-api/refresh-codex-tokens.py` | 账号池自动刷新脚本。§9 |
| `~/Library/LaunchAgents/com.banxia.cliproxy.refresh-codex.plist` | launchd 定时器（每 6h）。§9 |
| `~/.cli-proxy-api/logs/refresh-codex.log` | 刷新脚本运行日志。§9 |
| `src/api/openai-client.ts` | `max → xhigh` 出站映射（commit `1e5d517`）。§5.3 |

> 维护本系统时，**本文是单一入口**；上面三处关联文档从各自角度补充，但 codex×cliproxy
> 账号池的权威说明在这里。


