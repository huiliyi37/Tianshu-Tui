import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProxyForUrl, shouldBypassProxy, parseWindowsProxyOutput, parseScutilProxy } from '../proxy-resolver.js'

describe('shouldBypassProxy', () => {
  it('returns false when NO_PROXY unset', () => {
    assert.equal(shouldBypassProxy('example.com', undefined), false)
  })

  it('bypasses all on *', () => {
    assert.equal(shouldBypassProxy('example.com', '*'), true)
  })

  it('matches exact domain (case-insensitive)', () => {
    assert.equal(shouldBypassProxy('api.deepseek.com', 'api.deepseek.com'), true)
    assert.equal(shouldBypassProxy('API.DEEPSEEK.COM', 'api.deepseek.com'), true)
  })

  it('matches .suffix for subdomains and bare domain', () => {
    assert.equal(shouldBypassProxy('docs.example.com', '.example.com'), true)
    assert.equal(shouldBypassProxy('example.com', '.example.com'), true)
  })

  it('does not match unrelated domain', () => {
    assert.equal(shouldBypassProxy('other.com', '.example.com'), false)
  })

  it('handles comma-separated list with whitespace', () => {
    assert.equal(shouldBypassProxy('a.com', 'a.com, b.com , c.com'), true)
    assert.equal(shouldBypassProxy('b.com', 'a.com, b.com , c.com'), true)
    assert.equal(shouldBypassProxy('d.com', 'a.com, b.com , c.com'), false)
  })
})

describe('resolveProxyForUrl', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const envKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']

  beforeEach(() => {
    for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('returns undefined when no proxy configured', () => {
    // noProxy:'*' 显式绕过所有层（含宿主机 OS 系统代理——开发机可能正开着
    // Clash/V2Ray，否则这个"无代理"断言会在本机误判失败）。此用例验证的是
    // env/config 层未配置时的直连意图。
    assert.equal(resolveProxyForUrl('https://example.com', { noProxy: '*' }), undefined)
  })

  it('reads HTTPS_PROXY for https URLs', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('https://example.com'), 'http://127.0.0.1:7890')
  })

  it('reads HTTP_PROXY for http URLs', () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('http://example.com'), 'http://127.0.0.1:7890')
  })

  it('falls back HTTP_PROXY for https when HTTPS_PROXY absent', () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('https://example.com'), 'http://127.0.0.1:7890')
  })

  it('is case-insensitive on env var names', () => {
    process.env.https_proxy = 'http://127.0.0.1:7890'
    assert.equal(resolveProxyForUrl('https://example.com'), 'http://127.0.0.1:7890')
  })

  it('config proxyUrl takes precedence over env', () => {
    process.env.HTTPS_PROXY = 'http://env:7890'
    assert.equal(
      resolveProxyForUrl('https://example.com', { proxyUrl: 'http://config:1080' }),
      'http://config:1080',
    )
  })

  it('config noProxy bypasses even with proxy set', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    assert.equal(
      resolveProxyForUrl('https://localhost:3000', { noProxy: 'localhost' }),
      undefined,
    )
  })

  it('env NO_PROXY bypasses', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    process.env.NO_PROXY = '.internal.example.com'
    assert.equal(
      resolveProxyForUrl('https://api.internal.example.com'),
      undefined,
    )
  })

  it('returns undefined for invalid URL', () => {
    assert.equal(resolveProxyForUrl('not-a-url'), undefined)
  })

  it('returns undefined for non-http protocols when no OS proxy', () => {
    // ftp 等非 http 协议无专属 env 分支，仅回退到 OS 系统代理。
    // noProxy:'*' 隔离宿主状态（开发机 macOS 可能正开着系统代理）。
    assert.equal(resolveProxyForUrl('ftp://example.com', { noProxy: '*' }), undefined)
  })
})

/**
 * parseWindowsProxyOutput 纯函数测试——readWindowsSystemProxy 的判定核心。
 * 回归保护：历史上两个 bug——
 *   bug 1（顺序）：先读 ProxyServer 就 return，导致 ProxyEnable=0（代理禁用）时
 *                 仍返回残留的代理地址。Windows 关代理只翻 ProxyEnable 不清
 *                 ProxyServer，所以这个顺序必须反过来。
 *   bug 2（规范化）：裸 host:port 缺 http:// 前缀，new ProxyAgent 报 Invalid URL。
 */
