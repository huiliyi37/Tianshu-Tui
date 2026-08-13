/**
 * 所有测试入口都必须带挂死护栏 —— 不只走 run-node-tests.ts 的那条。
 *
 * 事故（2026-07-29）：一个 `npm run test:desktop` 进程跑满 2 天 13 小时、占着 75% CPU，
 * SIGTERM 都不吃。它的后果不止是烧一个核——被它拖慢的机器上，依赖时间窗的测试
 * （临时 git 仓变更率、watchdog 定时器、spawn tsc）成批失败，而这些失败看起来像是
 * 当前改动引入的回归。排查因此走了几小时弯路，最后要靠 `git worktree` 开干净副本
 * 逐文件隔离才归对因。
 *
 * 成因：`scripts/run-node-tests.ts` 早先已为同类事故加固过两次（`--test-timeout`
 * 挡 Node 默认的 Infinity、信号转发防子进程被 reparent 到 init），但加固只落在那一个
 * 入口上。`package.json` 的 `test:desktop`、`desktop/package.json` 与
 * `vscode-extension/package.json` 的 `test` 三处都直接 `node --test`，完整绕开。
 *
 * 所以这里不再锁"某个 runner 的参数"，而是锁**仓库里每一条 test 入口**：扫所有
 * package.json 的 scripts，凡是直接调 `node --test` 的，必须自带 `--test-timeout`
 * 与 `--test-force-exit`。新增入口时忘了带 = 这条测试红，而不是三个月后又捡到一个
 * 跑满两天的僵留进程。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_TEST_TIMEOUT_MS } from '../test-runner-flags.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 仓库内所有含 scripts 的 package.json。新增子包时在此登记。 */
const MANIFESTS = [
  'package.json',
  'desktop/package.json',
  'vscode-extension/package.json',
]

// 公开仓同步树不带 desktop/ 等子包——按实际存在的清单审计，门禁照样非空扫。
const presentManifests = MANIFESTS.filter(m => existsSync(join(repoRoot, m)))

interface DirectEntry {
  manifest: string
  script: string
  command: string
}

/**
 * 直接 spawn `node ... --test` 的脚本条目。
 *
 * 只认 `node` 开头的命令：走 `tsx scripts/run-node-tests.ts` 的入口由 runner 自己
 * 加参数（nodeTestFlags），命令行里看不到也不该看到 `--test-timeout`。
 */
function collectDirectNodeTestEntries(): DirectEntry[] {
  const out: DirectEntry[] = []
  for (const manifest of presentManifests) {
    const raw = readFileSync(join(repoRoot, manifest), 'utf8')
    const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {}
    for (const [script, command] of Object.entries(scripts)) {
      if (!/(^|\s|&&\s*)node\s/.test(command)) continue
      // `--test` 而非 `--test-xxx`：后者是同族参数，不代表这条命令在跑测试。
      if (!/--test(\s|$)/.test(command)) continue
      out.push({ manifest, script, command })
    }
  }
  return out
}

describe('测试入口挂死护栏', () => {
  test('审计到的直接 node --test 入口不为空（保证这条门禁没在空扫）', () => {
    const entries = collectDirectNodeTestEntries()
    const hasDesktop = presentManifests.includes('desktop/package.json')
    const minEntries = hasDesktop ? 3 : 2
    assert.ok(
      entries.length >= minEntries,
      `期望至少 ${minEntries} 个直接入口（root test:desktop${hasDesktop ? ' / desktop test' : ''} / vscode-extension test），`
        + `实际 ${entries.length} 个：${entries.map(e => `${e.manifest}:${e.script}`).join(', ')}`,
    )
  })

  test('每个直接 node --test 入口都带 --test-timeout', () => {
    for (const { manifest, script, command } of collectDirectNodeTestEntries()) {
      assert.match(
        command,
        /--test-timeout=\d+/,
        `${manifest} 的 "${script}" 缺 --test-timeout。Node 默认是 Infinity：`
          + `任一测试卡住，这个进程就永久挂着占 CPU（曾实测挂满 2 天 13 小时）。命令：${command}`,
      )
    }
  })

  test('每个直接 node --test 入口都带 --test-force-exit', () => {
    for (const { manifest, script, command } of collectDirectNodeTestEntries()) {
      assert.match(
        command,
        /--test-force-exit(\s|$)/,
        `${manifest} 的 "${script}" 缺 --test-force-exit：测试跑完但句柄（socket/watcher/`
          + `子进程）未释放时进程不退出。命令：${command}`,
      )
    }
  })

  test('超时值与 CLI runner 的默认值一致 —— 两套阈值会各自漂移', () => {
    for (const { manifest, script, command } of collectDirectNodeTestEntries()) {
      const found = command.match(/--test-timeout=(\d+)/)
      assert.ok(found, `${manifest}:${script} 应已在上一条断言中被拦下`)
      assert.equal(
        Number(found[1]),
        DEFAULT_TEST_TIMEOUT_MS,
        `${manifest} 的 "${script}" 超时值与 test-runner-flags.ts 的 `
          + `DEFAULT_TEST_TIMEOUT_MS(${DEFAULT_TEST_TIMEOUT_MS}) 不一致。package.json 没法 import 常量，`
          + `所以靠这条断言把两处钉在一起——改默认值时这里会红，提醒同步。`,
      )
    }
  })
})
