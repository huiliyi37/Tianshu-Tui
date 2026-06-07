export type IntentType = 'file' | 'test' | 'command'

export interface Intent {
  type: IntentType
  value: string
}

const FILE_PATH_RE = /(?:^|\s)((?:src|test|tests|lib|packages|config|scripts|docs|bin|tools|prisma|\.github)\/[\w./-]+\.(?:ts|tsx|js|json|md|yml|yaml|toml))/g
const TEST_FILE_RE = /(\S+\.test\.\w+)/g
const COMMAND_RE = /(?:run|execute|check with)\s+(npm\s+\w+|tsc[^\n]*|npx[^\n]*)/gi
const CODE_BLOCK_RE = /```[\s\S]*?```/g

export function extractIntents(text: string): Intent[] {
  const cleaned = text
    .replace(CODE_BLOCK_RE, '')
    // 过滤掉独立的任务编号（不带斜杠或后缀），防止干扰路径识别
    .replace(/\b([PpTtSs]\d+|TASK-\d+)\b(?!\/|\.\w+)/g, '[REF]')
  const seen = new Set<string>()
  const intents: Intent[] = []

  for (const match of cleaned.matchAll(FILE_PATH_RE)) {
    const path = match[1]!
    if (seen.has(path)) continue
    seen.add(path)
    const type: IntentType = path.includes('.test.') ? 'test' : 'file'
    intents.push({ type, value: path })
  }

  for (const match of cleaned.matchAll(TEST_FILE_RE)) {
    const file = match[1]!
    if (seen.has(file)) continue
    seen.add(file)
    intents.push({ type: 'test', value: file })
  }

  for (const match of cleaned.matchAll(COMMAND_RE)) {
    const cmd = match[1]!.trim()
    if (seen.has(cmd)) continue
    seen.add(cmd)
    intents.push({ type: 'command', value: cmd })
  }

  return intents
}
