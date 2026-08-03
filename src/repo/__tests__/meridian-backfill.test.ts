import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { MeridianIndexer, isMeridianIndexablePath } from '../meridian-indexer.js'
import { scheduleMeridianBackfill, DEFAULT_MERIDIAN_BACKFILL_MAX } from '../meridian-backfill.js'

const ENV_KEYS = ['RIVET_MERIDIAN_BACKFILL', 'RIVET_MERIDIAN_BACKFILL_MAX'] as const

let dir: string
let savedEnv: Array<string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meridian-backfill-'))
  savedEnv = ENV_KEYS.map(k => process.env[k])
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  ENV_KEYS.forEach((k, i) => {
    const v = savedEnv[i]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  })
  rmSync(dir, { recursive: true, force: true })
})

/** 记录 indexFile 调用次序的假 indexer——绕开 tree-sitter，专注调度行为。 */
function fakeIndexer(calls: string[]): MeridianIndexer {
  return {
    backfillScheduled: false,
    indexFile: async (rel: string) => { calls.push(rel) },
  } as unknown as MeridianIndexer
}

function writeRel(root: string, rel: string, content = 'export const x = 1\n'): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

describe('isMeridianIndexablePath（与懒建过滤同规则）', () => {
  it('接受内容源文件，拒绝依赖/构建/运行时/静默层/非代码扩展名', () => {
    assert.equal(isMeridianIndexablePath('src/app.ts'), true)
    assert.equal(isMeridianIndexablePath('lib/util.py'), true)
    assert.equal(isMeridianIndexablePath('cmd/main.go'), true)
    assert.equal(isMeridianIndexablePath('node_modules/pkg/index.ts'), false)
    assert.equal(isMeridianIndexablePath('dist/bundle.js'), false)
    assert.equal(isMeridianIndexablePath('.rivet/knowledge/x.ts'), false)
    assert.equal(isMeridianIndexablePath('.codex/hooks.ts'), false, '外来静默层不可索引')
    assert.equal(isMeridianIndexablePath('.test-tmp/generated.ts'), false)
    assert.equal(isMeridianIndexablePath('docs/plan.md'), false, '非代码扩展名')
    assert.equal(isMeridianIndexablePath('src/app.ts.map'), false)
  })
})