describe('parseWindowsProxyOutput', () => {
  it('ProxyEnable=1 + ProxyServer 有值 → 返回规范化后的代理', () => {
    const enable = '    ProxyEnable    REG_DWORD    0x1'
    const server = '    ProxyServer    REG_SZ    127.0.0.1:7890'
    assert.equal(parseWindowsProxyOutput(enable, server), 'http://127.0.0.1:7890')
  })

  it('ProxyEnable=0（代理禁用）+ ProxyServer 残留 → 返回 undefined（bug 1 回归保护）', () => {
    const enable = '    ProxyEnable    REG_DWORD    0x0'
    const server = '    ProxyServer    REG_SZ    127.0.0.1:10808'
    // 修复前：先读 ProxyServer 直接 return 'http://127.0.0.1:10808'，无视 ProxyEnable=0
    assert.equal(parseWindowsProxyOutput(enable, server), undefined)
  })

  it('ProxyEnable 非 0x1（如空输出/键不存在）→ 返回 undefined', () => {
    assert.equal(parseWindowsProxyOutput('', '    ProxyServer    REG_SZ    127.0.0.1:7890'), undefined)
    assert.equal(parseWindowsProxyOutput('    ProxyEnable    REG_DWORD    0x1', ''), undefined)
  })

  it('裸 host:port 被 normalizeProxyUrl 加 http:// 前缀（bug 2 回归保护）', () => {
    const enable = '    ProxyEnable    REG_DWORD    0x1'
    const server = '    ProxyServer    REG_SZ    127.0.0.1:10808'
    // 修复前：直接返回 '127.0.0.1:10808'，new ProxyAgent 报 Invalid URL
    assert.equal(parseWindowsProxyOutput(enable, server), 'http://127.0.0.1:10808')
  })

  it('已带 http:// 前缀的 ProxyServer 原样返回', () => {
    const enable = '    ProxyEnable    REG_DWORD    0x1'
    const server = '    ProxyServer    REG_SZ    http://10.0.0.1:8080'
    assert.equal(parseWindowsProxyOutput(enable, server), 'http://10.0.0.1:8080')
  })

  it('多协议格式 http=a;https=b 优先取 https', () => {
    const enable = '    ProxyEnable    REG_DWORD    0x1'
    const server = '    ProxyServer    REG_SZ    http=127.0.0.1:80;https=127.0.0.1:443'
    assert.equal(parseWindowsProxyOutput(enable, server), 'http://127.0.0.1:443')
  })
})

/**
 * parseScutilProxy 纯函数测试——readMacosSystemProxy 的判定核心。
 * Fixture 取自真实 `scutil --proxy` 输出（macOS 系统代理开启，Clash 7890）。
 * 与 parseWindowsProxyOutput 同构：抽成纯函数避免 mock child_process。
 */
describe('parseScutilProxy', () => {
  // 真实输出（macOS，HTTP+HTTPS 均启用，Clash 7890）
  const REAL_OUTPUT = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}`

  it('HTTP+HTTPS 均启用 → 优先返回 HTTPS 代理（与 normalizeProxyUrl 语义一致）', () => {
    assert.equal(parseScutilProxy(REAL_OUTPUT), 'http://127.0.0.1:7890')
  })

  it('仅 HTTP 启用（HTTPSEnable=0）→ 回退 HTTP 代理', () => {
    const out = REAL_OUTPUT.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')
    assert.equal(parseScutilProxy(out), 'http://127.0.0.1:7890')
  })

  it('HTTPS 启用但 HTTP 禁用 → 返回 HTTPS 代理', () => {
    const out = REAL_OUTPUT.replace('HTTPEnable : 1', 'HTTPEnable : 0')
    assert.equal(parseScutilProxy(out), 'http://127.0.0.1:7890')
  })

  it('两者均禁用 → undefined', () => {
    const out = REAL_OUTPUT
      .replace('HTTPEnable : 1', 'HTTPEnable : 0')
      .replace('HTTPSEnable : 1', 'HTTPSEnable : 0')
    assert.equal(parseScutilProxy(out), undefined)
  })

  it('启用但缺 host/port → undefined（配置不完整）', () => {
    const out = `<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : 7890
}`
    // HTTPSProxy 字段缺失 —— 不能返回 http://undefined:7890
    assert.equal(parseScutilProxy(out), undefined)
  })

  it('空输出 / scutil 失败 → undefined', () => {
    assert.equal(parseScutilProxy(''), undefined)
    assert.equal(parseScutilProxy('Proxy Configuration is not enabled'), undefined)
  })

  it('PAC 启用但 HTTP/HTTPS 代理禁用 → 不处理 PAC，返回 undefined', () => {
    // ProxyAutoConfigEnable=1 时我们不解析 PAC JS —— 用户应自行设 HTTPS_PROXY
    const out = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1/proxy.pac
}`
    assert.equal(parseScutilProxy(out), undefined)
  })

  it('host 是非环回地址（如公司代理 10.0.0.1）也能正确解析', () => {
    const out = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 1
  HTTPSPort : 8080
  HTTPSProxy : 10.0.0.1
}`
    assert.equal(parseScutilProxy(out), 'http://10.0.0.1:8080')
  })
})
