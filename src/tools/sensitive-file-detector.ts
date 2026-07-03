/**
 * 敏感文件检测 — fail-closed 工具层拦截。
 *
 * prompt 约束（AGENTS.md Agent 安全保护，硬闸门）：
 *   不 cat/read/commit .env、credentials.*、*private*key*、*token*、*secret* 等文件。
 *   发现此类文件出现在 git add 或工具输出中时，立即警告用户并中止。
 *
 * 现状核实：path-validate.ts 只做路径逃逸校验，无敏感文件名模式检测。
 * bash.ts 有 SENSITIVE_ENV_KEYWORDS 但只管环境变量值泄漏，不管文件访问。
 * 即：这条 hard-gate 目前纯靠 prompt 维持，运行时零守护。
 *
 * 设计：fail-closed（拒绝并解释），不是 advisory 软提醒。
 * 集成到 validatePathSafe 中，作为路径逃逸检查之前的第二道防线。
 *
 * 正则来源（匹配的真实文件名模式）：
 *   `.env` → 项目根目录常见环境变量文件
 *   `credentials.json` / `credentials.yaml` → 云服务凭证
 *   `id_rsa` / `id_ed25519` → SSH 私钥
 *   `*.pem` / `*.key` → TLS/SSL 私钥
 *   `.npmrc` → npm auth token（_authToken=）
 * *   `.pypirc` → PyPI 凭证
 *
 * 白名单（不拦截）：
 *   `.env.example` / `.env.template` / `.env.sample` → 模板文件，无真实凭证
 *   `*.test.ts` / `*.spec.ts` → 测试 fixture
 *   `scripts/` 下的凭证生成脚本
 *   合法源码文件（如 auth/token-manager.ts）——按扩展名区分（.ts/.js 不拦截）
 */

/** 敏感文件名模式 */
const SENSITIVE_FILE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // .env（但不是 .env.example/.template/.sample）
  // 来源：项目根目录 .env 文件，含 API_KEY/DATABASE_URL 等真实凭证
  // 匹配 `.env` 文件本身和 `.env.local` / `.env.production` 等变体
  // 排除 `.env.example` / `.env.template` / `.env.sample`（白名单）
  {
    name: '.env (real)',
    re: /\.env(?:\.(?:local|production|staging|development|prod|staging|dev))?$/,
  },
  // credentials 文件
  // 来源：credentials.json / credentials.yaml / service-account-credentials.json
  {
    name: 'credentials file',
    re: /(^|\/)credentials\.(?:json|yaml|yml|xml|ini|conf)$/,
  },
  // 私钥文件
  // 来源：id_rsa / id_ed25519 / id_ecdsa — SSH 私钥命名约定
  {
    name: 'SSH private key',
    re: /(^|\/)id_(?:rsa|ed25519|ecdsa|dsa)$/,
  },
  // PKI 私钥
  // 来源：*.pem / *.key — TLS/SSL 私钥通用扩展名
  {
    name: 'PKI private key (.pem/.key)',
    re: /\.(?:pem|key)$/,
  },
  // npm/PyPI 凭证文件
  // 来源：.npmrc 含 _authToken= / .pypirc 含密码
  {
    name: 'package manager credentials',
    re: /(^|\/)(?:\.npmrc|\.pypirc)$/,
  },
  // 通用 secret/token 文件名
  // 来源：secrets.json / tokens.json / auth-tokens.json 等
  // 注意：只匹配 .json/.yaml/.yml/.ini 扩展名，不匹配 .ts/.js（合法源码不拦截）
  {
    name: 'secrets/token file',
    re: /(^|\/)(?:secret[s]?|token[s]?|auth[_-]?token[s]?)\.(?:json|yaml|yml|ini|env)$/,
  },
]

/** 白名单模式——这些路径即使匹配敏感模式也不拦截 */
const WHITELIST_PATTERNS: RegExp[] = [
  // .env 模板文件（无真实凭证）
  /\.env\.(?:example|template|sample)$/,
  // 测试文件
  /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/,
  // fixtures 目录
  /(?:^|\/)fixtures?\//,
  // scripts 目录
  /(?:^|\/)scripts\//,
  // 文档
  /\.md$/,
]

export interface SensitiveFileResult {
  sensitive: boolean
  patternName?: string
  path: string
}

/**
 * 检测路径是否为敏感文件。
 * @param inputPath 输入路径（相对或绝对）
 * @returns 是否敏感 + 匹配的模式名
 */
export function detectSensitiveFile(inputPath: string): SensitiveFileResult {
  // 先检查白名单——白名单优先
  for (const re of WHITELIST_PATTERNS) {
    if (re.test(inputPath)) return { sensitive: false, path: inputPath }
  }

  for (const { name, re } of SENSITIVE_FILE_PATTERNS) {
    if (re.test(inputPath)) {
      return { sensitive: true, patternName: name, path: inputPath }
    }
  }

  return { sensitive: false, path: inputPath }
}

/**
 * 检测 bash 命令文本中是否包含 git add 敏感文件的操作。
 *
 * 正则来源：匹配 `git add .env` / `git add credentials.json` 等
 * 从命令文本中提取 git add 的参数，检查是否含敏感文件名。
 *
 * @returns 匹配到的敏感文件名数组（可能为空）
 */
export function detectSensitiveGitAdd(command: string): string[] {
  // 匹配 `git add <file>` — 提取文件参数
  // 来源：prompt security 段 "发现此类文件出现在 git add 中时中止"
  const gitAddRe = /git\s+add\s+(.+)/g
  const sensitiveFiles: string[] = []

  let match: RegExpExecArray | null
  while ((match = gitAddRe.exec(command)) !== null) {
    const args = match[1]!.trim()
    // 拆分空格分隔的参数（简化处理，不处理引号边界情况）
    const files = args.split(/\s+/).filter(f => !f.startsWith('-'))
    for (const f of files) {
      const result = detectSensitiveFile(f)
      if (result.sensitive) sensitiveFiles.push(f)
    }
  }

  return sensitiveFiles
}
