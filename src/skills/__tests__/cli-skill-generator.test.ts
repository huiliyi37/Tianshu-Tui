import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseHelpText, generateSkillMarkdown, generateCliSkill } from '../cli-skill-generator.js'
import { parseSkillMarkdown, SkillRegistry } from '../skill-loader.js'

// ── 三形态解析契约（commander / click / argparse）──────────────────

const COMMANDER_HELP = `Usage: mycli [options] [command]

Options:
  -V, --version        output the version number
  -h, --help           display help for command

Commands:
  init [options]       initialize a new project
  config set [options]  set configuration values
  help [command]       display help for command
`

const CLICK_HELP = `Usage: mycli [OPTIONS] COMMAND [ARGS]...

Options:
  --version  Show the version and exit.
  --help     Show this message and exit.

Commands:
  init  Initialize a new project.
  build  Build the project with all dependencies
         and run the test suite.
`

const ARGPARSE_HELP = `usage: mycli [-h] {init,build,help} ...

positional arguments:
  {init,build,help}
    init              Initialize a new project.
    build             Build the project.

options:
  -h, --help  show this help message and exit
`

const ARGPARSE_METAVAR_HELP = `usage: mycli [-h] command ...

positional arguments:
  command
    {init,build,help}
      init     Initialize a new project.
      build    Build the project.
`

describe('parseHelpText — commander 形态', () => {
  it('识别 commander 方言并提取子命令（含多词命令与 [options] 标记剥离）', () => {
    const parse = parseHelpText(COMMANDER_HELP)
    assert.equal(parse.dialect, 'commander')
    assert.equal(parse.degraded, false)
    assert.deepEqual(parse.commands.map(c => c.name), ['init', 'config set', 'help'])
    assert.equal(parse.commands[0]!.description, 'initialize a new project')
    assert.equal(parse.commands[1]!.description, 'set configuration values')
    // `help [command]` 的 [command] 标记剥离后名字正确，描述保留
    assert.equal(parse.commands[2]!.description, 'display help for command')
  })
})

describe('parseHelpText — click 形态', () => {
  it('识别 click 方言，续行并入前一条描述', () => {
    const parse = parseHelpText(CLICK_HELP)
    assert.equal(parse.dialect, 'click')
    assert.equal(parse.degraded, false)
    assert.deepEqual(parse.commands.map(c => c.name), ['init', 'build'])
    assert.equal(parse.commands[1]!.description, 'Build the project with all dependencies and run the test suite.')
  })
})

describe('parseHelpText — argparse 形态', () => {
  it('识别 argparse 方言（usage 的 {a,b,c} 集合 + positional 子解析器条目）', () => {
    const parse = parseHelpText(ARGPARSE_HELP)
    assert.equal(parse.dialect, 'argparse')
    assert.equal(parse.degraded, false)
    assert.deepEqual(parse.commands.map(c => c.name), ['init', 'build'])
    assert.equal(parse.commands[0]!.description, 'Initialize a new project.')
  })

  it('argparse metavar 变体（command 标签行被丢弃，只留真实子命令）', () => {
    const parse = parseHelpText(ARGPARSE_METAVAR_HELP)
    assert.equal(parse.dialect, 'argparse')
    assert.deepEqual(parse.commands.map(c => c.name), ['init', 'build'])
  })

  it('usage 有 {a,b,c} 但 positional 区为空 → 合成裸命令名', () => {
    const parse = parseHelpText('usage: mycli [-h] {foo,bar} ...\n\noptions:\n  -h, --help  show this help message and exit\n')
    assert.equal(parse.dialect, 'argparse')
    assert.deepEqual(parse.commands.map(c => c.name), ['foo', 'bar'])
  })
})