describe('scheduleMeridianBackfill', () => {
  it('git 仓枚举遵循 gitignore（--exclude-standard）', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeRel(dir, '.gitignore', 'ignored.ts\n')
    writeRel(dir, 'src/a.ts')
    writeRel(dir, 'src/b.ts')
    writeRel(dir, 'ignored.ts')

    const calls: string[] = []
    const handle = scheduleMeridianBackfill(fakeIndexer(calls), dir)
    await handle.done

    assert.ok(calls.includes('src/a.ts'), `src/a.ts 应被索引: ${calls}`)
    assert.ok(calls.includes('src/b.ts'), `src/b.ts 应被索引: ${calls}`)
    assert.ok(!calls.includes('ignored.ts'), 'gitignore 的文件不应进入候选')
    assert.ok(!calls.includes('.gitignore'), '非代码扩展名被过滤')
  })

  it('非 git 目录回退 readdir，跳过 node_modules/dist/.rivet 并统一过滤', async () => {
    writeRel(dir, 'src/a.ts')
    writeRel(dir, 'lib/deep/b.py')
    writeRel(dir, 'node_modules/pkg/skip.ts')
    writeRel(dir, 'dist/skip.js')
    writeRel(dir, '.rivet/skip.ts')
    writeRel(dir, 'readme.md')

    const calls: string[] = []
    const handle = scheduleMeridianBackfill(fakeIndexer(calls), dir)
    await handle.done

    assert.deepEqual([...calls].sort(), ['lib/deep/b.py', 'src/a.ts'])
  })

  it('候选按 mtime 新→旧排序', async () => {
    writeRel(dir, 'old.ts')
    writeRel(dir, 'mid.ts')
    writeRel(dir, 'new.ts')
    utimesSync(join(dir, 'old.ts'), new Date('2020-01-01'), new Date('2020-01-01'))
    utimesSync(join(dir, 'mid.ts'), new Date('2021-01-01'), new Date('2021-01-01'))
    utimesSync(join(dir, 'new.ts'), new Date('2022-01-01'), new Date('2022-01-01'))

    const calls: string[] = []
    const handle = scheduleMeridianBackfill(fakeIndexer(calls), dir)
    await handle.done

    assert.deepEqual(calls, ['new.ts', 'mid.ts', 'old.ts'])
  })

  it('RIVET_MERIDIAN_BACKFILL_MAX 覆盖总量上限，默认上限 2000', async () => {
    assert.equal(DEFAULT_MERIDIAN_BACKFILL_MAX, 2000)
    process.env.RIVET_MERIDIAN_BACKFILL_MAX = '3'
    for (let i = 0; i < 6; i++) writeRel(dir, `f${i}.ts`)

    const calls: string[] = []
    const handle = scheduleMeridianBackfill(fakeIndexer(calls), dir)
    await handle.done

    assert.equal(calls.length, 3)
  })

  it('RIVET_MERIDIAN_BACKFILL_MAX 非法值回退默认上限', async () => {
    process.env.RIVET_MERIDIAN_BACKFILL_MAX = 'abc'
    for (let i = 0; i < 5; i++) writeRel(dir, `f${i}.ts`)

    const calls: string[] = []
    const handle = scheduleMeridianBackfill(fakeIndexer(calls), dir)
    await handle.done

    assert.equal(calls.length, 5, '非法值不应截断也不应崩溃')
  })

  it('RIVET_MERIDIAN_BACKFILL=0 整体关闭', async () => {
    process.env.RIVET_MERIDIAN_BACKFILL = '0'
    writeRel(dir, 'a.ts')

    const calls: string[] = []
    const handle = scheduleMeridianBackfill(fakeIndexer(calls), dir)
    await handle.done

    assert.equal(calls.length, 0)
  })

  it('stop() 中断索引循环', async () => {
    for (let i = 0; i < 40; i++) writeRel(dir, `f${String(i).padStart(2, '0')}.ts`)

    const calls: string[] = []
    const handle = scheduleMeridianBackfill(fakeIndexer(calls), dir)
    // 枚举与首个文件的 indexFile 在 schedule 内同步开跑；此处 stop 后
    // 循环在下一个文件前检查 stopped 并退出。
    handle.stop()
    await handle.done

    assert.equal(calls.length, 1)
  })

  it('每个 indexer 实例只调度一次（实例上挂 flag）', async () => {
    writeRel(dir, 'a.ts')
    const calls: string[] = []
    const indexer = fakeIndexer(calls)

    await scheduleMeridianBackfill(indexer, dir).done
    assert.equal(calls.length, 1)

    await scheduleMeridianBackfill(indexer, dir).done
    assert.equal(calls.length, 1, '重复调度应是空操作')
  })

  it('真 indexer 端到端 + hash 幂等：同一 stateDir 二轮不重复 parse（getStats 不变）', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'meridian-backfill-state-'))
    try {
      writeRel(dir, 'src/a.ts', 'export const a = 1\n')
      writeRel(dir, 'src/b.ts', 'export const b = 2\n')
      writeRel(dir, 'src/c.ts', 'export const c = 3\n')

      const first = new MeridianIndexer(dir, stateDir)
      await scheduleMeridianBackfill(first, dir).done
      const stats1 = first.getStats()
      assert.equal(stats1.files, 3)
      assert.ok(stats1.symbols > 0, '首轮确实 parse 出了符号')
      first.close()

      // 新实例同一 stateDir（跨会话语义）——needsParse 短路，stats 不变
      const second = new MeridianIndexer(dir, stateDir)
      await scheduleMeridianBackfill(second, dir).done
      assert.deepEqual(second.getStats(), stats1, '二轮全量 hash 命中，不重复 parse/upsert')
      second.close()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
