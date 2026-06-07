import { Box, Text } from 'ink'
import { memo, useMemo, type ReactNode } from 'react'
import { getTheme } from './theme.js'
import { useTerminalSize } from './use-terminal-size.js'

interface Segment {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  underline?: boolean
  color?: string
  dimmed?: boolean
}

type BlockType = 'paragraph' | 'code' | 'header' | 'list' | 'blockquote' | 'hr' | 'table'

interface Block {
  type: BlockType
  level?: number
  language?: string
  content: string
  items?: string[]
}

interface MarkdownProps {
  text: string
  language?: string
}

// --- Inline tokenizer ---

function parseInline(text: string): Segment[] {
  const segments: Segment[] = []
  let i = 0
  let buf = ''

  const flush = () => {
    if (buf) {
      segments.push({ text: buf })
      buf = ''
    }
  }

  while (i < text.length) {
    // **bold** or __bold__
    if ((text[i] === '*' && text[i + 1] === '*') || (text[i] === '_' && text[i + 1] === '_')) {
      const delim = text.slice(i, i + 2)
      const end = text.indexOf(delim, i + 2)
      if (end !== -1) {
        flush()
        segments.push({ text: text.slice(i + 2, end), bold: true })
        i = end + 2
        continue
      }
    }

    // *italic* or _italic_ (single delimiter, not preceded/followed by same)
    if (text[i] === '*' && text[i + 1] !== '*' && (i === 0 || text[i - 1] !== '*')) {
      const end = text.indexOf('*', i + 1)
      if (end !== -1 && text[end + 1] !== '*' && (end === 0 || text[end - 1] !== '*')) {
        flush()
        segments.push({ text: text.slice(i + 1, end), italic: true })
        i = end + 1
        continue
      }
    }
    if (text[i] === '_' && text[i + 1] !== '_' && (i === 0 || text[i - 1] !== '_') && (i === 0 || /[a-zA-Z]/.test(text[i - 1] ?? ''))) {
      const end = text.indexOf('_', i + 1)
      if (end !== -1 && text[end + 1] !== '_') {
        flush()
        segments.push({ text: text.slice(i + 1, end), italic: true })
        i = end + 1
        continue
      }
    }

    // `inline code`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end !== -1) {
        flush()
        segments.push({ text: text.slice(i + 1, end), code: true })
        i = end + 1
        continue
      }
    }

    // [link text](url)
    if (text[i] === '[') {
      const textEnd = text.indexOf(']', i + 1)
      if (textEnd !== -1 && text[textEnd + 1] === '(') {
        const urlEnd = text.indexOf(')', textEnd + 2)
        if (urlEnd !== -1) {
          flush()
          segments.push({ text: text.slice(i + 1, textEnd), underline: true })
          i = urlEnd + 1
          continue
        }
      }
    }

    buf += text[i]
    i++
  }

  flush()
  return segments
}

function renderSegments(segments: Segment[]): ReactNode[] {
  return segments.map((seg, idx) => (
    <Text key={idx} bold={seg.bold} italic={seg.italic} underline={seg.underline} dimColor={seg.dimmed} color={seg.color ?? (seg.code ? getTheme().secondary : undefined)}>
      {seg.code ? ` ${seg.text} ` : seg.text}
    </Text>
  ))
}

// --- Block parser ---

function parseBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Code fence
    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!)
        i++
      }
      blocks.push({ type: 'code', language: language || undefined, content: codeLines.join('\n') })
      i++ // skip closing ```
      continue
    }

    // Header
    const headerMatch = line.match(/^(#{1,6})\s+(.*)/)
    if (headerMatch) {
      blocks.push({ type: 'header', level: headerMatch[1]!.length, content: headerMatch[2]! })
      i++
      continue
    }

    // Horizontal rule (check before list — `---` is HR, `- text` is list)
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr', content: '' })
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i]!.startsWith('> ')) {
        quoteLines.push(lines[i]!.slice(2))
        i++
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') })
      continue
    }

    // List (must have space after delimiter: `- text`, not `---`)
    if (/^(\s*[-*]\s|\s*\d+\.\s)/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^(\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s|\s*\d+\.\s/, ''))
        i++
      }
      blocks.push({ type: 'list', content: items.join('\n'), items })
      continue
    }

    // Table (simple detection: line with | and following separator line)
    if (line.includes('|') && i + 1 < lines.length && /^\|?[\s-:|]+\|?$/.test(lines[i + 1]!)) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i]!.includes('|')) {
        tableLines.push(lines[i]!)
        i++
      }
      blocks.push({ type: 'table', content: tableLines.join('\n') })
      continue
    }

    // Blank line
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph — collect consecutive non-blank, non-special lines
    const paraLines: string[] = []
    while (i < lines.length && lines[i]!.trim() !== '' && !lines[i]!.startsWith('#') && !lines[i]!.startsWith('```') && !lines[i]!.startsWith('> ') && !/^(\s*[-*]\s)/.test(lines[i]!)) {
      paraLines.push(lines[i]!)
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paraLines.join('\n') })
    } else {
      // Guard against a non-advancing iteration. A line can fall through every
      // block branch above yet still be EXCLUDED by the paragraph collector,
      // leaving `i` unchanged → the outer while spins forever at 100% CPU and
      // freezes the whole TUI (the loop is inside parseBlocks' useMemo, so it
      // never returns). The known trigger: a `#`-prefixed line that is not a
      // valid ATX header — the header branch requires `#{1,6}\s+`, but the
      // paragraph collector excludes anything starting with `#`. So `#foo`,
      // `####### x` (7+ hashes), or CJK headers without a space (`#标题`,
      // `###结论`, very common) wedge the renderer. Emit the orphan line as a
      // plain paragraph and advance — `i` is now guaranteed to move every pass.
      blocks.push({ type: 'paragraph', content: line })
      i++
    }
  }

  return blocks
}

