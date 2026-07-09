# 2026-07-09 — httpFetchGuarded 连接钉扎：堵死 DNS rebinding (TOCTOU) 窗口

## 背景

`aaae9751` 引入的 `net/http-fetch.ts` 已经做了协议白名单、逐跳 SSRF 校验、
流式大小限制和真实超时——能挡住静态私网域名和「重定向到内网」。但残留一个
经典 TOCTOU / DNS rebinding 窗口：

- `resolveAndAssertPublic(hostname, lookup)` 解析一次 DNS、断言 IP 为公网；
- 紧接着 `fetchImpl(currentUrl)`（undici）内部**独立再解析一次** DNS 去建连。

两次解析之间攻击者可翻转自己域名的 A 记录（TTL=0）：第一次返回公网 IP 骗过
SSRF 守卫，第二次返回 `169.254.169.254` / `127.0.0.1` / `10.x` 等内网地址完成
建连。校验通过的地址和实际连接的地址不是同一个，守卫形同虚设。

## 修复思路

把 SSRF 校验过的那个 IP **钉进连接层**：让 undici 连接到我们已校验的确切地址，
而不是重新解析主机名。TLS SNI / 证书校验仍走原 hostname（undici 的 `servername`
取 origin 主机名，不取被连接的 IP），所以 HTTPS 证书链不受影响。

Node ≥24 的全局 `fetch` 底层即 undici，且 `undici` 是直接依赖，可用
`Agent { connect: { lookup } }` 覆写解析。

## 改动

- `net/ssrf.ts`：`resolveAndAssertPublic` 返回 `{address, family}`（family 从
  lookup 取，缺失时用 `isIP` 推断 4/6），供钉扎连接指定地址族。
- `net/http-fetch.ts`：
  - 新增 `buildPinnedLookup(address, family)`——生成「无视传入 hostname、永远
    返回已校验 IP」的 DNS lookup，并二次断言非私网（纵深防御，防钉扎值被篡改）。
    导出以便无 socket 单测。支持 undici 的单地址与 `{all:true}` 数组两种回调形态。
  - `createPinnedDispatcher` 用 undici `Agent` 承载该 lookup。
  - 重构 fetch 循环：每跳单独校验 + 单独 dispatcher；重定向跳先 `body.cancel()`
    再 `destroy()` 释放连接；终端响应的 dispatcher 保活到流式 body 读完，在外层
    `finally` 里 destroy（避免读 body 时连接被提前销毁）。
  - 删除循环外冗余的 pre-flight 解析（循环首跳已覆盖，避免同主机双解析）。
  - 门控 `pin = isConnectionPinningEnabled() && !deps.fetch`：仅真实 undici 网络
    路径生效；注入 fetch（测试 / 非 undici 传输）自动跳过。env 开关
    `RIVET_FETCH_PIN=0` / `false` 可禁用。
- `web-fetch/tool.ts`：`defaultDeps` 去掉显式 `globalThis.fetch.bind()`，留空让
  `httpFetchGuarded` 用真实 global fetch 并启用钉扎——否则显式注入 fetch 会关掉
  pinning。`import_resource` 本就传 `undefined` deps，自动受益。

## 测试

- `http-fetch.test.ts` 新增 `buildPinnedLookup` 三例：钉扎 IP 无视 hostname、
  `{all:true}` 数组形态、私网地址触发 `SSRFError`（纵深防御）。既有注入 fetch 的
  用例因 `!deps.fetch` 门控关闭 pinning，行为不变、全部保留。
- `ssrf.test.ts` 新增 family 传递 / 推断两例。
- net 21/21、web-fetch+import-resource 42/42、typecheck、lint 全绿。

## 取舍

- 门控用 `!deps.fetch` 而非单一 env：pinning 只对 undici 真实路径有意义，mock
  fetch 会忽略 `dispatcher`。代价是删掉 `defaultDeps.fetch` 的显式 bind（语义等价，
  http-fetch 本就默认 global fetch）。
- 多 A 记录轮询时 `dns.lookup` 默认只取一条，钉扎的就是校验的那条——这正是想要的
  行为；单请求内不会自动切换 IP（重定向跳会重新解析）。安全优先的合理取舍。
