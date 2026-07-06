import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ToolRegistry } from '../../tools/registry.js'
import { initializePlugins } from '../plugin-loader.js'
import type { Tool } from '../../tools/types.js'

function dummyTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `Dummy tool ${name}`,
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: 'ok' }),
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

/** Create a fresh isolated plugins dir for a single test. */
function freshEnv(): { pluginsDir: string; pluginsSubdir: string } {
  const pluginsDir = join(process.cwd(), '.rivet', `plugin-test-${randomUUID()}`)
  const pluginsSubdir = join(pluginsDir, 'plugins')
  mkdirSync(pluginsSubdir, { recursive: true })
  return { pluginsDir, pluginsSubdir }
}

/** Set up a fake plugin directory structure. */
function setupPlugin(baseDir: string, dirName: string, opts: {
  pkgJson?: Record<string, unknown>
  entryContent?: string
} = {}): string {
  const pluginDir = join(baseDir, dirName)
  mkdirSync(pluginDir, { recursive: true })

  const pkgJson = opts.pkgJson ?? {
    name: dirName,
    version: '1.0.0',
    tianshu: {
      name: dirName,
      version: '1.0.0',
      description: 'Test plugin',
      entry: 'index.js',
      tools: [{ name: `${dirName}_tool`, description: 'A test tool' }],
      permissions: { fs: true },
    },
  }
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(pkgJson))

  if (opts.entryContent !== undefined) {
    writeFileSync(join(pluginDir, 'index.js'), opts.entryContent)
  }

  return pluginDir
}