// --- Syntax highlighting (minimal) ---

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'class', 'new', 'this', 'import', 'export', 'from', 'default', 'async', 'await',
  'try', 'catch', 'throw', 'typeof', 'instanceof', 'switch', 'case', 'break',
  'continue', 'interface', 'type', 'enum', 'extends', 'implements', 'readonly',
  'true', 'false', 'null', 'undefined', 'void', 'delete', 'in', 'of', 'as',
])

const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import',
  'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'yield',
  'lambda', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is',
  'True', 'False', 'None', 'self', 'async', 'await', 'print',
])

const GO_KEYWORDS = new Set([
  'func', 'return', 'if', 'else', 'for', 'range', 'var', 'const', 'type',
  'struct', 'interface', 'package', 'import', 'defer', 'go', 'chan', 'select',
  'case', 'switch', 'default', 'break', 'continue', 'map', 'nil', 'true', 'false',
  'err', 'make', 'append',
])

const RUST_KEYWORDS = new Set([
  'fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'mod', 'use',
  'return', 'if', 'else', 'for', 'while', 'loop', 'match', 'self', 'Self',
  'true', 'false', 'Some', 'None', 'Ok', 'Err', 'async', 'await', 'move',
  'where', 'type', 'const', 'static', 'ref', 'as', 'in',
])

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case',
  'esac', 'function', 'return', 'exit', 'echo', 'export', 'source', 'alias',
  'local', 'readonly', 'set', 'unset', 'true', 'false',
])

const CPP_KEYWORDS = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'atomic_cancel', 'atomic_commit',
  'atomic_noexcept', 'auto', 'bitand', 'bitor', 'bool', 'break', 'case', 'catch',
  'char', 'char8_t', 'char16_t', 'char32_t', 'class', 'compl', 'concept', 'const',
  'consteval', 'constexpr', 'constinit', 'const_cast', 'continue', 'co_await',
  'co_return', 'co_yield', 'decltype', 'default', 'delete', 'do', 'double',
  'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float',
  'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace',
  'new', 'noexcept', 'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq',
  'private', 'protected', 'public', 'reflexpr', 'register', 'reinterpret_cast',
  'requires', 'return', 'short', 'signed', 'sizeof', 'static', 'static_assert',
  'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local', 'throw',
  'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using',
  'virtual', 'void', 'volatile', 'wchar_t', 'while', 'xor', 'xor_eq',
])

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package',
  'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient',
  'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
])

const SQL_KEYWORDS = new Set([
  'select', 'insert', 'update', 'delete', 'from', 'where', 'join', 'left',
  'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit',
  'offset', 'create', 'table', 'alter', 'drop', 'index', 'view', 'into',
  'values', 'set', 'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false',
  'as', 'distinct', 'count', 'sum', 'avg', 'min', 'max', 'union', 'all',
  'any', 'exists', 'like', 'between', 'case', 'when', 'then', 'else', 'end',
])

const RUBY_KEYWORDS = new Set([
  'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined?', 'do',
  'else', 'elsif', 'end', 'ensure', 'false', 'for', 'if', 'in', 'module',
  'next', 'nil', 'not', 'or', 'redo', 'rescue', 'retry', 'return', 'self',
  'super', 'then', 'true', 'undef', 'unless', 'until', 'when', 'while', 'yield',
])