describe('parseHelpText — Commands 区兜底方言判定（无 Options 区信号）', () => {
  it('仅 Commands 区 + 无 [options] 标记 → 按条目风格兜底为 click，不降级', () => {
    const parse = parseHelpText(`Usage: tool [command]

Commands:
  run   Do the thing
  stop  Stop the thing
`)
    assert.equal(parse.dialect, 'click')
    assert.equal(parse.degraded, false)
    assert.deepEqual(parse.commands.map(c => c.name), ['run', 'stop'])
    assert.equal(parse.commands[0]!.description, 'Do the thing')
  })

  it('仅 Commands 区 + [options] 标记 → 兜底为 commander，标记剥离且不降级', () => {
    const parse = parseHelpText(`Usage: tool [command]

Commands:
  run [options]  Do the thing
`)
    assert.equal(parse.dialect, 'commander')
    assert.equal(parse.degraded, false)
    assert.deepEqual(parse.commands.map(c => c.name), ['run'])
    assert.equal(parse.commands[0]!.description, 'Do the thing')
  })
})

describe('parseHelpText — 优雅降级', () => {
  it('无法识别方言 → degraded，命令列表为空，原始文本保留', () => {
    const parse = parseHelpText('this is not help at all\njust some random output lines')
    assert.equal(parse.dialect, 'unknown')
    assert.equal(parse.degraded, true)
    assert.deepEqual(parse.commands, [])
    assert.match(parse.rawText, /random output/)
  })

  it('click 叶子 CLI（真实文案 "Show this message and exit."，方言命中但无 Commands 区）→ 降级', () => {
    const parse = parseHelpText(`Usage: tool [options]

Options:
  --version  Show the version and exit.
  --help     Show this message and exit.
`)
    // 方言被识别（click），但没有提取到任何命令 —— 契约要求仍降级
    assert.equal(parse.dialect, 'click')
    assert.equal(parse.degraded, true)
    assert.deepEqual(parse.commands, [])
  })

  it('commander 叶子 CLI（"display help for command" 命中但无 Commands 区）→ 降级', () => {
    const parse = parseHelpText(`Usage: tool [options]

Options:
  -V, --version  output the version number
  -h, --help     display help for command
`)
    assert.equal(parse.dialect, 'commander')
    assert.equal(parse.degraded, true)
    assert.deepEqual(parse.commands, [])
  })

  it('空文本 → degraded', () => {
    const parse = parseHelpText('   \n  ')
    assert.equal(parse.degraded, true)
  })
})