describe('initializePlugins', () => {
  const origHome = process.env.RIVET_HOME
  const activeDirs: string[] = []

  after(() => {
    process.env.RIVET_HOME = origHome ?? ''
    if (origHome === undefined) delete process.env.RIVET_HOME
    for (const dir of activeDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  function setHome(dir: string) {
    activeDirs.push(dir)
    process.env.RIVET_HOME = dir
  }

  it('returns empty result when plugins dir is empty', async () => {
    const { pluginsDir } = freshEnv()
    setHome(pluginsDir)

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    assert.equal(result.scanned, 0)
    assert.equal(result.loaded, 0)
    assert.equal(result.totalTools, 0)
    assert.deepEqual(result.suppressTools, [])
  })

  it('loads a valid plugin and registers its tools', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'hello-plugin', {
      entryContent: `
export const tools = [{
  definition: { name: 'hello_tool', description: 'Hello', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'hello' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    assert.equal(result.scanned, 1)
    assert.equal(result.loaded, 1)
    assert.equal(result.totalTools, 1)
    assert.ok(registry.has('hello_tool'))
  })

  it('skips plugin with invalid manifest', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'bad-plugin', {
      pkgJson: {
        name: 'bad-plugin',
        version: '1.0.0',
        tianshu: { name: 'bad-plugin' }, // missing required fields
      },
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const bad = result.results.find(r => r.pluginName === 'bad-plugin')
    assert.ok(bad)
    assert.equal(bad!.status, 'skipped_invalid_manifest')
    assert.equal(result.loaded, 0)
  })

  it('skips plugin with no tianshu field', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'no-tianshu', {
      pkgJson: { name: 'no-tianshu', version: '1.0.0' },
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'no-tianshu')
    assert.ok(item)
    assert.equal(item!.status, 'skipped_no_manifest')
    assert.equal(result.loaded, 0)
  })

  it('skips disabled plugin', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'disabled-plugin', {
      entryContent: `
export const tools = [{
  definition: { name: 'disabled_tool', description: 'x', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'x' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(
      { enabled: { 'disabled-plugin': false } },
      registry,
      process.cwd(),
    )
    const item = result.results.find(r => r.pluginName === 'disabled-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'skipped_disabled')
    assert.equal(result.loaded, 0)
  })

  it('rejects plugin with conflicting tool names', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'conflict-plugin', {
      entryContent: `
export const tools = [{
  definition: { name: 'read_file', description: 'Conflicting read', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'x' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    registry.register(dummyTool('read_file')) // pre-existing built-in

    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'conflict-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'skipped_conflict')
    assert.ok(item!.error?.includes('read_file'))
  })

  it('returns suppressTools based on loaded plugins', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'office-pdf', {
      entryContent: `
export const tools = [{
  definition: { name: 'pdf_create', description: 'Create PDF', input_schema: { type: 'object', properties: {} } },
  execute: async () => ({ content: 'pdf' }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    registry.register(dummyTool('create_pdf')) // built-in HTML tool

    const result = await initializePlugins(undefined, registry, process.cwd())
    assert.ok(result.suppressTools.includes('create_pdf'))
    assert.equal(result.loaded, 1)
  })

  it('isolation: skips plugin with import error, does not block startup', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'crash-plugin', {
      entryContent: `throw new Error('Boom!')`,
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'crash-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'skipped_import_error')
  })

  it('rejects plugin with entry path escaping plugin dir', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'escape-plugin', {
      pkgJson: {
        name: 'escape-plugin',
        version: '1.0.0',
        tianshu: {
          name: 'escape-plugin',
          version: '1.0.0',
          description: 'Evil plugin',
          entry: '../../etc/passwd',
          tools: [{ name: 'evil_tool', description: 'x' }],
          permissions: {},
        },
      },
    })

    const registry = new ToolRegistry()
    const result = await initializePlugins(undefined, registry, process.cwd())
    const item = result.results.find(r => r.pluginName === 'escape-plugin')
    assert.ok(item)
    assert.equal(item!.status, 'skipped_import_error')
    assert.ok(item!.error?.includes('escapes'))
  })

  it('path safety: blocks sensitive file reads via plugin tool', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'reader-plugin', {
      entryContent: `
export const tools = [{
  definition: {
    name: 'reader_tool',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to read' },
      },
      required: ['file_path'],
    },
  },
  execute: async (params) => ({ content: 'read ' + params.file_path }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    await initializePlugins(undefined, registry, process.cwd())
    assert.ok(registry.has('reader_tool'))

    const tool = registry.get('reader_tool')!
    // Should block .env read
    const result = await tool.execute({ file_path: '.env' } as any)
    assert.ok(result.isError)
    assert.ok(result.content.includes('Sensitive file blocked') || result.content.includes('sensitive'))
  })

  it('path safety: blocks path escape via plugin tool', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'writer-plugin', {
      entryContent: `
export const tools = [{
  definition: {
    name: 'writer_tool',
    description: 'Write a file',
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: 'Output path' },
      },
      required: ['destination_path'],
    },
  },
  execute: async (params) => ({ content: 'wrote ' + params.destination_path }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    await initializePlugins(undefined, registry, process.cwd())
    assert.ok(registry.has('writer_tool'))

    const tool = registry.get('writer_tool')!
    // Should block escape to /etc/passwd
    const result = await tool.execute({ destination_path: '/etc/passwd' } as any)
    assert.ok(result.isError)
    assert.ok(result.content.includes('outside') || result.content.includes('escapes') || result.content.includes('not allowed'))
  })

  it('path safety: allows legitimate in-workspace paths', async () => {
    const { pluginsDir, pluginsSubdir } = freshEnv()
    setHome(pluginsDir)

    setupPlugin(pluginsSubdir, 'safe-plugin', {
      entryContent: `
export const tools = [{
  definition: {
    name: 'safe_tool',
    description: 'Process a file safely',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Input file' },
        destination_path: { type: 'string', description: 'Output file' },
      },
    },
  },
  execute: async (params) => ({ content: 'processed ' + (params.file_path || '') }),
  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}];
`
    })

    const registry = new ToolRegistry()
    await initializePlugins(undefined, registry, process.cwd())
    const tool = registry.get('safe_tool')!

    // In-workspace paths should pass
    const result = await tool.execute({ file_path: 'package.json', destination_path: 'output.txt' } as any)
    assert.ok(!result.isError)
    assert.ok(result.content.includes('processed'))
  })
})
