# 天枢授权服务器 (license-server)

桌面端在线激活的签发端。Ed25519 签名 license token,激活码存 D1。

> ⚠️ **不进入开源仓库**。`sync-to-public.sh` 是顶层白名单,不含本目录;私钥只放 Worker secret,绝不进客户端。

## 架构

- **Cloudflare Workers + D1**(无状态签发,边缘部署)
- Ed25519 私钥仅在 Worker 内签名;公钥硬编码进桌面端 Rust 验签器
- Token 格式(与 Rust 验签器共享契约,见 `src/token.ts`):

  ```
  token = base64url(JSON(payload)) + "." + base64url(ed25519_sig)
  ```

  签名对象是**第一段 base64url 字符串的 ASCII 字节**(不是原始 JSON)。payload:
  `{ product, deviceId, tier, iat, exp, lic }`

## 端点

| 方法 | 路径 | 入参 | 说明 |
|------|------|------|------|
| POST | `/activate` | `{ code, deviceId }` | 校验激活码 → 绑定设备 → 返回签名 token |
| POST | `/verify` | `{ token, deviceId }` | 吊销/有效期复检 + 续签(心跳) |
| GET | `/health` | — | 健康检查 |

`/activate` 对已绑定设备幂等(重复激活返回新 token,不占额度)。`/verify` 每次续签一个新 token(滚动 TTL),供客户端心跳刷新;若激活码或设备被吊销 → `{ valid:false, reason:'revoked' }`。

## 部署步骤

```bash
cd license-server
npm install

# 1) 生成密钥对
npm run genkeys
#   → 把 PRIVATE(PKCS#8 base64)设为 secret
#   → 把 PUBLIC(raw 32B base64)填进 Rust 验签器 activation.rs

# 2) 建 D1 库,把返回的 database_id 填进 wrangler.toml
wrangler d1 create tianshu-licenses
npm run db:init          # 建表(远程);本地开发用 db:init:local

# 3) 设私钥 secret
wrangler secret put SIGNING_KEY_PKCS8   # 粘贴 genkeys 的 PRIVATE

# 4) 部署
npm run deploy
```

## 发放激活码

```bash
# 5 个 pro 码,每码绑 1 台设备,365 天有效
node scripts/gencode.mjs --count 5 --tier pro --devices 1 --days 365 > /tmp/codes.sql
wrangler d1 execute tianshu-licenses --file=/tmp/codes.sql
# 生成的码打印在 stderr;--days 省略即永久授权
```

## 吊销

```bash
# 吊销某激活码(所有设备失效)
wrangler d1 execute tianshu-licenses --command \
  "UPDATE codes SET revoked=1 WHERE code='TS-XXXX-XXXX-XXXX'"
# 吊销单台设备
wrangler d1 execute tianshu-licenses --command \
  "UPDATE activations SET revoked=1 WHERE device_id='<fingerprint>'"
```

吊销在客户端下次 `/verify` 心跳时生效(受离线宽限期延迟)。

## 客户端契约要点

- 公钥(raw 32B base64)硬编码在 `desktop/src-tauri/src/activation.rs`,与 `genkeys` 输出一致
- `product` 常量三处必须一致:`wrangler.toml` `PRODUCT` / token payload / Rust 验签器
- Token TTL 由 `TOKEN_TTL_DAYS` 控制(默认 30 天);客户端离线宽限期独立(建议 7–14 天),两者叠加决定断网可用时长
