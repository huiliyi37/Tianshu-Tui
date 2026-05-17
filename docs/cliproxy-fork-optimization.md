# Cliproxy Fork 优化：Codex 额度减半

## 问题

cliproxy 配置中 codex 账号开启了 `fork: true`，导致每次 Claude Code 请求同时产生两条 Codex API 调用，额度消耗翻倍。

### 双倍消耗路径

```
用户请求 claude-opus-4-5
  ├── 路径1: codex-claude-bridge → gpt-5.5   (Codex 额度 +1)
  └── 路径2: codex fork → gpt-5.5            (Codex 额度 +1，重复)
```

日志中同一秒出现配对请求：

```
08:23:02 codex-claude-bridge → claude-opus-4-5
08:23:02 codex-fatinhan     → gpt-5.5         ← fork 重复消耗
```

### 诊断方法

```bash
# 检查 cliproxy 主日志中的模型调用分布
grep "2026-05-17" ~/.cli-proxy-api/logs/main.log | grep -oP 'model=\S+' | sort | uniq -c | sort -rn

# 检查同一秒内的配对请求（双倍消耗的标志）
grep "HH:MM:SS" ~/.cli-proxy-api/logs/main.log | grep -E "codex-claude-bridge|codex-"
```

## 修复

将 `~/.cli-proxy-api/config.yaml` 中 codex section 的 fork 关闭：

```yaml
# 修复前
  codex:
    - name: gpt-5.5
      alias: claude-opus-4.7
      fork: true              # ← 双倍消耗
    - name: gpt-5.4-mini
      alias: claude-hiku-4
      fork: true              # ← 双倍消耗

# 修复后
  codex:
    - name: gpt-5.5
      alias: claude-opus-4-5
      fork: false             # ← 只走 bridge 单路径
    - name: gpt-5.4-mini
      alias: claude-hiku-4-5
      fork: false             # ← 只走 bridge 单路径
```

## 修复后的路径

```
用户请求 claude-opus-4-5
  └── codex-claude-bridge → gpt-5.5           (Codex 额度 +1，单路径)
```

bridge 路由已经完成了 claude→codex 的协议转换，fork 是多余的。

## Fork 机制说明

| fork 值 | 行为 |
|---------|------|
| `true` | 请求同时发给原始上游和 codex 上游，双倍额度消耗 |
| `false` | 不做 fork，请求只走 bridge 定义的路由 |

## 其他 provider 的 fork

github-copilot 和 kiro 的 fork 保持不变——它们的上游是免费/独立的，不消耗 Codex 额度。

## 注意事项

- cliproxy 支持热加载，修改 config.yaml 后自动生效，无需重启进程
- **禁止 kill/restart cliproxyapi 进程**
- 修改后可用 `curl http://127.0.0.1:8891/v1/models` 验证配置生效