const PHP_KEYWORDS = new Set([
  'abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch',
  'class', 'clone', 'const', 'continue', 'declare', 'default', 'die', 'do',
  'echo', 'else', 'elsif', 'empty', 'enddeclare', 'endfor', 'endforeach',
  'endif', 'endswitch', 'endwhile', 'eval', 'exit', 'extends', 'final',
  'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if',
  'implements', 'include', 'include_once', 'instanceof', 'insteadof',
  'interface', 'isset', 'list', 'match', 'namespace', 'new', 'or', 'print',
  'private', 'protected', 'public', 'readonly', 'require', 'require_once',
  'return', 'static', 'switch', 'throw', 'trait', 'try', 'unset', 'use',
  'var', 'while', 'xor', 'yield', 'true', 'false', 'null',
])

const SWIFT_KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate',
  'func', 'import', 'init', 'inout', 'internal', 'let', 'open', 'operator',
  'private', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript',
  'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do',
  'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return',
  'switch', 'where', 'while', 'as', 'any', 'some', 'nil', 'true', 'false',
  'self', 'Self', 'throw', 'try', 'catch',
])

const KOTLIN_KEYWORDS = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun',
  'if', 'in', 'interface', 'is', 'null', 'object', 'package', 'return',
  'super', 'this', 'throw', 'true', 'try', 'typealias', 'val', 'var',
  'when', 'while', 'by', 'companion', 'constructor', 'delegate', 'dynamic',
  'field', 'file', 'get', 'init', 'import', 'open', 'out', 'override',
  'private', 'protected', 'public', 'set', 'value',
])

const DOCKERFILE_KEYWORDS = new Set([
  'from', 'run', 'cmd', 'label', 'maintainer', 'expose', 'env', 'add',
  'copy', 'entrypoint', 'volume', 'user', 'workdir', 'arg', 'onbuild',
  'stopsignal', 'healthcheck', 'shell',
])

interface LangConfig {
  keywords: Set<string>
  caseInsensitive?: boolean
}

function keywordsForLang(lang: string): LangConfig | null {
  const l = lang.toLowerCase()
  if (l === 'typescript' || l === 'ts' || l === 'javascript' || l === 'js' || l === 'jsx' || l === 'tsx') {
    return { keywords: JS_KEYWORDS }
  }
  if (l === 'python' || l === 'py') {
    return { keywords: PY_KEYWORDS }
  }
  if (l === 'go' || l === 'golang') {
    return { keywords: GO_KEYWORDS }
  }
  if (l === 'rust' || l === 'rs') {
    return { keywords: RUST_KEYWORDS }
  }
  if (l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh') {
    return { keywords: BASH_KEYWORDS }
  }
  if (l === 'cpp' || l === 'c' || l === 'cc' || l === 'h' || l === 'hpp' || l === 'cxx' || l === 'hxx') {
    return { keywords: CPP_KEYWORDS }
  }
  if (l === 'java') {
    return { keywords: JAVA_KEYWORDS }
  }
  if (l === 'sql') {
    return { keywords: SQL_KEYWORDS, caseInsensitive: true }
  }
  if (l === 'ruby' || l === 'rb') {
    return { keywords: RUBY_KEYWORDS }
  }
  if (l === 'php') {
    return { keywords: PHP_KEYWORDS }
  }
  if (l === 'swift') {
    return { keywords: SWIFT_KEYWORDS }
  }
  if (l === 'kotlin' || l === 'kt') {
    return { keywords: KOTLIN_KEYWORDS }
  }
  if (l === 'dockerfile' || l === 'docker') {
    return { keywords: DOCKERFILE_KEYWORDS, caseInsensitive: true }
  }
  return null
}

// Syntax token colors — pure monochrome gray ramp. Differentiation by
// brightness + weight only, no hue, so code blocks stay calm against the
// refined black/gray UI (keyword also rendered bold via highlightLine).
//   Tier 1 (brightest, bold): keyword   — control flow, declarations
//   Tier 2 (bright):          type, func
//   Tier 3 (medium):          string, number
//   Tier 4 (dim/dimmest):     punct, comment
const SYN = {
  keyword: '#d7dce3',  // brightest gray (bold) — control flow, declarations
  type: '#b0b8c4',     // bright gray — capitalized identifiers (types/classes)
  func: '#b0b8c4',     // bright gray — function calls (word followed by `(`)
  string: '#9aa2b1',   // medium gray — string literals
  number: '#9aa2b1',   // medium gray — numeric literals
  punct: '#6e7681',    // dim gray — operators, brackets, punctuation
  comment: '#6e7681',  // dimmest gray — comments
}

