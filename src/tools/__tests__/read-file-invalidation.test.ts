import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  READ_FILE_TOOL,
  __resetReadHistoryForTests,
  invalidateReadHistory,
  wasFileEditedBySession,
  getFileReadMtime,
} from '../read-file.js'
import { EDIT_FILE_TOOL } from '../edit.js'
import { HASH_EDIT_TOOL, hashLine } from '../hash-edit.js'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { READ_SECTION_TOOL } from '../read-section.js'
import { invalidateReadCachesForEvents } from '../../agent/hooks/cross-session-hook.js'
import { ArtifactStore } from '../../artifact/store.js'
import type { ToolCallParams } from '../types.js'

/**
 * Regression suite for the "read_file cache poisoning after edit" bug:
 * the old refreshFileReadMtime stamped read-dedup entries with the post-edit
 * mtime, so a follow-up read_file answered [read-ref] "已读且未变" (or served
 * a pre-edit artifact slice) even though edit_file had just changed the file.
 * These tests drive the REAL edit tools (the old suite simulated edits with
 * fs.writeFileSync, which never touched the poison path).
 */
describe('read history invalidation after edits', () => {
  const savedReadRef = process.env['RIVET_READ_REF']
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-read-inval-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    __resetReadHistoryForTests()
    process.env['RIVET_READ_REF'] = '1'
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    if (savedReadRef === undefined) delete process.env['RIVET_READ_REF']
    else process.env['RIVET_READ_REF'] = savedReadRef
  })

  /** >2KB so a repeat read would qualify for [read-ref] if wrongly deduped. */
  function makeBigFile(name: string, lines = 100, width = 80): string {
    const abs = join(dir, name)
    const content = Array.from({ length: lines }, (_, i) => `line ${i + 1}`.padEnd(width, ' ')).join('\n')
    writeFileSync(abs, content, 'utf-8')
    return abs
  }

  function params(input: Record<string, unknown>, sessionId?: string, artifactStore?: ArtifactStore): ToolCallParams {
    return {
      toolUseId: `t-${Math.random().toString(36).slice(2, 8)}`,
      cwd: dir,
      input: input as ToolCallParams['input'],
      contextWindow: 128_000,
      ...(sessionId ? { sessionId } : {}),
      ...(artifactStore ? { artifactStore } : {}),
    }
  }

  it('edit_file → full re-read returns new content, never [read-ref]', async () => {
    const fp = makeBigFile('src/a.txt')

    const r1 = await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))
    assert.ok(r1.content.includes('line 50'), 'first read returns content')

    const edit = await EDIT_FILE_TOOL.execute(params({
      file_path: fp,
      old_string: 'line 50'.padEnd(80, ' '),
      new_string: 'CHANGED LINE 50'.padEnd(80, ' '),
    }, 'sessA'))
    assert.ok(!edit.isError, `edit must succeed: ${edit.content}`)
    assert.ok(edit.content.includes('已编辑'), 'plain success (no false stale)')

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))
    assert.ok(!r2.content.startsWith('[read-ref]'), 'must not return [read-ref] after edit')
    assert.ok(r2.content.includes('CHANGED LINE 50'), 'must return post-edit content')
    assert.ok(!r2.content.includes('read-dedup'), 'must not warn "already read" after edit')
  })

  it('edit_file → offset re-read does not serve stale artifact slice', async () => {
    const fp = makeBigFile('src/b.txt')
    const store = new ArtifactStore(dir, 'inval-artifact')

    const r1 = await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA', store))
    assert.ok(r1.content.includes('line 50'))

    const edit = await EDIT_FILE_TOOL.execute(params({
      file_path: fp,
      old_string: 'line 50'.padEnd(80, ' '),
      new_string: 'CHANGED LINE 50'.padEnd(80, ' '),
    }, 'sessA'))
    assert.ok(!edit.isError, `edit must succeed: ${edit.content}`)

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: fp, offset: 50, limit: 1 }, 'sessA', store))
    assert.ok(r2.content.includes('CHANGED LINE 50'), `offset read must see post-edit content, got: ${r2.content.slice(0, 120)}`)
  })

  it('hash_edit → re-read returns new content', async () => {
    const fp = makeBigFile('src/c.txt')
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))

    const line50 = 'line 50'.padEnd(80, ' ')
    const edit = await HASH_EDIT_TOOL.execute(params({
      file_path: fp,
      anchors: [`L50:${hashLine(line50)}`],
      new_string: 'HASH CHANGED'.padEnd(80, ' '),
    }, 'sessA'))
    assert.ok(!edit.isError, `hash_edit must succeed: ${edit.content}`)

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))
    assert.ok(!r2.content.startsWith('[read-ref]'), 'no [read-ref] after hash_edit')
    assert.ok(r2.content.includes('HASH CHANGED'), 'post-edit content visible')
  })

  it('write_file → re-read returns new content', async () => {
    const fp = makeBigFile('src/d.txt')
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))

    const newContent = Array.from({ length: 60 }, (_, i) => `rewritten ${i + 1}`.padEnd(80, ' ')).join('\n')
    const w = await WRITE_FILE_TOOL.execute(params({ file_path: fp, content: newContent }, 'sessA'))
    assert.ok(!w.isError, `write must succeed: ${w.content}`)

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))
    assert.ok(!r2.content.startsWith('[read-ref]'), 'no [read-ref] after write_file')
    assert.ok(r2.content.includes('rewritten 30'), 'post-write content visible')
  })

  it('consecutive same-session edits do not false-positive the stale branch', async () => {
    const fp = makeBigFile('src/e.txt')
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))

    const e1 = await EDIT_FILE_TOOL.execute(params({
      file_path: fp,
      old_string: 'line 10'.padEnd(80, ' '),
      new_string: 'EDIT ONE'.padEnd(80, ' '),
    }, 'sessA'))
    assert.ok(!e1.isError && !e1.content.includes('外部修改'), `first edit plain success: ${e1.content}`)

    // Second edit WITHOUT re-reading: 表2 was updated by the first edit, so
    // the staleness check must not fire on our own write.
    const e2 = await EDIT_FILE_TOOL.execute(params({
      file_path: fp,
      old_string: 'line 20'.padEnd(80, ' '),
      new_string: 'EDIT TWO'.padEnd(80, ' '),
    }, 'sessA'))
    assert.ok(!e2.isError, `second edit must succeed: ${e2.content}`)
    assert.ok(!e2.content.includes('modified'), `second edit must not report modification: ${e2.content}`)
  })

  it('external modification after read triggers edit_file stale-recovery branch', async () => {
    const fp = makeBigFile('src/f.txt')
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))
    assert.notEqual(getFileReadMtime(fp, 'sessA'), null, '表2 must be populated by read_file')

    // External writer changes the file (different content AND size)
    const external = Array.from({ length: 100 }, (_, i) => `extern ${i + 1}`.padEnd(80, ' ')).join('\n')
    writeFileSync(fp, external, 'utf-8')
    const bumped = new Date(Date.now() + 5000)
    utimesSync(fp, bumped, bumped)

    const edit = await EDIT_FILE_TOOL.execute(params({
      file_path: fp,
      old_string: 'extern 5'.padEnd(80, ' '),
      new_string: 'RECOVERED'.padEnd(80, ' '),
    }, 'sessA'))
    assert.ok(!edit.isError, `stale-recovery should re-apply: ${edit.content}`)
    assert.ok(edit.content.includes('外部修改'), `must report external modification: ${edit.content}`)
  })

  it('read_section reports staleness after external modification', async () => {
    const fp = makeBigFile('src/g.txt')
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))

    writeFileSync(fp, 'totally new\ncontent here\n', 'utf-8')
    // 显式抬升 mtime：毫秒级时间戳下外部写入可能与记录时刻同刻，造成偶发漏判
    const bumped = new Date(Date.now() + 5000)
    utimesSync(fp, bumped, bumped)

    const r = await READ_SECTION_TOOL.execute(params({ file_path: fp, section: 'L1-L2' }, 'sessA'))
    assert.ok(r.content.includes('已变更'), `staleness note must appear: ${r.content.slice(0, 120)}`)
  })

  it('edit_file rollback → hash_edit position-only does NOT false-report staleness', async () => {
    // Regression: edit_file 失败回滚后 copyFileSync 改变 mtime，但内容已恢复。
    // 此前 hash_edit 的仅位置锚点检查会看到 mtime 不匹配，报告"文件已变化"，
    // 主控被要求重读——浪费一轮。修复后回滚路径会刷新 mtime 追踪器。
    const fp = join(dir, 'src/rollback.ts')
    writeFileSync(fp, `const x: number = 1\nconst y: string = "hello"\n`, 'utf-8')
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))

    // 故意引入 TypeScript 语法错误触发回滚
    const bad = await EDIT_FILE_TOOL.execute(params({
      file_path: fp,
      old_string: 'const x: number = 1',
      new_string: 'const x: number = ;', // 语法错
    }, 'sessA'))
    assert.ok(bad.isError, 'must fail with syntax error')
    assert.ok(bad.content.includes('回滚'), `must mention rollback: ${bad.content.slice(0, 120)}`)

    // 回滚后，仅位置锚点的 hash_edit 不应再报告 mtime 漂移
    const h = await HASH_EDIT_TOOL.execute(params({
      file_path: fp,
      anchors: ['L1'],
      new_string: 'const x: number = 42',
    }, 'sessA'))
    assert.ok(!h.isError, `hash_edit should succeed after rollback: ${h.content.slice(0, 160)}`)
    assert.ok(!h.content.includes('已修改'), `must not report file modification after rollback: ${h.content.slice(0, 200)}`)
    assert.ok(!h.content.includes('仅位置锚点'), `must not warn about position drift after rollback: ${h.content.slice(0, 200)}`)
  })
})

