import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { formatGlanceLeft, shortenCwd, type GlanceBarInput } from '../format/glance-bar.js'
import { getTheme } from '../theme.js'

const theme = getTheme()
const HOME = homedir()

/** 剥离 ANSI 转义码，取纯文本（便于断言内容而非颜色）。 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function baseInput(overrides: Partial<GlanceBarInput> = {}): GlanceBarInput {
  return { width: 120, domainName: '天枢', ...overrides }
}

describe('shortenCwd', () => {
  it('replaces home prefix with ~', () => {
    assert.equal(shortenCwd(HOME), '~')
    assert.equal(shortenCwd(`${HOME}/app/deepseek-tui`), '~/app/deepseek-tui')
  })

  it('returns path unchanged when not under home', () => {
    assert.equal(shortenCwd('/tmp/foo'), '/tmp/foo')
    assert.equal(shortenCwd('/usr/local/bin'), '/usr/local/bin')
  })
})

describe('formatGlanceLeft cwd display', () => {
  it('shows cwd on wide terminal and omits git branch', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      branch: 'main',
      cwd: '/Users/test/app',
    }), theme))
    assert.equal(out.includes('main'), false, 'git branch is not shown on the input chrome')
    assert.equal(out.includes('⎇'), false, 'no git glyph')
    assert.match(out, /\/Users\/test\/app/, 'cwd should still appear')
  })

  it('shows shortened cwd (~ prefix)', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      branch: 'dev',
      cwd: `${HOME}/projects/foo`,
    }), theme))
    // home 被替换为 ~（跨平台）
    assert.ok(out.includes('~/projects/foo'), `expected ~/projects/foo in: ${out}`)
    assert.equal(out.includes('dev'), false, 'branch omitted')
  })

  it('uses accent for domain and dim for cwd (no branch tier)', () => {
    const out = formatGlanceLeft(baseInput({
      branch: 'feature',
      cwd: '/tmp/proj',
    }), theme)
    const colorSegments = out.match(/\x1b\[[0-9;]*m/g) ?? []
    assert.ok(colorSegments.length >= 4, `expect >=4 color codes (open+close for domain + cwd), got ${colorSegments.length}`)
  })

  it('hides cwd on narrow terminal (<60 cols)', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      width: 40,
      branch: 'main',
      cwd: '/Users/test/app',
    }), theme))
    assert.equal(out.includes('main'), false, 'branch hidden')
    assert.equal(out.includes('/Users/test/app'), false, 'cwd hidden when narrow')
    assert.ok(out.includes('天枢'), 'domain name always shows')
  })

  it('does not show branch when cwd is undefined', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      branch: 'main',
    }), theme))
    assert.equal(out.includes('main'), false)
    assert.equal(out.includes('⎇'), false)
    assert.ok(out.includes('天枢'))
  })

  it('does not paint long branch names on the input chrome', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      branch: 'feat/v2.4-hardening',
      cwd: 'D:\\Tianshu-Tui\\desktop-widget',
    }), theme))
    assert.equal(out.includes('feat/v2.4-hardening'), false)
    assert.equal(out.includes('⎇'), false)
    assert.ok(out.includes('desktop-widget'))
  })

  it('shows neither branch nor cwd when both undefined', () => {
    const out = stripAnsi(formatGlanceLeft(baseInput({
      domainName: '天枢',
    }), theme))
    assert.equal(out.includes('('), false)
    assert.equal(out.includes('~'), false)
    assert.ok(out.includes('天枢'))
  })
})