function highlightLine(line: string, keywords: Set<string> | null, caseInsensitive = false): Segment[] {
  if (!keywords) return [{ text: line }]

  const segments: Segment[] = []

  // Comment detection
  const commentIdx = line.indexOf('//')
  const hashCommentIdx = line.indexOf('#')
  let effectiveCommentIdx = -1
  if (commentIdx !== -1 && (hashCommentIdx === -1 || commentIdx < hashCommentIdx)) {
    effectiveCommentIdx = commentIdx
  } else if (hashCommentIdx !== -1) {
    effectiveCommentIdx = hashCommentIdx
  }

  const effectiveLine = effectiveCommentIdx !== -1 ? line.slice(0, effectiveCommentIdx) : line
  const commentPart = effectiveCommentIdx !== -1 ? line.slice(effectiveCommentIdx) : ''

  // Tokenize: strings, words, operators, whitespace
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\w+\b|\s+|[^\s\w]+)/g
  let match
  while ((match = re.exec(effectiveLine)) !== null) {
    const token = match[0]!
    if (/^\s+$/.test(token)) {
      segments.push({ text: token })
    } else if (/^["'`]/.test(token)) {
      segments.push({ text: token, color: SYN.string })
    } else if (/^[^\s\w]+$/.test(token)) {
      // Punctuation / operators
      segments.push({ text: token, color: SYN.punct })
    } else {
      const matchToken = caseInsensitive ? token.toLowerCase() : token
      if (keywords.has(matchToken)) {
        segments.push({ text: token, color: SYN.keyword, bold: true })
      } else if (/^\d[\d._]*$/.test(token)) {
        segments.push({ text: token, color: SYN.number })
      } else if (/^[A-Z][a-zA-Z0-9]*$/.test(token)) {
        // PascalCase → type/class
        segments.push({ text: token, color: SYN.type })
      } else if (effectiveLine[match.index + token.length] === '(') {
        // Followed by `(` → function call
        segments.push({ text: token, color: SYN.func })
      } else {
        segments.push({ text: token })
      }
    }
  }

  if (commentPart) {
    segments.push({ text: commentPart, color: SYN.comment })
  }

  return segments
}

// --- Block renderers ---

function renderCodeBlock(language: string | undefined, content: string, columns: number): ReactNode {
  const theme = getTheme()
  const lines = content.split('\n')
  const langConfig = language ? keywordsForLang(language) : null
  const keywords = langConfig?.keywords ?? null
  const caseInsensitive = langConfig?.caseInsensitive ?? false

  const MAX_CODE_LINES = 60
  const truncated = lines.length > MAX_CODE_LINES
  const visible = truncated ? lines.slice(0, MAX_CODE_LINES) : lines

  const headerText = `── ${language || 'code'} `
  const headerWidth = Math.max(20, columns - 6)
  const headerBorder = '┌' + headerText + '─'.repeat(Math.max(0, headerWidth - headerText.length))
  const footerBorder = '└' + '─'.repeat(headerWidth)

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={theme.dim}>{headerBorder}</Text>
      <Box
        borderStyle="single"
        borderColor={theme.dim}
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        paddingLeft={2}
        flexDirection="column"
      >
        {visible.map((line, i) => {
          const segs = highlightLine(line, keywords, caseInsensitive)
          return <Text key={i}>{renderSegments(segs)}</Text>
        })}
        {truncated && <Text color={theme.muted}>… ({lines.length - MAX_CODE_LINES} more lines)</Text>}
      </Box>
      <Text color={theme.dim}>{footerBorder}</Text>
    </Box>
  )
}

function renderTable(content: string): ReactNode {
  const lines = content.split('\n')
  const theme = getTheme()
  // Skip separator lines (---, :--, etc.)
  const dataLines = lines.filter(l => !/^\|?[\s-:|]+\|?$/.test(l.trim()))
  return (
    <Box flexDirection="column">
      {dataLines.map((line, i) => (
        <Text key={i} bold={i === 0} color={i === 0 ? theme.primary : undefined}>
          {line}
        </Text>
      ))}
    </Box>
  )
}