describe('in-process concurrent session isolation', () => {
  const savedReadRef = process.env['RIVET_READ_REF']
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-read-sess-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    __resetReadHistoryForTests()
    process.env['RIVET_READ_REF'] = '1'
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    if (savedReadRef === undefined) delete process.env['RIVET_READ_REF']
    else process.env['RIVET_READ_REF'] = savedReadRef
  })

  function makeBigFile(name: string): string {
    const abs = join(dir, name)
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`.padEnd(80, ' ')).join('\n')
    writeFileSync(abs, content, 'utf-8')
    return abs
  }

  function params(input: Record<string, unknown>, sessionId: string): ToolCallParams {
    return {
      toolUseId: `t-${Math.random().toString(36).slice(2, 8)}`,
      cwd: dir,
      input: input as ToolCallParams['input'],
      contextWindow: 128_000,
      sessionId,
    }
  }

  it('session B is unaffected by session A reads and edits', async () => {
    const fp = makeBigFile('src/shared.txt')

    // A reads and edits
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))
    const edit = await EDIT_FILE_TOOL.execute(params({
      file_path: fp,
      old_string: 'line 42'.padEnd(80, ' '),
      new_string: 'A CHANGED THIS'.padEnd(80, ' '),
    }, 'sessA'))
    assert.ok(!edit.isError)

    // B's first read must return real content — no read-ref, no repeat warning
    const rB = await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessB'))
    assert.ok(!rB.content.startsWith('[read-ref]'), 'B never read this file — no read-ref')
    assert.ok(!rB.content.includes('read-dedup'), 'no repeat warning for B')
    assert.ok(rB.content.includes('A CHANGED THIS'), 'B sees current on-disk content')

    // Edit marks are session-scoped
    assert.equal(wasFileEditedBySession(fp, 'sessA'), true)
    assert.equal(wasFileEditedBySession(fp, 'sessB'), false)
  })

  it("session B's stale message says externally, not self-edited", async () => {
    const fp = makeBigFile('src/blame.txt')

    // Both sessions read; A edits (changing mtime under B's feet)
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessB'))
    const editA = await EDIT_FILE_TOOL.execute(params({
      file_path: fp,
      old_string: 'line 42'.padEnd(80, ' '),
      new_string: 'A WAS HERE FIRST WITH A MUCH LONGER LINE THAN BEFORE'.padEnd(120, ' '),
    }, 'sessA'))
    assert.ok(!editA.isError)

    // B edits with an old_string that no longer exists → stale error must
    // blame an external modification, not "you previously edited this file".
    const editB = await EDIT_FILE_TOOL.execute(params({
      file_path: fp,
      old_string: 'line 42'.padEnd(80, ' '),
      new_string: 'B TRIES TOO'.padEnd(80, ' '),
    }, 'sessB'))
    assert.ok(editB.isError, 'B edit must fail (content gone)')
    assert.ok(!editB.content.includes('你在当前会话中曾编辑过'), `B did not edit this file: ${editB.content.slice(0, 160)}`)
  })

  it('position-only hash_edit after edits warns about drift instead of hard-rejecting', async () => {
    // ff25d68b 守卫减负：「仅位置锚点 + 已编辑」不再硬拒绝——仍尝试编辑
    // （越界由行号存在性检查兜底），但必须带漂移警告。警告有两条触发路径：
    // 本会话编辑过（session-scoped）与读后 mtime 变化（跨会话也触发——
    // 文件确实被改了，行号漂移对 B 同样真实）。
    const fp = makeBigFile('src/pos.txt')
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessB'))

    const editA = await EDIT_FILE_TOOL.execute(params({
      file_path: fp,
      old_string: 'line 99'.padEnd(80, ' '),
      new_string: 'A EDIT'.padEnd(80, ' '),
    }, 'sessA'))
    assert.ok(!editA.isError)

    // A edited the file → A's position-only hash_edit succeeds WITH drift warning
    const hA = await HASH_EDIT_TOOL.execute(params({
      file_path: fp,
      anchors: ['L5'],
      new_string: 'A POS EDIT'.padEnd(80, ' '),
    }, 'sessA'))
    assert.ok(!hA.isError, `A must not be hard-rejected: ${hA.content.slice(0, 160)}`)
    assert.ok(hA.content.includes('仅位置锚点'), `A gets a drift warning: ${hA.content.slice(0, 160)}`)

    // B did not edit, but the file changed under B's feet since its read →
    // mtime drift path also warns (and the edit still goes through).
    const hB = await HASH_EDIT_TOOL.execute(params({
      file_path: fp,
      anchors: ['L5'],
      new_string: 'B POS EDIT'.padEnd(80, ' '),
    }, 'sessB'))
    assert.ok(!hB.isError, `B must not be hard-rejected: ${hB.content.slice(0, 160)}`)
    assert.ok(hB.content.includes('仅位置锚点'), `B gets a drift warning: ${hB.content.slice(0, 160)}`)
  })
})

describe('cross-session file_changed event invalidation', () => {
  const savedReadRef = process.env['RIVET_READ_REF']
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-read-xsess-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    __resetReadHistoryForTests()
    process.env['RIVET_READ_REF'] = '1'
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    if (savedReadRef === undefined) delete process.env['RIVET_READ_REF']
    else process.env['RIVET_READ_REF'] = savedReadRef
  })

  function params(input: Record<string, unknown>, sessionId: string): ToolCallParams {
    return {
      toolUseId: `t-${Math.random().toString(36).slice(2, 8)}`,
      cwd: dir,
      input: input as ToolCallParams['input'],
      contextWindow: 128_000,
      sessionId,
    }
  }

  it('file_changed event from a peer session drops local read-dedup records', async () => {
    const fp = join(dir, 'src/peer.ts')
    writeFileSync(fp, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`.padEnd(80, ' ')).join('\n'), 'utf-8')

    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessMe'))

    // Peer session (other process) reports it changed the file. Our repeat
    // read would normally hit read-ref; after invalidation it must not.
    invalidateReadCachesForEvents(
      [{ id: 1, sessionId: 'peer', eventType: 'file_changed', filePath: 'src/peer.ts', detail: 'Modified by session peer', priority: 0, createdAt: new Date().toISOString() }],
      dir,
    )

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessMe'))
    assert.ok(!r2.content.startsWith('[read-ref]'), 'read-dedup record must be gone after peer file_changed event')
    assert.ok(r2.content.includes('line 50'), 'real content returned')
  })

  it('invalidateReadHistory drops entries for all sessions of a path', async () => {
    const fp = join(dir, 'src/all.ts')
    writeFileSync(fp, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`.padEnd(80, ' ')).join('\n'), 'utf-8')

    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))
    await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessB'))

    invalidateReadHistory(fp)

    const rA = await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessA'))
    const rB = await READ_FILE_TOOL.execute(params({ file_path: fp }, 'sessB'))
    assert.ok(!rA.content.startsWith('[read-ref]'), 'A entry dropped')
    assert.ok(!rB.content.startsWith('[read-ref]'), 'B entry dropped')
  })
})
