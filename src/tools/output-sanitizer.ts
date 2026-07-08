/**
 * Tool Output Sanitizer — 工具输出噪声裁剪(主控工作流缺口 B,2026-07-04)。
 *
 * 工具输出直接进会话历史,大量字节是上下文噪声:npm 的 spinner/进度、
 * test runner 的逐条 ✔ 通过行、ANSI 转义码。这些计入 input tokens 但
 * attention 信息量接近零。裁剪的不是 API 费用,是信息密度。
 *
 * 关键顺序约束(天枢文档核查修正):裁剪必须发生在失败分类器
 * (classifyFailure/classifyTestRun)、修复提示、artifact 拦截之后——
 * 它们依赖原始输出(stack trace、"Found N errors" 行)。接线点是
 * tool-execution.ts 的 addToolResults 边界:session 只存裁剪版,
 * UI 回调(onToolResult)在此之前已收到全文,保真不受影响。
 *
 * 保守原则:
 *   - 白名单规则(按 toolName + 命令特征),不做通用正则扫描
 *   - 失败诊断信息永不裁剪(✖ 行、error 行、assertion diff、stack)
 *   - 裁剪收益 < MIN_SAVINGS 时返回原文(不为几十字节引入抖动)
 *   - 裁空时保底一行摘要
 */

import { stripAnsi } from './run-tests.js'

/** 低于此字节数的输出不裁剪(收益不值得) */
const MIN_CONTENT_LENGTH = 500
/** 裁剪节省低于此字节数时返回原文 */
const MIN_SAVINGS = 200

export interface SanitizeResult {
  content: string
  /** 实际去除的字节数;0 = 未裁剪 */
  trimmedBytes: number
  /** 命中的 filter 名（用于遥测归因） */
  filterName?: string
}

const NPM_INSTALL_RE = /\bnpm\s+(install|i|ci|add|update)\b/
const TSC_RE = /\btsc\b/
const NODE_TEST_RE = /\b(node|tsx)\b[^|;&]*--test\b|\bnpm\s+(run\s+)?test\b/