function renderBlock(block: Block, key: number, columns: number): ReactNode {
  const theme = getTheme()

  switch (block.type) {
    case 'header': {
      const level = block.level ?? 1
      // Terminal hierarchy has no font-size lever — every cell is one size — so
      // headers separate from body via weight + accent + whitespace only. Body
      // renders at the terminal's bright default fg, so a header must never be
      // DIMMER than body (that inverts the hierarchy). H1 pops via accent color;
      // H2/H3 stay body-bright + bold; deep levels recede slightly but stay bold.
      const colors = [theme.primary, undefined, undefined, theme.secondary, theme.secondary, theme.secondary]
      const glyphs = ['▍', '▍', '', '', '', '']
      const glyph = glyphs[level - 1] ?? ''
      const color = colors[level - 1]
      return (
        <Box key={key} marginTop={level <= 2 ? 1 : 0}>
          <Text bold color={color}>{glyph ? `${glyph} ` : ''}{block.content}</Text>
        </Box>
      )
    }
    case 'code':
      return <Box key={key}>{renderCodeBlock(block.language, block.content, columns)}</Box>
    case 'list': {
      const items = block.items ?? block.content.split('\n')
      return (
        <Box key={key} flexDirection="column" paddingLeft={1}>
          {items.map((item, i) => (
            <Text key={i}>
              <Text color={theme.secondary}>◇ </Text>
              {renderSegments(parseInline(item))}
            </Text>
          ))}
        </Box>
      )
    }
    case 'blockquote':
      return (
        <Box key={key} paddingLeft={2}>
          <Text color={theme.muted}>│ {block.content}</Text>
        </Box>
      )
    case 'hr':
      return <Text key={key} color={theme.dim}>{'─'.repeat(Math.max(20, columns - 4))}</Text>
    case 'table':
      return <Box key={key}>{renderTable(block.content)}</Box>
    case 'paragraph':
    default:
      return <Text key={key}>{renderSegments(parseInline(block.content))}</Text>
  }
}

export function hasMarkdown(text: string): boolean {
  return text.includes('**') || text.includes('`') || text.includes('```')
    || /^#{1,6}\s/m.test(text) || /^[-*]\s/m.test(text) || /^>\s/m.test(text)
}

/** Detect `  N│ ` numbered-line format from read_file tool output */
const NUMBERED_LINE_RE = /^\s*\d+│/

/** Guess language from content heuristics */
function guessLang(text: string): string | undefined {
  const sample = text.slice(0, 500)
  if (/\bimport\b.*\bfrom\b|export\s+(default|const|function)|=>\s*[{(]|:\s*(string|number|boolean)\b/.test(sample)) return 'typescript'
  if (/\bdef\b|\bclass\b.*:$|import\s+\w+/m.test(sample)) return 'python'
  if (/\bfunc\b|\bpackage\b\s+\w+|:=/.test(sample)) return 'go'
  if (/\bfn\b|\blet\s+mut\b|\bimpl\b/.test(sample)) return 'rust'
  if (/^#!/.test(sample) || /\bfi\b|\bdone\b|\besac\b/.test(sample)) return 'bash'
  return undefined
}

/**
 * Markdown — outer shell with fast-path for plain text.
 *
 * When text has no markdown syntax, returns a simple <Text> node
 * without ever calling parseBlocks or useTerminalSize.
 * Only markdown-bearing text enters the heavier MarkdownBlocks path.
 */
export const Markdown = memo(function Markdown({ text, language }: MarkdownProps) {
  if (!text) return null
  // Detect numbered-line tool output (e.g. "   1│ import ...")
  if (!hasMarkdown(text) && NUMBERED_LINE_RE.test(text)) {
    return <NumberedCodeBlock text={text} language={language} />
  }
  if (!hasMarkdown(text)) return <Text>{text}</Text>
  return <MarkdownBlocks text={text} />
})

/** Renders numbered-line tool output with gutter dimming + syntax highlighting */
const NumberedCodeBlock = memo(function NumberedCodeBlock({ text, language }: { text: string; language?: string }) {
  const theme = getTheme()
  const lang = language ?? guessLang(text)
  const langConfig = lang ? keywordsForLang(lang) : null
  const keywords = langConfig?.keywords ?? null
  const caseInsensitive = langConfig?.caseInsensitive ?? false
  const lines = useMemo(() => text.split('\n'), [text])

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const pipeIdx = line.indexOf('│')
        if (pipeIdx === -1) return <Text key={i}>{line}</Text>
        const gutter = line.slice(0, pipeIdx + 1)
        const code = line.slice(pipeIdx + 1)
        const segs = keywords ? highlightLine(code, keywords, caseInsensitive) : [{ text: code }]
        return (
          <Text key={i}>
            <Text color={theme.dim}>{gutter}</Text>
            {renderSegments(segs)}
          </Text>
        )
      })}
    </Box>
  )
})

const MarkdownBlocks = memo(function MarkdownBlocks({ text }: MarkdownProps) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  const { columns } = useTerminalSize()
  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((block, i) => renderBlock(block, i, columns))}
    </Box>
  )
})

export { parseBlocks, parseInline, type Block, type Segment, keywordsForLang }
