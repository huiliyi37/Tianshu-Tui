import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeToolUse, type ToolPipelineDeps } from '../tool-pipeline.js'
import { createTurnBudget } from '../turn-budget.js'
import { fingerprintToolCall } from '../trace-store.js'
import type { EvidenceTrackerPublic } from '../evidence.js'
import { ArtifactStore } from '../../artifact/store.js'
import { _setSandboxBackendForTest, _resetSandboxBackendCache } from '../../tools/sandbox-profile.js'
import { isWriteGranted, _resetGrantsForTest } from '../../tools/path-grants.js'

const mockEvidence = {
  trackFileRead: () => {},
  trackFileModified: () => {},
  trackImpact: () => {},
  trackVerification: () => {},
  getState: () => ({
    filesRead: new Set<string>(),
    filesModified: new Set<string>(),
    verifications: [],
    deliveryStatus: 'unverified' as const,
    impactedFiles: new Set<string>(),
    impactedTests: new Set<string>(),
  }),
  getVerificationSummary: () => ({ total: 0, verified: 0, pending: 0, files: [] }),
  buildBadge: () => null,
  reset: () => {},
} satisfies EvidenceTrackerPublic

describe('executeToolUse', () => {
  function makeDeps(overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
    return {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
        hooks: null,
        lspEnabled: false,
        fileHistory: undefined,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        promptEngine: { markGitDirty: () => {} },
      } as any,
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      } as any,
      prewarm: { get: () => null, invalidate: () => {} } as any,
      evidence: mockEvidence,
      traceStore: { events: [], toolFingerprints: [] } as any,
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} } as any,
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      trajectory: { getEntries: () => [] } as any,
      getDoomLoopLevel: () => 'none' as const,
      latestRisk: { level: 'none' as const, reasons: [], suggestedAction: '' },
      sessionTurnCount: 1,
      sessionId: 'test-session',
      recordToolHistory: () => {},
      turnBudget: createTurnBudget(0),
      ...overrides,
    }
  }

  it('adds read-loop strategy signal after repeated diet no-info read_file results', async () => {
    const deps = makeDeps({
      trajectory: {
        getEntries: () => [
          {
            turn: 1,
            tool: 'read_file',
            target: 'src/agent/loop.ts',
            durationMs: 10,
            status: 'success',
            inputSummary: '',
            resultSummary: '[diet:redundant] re-read later',
          },
        ],
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '[diet:useless] retried successfully', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-read-loop', name: 'read_file', input: { file_path: 'src/agent/loop.ts' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.includes('[策略信号：读取循环]'))
    assert.ok(content.includes('grep / repo_graph / ask_user_question'))
  })

  it('does not add read-loop strategy signal for first diet placeholder', async () => {
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '[diet:redundant] re-read later', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-read-loop-first', name: 'read_file', input: { file_path: 'src/agent/loop.ts' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(!content.includes('[策略信号：读取循环]'))
  })

  it('VSW: injects verificationSnapshot into run_tests params when the manager returns a plan', async () => {
    let seen: any
    const deps = makeDeps({
      ownershipLedger: { getOwnedFiles: () => ['a.ts'], getBaselineHead: () => 'head1' } as any,
      verificationSnapshotManager: {
        prepare: (owned: string[]) => ({ path: '/snap/dir', snapshotRef: 'head1+diffX', decision: { snapshot: true } as any, ownedFiles: owned }),
        lastDecision: () => null,
        currentSnapshotRef: () => 'head1+diffX',
        destroy: () => {},
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async (_name: string, params: any) => { seen = params.verificationSnapshot; return { content: 'ok', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-rt', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.deepEqual(seen, { path: '/snap/dir', snapshotRef: 'head1+diffX' })
  })

  it('VSW: leaves verificationSnapshot unset when the manager returns null (in-place)', async () => {
    let seen: any = 'sentinel'
    const deps = makeDeps({
      ownershipLedger: { getOwnedFiles: () => [], getBaselineHead: () => '' } as any,
      verificationSnapshotManager: {
        prepare: () => null,
        lastDecision: () => null,
        currentSnapshotRef: () => undefined,
        destroy: () => {},
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async (_name: string, params: any) => { seen = params.verificationSnapshot; return { content: 'ok', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-rt2', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(seen, undefined)
  })

  it('A1: tool timeout cascades an abort into the underlying op before rejecting', async () => {
    let captured: AbortSignal | undefined
    let abortedInTool = false
    const loopController = new AbortController()
    const deps = makeDeps({
      abortSignal: loopController.signal,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          // Underlying op that only settles when its abortSignal fires — proves
          // that a tool-level timeout must cascade an abort (not merely reject the wrapper).
          execute: (_name: string, params: any) => {
            captured = params.abortSignal
            return new Promise((resolve) => {
              params.abortSignal?.addEventListener('abort', () => {
                abortedInTool = true
                resolve({ content: 'aborted', isError: true })
              }, { once: true })
            })
          },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false, timeoutMs: () => 20 }),
          needsApproval: () => false,
        } as any,
      } as any,
    })

    await executeToolUse(
      { id: 'tu-timeout', name: 'grep', input: { pattern: 'x' } },
      deps, noopCallbacks as any, 1, false,
    ).catch(() => {})

    assert.ok(captured, 'tool received a composed abortSignal via params')
    assert.equal(captured!.aborted, true, 'composed signal aborted when the tool timed out')
    assert.equal(abortedInTool, true, 'underlying op observed the abort')
    assert.equal(loopController.signal.aborted, false, 'loop signal itself is not aborted by a single tool timeout')
  })

  it('records applied plan_close as file_write in task ledger', async () => {
    const events: any[] = []
    const owned: string[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
      } as any,
      ownershipLedger: {
        registerOwned: (file: string) => { owned.push(file) },
        getOwnedFiles: () => owned,
        getBaselineHead: () => '',
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'Plan closed: docs/superpowers/plans/demo.md', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-plan-close-apply', name: 'plan_close', input: { file_path: 'docs/superpowers/plans/demo.md', tasks: '1', apply: true } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'file_write')
    assert.equal(event.path, 'docs/superpowers/plans/demo.md')
    assert.deepEqual(owned, ['docs/superpowers/plans/demo.md'])
  })

  it('records preview plan_close as tool_exec without owning the file', async () => {
    const events: any[] = []
    const owned: string[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
        getOwnedFiles: () => owned,
      } as any,
      ownershipLedger: {
        registerOwned: (file: string) => { owned.push(file) },
        getOwnedFiles: () => owned,
        getBaselineHead: () => '',
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'Plan close preview: docs/superpowers/plans/demo.md', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-plan-close-preview', name: 'plan_close', input: { file_path: 'docs/superpowers/plans/demo.md', tasks: '1', apply: false } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'tool_exec')
    assert.equal(event.tool, 'plan_close')
    assert.equal(event.path, 'docs/superpowers/plans/demo.md')
    assert.deepEqual(owned, [])
  })

  it('warns before editing sensitive paths when manifest was not read', async () => {
    const events: any[] = []
    const callbackChunks: string[] = []
    const deps = makeDeps({
      taskLedger: {
        getEvents: () => [],
        record: (event: any) => { events.push(event) },
        getOwnedFiles: () => events.filter(e => e.type === 'file_write').map(e => e.path),
      } as any,
      ownershipLedger: {
        registerOwned: () => {},
        getOwnedFiles: () => [],
        getBaselineHead: () => '',
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'edited', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onToolResult: (_id: string, _name: string, content: string) => { callbackChunks.push(content) } }

    await executeToolUse(
      { id: 'tu-sensitive-edit', name: 'edit_file', input: { file_path: 'src/context/project-memory-loader.ts' } },
      deps, callbacks as any, 1, false,
    )

    assert.ok(callbackChunks.some(chunk => chunk.includes('Sensitive-area preflight required')))
    assert.ok(callbackChunks.some(chunk => chunk.includes('.rivet/knowledge/manifest.md')))
  })

  it('does not warn for sensitive edits after manifest was read', async () => {
    const callbackChunks: string[] = []
    const deps = makeDeps({
      taskLedger: {
        getEvents: () => [{ type: 'file_read', path: '.rivet/knowledge/manifest.md', timestamp: Date.now() }],
        record: () => {},
        getOwnedFiles: () => [],
      } as any,
      ownershipLedger: {
        registerOwned: () => {},
        getOwnedFiles: () => [],
        getBaselineHead: () => '',
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'edited', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onToolResult: (_id: string, _name: string, content: string) => { callbackChunks.push(content) } }

    await executeToolUse(
      { id: 'tu-sensitive-edit-after-read', name: 'edit_file', input: { file_path: 'src/context/project-memory-loader.ts' } },
      deps, callbacks as any, 1, false,
    )

    assert.ok(!callbackChunks.some(chunk => chunk.includes('Sensitive-area preflight required')))
  })

  it('records run_tests as verification in task ledger', async () => {
    const events: any[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-ledger-run-tests', name: 'run_tests', input: { filter: 'src/foo.test.ts' } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'verification')
    assert.equal(event.command, 'run_tests src/foo.test.ts')
    assert.equal(event.status, 'passed')
    assert.equal(event.meta.scope, 'targeted')
  })

  it('marks git dirty after successful deliver_task commit', async () => {
    const events: any[] = []
    let gitDirtyCalls = 0
    const base = makeDeps()
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
      } as any,
      config: {
        ...base.config,
        promptEngine: {
          markGitDirty: () => { gitDirtyCalls++ },
        },
      } as any,
    })
    await executeToolUse(
      { id: 'tu-deliver-commit', name: 'deliver_task', input: { commit: true, message: 'feat: x' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(gitDirtyCalls, 1, 'markGitDirty must be called after successful deliver_task commit')
    const event = events.at(-1)
    assert.equal(event.type, 'git_action')
  })

  it('does not mark git dirty for deliver_task readiness check (commit=false)', async () => {
    let gitDirtyCalls = 0
    const base = makeDeps()
    const deps = makeDeps({
      taskLedger: { record: () => {} } as any,
      config: {
        ...base.config,
        promptEngine: {
          markGitDirty: () => { gitDirtyCalls++ },
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-deliver-check', name: 'deliver_task', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(gitDirtyCalls, 0)
  })

  it('records run_tests parsed verification counts in task ledger meta', async () => {
    const events: any[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({
            content: 'Exit code: 1\n0 passed, 0 failed, 0 skipped',
            isError: true,
            verification: {
              command: 'tsx --test src/foo.test.ts',
              status: 'failed',
              scope: 'targeted',
              exitCode: 1,
              passed: 0,
              failed: 0,
              skipped: 0,
              durationMs: 25,
            },
          }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-ledger-run-tests-failed', name: 'run_tests', input: { filter: 'src/foo.test.ts' } },
      deps, noopCallbacks as any, 1, false,
    )

    const event = events.at(-1)
    assert.equal(event.type, 'verification')
    assert.equal(event.command, 'run_tests src/foo.test.ts')
    assert.equal(event.status, 'failed')
    assert.deepEqual(event.meta, {
      scope: 'targeted',
      exitCode: 1,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 25,
      resolvedCommand: 'tsx --test src/foo.test.ts',
      recommendedCommand: 'tsx --test src/foo.test.ts',
    })
  })

  it('records failed bash typecheck as failed verification', async () => {
    const events: any[] = []
    const deps = makeDeps({
      taskLedger: {
        record: (event: any) => { events.push(event) },
      } as any,
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'type error', isError: true }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-ledger-tsc', name: 'bash', input: { command: 'npx tsc --noEmit' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.deepEqual(events.at(-1), {
      type: 'verification',
      command: 'npx tsc --noEmit',
      status: 'failed',
      meta: { scope: 'full' },
    })
  })

  const noopCallbacks = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
    onCheckpoint: () => {},
  }

  it('R2: blocks write_file when another session holds an exclusive claim (fail-closed)', async () => {
    let executed = false
    const fakeRegistry = {
      acquireClaim: (_sid: string, _path: string, _type: string) => false,
      checkClaim: (filePath: string) => ({ sessionId: 'peer-1234abcd', claimType: 'exclusive', filePath }),
    }
    let resultMsg = ''
    const callbacks = {
      ...noopCallbacks,
      onToolResult: (_id: string, _name: string, content: string, isError?: boolean) => {
        if (isError) resultMsg = content
      },
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { executed = true; const r = await execute(); return { content: r.content, isError: false, retried: false } },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-w', name: 'write_file', input: { file_path: 'foo.ts', content: 'x' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal((result.toolResult as any).is_error, true, 'must be an error tool result')
    assert.equal(executed, false, 'harness must NOT execute the write when claim is contested')
    assert.match((result.toolResult as any).content as string, /另一个会话/)
    assert.match(resultMsg, /阻断/)
  })

  it('R2: allows write_file when the claim is uncontended (acquireClaim true)', async () => {
    let executed = false
    const fakeRegistry = {
      acquireClaim: (_sid: string, _path: string, _type: string) => true,
      checkClaim: () => null,
    }
    const deps = makeDeps({
      sessionRegistry: fakeRegistry as any,
      sessionId: 'mine',
      harness: {
        executeTool: async ({ execute }: any) => { executed = true; const r = await execute(); return { content: r.content, isError: r.isError ?? false, retried: false } },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-w2', name: 'write_file', input: { file_path: 'foo.ts', content: 'x' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(executed, true, 'uncontended write must reach the harness (not blocked)')
    assert.doesNotMatch((result.toolResult as any).content as string, /阻断/, 'must not be the R2 block message')
  })

  it('executes a tool and returns result', async () => {
    const deps = makeDeps()
    const result = await executeToolUse(
      { id: 'tu-1', name: 'read_file', input: { file_path: 'test.ts' } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.equal((result.toolResult as any).tool_use_id, 'tu-1')
    assert.equal((result.toolResult as any).content, 'ok\n── 观象（read_file）')
    assert.equal((result.toolResult as any).is_error, false)
    assert.equal(result.checkpointCreated, false)
  })

  it('traces grep input keys when pattern disappears during repair', async () => {
    const oldDebug = process.env.RIVET_DEBUG
    const oldToolInputDebug = process.env.RIVET_DEBUG_TOOL_INPUT
    const oldSessionDir = process.env.RIVET_SESSION_DIR
    const oldWarn = console.warn
    const traceDir = mkdtempSync(join(tmpdir(), 'tool-input-trace-'))
    const warnings: string[] = []
    delete process.env.RIVET_DEBUG
    delete process.env.RIVET_DEBUG_TOOL_INPUT
    // getSessionDir reads RIVET_SESSION_DIR; without this the trace file
    // writes to ~/.rivet/sessions/<slug> instead of the temp dir.
    process.env.RIVET_SESSION_DIR = join(traceDir, '.rivet', 'sessions')
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      const deps = makeDeps({
        config: {
          ...makeDeps().config,
          toolRegistry: {
            execute: async () => ({ content: 'Error: pattern is required (non-empty string)', isError: true }),
            get: () => ({
              definition: {
                input_schema: {
                  type: 'object',
                  properties: { pattern: { type: 'string' }, path: { type: 'string' }, context_lines: { type: 'integer' } },
                  required: ['pattern'],
                },
              },
              isConcurrencySafe: () => false,
            }),
            needsApproval: () => false,
          },
        } as any,
        repairPipeline: {
          run: () => ({
            output: { path: 'src/bootstrap.ts', context_lines: 10 },
            telemetry: [{ pass: 'test', fixType: 'dropPattern', toolName: 'grep', timestamp: 1 }],
          }),
        } as any,
        cwd: traceDir,
      })

      await executeToolUse(
        { id: 'tu-grep-trace', name: 'grep', input: { pattern: 'switchAgentRuntime', path: 'src/bootstrap.ts', context_lines: 10 } },
        deps, noopCallbacks as any, 1, false,
      )
    } finally {
      console.warn = oldWarn
      if (oldDebug === undefined) delete process.env.RIVET_DEBUG
      else process.env.RIVET_DEBUG = oldDebug
      if (oldToolInputDebug === undefined) delete process.env.RIVET_DEBUG_TOOL_INPUT
      else process.env.RIVET_DEBUG_TOOL_INPUT = oldToolInputDebug
      if (oldSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
      else process.env.RIVET_SESSION_DIR = oldSessionDir
    }

    assert.deepEqual(warnings, [], 'natural grep trace must not write directly to terminal stderr')
    const tracePath = join(traceDir, '.rivet', 'sessions', 'test-session', 'tool-input-trace.jsonl')
    assert.equal(existsSync(tracePath), true)
    const trace = readFileSync(tracePath, 'utf8')
    assert.match(trace, /\[tool-input-trace\]/)
    assert.match(trace, /id=tu-grep-trace/)
    assert.match(trace, /name=grep/)
    assert.match(trace, /isError=true/)
    assert.match(trace, /beforeHook=\["context_lines","path","pattern"\]/)
    assert.match(trace, /afterHook=\["context_lines","path","pattern"\]/)
    assert.match(trace, /afterRepair=\["context_lines","path"\]/)
    rmSync(traceDir, { recursive: true, force: true })
  })

  it('calls onToolResult callback', async () => {
    const deps = makeDeps()
    let called = false
    const cb = { ...noopCallbacks, onToolResult: () => { called = true } }
    await executeToolUse(
      { id: 'tu-2', name: 'read_file', input: { file_path: 'x.ts' } },
      deps, cb as any, 1, false,
    )
    assert.ok(called)
  })

  it('records success in repairHintTracker on success', async () => {
    let successCalled = false
    const deps = makeDeps({
      repairHintTracker: { recordSuccess: () => { successCalled = true }, recordFailure: () => {} } as any,
    })
    await executeToolUse(
      { id: 'tu-3', name: 'read_file', input: { file_path: 'y.ts' } },
      deps, noopCallbacks as any, 1, false,
    )
    assert.ok(successCalled)
  })

  it('truncates oversized successful tool results', async () => {
    const hugeContent = 'HEAD_MARKER' + 'x'.repeat(500_000) + 'TAIL_MARKER'
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        contextWindow: 10_000,
        toolRegistry: {
          execute: async () => ({ content: hugeContent, isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-5', name: 'read_file', input: { file_path: 'huge.txt' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.length < hugeContent.length)
    assert.ok(content.startsWith('HEAD_MARKER'))
    assert.ok(content.endsWith('── 观象（read_file）'))
    assert.match(content, /TAIL_MARKER/)
    assert.match(content, /\.\.\.\[truncated \d+ chars\]\.\.\./)
  })

  it('truncates oversized run_tests diagnosis results', async () => {
    const hugeContent = 'HEAD_MARKER' + 'x'.repeat(500_000) + 'TAIL_MARKER'
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        contextWindow: 10_000,
        toolRegistry: {
          execute: async () => ({ content: hugeContent, isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      repairPipeline: {
        run: (input: any) => ({
          output: input,
          telemetry: [{ pass: 'failure-classifier', kind: 'test_failure', suggestion: 'Run the focused failing test.' }],
        }),
      } as any,
    })

    const result = await executeToolUse(
      { id: 'tu-6', name: 'run_tests', input: { command: 'npm test' } },
      deps, noopCallbacks as any, 1, false,
    )

    const content = (result.toolResult as any).content as string
    assert.ok(content.length < hugeContent.length)
    assert.ok(content.startsWith('HEAD_MARKER'))
    assert.match(content, /\.\.\.\[truncated \d+ chars\]\.\.\./)
    assert.match(content, /TAIL_MARKER|Diagnosis:/)
  })

  it('blocks write tools in degraded reliability mode before approval', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      getReliabilityDecision: () => ({ mode: 'degraded', reason: 'resource pressure rising', blockedTools: ['bash_write'] }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }

    const result = await executeToolUse(
      { id: 'tu-degraded-write', name: 'bash', input: { command: 'echo hello > out.txt' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 0)
    assert.equal(executed, false)
    assert.equal((result.toolResult as any).is_error, true)
    assert.match((result.toolResult as any).content, /reliability mode: degraded/)
  })

  it('allows read-only tools in minimal reliability mode', async () => {
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'read', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      getReliabilityDecision: () => ({ mode: 'minimal', reason: 'memory pressure critical', blockedTools: ['bash'] }),
    })

    const result = await executeToolUse(
      { id: 'tu-minimal-read', name: 'read_file', input: { file_path: 'README.md' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(executed, true)
    assert.equal((result.toolResult as any).is_error, false)
  })

  it('requires approval for bash writes when NO sandbox boundary is active (fail-closed)', async () => {
    // Without a kernel sandbox the write could escape the workspace, so the
    // approval gate must stay closed even at high confidence.
    _setSandboxBackendForTest('none')
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.8, pressure: 0.2, confidence: 0.95, complexity: 0.2, freshness: 0.9, stability: 0.9 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    try {
      const result = await executeToolUse(
        { id: 'tu-bash-write', name: 'bash', input: { command: 'echo hello > out.txt' } },
        deps, callbacks as any, 1, false,
      )

      assert.equal(approvalCalls, 1)
      assert.equal(executed, false)
      assert.equal((result.toolResult as any).is_error, true)
      assert.match((result.toolResult as any).content, /requires user approval/)
    } finally {
      _resetSandboxBackendCache()
    }
  })

  it('autonomy-first: bash writes do NOT require approval when a sandbox boundary is active', async () => {
    // The kernel boundary confines writes to the workspace and B2 rollback makes
    // them reversible, so an unattended run must not be interrupted for approval.
    _setSandboxBackendForTest('seatbelt')
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.8, pressure: 0.2, confidence: 0.95, complexity: 0.2, freshness: 0.9, stability: 0.9 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    try {
      await executeToolUse(
        { id: 'tu-bash-write-sb', name: 'bash', input: { command: 'echo hello > out.txt' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(approvalCalls, 0, 'sandboxed bash write must not prompt for approval')
      assert.equal(executed, true, 'sandboxed bash write should execute')
    } finally {
      _resetSandboxBackendCache()
    }
  })

  it('lets explicit allowlist override bash write approval', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [{ tool: 'bash', params: { command: 'echo hello > out.txt' } }] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.8, pressure: 0.2, confidence: 0.95, complexity: 0.2, freshness: 0.9, stability: 0.9 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    const result = await executeToolUse(
      { id: 'tu-bash-allow', name: 'bash', input: { command: 'echo hello > out.txt' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 0)
    assert.equal(executed, true)
    assert.equal((result.toolResult as any).is_error, false)
  })

  it('dangerously-skip-permissions bypasses high-risk and bash-write approval prompts', async () => {
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'dangerously-skip-permissions',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'reset', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => true,
        },
      } as any,
      getSensorium: () => ({ momentum: 0.2, pressure: 0.9, confidence: 0.1, complexity: 0.9, freshness: 0.1, stability: 0.1 }),
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return false } }

    const result = await executeToolUse(
      { id: 'tu-danger-skip', name: 'bash', input: { command: 'git reset --hard HEAD~1' } },
      deps, callbacks as any, 1, false,
    )

    assert.equal(approvalCalls, 0)
    assert.equal(executed, true)
    assert.equal((result.toolResult as any).is_error, false)
  })

  it('out-of-workspace write_file forces an approval prompt even in auto-safe, and records a grant on approval', async () => {
    _resetGrantsForTest()
    const workspace = mkdtempSync(join(tmpdir(), 'rivet-ws-'))
    const external = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    const target = join(external, 'out.txt')
    let approvalCalls = 0
    let executed = false
    const deps = makeDeps({
      cwd: workspace,
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }
    try {
      const result = await executeToolUse(
        { id: 'tu-oow-write', name: 'write_file', input: { file_path: target, content: 'x' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(approvalCalls, 1, 'out-of-workspace write must prompt despite auto-safe')
      assert.equal(executed, true, 'op proceeds after approval')
      assert.equal((result.toolResult as any).is_error, false)
      assert.equal(isWriteGranted(target), true, 'subtree grant recorded on approval')
    } finally {
      _resetGrantsForTest()
      rmSync(external, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denying the out-of-workspace prompt blocks the op and records no grant', async () => {
    _resetGrantsForTest()
    const external = mkdtempSync(join(tmpdir(), 'rivet-ext-'))
    const target = join(external, 'out.txt')
    let executed = false
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => { executed = true; return { content: 'wrote', isError: false } },
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => false }
    try {
      const result = await executeToolUse(
        { id: 'tu-oow-deny', name: 'write_file', input: { file_path: target, content: 'x' } },
        deps, callbacks as any, 1, false,
      )
      assert.equal(executed, false)
      assert.equal((result.toolResult as any).is_error, true)
      assert.match((result.toolResult as any).content, /requires user approval/)
      assert.equal(isWriteGranted(target), false, 'no grant on denial')
    } finally {
      _resetGrantsForTest()
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('in-workspace read_file does not trigger the out-of-workspace gate', async () => {
    _resetGrantsForTest()
    let approvalCalls = 0
    const deps = makeDeps({
      config: {
        ...makeDeps().config,
        approvalMode: 'auto-safe',
        permissions: { allow: [] },
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })
    const callbacks = { ...noopCallbacks, onApprovalRequired: async () => { approvalCalls++; return true } }
    await executeToolUse(
      { id: 'tu-inws-read', name: 'read_file', input: { file_path: 'src/file.ts' } },
      deps, callbacks as any, 1, false,
    )
    assert.equal(approvalCalls, 0, 'in-workspace read must not prompt')
    _resetGrantsForTest()
  })

  it('P1.3: strips trailing whitespace from tool result content', async () => {
    const deps = makeDeps()
    // Override tool registry to return content with trailing whitespace.
    // bash → star sig "── 执令（bash）" is appended at the end, so the
    // raw content (before star sig) must not end with whitespace.
    ;(deps.config as any).toolRegistry.execute = async () => ({
      content: 'hello world  \t\n\n',
      isError: false,
    })
    const result = await executeToolUse(
      { id: 'tu-norm', name: 'bash', input: { command: 'echo hello' } },
      deps, noopCallbacks as any, 1, false,
    )
    const fullContent = (result.toolResult as any).content as string
    // Strip the star signature suffix to get the raw content
    const starSig = '\n── 执令（bash）'
    const rawContent = fullContent.endsWith(starSig)
      ? fullContent.slice(0, -starSig.length)
      : fullContent
    // Raw content (before star sig) must not end with whitespace
    assert.ok(!/\s$/.test(rawContent),
      `raw content must not end with whitespace, got: ${JSON.stringify(rawContent)}`)
    // Must still contain the payload
    assert.ok(rawContent.includes('hello world'),
      'tool result must still contain the payload')
  })

  describe('doom-loop blocked gate (deadlock fix)', () => {
    const cb = { onToolResult: () => {}, onApprovalRequired: async () => false } as any
    // A fingerprint window where read_file('looping.ts','error') repeats to the
    // blocking threshold — that exact call is the offender.
    function loopingTraceStore() {
      const offenderFp = fingerprintToolCall('read_file', { file_path: 'looping.ts' }, 'error')
      return { events: [], toolFingerprints: Array(6).fill(offenderFp), bashClassFingerprints: [] } as any
    }

    it('blocks the offending call when doomLevel is blocked', async () => {
      const deps = makeDeps({ getDoomLoopLevel: () => 'blocked' as const, traceStore: loopingTraceStore() })
      const result = await executeToolUse(
        { id: 'tu-offend', name: 'read_file', input: { file_path: 'looping.ts' } },
        deps, cb, 1, false,
      )
      assert.equal((result.toolResult as any).is_error, true)
      assert.ok(((result.toolResult as any).content as string).includes('Recovery: try a different tool'))
    })

    it('lets a DIFFERENT tool through under blocked — the deadlock fix', async () => {
      // Before the fix this returned is_error with "Repeated identical failures";
      // now a non-offending call executes normally so the window can refresh.
      let executed = false
      const deps = makeDeps({
        getDoomLoopLevel: () => 'blocked' as const,
        traceStore: loopingTraceStore(),
        config: {
          ...makeDeps().config,
          toolRegistry: {
            execute: async () => { executed = true; return { content: 'todo updated', isError: false } },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
      })
      const result = await executeToolUse(
        { id: 'tu-different', name: 'todo', input: { action: 'list' } },
        deps, cb, 1, false,
      )
      assert.equal(executed, true, 'different tool must actually execute under blocked')
      assert.notEqual((result.toolResult as any).is_error, true)
    })

    it('lets the same tool with DIFFERENT input through under blocked', async () => {
      let executed = false
      const deps = makeDeps({
        getDoomLoopLevel: () => 'blocked' as const,
        traceStore: loopingTraceStore(),
        config: {
          ...makeDeps().config,
          toolRegistry: {
            execute: async () => { executed = true; return { content: 'file body', isError: false } },
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
      })
      const result = await executeToolUse(
        { id: 'tu-diff-input', name: 'read_file', input: { file_path: 'other.ts' } },
        deps, cb, 1, false,
      )
      assert.equal(executed, true, 'same tool / different target must execute under blocked')
      assert.notEqual((result.toolResult as any).is_error, true)
    })
  })
})

// ── Artifact Intercept 端到端验证 ──────────────────────────────────────
// 验证 delegate_batch worker 内部 pipeline 的 artifactIntercept 行为：
// 1. 大输出非 read 工具 → 被拦截并持久化到磁盘
// 2. 返回内容变为 [artifact:ID] 摘要引用
// 3. read_file/read_section 不被拦截（模型的眼睛）；grep/glob/bash 等搜索工具在 3x 阈值下可拦截
// 4. 两个独立 ArtifactStore 实例互不干扰（worker 隔离）

describe('artifactIntercept in tool pipeline', () => {
  let tempDir: string
  let store: ArtifactStore

  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-artifact-test-'))
    store = new ArtifactStore(tempDir, 'test-session')
  }

  function cleanup() {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }

  function makeDepsWithStore(overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
    return {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'ok', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
        hooks: null,
        lspEnabled: false,
        fileHistory: undefined,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        promptEngine: { markGitDirty: () => {} },
      } as any,
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      } as any,
      prewarm: { get: () => null, invalidate: () => {} } as any,
      evidence: mockEvidence,
      traceStore: { events: [], toolFingerprints: [] } as any,
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} } as any,
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      trajectory: { getEntries: () => [] } as any,
      getDoomLoopLevel: () => 'none' as const,
      latestRisk: { level: 'none' as const, reasons: [], suggestedAction: '' },
      sessionTurnCount: 1,
      sessionId: 'test-session',
      recordToolHistory: () => {},
      turnBudget: createTurnBudget(0),
      artifactStore: store,
      ...overrides,
    }
  }

  const noopCallbacks = {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: () => {},
    onAbort: () => {},
    onApprovalRequired: async () => false,
    onCheckpoint: () => {},
  }

  it('intercepts large non-read tool output and persists to disk', async () => {
    setup()
    try {
      // 10000 chars — must exceed effective threshold.
      // With turnBudget.maxTokensPerTurn=0, remainingBudgetFraction defaults to 1,
      // triggering 3x scaling: 2500 * 3 = 7500. So 10000 > 7500.
      const largeOutput = 'A'.repeat(10000)
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: largeOutput, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-artifact-1', name: 'run_tests', input: { command: 'npm test' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      // Must be replaced with artifact reference
      assert.ok(content.startsWith('[artifact:'),
        `expected artifact reference, got: ${content.slice(0, 100)}`)
      assert.ok(content.includes('Use read_section'),
        'artifact ref should include read_section hint')
      // Must NOT contain the original large output
      assert.ok(!content.includes('AAAAA'),
        'original large output should not be inline')

      // Verify artifact was persisted to disk
      const artifacts = store.list()
      assert.equal(artifacts.length, 1, 'should have one artifact')
      const art = artifacts[0]!
      assert.equal(art.tool, 'run_tests')
      assert.equal(art.charCount, 10000)
      assert.ok(existsSync(art.rawPath), `artifact raw file should exist at ${art.rawPath}`)
      const diskContent = readFileSync(art.rawPath, 'utf-8')
      assert.equal(diskContent, largeOutput, 'disk content should match original output')
    } finally {
      cleanup()
    }
  })

  it('does NOT re-wrap grep output already carrying a trailing artifact ref (L0→L1 double-save)', async () => {
    setup()
    try {
      // Simulate an L0-wrapped grep result: large inline body + trailing [artifact:] marker.
      // 40000 chars exceeds the budget-scaled READ threshold (2500*3*3=22500 when
      // remainingBudgetFraction=1), so the current startsWith check would re-save.
      const l0Wrapped =
        'G'.repeat(40000) +
        '\n\nmatches summary\nUse read_section(artifactId="preexisting-l0", section="L1-L200") to expand.\n[artifact:preexisting-l0]'
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: l0Wrapped, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-grep-double', name: 'grep', input: { pattern: 'x' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      // L1 must NOT create a new artifact for an already-wrapped result.
      assert.equal(store.list().length, 0,
        'L1 must not double-save a grep result that already carries a trailing artifact ref')
      // The original L0 artifact ref must survive untouched.
      assert.ok(content.includes('[artifact:preexisting-l0]'),
        'original L0 artifact ref must survive')
    } finally {
      cleanup()
    }
  })

  it('does NOT intercept read_file output (read-class tool bypass)', async () => {
    setup()
    try {
      const largeOutput = 'B'.repeat(5000)
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: largeOutput, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-read-bypass', name: 'read_file', input: { file_path: 'big.ts' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      // read_file should NOT be intercepted — content stays inline
      // (may be truncated by truncateSuccessfulToolResult, but not wrapped in [artifact:])
      assert.ok(!content.startsWith('[artifact:'),
        `read_file should not be artifact-intercepted, got: ${content.slice(0, 100)}`)

      // No artifacts should be created
      assert.equal(store.list().length, 0, 'read_file should not create artifacts')
    } finally {
      cleanup()
    }
  })

  it('delivers a large skill body COMPLETE and inline (fidelity-exempt, no artifact, no truncation)', async () => {
    setup()
    try {
      // 20000 chars — well above the 7500 effective artifact threshold, so a
      // non-exempt tool (see run_tests test above) would be summarized to an
      // [artifact:...] ref. The skill tool must NOT: it loads instructions the
      // model will follow verbatim, so the body must arrive whole.
      const skillBody = `<skill name="huge">\n${'Z'.repeat(20000)}\n</skill>`
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: skillBody, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-skill-fidelity', name: 'skill', input: { name: 'huge' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(!content.startsWith('[artifact:'),
        `skill output must not be artifact-intercepted, got: ${content.slice(0, 100)}`)
      assert.ok(!content.includes('[truncated'),
        'skill output must not be head/tail truncated')
      assert.ok(!content.includes('<stored '),
        'skill output must not be collapsed to a budget preview')
      // The ENTIRE body survives intact.
      assert.ok(content.includes('Z'.repeat(20000)),
        'full skill body must be present inline')
      assert.equal(store.list().length, 0, 'skill should not create artifacts')
    } finally {
      cleanup()
    }
  })

  it('does NOT intercept small non-read tool output below threshold', async () => {
    setup()
    try {
      const smallOutput = 'C'.repeat(500) // well below 2500-char threshold
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: smallOutput, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-small', name: 'bash', input: { command: 'echo hello' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(!content.startsWith('[artifact:'),
        'small output should not be artifact-intercepted')
      assert.equal(store.list().length, 0, 'small output should not create artifacts')
    } finally {
      cleanup()
    }
  })

  it('intercepts large error output from non-read tool', async () => {
    setup()
    try {
      const largeError = 'Error: something went wrong\n'.repeat(200) // ~6000 chars
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: largeError, isError: true }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-error-artifact', name: 'run_tests', input: { command: 'npm test' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      // Error output above threshold should be artifact-intercepted
      assert.ok(content.startsWith('[artifact:'),
        `expected artifact reference for large error, got: ${content.slice(0, 100)}`)
      // Error artifacts include an excerpt for debugging
      assert.ok(content.includes('Error'),
        'error artifact should include error excerpt')

      const artifacts = store.list()
      assert.equal(artifacts.length, 1)
      assert.ok(existsSync(artifacts[0]!.rawPath))
    } finally {
      cleanup()
    }
  })

  it('does NOT intercept read-only bash commands (cat, grep, git log)', async () => {
    setup()
    try {
      const largeOutput = 'D'.repeat(5000)
      const deps = makeDepsWithStore({
        config: {
          ...makeDepsWithStore().config,
          toolRegistry: {
            execute: async () => ({ content: largeOutput, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
      })

      const result = await executeToolUse(
        { id: 'tu-bash-read', name: 'bash', input: { command: 'cat /tmp/big.txt' } },
        deps, noopCallbacks as any, 1, false,
      )

      const content = (result.toolResult as any).content as string
      assert.ok(!content.startsWith('[artifact:'),
        'read-only bash (cat) should not be artifact-intercepted')
      assert.equal(store.list().length, 0)
    } finally {
      cleanup()
    }
  })

  it('two ArtifactStore instances are isolated (worker independence)', async () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'rivet-worker-a-'))
    const dir2 = mkdtempSync(join(tmpdir(), 'rivet-worker-b-'))
    try {
      const storeA = new ArtifactStore(dir1, 'worker-a')
      const storeB = new ArtifactStore(dir2, 'worker-b')

      // Save artifact in store A
      const idA = await storeA.save({
        tool: 'run_tests',
        target: 'npm test',
        rawContent: 'A'.repeat(5000),
        summary: 'test output A',
        sections: [],
      })

      // Save different artifact in store B
      const idB = await storeB.save({
        tool: 'bash',
        target: 'echo hello',
        rawContent: 'B'.repeat(3000),
        summary: 'test output B',
        sections: [],
      })

      // Verify isolation: store A only has A's artifact
      assert.equal(storeA.list().length, 1)
      assert.equal(storeA.list()[0]!.id, idA)
      assert.equal(storeA.list()[0]!.tool, 'run_tests')

      // Verify isolation: store B only has B's artifact
      assert.equal(storeB.list().length, 1)
      assert.equal(storeB.list()[0]!.id, idB)
      assert.equal(storeB.list()[0]!.tool, 'bash')

      // Cross-store lookups return null
      assert.equal(storeA.get(idB), null, 'store A should not find store B artifact')
      assert.equal(storeB.get(idA), null, 'store B should not find store A artifact')

      // Disk paths are in separate directories
      assert.ok(storeA.list()[0]!.rawPath.startsWith(dir1))
      assert.ok(storeB.list()[0]!.rawPath.startsWith(dir2))

      // Verify disk files are independent
      const contentA = await storeA.readRaw(idA)
      assert.equal(contentA!.length, 5000)
      const contentB = await storeB.readRaw(idB)
      assert.equal(contentB!.length, 3000)
    } finally {
      try { rmSync(dir1, { recursive: true, force: true }) } catch { /* */ }
      try { rmSync(dir2, { recursive: true, force: true }) } catch { /* */ }
    }
  })

  it('delegate_batch scenario: two workers with independent artifact stores', async () => {
    // Simulates the delegate_batch end-to-end scenario:
    // Worker 1 (code_scout) produces large output → artifact intercepted
    // Worker 2 (reviewer) produces large output → artifact intercepted
    // Each worker has its own ArtifactStore, artifacts don't leak across stores
    const dir1 = mkdtempSync(join(tmpdir(), 'rivet-batch-w1-'))
    const dir2 = mkdtempSync(join(tmpdir(), 'rivet-batch-w2-'))
    try {
      const store1 = new ArtifactStore(dir1, 'worker-wo_1')
      const store2 = new ArtifactStore(dir2, 'worker-wo_2')

      const largeOutput1 = 'Worker1 findings: '.repeat(600) // ~10800 chars (>7500 effective threshold)
      const largeOutput2 = 'Worker2 review: '.repeat(600) // ~9600 chars

      // Worker 1: inspect_project tool with large output (no L0 wrap → L1 intercepts)
      const deps1 = makeDepsWithStore({
        artifactStore: store1,
        config: {
          ...makeDepsWithStore().config,
          sessionId: 'worker-wo_1',
          toolRegistry: {
            execute: async () => ({ content: largeOutput1, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
        sessionId: 'worker-wo_1',
      })

      // Worker 2: run_tests tool with large output
      const deps2 = makeDepsWithStore({
        artifactStore: store2,
        config: {
          ...makeDepsWithStore().config,
          sessionId: 'worker-wo_2',
          toolRegistry: {
            execute: async () => ({ content: largeOutput2, isError: false }),
            get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
            needsApproval: () => false,
          },
        } as any,
        sessionId: 'worker-wo_2',
      })

      // Execute both workers
      const result1 = await executeToolUse(
        { id: 'tu-w1', name: 'inspect_project', input: {} },
        deps1, noopCallbacks as any, 1, false,
      )
      const result2 = await executeToolUse(
        { id: 'tu-w2', name: 'run_tests', input: { command: 'npm test' } },
        deps2, noopCallbacks as any, 1, false,
      )

      // Both should be artifact-intercepted
      const content1 = (result1.toolResult as any).content as string
      const content2 = (result2.toolResult as any).content as string
      assert.ok(content1.startsWith('[artifact:'), 'worker 1 output should be artifact-ref')
      assert.ok(content2.startsWith('[artifact:'), 'worker 2 output should be artifact-ref')

      // Verify isolation: each store has exactly one artifact
      assert.equal(store1.list().length, 1, 'store 1 should have 1 artifact')
      assert.equal(store2.list().length, 1, 'store 2 should have 1 artifact')

      // Artifact IDs are different
      const id1 = store1.list()[0]!.id
      const id2 = store2.list()[0]!.id
      assert.notEqual(id1, id2, 'artifact IDs should be different across workers')

      // Cross-store isolation
      assert.equal(store1.get(id2), null, 'store 1 should not find store 2 artifact')
      assert.equal(store2.get(id1), null, 'store 2 should not find store 1 artifact')

      // Disk files are in separate directories
      assert.ok(existsSync(store1.list()[0]!.rawPath))
      assert.ok(existsSync(store2.list()[0]!.rawPath))
      assert.ok(store1.list()[0]!.rawPath.startsWith(dir1))
      assert.ok(store2.list()[0]!.rawPath.startsWith(dir2))
    } finally {
      try { rmSync(dir1, { recursive: true, force: true }) } catch { /* */ }
      try { rmSync(dir2, { recursive: true, force: true }) } catch { /* */ }
    }
  })
})

// ─── Phase-aware prediction recording (TDD RED fix) ──

describe('phase-aware prediction recording', () => {
  function makeDeps(overrides?: Partial<ToolPipelineDeps>): ToolPipelineDeps {
    return {
      config: {
        toolRegistry: {
          execute: async () => ({ content: 'test output', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
        hooks: null,
        lspEnabled: false,
        fileHistory: undefined,
        contextClaimStore: undefined,
        sessionId: 'test-session',
        promptEngine: { markGitDirty: () => {} },
      } as any,
      cwd: '/tmp/test',
      harness: {
        executeTool: async ({ execute }: any) => {
          const r = await execute()
          return { content: r.content, isError: r.isError ?? false, retried: false }
        },
      } as any,
      prewarm: { get: () => null, invalidate: () => {} } as any,
      evidence: mockEvidence,
      traceStore: { events: [], toolFingerprints: [] } as any,
      repairHintTracker: { recordSuccess: () => {}, recordFailure: () => {} } as any,
      repairPipeline: { run: (input: any) => ({ output: input, telemetry: [] }) } as any,
      importGraph: null,
      lastConflictCheckCount: 0,
      trajectory: { getEntries: () => [] } as any,
      getDoomLoopLevel: () => 'none' as const,
      latestRisk: { level: 'none' as const, reasons: [], suggestedAction: '' },
      sessionTurnCount: 1,
      sessionId: 'test-session',
      recordToolHistory: () => {},
      turnBudget: createTurnBudget(0),
      ...overrides,
    }
  }

  const noopCallbacks = { onWrite: () => {}, onRead: () => {}, onBash: () => {}, onEdit: () => {}, onToolResult: () => {}, onApprovalRequired: async () => true }

  it('does NOT record prediction for run_tests failure in verify phase (TDD RED)', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      phaseHint: 'verify',
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '1 test failed', isError: true }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-tdd-red', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, undefined, 'TDD RED in verify phase should NOT record prediction')
  })

  it('DOES record prediction for run_tests failure in execute phase (real bug)', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      phaseHint: 'execute',
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '1 test failed', isError: true }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-bug-red', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, false, 'run_tests failure in execute phase should record as prediction error')
  })

  it('DOES record prediction for non-run_tests failure regardless of phase', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      phaseHint: 'verify',
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'file not found', isError: true }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-read-fail', name: 'read_file', input: { file_path: 'nonexistent' } },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, false, 'non-run_tests failures always record prediction')
  })

  it('DOES record prediction for run_tests success in verify phase (TDD GREEN)', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      phaseHint: 'verify',
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: 'all tests passed', isError: false }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-tdd-green', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, true, 'run_tests success in verify phase should record as correct prediction')
  })

  it('phaseHint defaults to execute — verify exemption does NOT trigger', async () => {
    let recorded: boolean | undefined = undefined
    const deps = makeDeps({
      // phaseHint NOT set — should default to 'execute'
      recordPrediction: (correct: boolean) => { recorded = correct },
      config: {
        ...makeDeps().config,
        toolRegistry: {
          execute: async () => ({ content: '1 test failed', isError: true }),
          get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
          needsApproval: () => false,
        },
      } as any,
    })

    await executeToolUse(
      { id: 'tu-no-phase', name: 'run_tests', input: {} },
      deps, noopCallbacks as any, 1, false,
    )

    assert.equal(recorded, false, 'without phaseHint, run_tests failure records as prediction error')
  })
})