/** npm 噪声行:日志级别前缀、spinner 残留、进度条、reify 内部计时 */
const NPM_NOISE_LINE_RE = /^(npm\s+(timing|http|sill|verb|notice)\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]*$|\[[#=.\s]*\]|reify:)/
/** test runner 逐条通过行(✔ / ok N / TAP 子测试通过)——失败诊断的反面,纯噪声 */
const TEST_PASS_LINE_RE = /^\s*(✔|ok\s+\d)/

function command(input: Record<string, unknown> | undefined): string {
  const cmd = input?.command
  return typeof cmd === 'string' ? cmd : ''
}

function withMarker(kept: string, original: string, fallback: string, filterName?: string): SanitizeResult {
  let content = kept.replace(/\n{3,}/g, '\n\n').trim()
  if (content.length === 0) content = fallback
  const trimmedBytes = original.length - content.length
  if (trimmedBytes < MIN_SAVINGS) return { content: original, trimmedBytes: 0 }
  return {
    content: `${content}\n[output trimmed: ${trimmedBytes} bytes of noise removed]`,
    trimmedBytes,
    filterName,
  }
}

// ── Line-level filter framework ──
// 借鉴 rtk-ai/rtk 的 per-command TOML filter 策略，用 TypeScript 原生实现。
// 三个原语：stripLines（正则删行）、maxLines（行数上限）、shortCircuit（短路摘要）。

interface LineFilter {
  /** 命令匹配正则（测试 input.command 字段）。更具体的规则排在注册表前面 */
  matchCommand: RegExp
  /** 要删除的行正则数组。诊断行（DIAGNOSTIC_LINE_RE）不受此影响 */
  stripLines?: RegExp[]
  /** 最大保留行数。超出时先保留诊断行，再从尾部取非诊断行补齐 */
  maxLines?: number
  /** 短路：输出包含此模式时直接返回摘要 */
  shortCircuit?: RegExp
  /** 是否剥离 ANSI（默认 true） */
  stripAnsi?: boolean
}

/** 诊断行保护：包含这些模式的行永远不会被 stripLines 删除或 maxLines 截断 */
const DIAGNOSTIC_LINE_RE = /✖|\b(?:error|fail|panic|traceback|exception|AssertionError)\b/i

/**
 * 行级过滤注册表。按命令分类，顺序 = 优先级（具体规则在前）。
 * 每条正则注释来源：匹配的真实命令字符串。
 */
const LINE_FILTERS: Record<string, LineFilter> = {
  // ── git diff ──
  // 来源：diff header + index/---/+++ 行是 metadata，保留 +/- 内容行
  'git-diff': {
    matchCommand: /\bgit\s+diff\b/,
    stripLines: [
      /^diff --git /,           // diff 头
      /^index [0-9a-f]+\.\./,   // index 行（hash 前缀可变长度）
      /^---\s/,                  // 源文件标记
      /^\+\+\+\s/,              // 目标文件标记
      /^@@\s+-?\d/,             // hunk header @@ -10,6 +10,8 @@
    ],
    maxLines: 80,
  },

  // ── git log ──
  // 来源：git log --oneline 每行一个 commit；无 stripLines，仅 maxLines 防超长
  'git-log': {
    matchCommand: /\bgit\s+log\b/,
    maxLines: 60,
  },

  // ── git status ──
  // 来源："On branch feat/x\nChanges not staged...\n\tmodified: file.ts"
  'git-status': {
    matchCommand: /\bgit\s+status\b/,
    stripLines: [
      /^On branch /,            // 分支信息行
      /^Your branch is /,       // ahead/behind 提示
      /^\s*\(.*\)$/,           // 提示括号行 (use "git add"...)
      /^Changes not staged/,    // 标题行
      /^no changes added/,      // 尾部无操作提示
      /^nothing to commit/,     // clean 工作区提示
    ],
  },

  // ── eslint / biome ──
  // 来源：eslint/biome 输出含 error/warning 行 + summary；clean 时输出 "✔ No issues"
  'eslint': {
    matchCommand: /\b(?:eslint|biome|npx\s+(?:eslint|@biomejs))\b/,
    shortCircuit: /✔.*(?:No issues|clean|No problems)|\d+ problems? \(0 errors/,
    stripLines: [/^\s*$/],       // 压缩空行
    maxLines: 40,
  },

  // ── ls ──
  // 来源：ls -la 输出 "drwxr-xr-x@ 3 user staff 96 Jan 1 12:00 dirname"
  // 只匹配带 flags 的 ls（裸 ls 输出很短无需过滤）
  'ls': {
    matchCommand: /\bls\s+(?:-|--)/,
    stripLines: [/^total \d+/],  // total 统计行
    maxLines: 40,
  },

  // ── grep ──
  // 来源：grep 输出 "file.ts:42:matched line content"——已有信息密度，仅 maxLines 防超长
  'grep': {
    matchCommand: /\bgrep\b/,
    maxLines: 80,
  },

  // ── find ──
  // 来源：find 输出路径列表，每行一个路径
  'find': {
    matchCommand: /\bfind\b/,
    maxLines: 60,
  },

  // ── pip install ──
  // 来源：pip install 输出含 "Collecting/Downloading/Installing" 阶段行
  'pip': {
    matchCommand: /\b(?:pip3?|uv\s+pip)\s+install\b/,
    stripLines: [
      /^Downloading\s/,               // 下载进度
      /^Collecting\s/,                 // collecting 阶段
      /^\s*Downloading.*%\|/,         // 进度条
      /^Installing collected/,         // 安装阶段标记
      /^\s*━/,                        // pip/uv 进度条字符
    ],
    shortCircuit: /already satisfied|Requirement already satisfied/,
    maxLines: 20,
  },

  // ── cargo build/test ──
  // 来源：cargo build 输出大量 "Compiling X vY.Z" 行，只留 error/warning + summary
  'cargo': {
    matchCommand: /\bcargo\s+(?:build|test|check|clippy)\b/,
    stripLines: [
      /^\s*Compiling\s/,   // 编译阶段（最多噪声）
      /^\s*Finished\s/,     // 完成标记
      /^\s*Running\s/,      // 运行标记
    ],
    maxLines: 30,
  },

  // ── docker pull/build ──
  // 来源：docker pull 输出逐层下载进度
  'docker': {
    matchCommand: /\bdocker\s+(?:pull|build|compose\s+(?:up|build))\b/,
    stripLines: [
      /^\s*(?:Pulling fs layer|Downloading.*%|Extracting|Pull complete)/,
      /^#[0-9a-f]{12}\s*\[/,  // build step 内部进度
    ],
    maxLines: 20,
  },

  // ── pnpm / yarn ──
  // 来源：pnpm install 输出 "Progress: resolved 123, reused 100, downloaded 23, added 50"
  // yarn 输出类似 npm 的 spinner + "Done in X.XXs"
  'pnpm-yarn': {
    matchCommand: /\b(?:pnpm|yarn)\s+(?:install|add|up|dlx|create)\b/,
    stripLines: [
      /^\s*(?:Progress:|Packages:|●|\│|├|└|\s){2,}/,  // pnpm progress tree / yarn step prefix
      /^Done in \d/,            // yarn "Done in 3.45s"
    ],
    shortCircuit: /Already up[ -]to[ -]date|Nothing to install/,
    maxLines: 25,
  },

  // ── go build / go test ──
  // 来源：go build 输出 "go: downloading github.com/foo v1.2.3"
  // go test 输出 "ok   pkg/name  0.123s" 或 "--- FAIL: TestName"
  'go': {
    matchCommand: /\bgo\s+(?:build|test|install|run|vet)\b/,
    stripLines: [
      /^go: downloading /,     // 依赖下载进度
      /^ok\s+\S+\s+\d/,        // 通过行 "ok   pkg  0.123s"（FAIL 行含 error 会被 DIAGNOSTIC 保护）
    ],
    maxLines: 40,
  },

  // ── ruff / mypy ──
  // 来源：ruff check 输出 "Found 3 errors (2 fixed, 1 remaining)"
  // mypy 输出 "Success: no issues found in 5 source files"
  'ruff': {
    matchCommand: /\b(?:ruff|mypy|pyright)\b/,
    shortCircuit: /(?:^|\n)(?:All good!|No errors? found|Success: no issues|0 errors?)/,
    stripLines: [
      /^\s*$/,                  // 空行压缩
    ],
    maxLines: 40,
  },

  // ── make ──
  // 来源：make 输出 "make: Nothing to be done for 'all'" 或 gcc/clang 编译行
  // 保留 error/warning/undefined reference 等诊断；strip 编译命令、进入目录行
  'make': {
    matchCommand: /\bmake\b/,
    stripLines: [
      /^(?:gcc|g\+\+|clang|cc)\s/,     // 编译命令 "gcc -c -o foo.o foo.c"
      /^make\[\d+\]: (?:Entering|Leaving)/, // 递归目录进入/退出
      /^ar cr /,                         // 归档命令
      /^(?:ranlib|strip)\s/,            // 后处理
    ],
    maxLines: 30,
  },

  // ── git push / fetch / remote ──
  // 来源：git push 输出 "Enumerating objects: 42, done. Writing objects: 100% (42/42)"
  'git-push': {
    matchCommand: /\bgit\s+(?:push|fetch|pull|remote\s+(?:add|update|set-url))\b/,
    stripLines: [
      /^(?:Enumerating|Counting|Compressing|Writing|Total|remote:|Resolving)/,
      /^\s*\d+%/,                         // 进度百分比
    ],
    shortCircuit: /Everything up[ -]to[ -]date|Already up[ -]to[ -]date/,
    maxLines: 15,
  },

  // ── terraform ──
  // 来源：terraform plan/apply 输出 "Refreshing state... [id=xxx]" 和 plan summary
  'terraform': {
    matchCommand: /\bterraform\s+(?:plan|apply|init|validate|fmt)\b/,
    stripLines: [
      /^data\.\S+: Reading\.\.\./,     // data source 读取
      /^\S+: (?:Refreshing|Creating|Modifying|Destroying)\.\.\./, // 资源操作进度
      /^\s*(?:\S+\.)+\S+: (?:Creation|Modification|Destruction) complete/,  // 完成行
    ],
    maxLines: 40,
  },

  // ── prettier ──
  // 来源：prettier --check 输出 "Checking formatting... [warn] src/foo.ts\n[warn] Code style issues found"
  // 或 prettier --write 输出 "src/foo.ts 123ms"
  'prettier': {
    matchCommand: /\b(?:prettier|npx\s+prettier)\b/,
    shortCircuit: /All matched files use Prettier|Code style issues found in .* file/,
    stripLines: [
      /^\s*$/,                  // 空行压缩
    ],
    maxLines: 30,
  },

  // ── uv sync / uv pip ──
  // 来源：uv sync 输出 "Resolved 150 packages in 2.3s\nPrepared 50 packages in 1.5s\nInstalled 50 packages in 0.8s"
  // uv 是新一代 Python 包管理器，输出比 pip 更紧凑但仍含进度条
  'uv': {
    matchCommand: /\buv\s+(?:sync|lock|pip\s+install|pip\s+compile|add|remove)\b/,
    stripLines: [
      /^\s*(?:Resolved|Prepared|Installed|Uninstalled|Audited)\s+\d+/,  // 阶段摘要
      /^\s*━/,                   // 进度条
      /^\s*(?:⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)/, // spinner
    ],
    shortCircuit: /Not modified|No changes|already satisfied/,
    maxLines: 20,
  },

  // ── jq / yq ──
  // 来源：jq '.field' data.json 输出结构化 JSON/行；超长输出 maxLines 截断
  'jq-yq': {
    matchCommand: /\b(?:jq|yq)\b/,
    maxLines: 40,
  },
}

/** 应用行级过滤。诊断行受 DIAGNOSTIC_LINE_RE 保护。 */
function applyLineFilter(name: string, filter: LineFilter, raw: string): SanitizeResult {
  const text = filter.stripAnsi === false ? raw : stripAnsi(raw)

  // 短路检查：输出匹配 shortCircuit 时返回简短摘要，跳过行级处理
  if (filter.shortCircuit && filter.shortCircuit.test(text)) {
    const msg = `[${name}: short-circuit matched]`
    const trimmedBytes = raw.length - msg.length
    if (trimmedBytes < MIN_SAVINGS) return { content: raw, trimmedBytes: 0 }
    return { content: msg, trimmedBytes, filterName: name }
  }

  let lines = text.split('\n')

  // 行级删除：诊断行受保护
  if (filter.stripLines && filter.stripLines.length > 0) {
    lines = lines.filter(line =>
      !filter.stripLines!.some(re => re.test(line)) || DIAGNOSTIC_LINE_RE.test(line),
    )
  }

  // maxLines 截断：诊断行不计入上限
  if (filter.maxLines && lines.length > filter.maxLines) {
    const diagnostic = lines.filter(l => DIAGNOSTIC_LINE_RE.test(l))
    const nonDiag = lines.filter(l => !DIAGNOSTIC_LINE_RE.test(l))
    const budget = Math.max(0, filter.maxLines - diagnostic.length)
    const tail = nonDiag.slice(-budget)
    const omitted = nonDiag.length - tail.length
    lines = [...diagnostic, ...tail]
    if (omitted > 0) lines.push(`... ${omitted} non-diagnostic lines trimmed (maxLines=${filter.maxLines}) ...`)
  }

  return withMarker(lines.join('\n'), raw, `${name}: output trimmed`, name)
}

/**
 * 裁剪工具输出。纯函数;调用方(tool-execution)负责 env 开关与遥测。
 * 返回原文(trimmedBytes=0)表示无需替换。
 */
export function sanitizeToolOutput(
  toolName: string,
  input: Record<string, unknown> | undefined,
  content: string,
): SanitizeResult {
  if (content.length < MIN_CONTENT_LENGTH) return { content, trimmedBytes: 0 }

  if (toolName === 'run_tests') {
    // run_tests 内容是格式化摘要,只剥 ANSI(其余已是有效信息)
    const clean = stripAnsi(content)
    const trimmedBytes = content.length - clean.length
    if (trimmedBytes < MIN_SAVINGS) return { content, trimmedBytes: 0 }
    return { content: clean, trimmedBytes }
  }

  if (toolName !== 'bash') return { content, trimmedBytes: 0 }

  const cmd = command(input)
  const clean = stripAnsi(content)
  const lines = clean.split('\n')

  if (TSC_RE.test(cmd)) {
    // 只留 error TS 行与统计尾行;无错误时保底一行
    const kept = lines.filter(l => /error TS\d+/.test(l) || /Found \d+ errors?/.test(l))
    return withMarker(kept.join('\n'), content, 'tsc: no errors reported', 'tsc')
  }

  if (NODE_TEST_RE.test(cmd)) {
    // 失败诊断(✖ 行、assertion diff、stack)全保留;只裁逐条通过行。
    // 全绿时逐条 ✔ 是最大的噪声源(数百行),统计块(ℹ tests/pass/fail)保留。
    const kept = lines.filter(l => !TEST_PASS_LINE_RE.test(l))
    return withMarker(kept.join('\n'), content, 'tests: all passed (details trimmed)', 'node-test')
  }

  if (NPM_INSTALL_RE.test(cmd)) {
    // 去日志级别/spinner/进度噪声,保留摘要(added N packages)、警告与错误
    const kept = lines.filter(l => !NPM_NOISE_LINE_RE.test(l))
    return withMarker(kept.join('\n'), content, 'npm: completed (output trimmed)', 'npm')
  }

  // ── LineFilter 注册表分发 ──
  for (const [name, filter] of Object.entries(LINE_FILTERS)) {
    if (filter.matchCommand.test(cmd)) {
      return applyLineFilter(name, filter, content)
    }
  }

  // 其余 bash:仅当 ANSI 剥离本身有可观收益时替换
  const ansiTrimmed = content.length - clean.length
  if (ansiTrimmed >= MIN_SAVINGS) return { content: clean, trimmedBytes: ansiTrimmed }
  return { content, trimmedBytes: 0 }
}
