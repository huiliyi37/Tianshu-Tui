import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildMirrorEnv, rewriteGitHubUrls, formatMirrorStatus } from '../mirror-env.js'
import type { MirrorsConfig } from '../../config/schema.js'

describe('mirror-env', () => {
  const base: MirrorsConfig = {
    enabled: false,
    preset: 'default',
    github: 'default',
    npm: 'default',
    pypi: 'default',
    go: 'default',
    rust: 'default',
  }

  describe('buildMirrorEnv', () => {
    it('returns empty env when disabled', () => {
      const env = buildMirrorEnv(base)
      assert.deepEqual(env, {})
    })

    it('injects china preset env vars', () => {
      const env = buildMirrorEnv({ ...base, enabled: true, preset: 'china' })
      assert.equal(env.npm_config_registry, 'https://registry.npmmirror.com')
      assert.equal(env.YARN_REGISTRY, 'https://registry.npmmirror.com')
      assert.equal(env.PNPM_REGISTRY, 'https://registry.npmmirror.com')
      assert.equal(env.PIP_INDEX_URL, 'https://pypi.tuna.tsinghua.edu.cn/simple')
      assert.equal(env.PIP_TRUSTED_HOST, 'pypi.tuna.tsinghua.edu.cn')
      assert.equal(env.GOPROXY, 'https://goproxy.cn,direct')
      assert.equal(env.RUSTUP_DIST_SERVER, 'https://mirrors.tuna.tsinghua.edu.cn/rustup')
      assert.equal(env.RUSTUP_UPDATE_ROOT, 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup')
    })

    it('respects per-ecosystem overrides', () => {
      const env = buildMirrorEnv({
        ...base,
        enabled: true,
        preset: 'china',
        npm: 'huawei',
        pypi: 'aliyun',
        go: 'aliyun',
        rust: 'ustc',
      })
      assert.equal(env.npm_config_registry, 'https://repo.huaweicloud.com/repository/npm/')
      assert.equal(env.PIP_INDEX_URL, 'https://mirrors.aliyun.com/pypi/simple/')
      assert.equal(env.PIP_TRUSTED_HOST, 'mirrors.aliyun.com')
      assert.equal(env.GOPROXY, 'https://mirrors.aliyun.com/goproxy/,direct')
      assert.equal(env.RUSTUP_DIST_SERVER, 'https://mirrors.ustc.edu.cn/rust-static')
      assert.equal(env.RUSTUP_UPDATE_ROOT, 'https://mirrors.ustc.edu.cn/rust-static/rustup')
    })

    it('default preset with explicit mirrors still works', () => {
      const env = buildMirrorEnv({
        ...base,
        enabled: true,
        preset: 'default',
        npm: 'taobao',
      })
      assert.equal(env.npm_config_registry, 'https://registry.npmmirror.com')
      assert.equal(env.PIP_INDEX_URL, undefined)
    })
  })

  describe('rewriteGitHubUrls', () => {
    it('does nothing when disabled', () => {
      const cmd = rewriteGitHubUrls('git clone https://github.com/foo/bar.git', base)
      assert.equal(cmd, 'git clone https://github.com/foo/bar.git')
    })

    it('rewrites github clone to gitcode with china preset', () => {
      const cmd = rewriteGitHubUrls('git clone https://github.com/foo/bar.git', { ...base, enabled: true, preset: 'china' })
      assert.equal(cmd, 'git clone https://gitcode.com/gh_mirror/foo/bar.git')
    })

    it('rewrites bare repo path without .git', () => {
      const cmd = rewriteGitHubUrls('git clone https://github.com/foo/bar', { ...base, enabled: true, github: 'kkgithub' })
      assert.equal(cmd, 'git clone https://kkgithub.com/foo/bar')
    })

    it('rewrites multiple github urls in one command', () => {
      const cmd = rewriteGitHubUrls('git clone https://github.com/a/b && git clone https://github.com/c/d.git', { ...base, enabled: true, github: 'fastgit' })
      assert.equal(cmd, 'git clone https://hub.fastgit.xyz/a/b && git clone https://hub.fastgit.xyz/c/d.git')
    })

    it('does not rewrite non-github urls', () => {
      const cmd = rewriteGitHubUrls('git clone https://gitlab.com/foo/bar.git', { ...base, enabled: true, preset: 'china' })
      assert.equal(cmd, 'git clone https://gitlab.com/foo/bar.git')
    })
  })

  describe('formatMirrorStatus', () => {
    it('reports disabled', () => {
      const text = formatMirrorStatus(base)
      assert.ok(text.includes('disabled'))
    })

    it('lists effective mirrors when enabled', () => {
      const text = formatMirrorStatus({ ...base, enabled: true, preset: 'china' })
      assert.ok(text.includes('enabled'))
      assert.ok(text.includes('GitCode GitHub 镜像'))
      assert.ok(text.includes('registry.npmmirror.com'))
    })
  })
})