describe('generateSkillMarkdown — 产物结构', () => {
  const md = generateSkillMarkdown({
    binary: 'gh',
    skillName: 'cli-gh',
    dialect: 'commander',
    degraded: false,
    groups: [
      { name: 'gh', description: '', commands: [{ name: 'auth', description: 'Authenticate gh' }, { name: 'repo', description: 'Create and view repositories' }] },
      { name: 'auth', description: '', commands: [{ name: 'login', description: 'Log in' }] },
    ],
    generatedAt: '2026-08-07T00:00:00.000Z',
  })

  it('frontmatter 无引号，可被既有 skill-loader 解析（Tier1/Tier2 兼容）', () => {
    const skill = parseSkillMarkdown(md, 'cli-gh.md')
    assert.equal(skill.name, 'cli-gh')
    assert.match(skill.description, /gh/)
    // triggers 数组被 loader 解析为正则
    assert.ok(skill.triggers.some(t => t.test('use gh here')))
  })

  it('含命令组表（| Command | Description |）与 For AI Agents 纪律段', () => {
    assert.match(md, /\| Command \| Description \|/)
    assert.match(md, /\| `auth` \| Authenticate gh \|/)
    assert.match(md, /## For AI Agents/)
    assert.match(md, /## Command Groups/)
    assert.match(md, /### auth/)
  })

  it('降级时原始 help 文本进 body，frontmatter 仍合法', () => {
    const degradedMd = generateSkillMarkdown({
      binary: 'gh',
      skillName: 'cli-gh',
      dialect: 'unknown',
      degraded: true,
      groups: [],
      rawText: 'unparseable raw help\nsecond line',
      generatedAt: '2026-08-07T00:00:00.000Z',
    })
    const skill = parseSkillMarkdown(degradedMd, 'cli-gh.md')
    assert.equal(skill.name, 'cli-gh')
    assert.match(skill.body, /unparseable raw help/)
  })
})

// ── 运行时执行 + 全流程 ────────────────────────────────────────────

/** 写一个可执行的假 CLI 脚本（shebang 指向当前 node），返回路径。 */
function makeFakeCli(name: string, behavior: 'commander' | 'garbage' | 'sub-garbage'): string {
  const dir = mkdtempSync(join(tmpdir(), `rivet-cli-skillgen-${name}-`))
  const path = join(dir, `${name}.mjs`)
  const body = behavior === 'garbage'
    ? `console.log('garbage output with no structure here')`
    : behavior === 'sub-garbage'
      ? `const sub = process.argv[2];
if (sub && sub !== '--help') {
  console.log('subcommand ' + sub + ' --help produced unparseable output');
} else {
  console.log('Usage: fake-gh [options] [command]');
  console.log('');
  console.log('Options:');
  console.log('  -h, --help     display help for command');
  console.log('');
  console.log('Commands:');
  console.log('  init [options]       initialize a new project');
  console.log('  build [options]      build the project');
  console.log('  help [command]       display help for command');
}`
      : `const sub = process.argv[2];
if (sub && sub !== '--help') {
  console.log('Usage: fake-gh ' + sub + ' [options]');
  console.log('');
  console.log('Options:');
  console.log('  -h, --help  display help for command');
  console.log('');
  console.log('Commands:');
  console.log('  run [options]       run the ' + sub + ' workflow');
} else {
  console.log('Usage: fake-gh [options] [command]');
  console.log('');
  console.log('Options:');
  console.log('  -V, --version  output the version number');
  console.log('  -h, --help     display help for command');
  console.log('');
  console.log('Commands:');
  console.log('  init [options]       initialize a new project');
  console.log('  build [options]      build the project');
  console.log('  help [command]       display help for command');
}`
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, 'utf-8')
  chmodSync(path, 0o755)
  return path
}

describe('generateCliSkill — 运行时执行与产物落盘', () => {
  it('执行 <cli> --help + 子命令一层，产物被既有 registry 发现', async () => {
    const cli = makeFakeCli('fake-gh', 'commander')
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-cwd-'))
    try {
      const res = await generateCliSkill({ binary: cli, cwd, timeoutMs: 10_000 })

      assert.equal(res.dialect, 'commander')
      assert.equal(res.degraded, false)
      // 根组 + 一个成功展开的子命令组（init/build 都展开，因脚本对任意子命令返回 help）
      assert.ok(res.groups.some(g => g.name === cli))
      assert.ok(res.groups.some(g => g.name === 'init' && g.commands.some(c => c.name === 'run')))
      // 产物文件存在且位于 .rivet/skills/ 下
      assert.ok(res.filePath.endsWith('.md'))
      assert.ok(res.filePath.startsWith(join(cwd, '.rivet', 'skills')))

      // 既有 skills 体系可直接发现（Tier1/Tier2 兼容性终验）
      const reg = new SkillRegistry()
      const loaded = reg.loadFromDirectory(join(cwd, '.rivet', 'skills'))
      assert.ok(loaded.loaded.includes(res.skillName), `loaded=${loaded.loaded}`)
      const skill = reg.get(res.skillName)!
      assert.ok(skill.description.length > 0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('help 无法解析 → 不硬失败，降级产物仍写入', async () => {
    const cli = makeFakeCli('fake-noise', 'garbage')
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-noise-'))
    try {
      const res = await generateCliSkill({ binary: cli, cwd, timeoutMs: 10_000 })
      assert.equal(res.degraded, true)
      assert.equal(res.skillName, 'cli-fake-noise-mjs')
      const { readFileSync } = await import('node:fs')
      const content = readFileSync(res.filePath, 'utf-8')
      assert.match(content, /garbage output with no structure here/)
      // 降级产物同样可被 loader 解析
      const skill = parseSkillMarkdown(content, res.filePath)
      assert.equal(skill.name, res.skillName)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('子命令 --help 无法解析 → 跳过不 fatal，产物含未展开列表', async () => {
    const cli = makeFakeCli('fake-sub', 'sub-garbage')
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-sub-'))
    try {
      const res = await generateCliSkill({ binary: cli, cwd, timeoutMs: 10_000 })
      // 根 help 正常解析，degraded 为 false
      assert.equal(res.degraded, false)
      // 只有根组，子命令组全部因不可解析而缺席
      assert.equal(res.groups.length, 1)
      assert.equal(res.groups[0]!.name, cli)
      // 全部子命令被记入 skippedSubcommands
      assert.deepEqual(res.skippedSubcommands, ['init', 'build', 'help'])
      // 产物 markdown 含「未展开的子命令」清单
      const content = readFileSync(res.filePath, 'utf-8')
      assert.match(content, /## 未展开的子命令/)
      assert.match(content, /init, build, help/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('click 叶子 CLI → 降级产物：原始帮助文本进正文，可被 loader 解析', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-leaf-'))
    const leaf = join(dir, 'leaf.mjs')
    writeFileSync(leaf, `#!${process.execPath}
console.log('Usage: leaf [options]');
console.log('');
console.log('Options:');
console.log('  --version  Show the version and exit.');
console.log('  --help     Show this message and exit.');
`, 'utf-8')
    chmodSync(leaf, 0o755)
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-leaf-cwd-'))
    try {
      const res = await generateCliSkill({ binary: leaf, cwd, timeoutMs: 10_000 })
      // 方言识别成功（click）但无命令列表 → 必须降级而非生成空壳技能
      assert.equal(res.dialect, 'click')
      assert.equal(res.degraded, true)
      assert.equal(res.groups.length, 0)
      assert.deepEqual(res.skippedSubcommands, [])
      const content = readFileSync(res.filePath, 'utf-8')
      // 降级正文嵌入原始帮助文本
      assert.match(content, /## 原始帮助文本（解析失败降级）/)
      assert.match(content, /Show this message and exit/)
      const skill = parseSkillMarkdown(content, res.filePath)
      assert.equal(skill.name, res.skillName)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('--help 无输出（exit 0 但空 stdout/stderr）→ 明确报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-silent-'))
    const silent = join(dir, 'silent.mjs')
    writeFileSync(silent, `#!${process.execPath}\nprocess.exit(0)\n`, 'utf-8')
    chmodSync(silent, 0o755)
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-silent-cwd-'))
    try {
      await assert.rejects(
        () => generateCliSkill({ binary: silent, cwd, timeoutMs: 5_000 }),
        /produced no output/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('binary 不存在 → 明确报错（无 help 可降级）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-enoent-'))
    try {
      await assert.rejects(
        () => generateCliSkill({ binary: 'cli-skillgen-definitely-missing-xyz-123', cwd, timeoutMs: 5_000 }),
        /not found/,
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('--help 以非零码退出但输出有效帮助 → 仍解析成功，exit code 不 gate 解析', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-exit1-'))
    const cli = join(dir, 'exit1-cli.mjs')
    writeFileSync(cli, `#!${process.execPath}
console.log('Usage: exit1-cli [options] [command]');
console.log('');
console.log('Options:');
console.log('  -h, --help  display help for command');
console.log('');
console.log('Commands:');
console.log('  run [options]  execute a task');
process.exit(1);
`, 'utf-8')
    chmodSync(cli, 0o755)
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-exit1-cwd-'))
    try {
      const res = await generateCliSkill({ binary: cli, cwd, timeoutMs: 10_000 })
      // 根 help 非零退出但文本有效 → 正常解析，不降级
      assert.equal(res.dialect, 'commander')
      assert.equal(res.degraded, false)
      assert.deepEqual(res.groups[0]!.commands.map(c => c.name), ['run'])
      // 子命令 --help 同样非零退出 → 按"运行失败"契约记入 skipped
      assert.deepEqual(res.skippedSubcommands, ['run'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('--help 非零码退出且输出无结构 → 降级产物写入原始文本', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-exit1-noise-'))
    const cli = join(dir, 'exit1-noise.mjs')
    writeFileSync(cli, `#!${process.execPath}
console.log('error: unknown option --help');
process.exit(1);
`, 'utf-8')
    chmodSync(cli, 0o755)
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-exit1-noise-cwd-'))
    try {
      const res = await generateCliSkill({ binary: cli, cwd, timeoutMs: 10_000 })
      assert.equal(res.dialect, 'unknown')
      assert.equal(res.degraded, true)
      assert.equal(res.groups.length, 0)
      const content = readFileSync(res.filePath, 'utf-8')
      assert.match(content, /unknown option --help/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// ── 契约边界锁定（实现已存在，测试用于防回归）────────────────────────

describe('parseHelpText — 行尾归一化', () => {
  it('CRLF 行尾（Windows 帮助文本）→ 归一化后正常识别方言并提取命令', () => {
    const parse = parseHelpText(COMMANDER_HELP.replace(/\n/g, '\r\n'))
    assert.equal(parse.dialect, 'commander')
    assert.equal(parse.degraded, false)
    assert.deepEqual(parse.commands.map(c => c.name), ['init', 'config set', 'help'])
  })
})

describe('generateSkillMarkdown — 表格转义', () => {
  it('命令描述含管道符 → 单元格内转义，不产生第四列', () => {
    const md = generateSkillMarkdown({
      binary: 'gh',
      skillName: 'cli-gh',
      dialect: 'commander',
      degraded: false,
      groups: [
        { name: 'gh', description: '', commands: [{ name: 'auth', description: 'pipe | in description' }] },
      ],
      generatedAt: '2026-08-07T00:00:00.000Z',
    })
    assert.match(md, /\| `auth` \| pipe \\\| in description \|/)
  })
})

describe('generateCliSkill — 输出通道与展开选项', () => {
  it('help 输出到 stderr（而非 stdout）→ 仍解析成功，不误判为无输出降级', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-stderr-'))
    const cli = join(dir, 'stderr-cli.mjs')
    writeFileSync(cli, `#!${process.execPath}
console.error('Usage: stderr-cli [options] [command]');
console.error('');
console.error('Options:');
console.error('  -h, --help  display help for command');
console.error('');
console.error('Commands:');
console.error('  run [options]  execute a task');
`, 'utf-8')
    chmodSync(cli, 0o755)
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-stderr-cwd-'))
    try {
      const res = await generateCliSkill({ binary: cli, cwd, timeoutMs: 10_000 })
      assert.equal(res.dialect, 'commander')
      assert.equal(res.degraded, false)
      assert.deepEqual(res.groups[0]!.commands.map(c => c.name), ['run'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('subcommands: false → 只生成根组，不展开子命令', async () => {
    const cli = makeFakeCli('fake-gh', 'commander')
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cli-skillgen-nosub-'))
    try {
      const res = await generateCliSkill({ binary: cli, cwd, timeoutMs: 10_000, subcommands: false })
      assert.equal(res.dialect, 'commander')
      assert.equal(res.degraded, false)
      assert.equal(res.groups.length, 1)
      assert.equal(res.groups[0]!.name, cli)
      assert.deepEqual(res.skippedSubcommands, [])
      // 产物不含子命令组标题（fake-gh 子命令可展开，若展开会有 ### init）
      const content = readFileSync(res.filePath, 'utf-8')
      assert.doesNotMatch(content, /^### init$/m)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
