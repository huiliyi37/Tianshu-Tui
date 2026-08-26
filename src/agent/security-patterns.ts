/**
 * 安全模式规则表 — 从官方 Claude Code security-guidance 插件 patterns.py 移植。
 *
 * 纯数据 + 一个纯函数 scanContent。无 env 读取、无 I/O、无副作用——可独立导入。
 * 覆盖常见 web 漏洞类:命令注入、反序列化 RCE、XSS、eval 注入、弱加密、
 * TLS 校验关闭、XXE、CI 表达式注入、缺 SRI 的外链脚本、SQL 注入、硬编码密钥。
 *
 * 与官方的差异:
 *   - reminder 文案改中文,与 Tianshu advisory 生态一致
 *   - 保留官方的 lookbehind / pathFilter 边界(防误报),逐条移植其正则
 *   - RuleId 稳定枚举照搬(便于遥测归因,值冻结不重编号)
 *   - 26/27 是本仓库补的两条(SQL 注入、硬编码密钥)。官方规则表没有它们——
 *     官方靠 LLM 审查层抓,但这两类最常见、形状足够固定,纯正则也能可靠命中,
 *     没必要等有成本的层2。误报边界比移植规则更保守(见各条注释)。
 *
 * @module security-patterns
 */

const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'] as const
const PY_EXTS = ['.py', '.pyi', '.ipynb'] as const
const DOC_EXTS = ['.md', '.mdx', '.txt', '.rst', '.json', '.yaml', '.yml'] as const

function endsWithAny(path: string, exts: readonly string[]): boolean {
  return exts.some(ext => path.endsWith(ext))
}

// ── 共享 reminder 文案（多条规则复用） ──────────────────────────────

const UNSAFE_DESERIALIZATION_REMINDER =
  '⚠️ 安全警告:从不可信来源加载 pickle 数据（或等价物:cPickle、cloudpickle、dill、marshal、shelve、joblib、pandas.read_pickle、numpy allow_pickle=True）会导致任意代码执行。\n\n简单数据用 JSON 或 msgspec;类型化对象用 schema 校验的反序列化器（msgspec.Struct、pydantic、marshmallow），只构造声明过的类型。\n\n若确认安全或确有必要,先在代码里加注释说明再继续。'

const UNSAFE_YAML_LOAD_REMINDER =
  '⚠️ 安全警告:yaml.load() / yaml.unsafe_load() 会通过 !!python/object 标签执行任意 Python。\n\n若文件只含简单数据结构（dict、list、字符串、数字）用 yaml.safe_load()。需要类型化对象时用 safe_load 解析后再对结果做 schema 校验（pydantic、msgspec、marshmallow）——绝不要用构造任意类型的自定义 Loader。'

const UNSAFE_TORCH_LOAD_REMINDER =
  '⚠️ 安全警告:torch.load() 默认 weights_only=False,会 unpickle 任意 Python 对象,导致任意代码执行。\n\n若文件只含张量和简单数据结构,传 weights_only=True（或设 TORCH_FORCE_WEIGHTS_ONLY_LOAD=1）。'

// ── 规则类型 ────────────────────────────────────────────────────────

export interface SecurityPattern {
  /** 稳定规则名 — 与 RuleId 一一对应 */
  ruleName: string
  /** 路径前置过滤:返回 false 则跳过此文件（缩小误报面） */
  pathFilter?: (path: string) => boolean
  /** 路径命中即触发（无需正则/子串,如 GitHub Actions 工作流文件） */
  pathCheck?: (path: string) => boolean
  /** 子串命中（任一）即触发 */
  substrings?: string[]
  /** 正则命中即触发 */
  regex?: RegExp
  /** 命中时注入的中文提醒文案 */
  reminder: string
}

/** 单次扫描命中 */
export interface SecurityHit {
  ruleName: string
  reminder: string
}

// ── 规则表（25 条,顺序与官方 RuleId 一致） ─────────────────────────

