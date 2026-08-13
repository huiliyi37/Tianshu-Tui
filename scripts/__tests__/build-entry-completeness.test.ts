import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const pkg = JSON.parse(read('../../package.json')) as { scripts: Record<string, string> }
// 公开仓同步树不带 desktop/——tauri 配置存在才审计，缺失跳过该子测试。
const TAURI_CONF_URL = new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url)
const tauriConf = existsSync(TAURI_CONF_URL) ? readFileSync(TAURI_CONF_URL, 'utf8') : null
const updater = read('../../src/tui/updater.ts')

// `npm run build` used to be a bare `tsup`, while a complete `build:dist`
// (tsup + pack-native + stage-runtime-deps) sat next to it with **zero**
// callers. Everything that mattered — README, CLAUDE.md, five CI jobs, both
// release scripts, and the in-app source-install updater — ran the incomplete
// one. `clean: true` wipes the staged payload every time, so the produced dist
// starts fine and then silently degrades: meridian (tree-sitter), ast-grep, the
// typescript LSP fallback and better-sqlite3 all fail to resolve. That shape
// went unnoticed for two days and 303 swallowed index failures.
//
// The lesson is about *naming*, not about the scripts: the complete path has to
// own the obvious name, or the obvious name is what people will run.

describe('build entry completeness', () => {
  it('the obvious name produces a runnable dist', () => {
    const build = pkg.scripts.build
    assert.ok(build, 'build script is gone')
    for (const step of ['tsup', 'pack-native.js', 'stage-runtime-deps.js']) {
      assert.ok(build.includes(step), `\`npm run build\` no longer runs ${step}: ${build}`)
    }
    // Order matters: pack-native writes dist/native/, and stage-runtime-deps
    // asserts the staged wrapper round-trips against that binary.
    assert.ok(
      build.indexOf('tsup') < build.indexOf('pack-native.js'),
      'tsup clean would wipe what pack-native just staged',
    )
    assert.ok(
      build.indexOf('pack-native.js') < build.indexOf('stage-runtime-deps.js'),
      'stage-runtime-deps asserts against the packed binary, so it must run after',
    )
  })

  it('bundle-only builds keep an escape hatch, under a name nobody reaches for by accident', () => {
    assert.equal(pkg.scripts['build:bundle'], 'tsup')
    // `dev` is watch mode — it legitimately skips the 6s staging step, and the
    // tsup onSuccess warning covers the resulting dist being unfit to run.
    assert.match(pkg.scripts.dev, /tsup --watch/)
  })

  it('there is exactly one complete build entry', () => {
    // Two entries that differ only in completeness is the whole failure mode.
    // Whichever one gets the shorter name wins, and the other rots unused.
    const complete = Object.entries(pkg.scripts).filter(
      ([name, cmd]) => name.startsWith('build') && cmd.includes('stage-runtime-deps.js'),
    )
    assert.deepEqual(
      complete.map(([n]) => n),
      ['build'],
      'a second complete build entry re-creates the split that caused this',
    )
    assert.equal(pkg.scripts['build:dist'], undefined, 'build:dist was the unused twin; do not revive it')
  })

  it('publish path still stages the CLI sqlite wrapper last', () => {
    // stage-runtime-deps writes the slim wrapper the desktop sidecar wants
    // (loaded with an explicit nativeBinding). The npm CLI needs the full
    // package instead — users rebuild better-sqlite3 themselves — so its
    // staging must overwrite, not precede.
    const prepack = pkg.scripts.prepack
    assert.ok(prepack.indexOf('run build') < prepack.indexOf('stage-cli-sqlite-wrapper.js'), prepack)
  })

  it('tauri keeps staging on its own — it can run without a prior root build', { skip: tauriConf === null ? 'desktop/src-tauri not in this tree' : false }, () => {
    // Redundant with `npm run build` when a release script runs both, and both
    // scripts are idempotent, so the cost is ~6s. Dropping it would leave
    // `tauri build` on its own producing a degraded sidecar.
    const before = JSON.parse(tauriConf!).build.beforeBuildCommand as string
    assert.match(before, /pack-native\.js/)
    assert.match(before, /stage-runtime-deps\.js/)
  })

  it('the bundle-only warning keys off the caller script body, not a name list', () => {
    // tsup's onSuccess fires at the end of step 1, when the payload is *supposed*
    // to be missing under `npm run build` — the next two links stage it. So the
    // warning has to ask who invoked it. Two ways to get this wrong, both of
    // which shipped for a moment while writing this: key off a hardcoded script
    // name (rots on rename) or key off nothing (warns on every complete build,
    // telling the reader to run the exact command they just ran).
    const cfg = read('../../tsup.config.ts')
    assert.match(cfg, /npm_lifecycle_event/, 'onSuccess must know who called it')
    const marker = cfg.match(/callerScript\.includes\('([^']+)'\)/)?.[1]
    assert.ok(marker, 'the suppression predicate is gone')
    assert.ok(
      pkg.scripts.build.includes(marker),
      `\`npm run build\` does not contain "${marker}" — every complete build would warn`,
    )
    assert.ok(
      !pkg.scripts['build:bundle'].includes(marker),
      `"${marker}" also matches the bundle-only entry — the warning would never fire`,
    )
  })

  it('the in-app source updater rebuilds through the complete entry', () => {
    // Source installs self-update by running this verbatim. Pointing it at a
    // bundle-only build would hand every source user a degraded runtime.
    const cmd = updater.match(/command = '(git pull[^']*)'/)?.[1]
    assert.ok(cmd, 'source-install update command not found')
    assert.match(cmd, /npm run build$/, `updater must not use a bundle-only entry: ${cmd}`)
  })
})