export const SECURITY_PATTERNS: SecurityPattern[] = [
  {
    ruleName: 'github_actions_workflow',
    pathCheck: path =>
      path.includes('.github/workflows/') && (path.endsWith('.yml') || path.endsWith('.yaml')),
    reminder:
      '⚠️ 安全警告:你在编辑 GitHub Actions 工作流文件,注意这些风险:\n\n1. 命令注入:绝不要把不可信输入（issue 标题、PR 描述、commit message）直接插进 run: 命令而不转义\n2. 用环境变量:不要写 ${{ github.event.issue.title }},改用 env: 配合引号\n3. 危险输入还包括:github.event.issue.body、pull_request.title/body、comment.body、head_commit.message、client_payload.*（repository_dispatch 事件攻击者可设任意字段）\n4. ref 注入:绝不要把不可信输入用在 actions/checkout 的 ref: 参数;client_payload.pr_number 用于 ref 前先校验 ^[0-9]+$\n\n不安全:run: echo "${{ github.event.issue.title }}"\n安全:env:\\n  TITLE: ${{ github.event.issue.title }}\\nrun: echo "$TITLE"',
  },
  {
    ruleName: 'child_process_exec',
    // 限定 JS/TS:裸 exec( 否则会命中 Python 的 exec() 和文档里提到 exec 的散文
    pathFilter: p => endsWithAny(p, JS_EXTS),
    substrings: ['child_process.exec', 'execSync('],
    regex: /(?<![a-zA-Z0-9_.])exec\(/,
    reminder:
      '⚠️ 安全警告:child_process.exec() 会把命令字符串交给 shell 执行,插进去的用户输入可注入任意命令。改用 execFile()（或 spawn()）传参数数组:\n\n不要:exec(`command ${userInput}`)\n改用:import { execFile } from \'node:child_process\'\n     execFile(\'command\', [userInput], callback)\n\n参数数组不经过 shell,shell 元字符不会被解释。仅当确实需要 shell 特性且输入保证安全时才用 exec()。',
  },
  {
    ruleName: 'new_function_injection',
    substrings: ['new Function'],
    reminder:
      '⚠️ 安全警告:new Function() 配合字符串拼接是代码注入漏洞。任何被拼进函数体字符串的变量,若受攻击者控制即可执行任意代码。安全替代:属性访问用 obj[key] 或 array.reduce((o, k) => o[k], root);计算用安全表达式解析器。绝不要把不可信字符串插进 new Function() 函数体。',
  },
  {
    ruleName: 'eval_injection',
    // lookbehind 排除 . 使方法调用（model.eval()、redis.eval()）不命中;跳过文档
    pathFilter: p => !endsWithAny(p, DOC_EXTS),
    regex: /(?<![a-zA-Z0-9_.])eval\(/,
    reminder:
      '⚠️ 安全警告:eval() 执行任意代码,是重大安全风险。数据用 JSON.parse(),Python 字面量用 ast.literal_eval(),或用安全表达式解析器。若确认安全或确有必要,先加注释说明再继续。',
  },
  {
    ruleName: 'react_dangerously_set_html',
    substrings: ['dangerouslySetInnerHTML'],
    reminder:
      '⚠️ 安全警告:dangerouslySetInnerHTML 用于不可信内容会导致 XSS。确保内容经 HTML 消毒库（如 DOMPurify）处理,或改用安全替代方案。',
  },
  {
    ruleName: 'document_write_xss',
    substrings: ['document.write'],
    reminder:
      '⚠️ 安全警告:document.write() 可被利用做 XSS,且有性能问题。改用 DOM 操作方法（createElement()、appendChild()）。',
  },
  {
    ruleName: 'innerHTML_xss',
    substrings: ['.innerHTML =', '.innerHTML='],
    reminder:
      '⚠️ 安全警告:用不可信内容设置 innerHTML 会导致 XSS。纯文本用 textContent,需要 HTML 时用安全 DOM 方法,或用 HTML 消毒库（如 DOMPurify）。',
  },
  {
    ruleName: 'pickle_deserialization',
    // 只匹配反序列化（load/loads/Unpickler）。pickle.dump 不是 RCE 面。
    pathFilter: p => endsWithAny(p, PY_EXTS),
    regex: /(?<![a-zA-Z0-9_])pickle\.(loads?|Unpickler)\b|(?<![a-zA-Z0-9_])pkl_load\(/,
    reminder: UNSAFE_DESERIALIZATION_REMINDER,
  },
  {
    ruleName: 'os_system_injection',
    pathFilter: p => endsWithAny(p, PY_EXTS),
    regex: /\bos\.system\s*\(/,
    substrings: ['from os import system'],
    reminder:
      '⚠️ 安全警告:os.system() 会起 shell,是命令注入汇聚点。改用 subprocess.run([...]) 传参数列表。若确认安全或确有必要,先加注释说明再继续。',
  },
  {
    ruleName: 'python_subprocess_shell',
    regex: /subprocess\.(?:run|call|Popen|check_output|check_call)\(.*shell\s*=\s*True/,
    reminder:
      '⚠️ 安全警告:subprocess 配合 shell=True 会启用命令注入。\n\n不安全:subprocess.run(f"ls {user_input}", shell=True)\n安全（传参数列表,不用 shell）:subprocess.run(["ls", user_input])\n\n参数以列表传入且无 shell=True 时,特殊字符不会被当作 shell 元字符解释。',
  },
  {
    ruleName: 'go_exec_shell_injection',
    regex: /exec\.Command\(\s*"(?:sh|bash|\/bin\/sh|\/bin\/bash)"/,
    reminder:
      '⚠️ 安全警告:exec.Command 配合 shell 解释器（sh/bash）会启用命令注入。\n\n不安全:exec.Command("sh", "-c", "ping -c 1 " + host)\n安全（直接传参,不经 shell）:exec.Command("ping", "-c", "1", host)\n\n参数直接传入时用户输入里的特殊字符不会被当作 shell 元字符。此外校验输入:主机名/IP 用 net.ParseIP();文件路径用 filepath.Clean() 并确认在允许目录内;数值先 parse。',
  },
  {
    ruleName: 'unsafe_yaml_load',
    regex: /\byaml\.load\s*\((?![^)\n]{0,80}\bSafe)/,
    reminder: UNSAFE_YAML_LOAD_REMINDER,
  },
  {
    ruleName: 'node_createcipher_no_iv',
    regex: /\bcrypto\.(createCipher|createDecipher)\b/,
    reminder:
      '⚠️ 安全警告:改用 crypto.createCipheriv() / createDecipheriv()。createCipher 在 Node 22 已移除,且密钥派生不安全（无 IV、基于 MD5 的 KDF）。',
  },
  {
    ruleName: 'aes_ecb_mode',
    regex: /\bAES\.MODE_ECB\b|\bmodes\.ECB\s*\(|['"]aes-\d+-ecb['"]/,
    reminder:
      '⚠️ 安全警告:改用 AES-GCM 或 AES-CBC 配合 HMAC。ECB 模式泄露明文结构（相同明文块加密成相同密文块）。',
  },
  {
    ruleName: 'tls_verification_disabled',
    regex: /\bverify\s*=\s*False\b|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|ssl\._create_unverified_context|check_hostname\s*=\s*False/,
    reminder:
      '⚠️ 安全警告:不要关闭 TLS 校验,这会导致中间人攻击。自签名开发证书应把 CA 加入信任库,或用正规签发的证书。',
  },
  {
    ruleName: 'marshal_loads',
    regex: /\bmarshal\.loads?\s*\(/,
    reminder: UNSAFE_DESERIALIZATION_REMINDER,
  },
  {
    ruleName: 'shelve_open',
    regex: /\bshelve\.open\s*\(/,
    reminder: UNSAFE_DESERIALIZATION_REMINDER,
  },
  {
    ruleName: 'xml_unsafe_parse',
    regex: /\b(xml\.etree\.ElementTree|ElementTree|ET)\.(parse|fromstring|XML)\s*\(|\bminidom\.(parse|parseString)\s*\(|\bxml\.sax\.(parse|make_parser)\b/,
    reminder:
      '⚠️ 安全警告:改用 defusedxml.ElementTree。Python 标准库 XML 解析器默认易受 XXE（外部实体）和 billion-laughs 攻击。',
  },
  {
    ruleName: 'pickle_variants_load',
    regex: /\b(cPickle|cloudpickle|dill)\.(load|loads)\s*\(/,
    reminder: UNSAFE_DESERIALIZATION_REMINDER,
  },
  {
    ruleName: 'outerHTML_xss',
    substrings: ['.outerHTML =', '.outerHTML='],
    reminder:
      '⚠️ 安全警告:用 textContent 或经 DOMPurify 消毒。outerHTML 赋值是等同于 innerHTML 的 XSS 汇聚点。',
  },
  {
    ruleName: 'insertAdjacentHTML_xss',
    substrings: ['.insertAdjacentHTML('],
    reminder:
      '⚠️ 安全警告:用 insertAdjacentText() 或经 DOMPurify 消毒。insertAdjacentHTML 是 XSS 汇聚点。',
  },
  {
    ruleName: 'script_src_without_sri',
    // 检测通过动态加载远程内容做代码执行。src 后用负向前瞻确认标签内没有 integrity=
    regex: /<script\s+(?![^>]{0,400}integrity\s*=)[^>]{0,200}src\s*=\s*['"](?:https?:)?\/\/[^'"]{1,300}['"][^>]{0,100}>/,
    reminder:
      '⚠️ 安全警告:给外链 <script> 加 integrity="sha384-..." crossorigin="anonymous"。不带 Subresource Integrity 加载脚本会让你暴露于 CDN 被攻陷的风险。',
  },
  {
    ruleName: 'torch_unsafe_load',
    // 同行 weights_only=True（200 字符内）可抑制。weights_only=False 仍触发。
    regex: /(?:\btorch\.load|\.torch_load)\s*\((?![^)\n]{0,200}weights_only\s*=\s*True)/,
    reminder: UNSAFE_TORCH_LOAD_REMINDER,
  },
  {
    ruleName: 'yaml_unsafe_load_variants',
    // yaml.unsafe_load（标准库别名）+ 现实中见过的不安全包装方法名。
    regex: /(?:\byaml\.unsafe_load|\.yaml_unsafe_load)\s*\(/,
    reminder: UNSAFE_YAML_LOAD_REMINDER,
  },
  {
    ruleName: 'pickle_wrapper_load',
    // 不说 "pickle" 但会 unpickle 的库 API。numpy.load 仅在显式 allow_pickle=True 时触发。
    regex: /\bjoblib\.load\s*\(|\b(?:pd|pandas)\.read_pickle\s*\(|\.cloudpickle_load\s*\(|\b(?:np|numpy)\.load\s*\([^)\n]{0,200}allow_pickle\s*=\s*True/,
    reminder: UNSAFE_DESERIALIZATION_REMINDER,
  },
  {
    ruleName: 'sql_string_interpolation',
    // 官方规则表没有这条（官方靠 LLM 层抓 SQL 注入）。补上是因为纯正则能可靠
    // 命中最常见的形状：SQL 语句 + 插值/拼接/% 格式化。
    //
    // 两处刻意的收紧，都是被误报逼出来的：
    //   1. 要求成对的 SQL 语法（SELECT…FROM / UPDATE…SET），不认裸动词——
    //      `store.update({ name })` 这类调用会被裸 UPDATE + `{` 命中。
    //   2. 不把 `%s` 当危险信号——它正是 Python DB-API 的**参数化占位符**，
    //      `execute("… %s", (uid,))` 是正确写法。危险的是字符串结束后的 `%`
    //      运算（`"… %s" % uid`），所以匹配引号后紧跟的 `%`。
    //
    // 已知漏报：跨行 SQL（模板字符串里换行后才插值）——主体不跨行，跨行会把
    // 误报面放大到整段代码。与本模块整体取向一致：漏报优于误报。
    pathFilter: p => !endsWithAny(p, DOC_EXTS),
    regex: /(?:SELECT\b[^;\n]{0,120}\bFROM\b|INSERT\s+INTO\b|UPDATE\b[^;\n]{0,120}\bSET\b|DELETE\s+FROM\b)[^;\n]{0,200}(?:\$\{|\{[a-zA-Z_]|["'`]\s*\+|["'`]\s*%\s*[a-zA-Z_(]|\.format\()/i,
    reminder:
      '⚠️ 安全警告:SQL 语句里出现字符串插值/拼接,这是 SQL 注入的典型形状。改用参数化查询,让驱动去转义:\n\n不安全:`SELECT * FROM users WHERE id = ${userId}`\n安全（占位符 + 参数数组）:db.query(\'SELECT * FROM users WHERE id = ?\', [userId])\nPython:cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))  # 注意是逗号,不是 %\n\n表名/列名不能参数化,只能用白名单校验后再拼。ORDER BY 方向同理（只允许 ASC/DESC）。\n若这是静态 SQL 且插值来自常量,先加注释说明再继续。',
  },
  {
    ruleName: 'hardcoded_secret',
    // 只认「密钥类字段名 = 长字面量」以及可辨识的 token 前缀（sk-/ghp_/AKIA…）。
    // 刻意不认短值、占位符（xxx/your-…/<…>/env 读取/${}）——密钥泄露的代价高,
    // 但误报会让这条规则被无视,所以宁可漏报明显是示例的写法。
    pathFilter: p => !endsWithAny(p, DOC_EXTS),
    regex: /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["'`](?!(?:x{3,}|your[-_]|my[-_]|test|dummy|example|placeholder|change[-_]?me|\$\{|<|\.\.\.))[A-Za-z0-9_\-./+=]{16,}["'`]|\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/i,
    reminder:
      '⚠️ 安全警告:代码里出现疑似硬编码的密钥/令牌/口令。密钥一旦进 git 历史就收不回来——即使后续提交删掉,历史里仍可检出,必须视为已泄露并轮换。\n\n改法:从环境变量或密钥管理服务读取（process.env.X / os.environ["X"]），把真实值放进 .env 并确认 .env 已被 .gitignore 忽略;示例值写成明显的占位符（your-api-key-here）。\n\n若这是测试用的假值,把它改成一眼可辨的占位形状（xxx…/dummy-…),既消除告警也让读者不误当真值。',
  },
]

/**
 * 稳定数字 ID — 供遥测归因把 pattern 命中事件对应到具体规则。
 * 值冻结:不重编号已有条目,只追加新的。
 */
export enum RuleId {
  GITHUB_ACTIONS_WORKFLOW = 1,
  CHILD_PROCESS_EXEC = 2,
  NEW_FUNCTION_INJECTION = 3,
  EVAL_INJECTION = 4,
  REACT_DANGEROUSLY_SET_HTML = 5,
  DOCUMENT_WRITE_XSS = 6,
  INNERHTML_XSS = 7,
  PICKLE_DESERIALIZATION = 8,
  OS_SYSTEM_INJECTION = 9,
  PYTHON_SUBPROCESS_SHELL = 10,
  GO_EXEC_SHELL_INJECTION = 11,
  UNSAFE_YAML_LOAD = 12,
  NODE_CREATECIPHER_NO_IV = 13,
  AES_ECB_MODE = 14,
  TLS_VERIFICATION_DISABLED = 15,
  MARSHAL_LOADS = 16,
  SHELVE_OPEN = 17,
  XML_UNSAFE_PARSE = 18,
  PICKLE_VARIANTS_LOAD = 19,
  OUTERHTML_XSS = 20,
  INSERTADJACENTHTML_XSS = 21,
  SCRIPT_SRC_WITHOUT_SRI = 22,
  TORCH_UNSAFE_LOAD = 23,
  YAML_UNSAFE_LOAD_VARIANTS = 24,
  PICKLE_WRAPPER_LOAD = 25,
  // 26 起是本仓库在官方规则表之外补的（官方靠 LLM 层抓这两类）。
  SQL_STRING_INTERPOLATION = 26,
  HARDCODED_SECRET = 27,
}

const RULE_NAME_TO_ID: Record<string, RuleId> = {
  github_actions_workflow: RuleId.GITHUB_ACTIONS_WORKFLOW,
  child_process_exec: RuleId.CHILD_PROCESS_EXEC,
  new_function_injection: RuleId.NEW_FUNCTION_INJECTION,
  eval_injection: RuleId.EVAL_INJECTION,
  react_dangerously_set_html: RuleId.REACT_DANGEROUSLY_SET_HTML,
  document_write_xss: RuleId.DOCUMENT_WRITE_XSS,
  innerHTML_xss: RuleId.INNERHTML_XSS,
  pickle_deserialization: RuleId.PICKLE_DESERIALIZATION,
  os_system_injection: RuleId.OS_SYSTEM_INJECTION,
  python_subprocess_shell: RuleId.PYTHON_SUBPROCESS_SHELL,
  go_exec_shell_injection: RuleId.GO_EXEC_SHELL_INJECTION,
  unsafe_yaml_load: RuleId.UNSAFE_YAML_LOAD,
  node_createcipher_no_iv: RuleId.NODE_CREATECIPHER_NO_IV,
  aes_ecb_mode: RuleId.AES_ECB_MODE,
  tls_verification_disabled: RuleId.TLS_VERIFICATION_DISABLED,
  marshal_loads: RuleId.MARSHAL_LOADS,
  shelve_open: RuleId.SHELVE_OPEN,
  xml_unsafe_parse: RuleId.XML_UNSAFE_PARSE,
  pickle_variants_load: RuleId.PICKLE_VARIANTS_LOAD,
  outerHTML_xss: RuleId.OUTERHTML_XSS,
  insertAdjacentHTML_xss: RuleId.INSERTADJACENTHTML_XSS,
  script_src_without_sri: RuleId.SCRIPT_SRC_WITHOUT_SRI,
  torch_unsafe_load: RuleId.TORCH_UNSAFE_LOAD,
  yaml_unsafe_load_variants: RuleId.YAML_UNSAFE_LOAD_VARIANTS,
  pickle_wrapper_load: RuleId.PICKLE_WRAPPER_LOAD,
  sql_string_interpolation: RuleId.SQL_STRING_INTERPOLATION,
  hardcoded_secret: RuleId.HARDCODED_SECRET,
}

// 导入期防呆:规则表与 RuleId 表脱钩时立刻抛错（测试每次跑都会命中）。
{
  const patternNames = new Set(SECURITY_PATTERNS.map(p => p.ruleName))
  const idNames = new Set(Object.keys(RULE_NAME_TO_ID))
  const missing = [...patternNames].filter(n => !idNames.has(n))
  const extra = [...idNames].filter(n => !patternNames.has(n))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `RuleId 与 SECURITY_PATTERNS 脱钩:missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
    )
  }
}

/** 规则名 → 稳定数字 ID（未知名返回 undefined,如用户自定义规则）。 */
export function ruleNameToId(ruleName: string): RuleId | undefined {
  return RULE_NAME_TO_ID[ruleName]
}

/**
 * 扫描单个文件的写入内容,返回命中的规则列表。
 *
 * 纯函数:无 I/O、无副作用。每条规则按 pathFilter → pathCheck / substrings /
 * regex 顺序判定,任一命中即记一条 hit。同一规则最多命中一次。
 *
 * @param filePath 文件路径（用于 pathFilter / pathCheck 的扩展名/路径判定）
 * @param content  本次写入的新内容
 */
export function scanContent(filePath: string, content: string): SecurityHit[] {
  const hits: SecurityHit[] = []
  for (const pattern of SECURITY_PATTERNS) {
    // pathFilter:返回 false 直接跳过（缩小误报面,如 eval 只在非文档文件查）
    if (pattern.pathFilter && !pattern.pathFilter(filePath)) continue

    let matched = false
    if (pattern.pathCheck?.(filePath)) {
      matched = true
    } else if (pattern.substrings?.some(s => content.includes(s))) {
      matched = true
    } else if (pattern.regex?.test(content)) {
      matched = true
    }

    if (matched) {
      hits.push({ ruleName: pattern.ruleName, reminder: pattern.reminder })
    }
  }
  return hits
}
