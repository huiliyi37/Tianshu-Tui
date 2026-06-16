# Skill 三级渐进装载 — Phase 1 实现计划（保真优先 · 复制式单一来源）

> **面向 AI 代理：** 使用 `executing-plans` 逐任务实现（计划阶段不派子代理）。
> 步骤使用复选框（`- [ ]`）跟踪进度。
> 设计依据：`docs/superpowers/specs/2026-06-16-skill-system-optimization-design.md`

**目标：** 让主控模型能对**多文件夹技能**做无损按需装载——L1 名称+描述常驻、L2 加载 SKILL.md 正文、L3 按需完整读取子文件（references/scripts/assets）。

**装载模型（用户拍板）：** 运行时**单一来源 = `.rivet/skills/`（+ 内置）**，默认**不扫描任何外部目录**。外部技能（如 `~/.claude/skills` 里的某几个）由用户/agent**复制进 `.rivet/skills/`** 再装载，只装显式指定的，不与外部目录混用。`importFromClaude` 配置语义从"运行时扫描"改为"bootstrap 期复制进 `.rivet/skills/`"。

**架构：** `.rivet/skills/` 的 `loadFromDirectory` 同时支持扁平 `name.md` 与目录 `name/SKILL.md`（带子文件夹，不 flatten）；`SkillDefinition` 记录 `skillDir`，`skill` 工具返回 SKILL.md 正文时附带该技能的**文件树清单**；Tier-3 复用 `read_file`/`grep`/`glob` 读子文件——技能在 workspace 内，天然可读，**无需跨 workspace 授权**（旧 `grantSkillDirReads` 作废）。发现层溢出时给出"还有 N 个技能"安全网，防静默漏激活。

**第一优先级（已拍板）：保真 > 上下文洁净。** 本 Phase 不引入 fork（有损摘要），只做无损三级装载。

**技术栈：** TypeScript / node:test / 现有 read_file（workspace 边界）。

---

## 任务

### 任务 1：目录技能加载 — `.rivet/skills/` 支持目录技能 + skillDir + 文件树解析（不 flatten）

- [ ] 修改 `src/skills/skill-loader.ts`（`SkillDefinition` L23-35；`loadFromDirectory` L98-117）
- [ ] 修改 `src/skills/skill-loader.ts`（新增导出 `listSkillFiles`）
- [ ] 测试 `src/skills/__tests__/skill-loader.test.ts`

**目标：** `.rivet/skills/` 下的目录技能（`<name>/SKILL.md` + 子文件夹）记录其根目录并能列出子文件；扁平 `.rivet/skills/*.md` 技能无 skillDir（退化情形，行为不变）。

**调研背书：**
- `loadFromDirectory`（L98-117）：当前仅 `readdirSync(dir).filter(.md)` 扫扁平文件。改为 `withFileTypes:true` 遍历：`.md` 文件走原扁平解析；目录且含 `SKILL.md` 则解析为目录技能并记录 `skillDir`。扁平路径行为字节不变。调用者：`loadProjectSkills`（L312-332，任务 3 改）。
- `SkillDefinition`（L23-35）：已有 `bodyPath?`/`source?`，新增 `skillDir?` 与之同类（loader 设置，parser 不设）。`grep "SkillDefinition"` 仅类型引用，无字段封闭性依赖。
- `loadFromClaudeDirectory`（L123-151）：保留不动（`discovery.test.ts:117-136` 直接测它），但**不再在运行时路径调用**（任务 3）。

**实现：**
```typescript
// 顶部 import 增加 relative
import { join, relative } from 'node:path'

// SkillDefinition 增加字段（紧随 bodyPath 之后）
  /** Skill 根目录（仅目录型技能有；扁平 .rivet/skills/*.md 为 undefined）。 */
  skillDir?: string

// loadFromDirectory 改为同时支持扁平 + 目录技能
  loadFromDirectory(dir: string, source: SkillSource = 'rivet'): { loaded: string[]; errors: string[] } {
    const loaded: string[] = []
    const errors: string[] = []
    if (!existsSync(dir)) return { loaded, errors }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      try {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const skillFile = join(dir, entry.name)
          const def = parseSkillMarkdown(readFileSync(skillFile, 'utf-8'), entry.name)
          def.source = source
          def.bodyPath = skillFile
          this.skills.set(def.name, def)
          loaded.push(def.name)
        } else if (entry.isDirectory()) {
          const skillFile = join(dir, entry.name, 'SKILL.md')
          if (!existsSync(skillFile)) continue
          const def = parseSkillMarkdown(readFileSync(skillFile, 'utf-8'), entry.name)
          def.source = source
          def.bodyPath = skillFile
          def.skillDir = join(dir, entry.name)
          this.skills.set(def.name, def)
          loaded.push(def.name)
        }
      } catch (e) {
        errors.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { loaded, errors }
  }

// 文件树清单（深度/数量有界，排除 SKILL.md 自身），新增导出函数
export interface SkillFileEntry { path: string; kind: 'file' | 'dir' }

export function listSkillFiles(
  skillDir: string,
  opts?: { maxDepth?: number; maxEntries?: number },
): SkillFileEntry[] {
  const maxDepth = opts?.maxDepth ?? 3
  const maxEntries = opts?.maxEntries ?? 50
  const out: SkillFileEntry[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxEntries) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxEntries) return
      const abs = join(d, e.name)
      const rel = relative(skillDir, abs)
      if (rel === 'SKILL.md') continue
      if (e.isDirectory()) {
        out.push({ path: rel + '/', kind: 'dir' })
        walk(abs, depth + 1)
      } else if (e.isFile()) {
        out.push({ path: rel, kind: 'file' })
      }
    }
  }
  walk(skillDir, 1)
  return out
}
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/skills/__tests__/skill-loader.test.ts  # 期望全部通过
```
测试需新增：用 `mkdtempSync` 建临时目录 `<root>/myskill/SKILL.md` + `<root>/myskill/references/a.md` + `<root>/myskill/scripts/run.py` + `<root>/flat.md`，`loadFromDirectory(root)` 后断言：`get('myskill').skillDir` 指向 `<root>/myskill`、`get('flat').skillDir === undefined`；`listSkillFiles(skillDir)` 含 `references/`、`references/a.md`、`scripts/run.py` 且**不含** `SKILL.md`。

**提交：**
```bash
git add src/skills/skill-loader.ts src/skills/__tests__/skill-loader.test.ts
git commit -m "feat(skills): .rivet/skills 支持目录技能，保留 skillDir + listSkillFiles（任务 1/5）"
```

---

### 任务 2：skill 工具附带文件树（L3 入口可见性）

- [ ] 修改 `src/tools/skill.ts`（`execute` L34-55）
- [ ] 测试 `src/tools/__tests__/skill-tool.test.ts`

**目标：** 加载某技能时，除 SKILL.md 正文外，附上该技能的子文件清单 + skillDir 绝对路径，让模型知道"有哪些子文件可按需读"。无 skillDir 的技能行为不变。

**调研背书：**
- `skill.ts` `execute`（L34-55）：当前返回 `<skill name>...body...</skill>`，零截断（`skill-tool.test.ts` 断言 20KB 不截断——保真测试，**必须保持通过**）。新增内容**追加在 body 之后**，不动 body 本体。工具 `definition`（L17-32）保持字节稳定（不嵌入具体技能名），缓存安全断言不受影响——附加逻辑只在 `execute` 内。

**实现：**
```typescript
import { skillRegistry, listSkillFiles } from '../skills/skill-loader.js'

// execute 内，构造返回前：
    const body = `<skill name="${skill.name}">\n${skill.body}\n</skill>`
    if (!skill.skillDir) {
      return { content: body, uiContent: `Loaded skill: ${skill.name}` }
    }
    const files = listSkillFiles(skill.skillDir)
    if (files.length === 0) {
      return { content: body, uiContent: `Loaded skill: ${skill.name}` }
    }
    const tree = files.map(f => `  ${f.path}`).join('\n')
    const filesBlock = [
      `<skill-files dir="${skill.skillDir}" note="Read these on demand with read_file/grep/glob as the instructions above reference them. Do not load all of them preemptively.">`,
      tree,
      '</skill-files>',
    ].join('\n')
    return { content: `${body}\n${filesBlock}`, uiContent: `Loaded skill: ${skill.name} (+${files.length} files)` }
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/tools/__tests__/skill-tool.test.ts  # 期望全部通过（含既有 20KB 不截断断言）
```
测试需新增：注册一个带 `skillDir`（指向临时目录，内含子文件）的技能，调用后断言 `content` 含 `<skill-files dir=`、含子文件相对路径、仍含完整 body；注册一个无 `skillDir` 的技能断言 `content` **不含** `<skill-files`。

**提交：**
```bash
git add src/tools/skill.ts src/tools/__tests__/skill-tool.test.ts
git commit -m "feat(skills): skill 工具附带文件树清单，暴露 L3 子文件入口（任务 2/5）"
```

---

### 任务 3：运行时单一来源 + 复制式导入（`importFromClaude` 改为复制进 `.rivet/skills/`）

- [ ] 修改 `src/skills/skill-loader.ts`（新增导出 `importSkillsIntoRivet`；改写 `loadProjectSkills` L312-332）
- [ ] 测试 `src/skills/__tests__/skill-loader.test.ts`

**目标：** 运行时只装内置 + `.rivet/skills/`，**不再 in-place 扫外部 `.claude` 目录**。`importFromClaude` 列表中的技能在 bootstrap 期从 `.claude` 目录**复制**进 `.rivet/skills/`（幂等：已存在跳过，保护本地修改），随后统一装载——满足"只装用户指定、通过 claude 目录装到 rivet、不与外部混用"。

**调研背书：**
- `loadProjectSkills`（L312-332）：当前在 `importFromClaude` 非空时调 `loadFromClaudeDirectory` in-place 扫 global+project `.claude`——这是要废除的"混用"。无生产测试依赖此分支（`grep loadProjectSkills` 仅 bootstrap/config/docs 引用）。
- `bootstrap.ts:960` 调用点签名不变（仍传 `{ importFromClaude }`），无需改 bootstrap。
- 复制用 `cpSync(src, dest, { recursive: true })`（node:fs），目录技能连子文件夹整体拷贝。

**实现：**
```typescript
// 顶部 import 增加 cpSync
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs'

/**
 * 把指定技能从 .claude 目录复制进 .rivet/skills/（幂等）。
 * 优先项目 .claude/skills/<name>，回退全局 ~/.claude/skills/<name>。
 * 已存在于 .rivet/skills/<name> 则跳过（不覆盖本地修改）。
 */
export function importSkillsIntoRivet(
  cwd: string,
  names: string[],
): { copied: string[]; skipped: string[]; errors: string[] } {
  const copied: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  const rivetDir = join(cwd, '.rivet', 'skills')
  for (const name of names) {
    try {
      const dest = join(rivetDir, name)
      if (existsSync(dest) || existsSync(`${dest}.md`)) {
        skipped.push(name)
        continue
      }
      const projectSrc = join(cwd, '.claude', 'skills', name)
      const globalSrc = join(homedir(), '.claude', 'skills', name)
      const src = existsSync(projectSrc) ? projectSrc : existsSync(globalSrc) ? globalSrc : null
      if (!src) {
        errors.push(`${name}: not found in .claude/skills (project or global)`)
        continue
      }
      cpSync(src, dest, { recursive: true })
      copied.push(name)
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { copied, skipped, errors }
}

// loadProjectSkills 改写：复制式导入 + 单一来源
export function loadProjectSkills(
  cwd: string,
  options?: { importFromClaude?: string[] },
): { loaded: string[]; errors: string[] } {
  const loaded: string[] = []
  const errors: string[] = []
  loaded.push(...registerBuiltinSkills())
  const names = options?.importFromClaude
  if (names && names.length > 0) {
    const imp = importSkillsIntoRivet(cwd, names)
    errors.push(...imp.errors)
  }
  const r = skillRegistry.loadFromDirectory(join(cwd, '.rivet', 'skills'), 'rivet')
  loaded.push(...r.loaded)
  errors.push(...r.errors)
  return { loaded, errors }
}
```
（删除 `loadProjectSkills` 内对 `loadFromClaudeDirectory` 的两次调用与 `merge` 辅助；`homedir` import 已存在。`loadFromClaudeDirectory` 方法本体保留供测试。）

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/skills/__tests__/skill-loader.test.ts
```
测试需新增：建临时 cwd，`<cwd>/.claude/skills/foo/SKILL.md`（带子文件），`importSkillsIntoRivet(cwd, ['foo'])` 后断言 `<cwd>/.rivet/skills/foo/SKILL.md` 存在、`copied=['foo']`；再调一次断言 `skipped=['foo']`（幂等）；不存在的名字进 `errors`。

**提交：**
```bash
git add src/skills/skill-loader.ts src/skills/__tests__/skill-loader.test.ts
git commit -m "feat(skills): 运行时单一来源 .rivet/skills，importFromClaude 改为复制式导入（任务 3/5）"
```

---

### 任务 4：发现层规模安全网 — 溢出时提示"还有 N 个技能"

- [ ] 修改 `src/skills/skill-loader.ts`（`renderDiscoveryBlock` L175-219）
- [ ] 测试 `src/skills/__tests__/discovery.test.ts`

**目标：** 大池子下预算溢出时，相关技能已排前不丢；被丢弃的尾部要让模型知道"还有 N 个未列出"，避免静默丢失导致漏激活（保真：召回优先）。

**调研背书：**
- `renderDiscoveryBlock`（L202-218）：现循环按预算累加，`line.length > budget` 时 `continue`。被跳过的条目当前无任何痕迹。`discovery.test.ts:89-101` 断言溢出时小条目仍出现——本改动只追加一个计数提示行，不改既有跳过逻辑。

**实现：**
```typescript
    const lines: string[] = []
    let budget = maxChars
    let dropped = 0
    for (const skill of ordered) {
      const desc = (skill.description || '').replace(/\s+/g, ' ').trim().slice(0, maxDescChars)
      const rel = isRelevant(skill) ? ' relevant="true"' : ''
      const line = `<skill name="${skill.name}"${rel}>${desc}</skill>`
      if (line.length > budget) { dropped++; continue }
      lines.push(line)
      budget -= line.length
    }
    if (lines.length === 0) return null

    const tail = dropped > 0
      ? [`<more count="${dropped}" note="More skills available but omitted for space. Refine your request to surface them, or the user can run /skill list."/>`]
      : []
    return [
      '<available-skills note="Call the skill tool with a name to load its full instructions on demand.">',
      ...lines,
      ...tail,
      '</available-skills>',
    ].join('\n')
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/skills/__tests__/discovery.test.ts
```
测试需新增：注册多个描述较长的技能，`renderDiscoveryBlock('hint', { maxChars: <小值> })` 触发丢弃，断言输出含 `<more count="`；预算充足时**不**出现 `<more`。

**提交：**
```bash
git add src/skills/skill-loader.ts src/skills/__tests__/discovery.test.ts
git commit -m "feat(skills): 发现层溢出给出剩余技能计数安全网，防静默漏激活（任务 4/5）"
```

---

### 任务 5：/skill 命令文件树对齐 + 列表文案更新 + 文档

- [ ] 修改 `src/tui/slash-commands.ts`（`/skill list` 文案 L1145-1167；`/skill <name>` 分支 L1169-1186）
- [ ] 修改 `docs/skills-guide.md`（新增「目录技能与复制式装载」一节）

**目标：** `/skill <name>` 手动加载时与 `skill` 工具一致（附文件树）；`/skill list` 文案去掉"扫描 .claude 目录"的旧描述（已不扫），改为说明复制式装载；文档说明目录技能格式、L3 按需读取、复制进 `.rivet/skills/` 的导入模型。

**调研背书：**
- `slash-commands.ts` `/skill <name>`（L1184）：`ctx.session.addUserMessage` 注入完整 body（append-only，无截断）。本改动只在该消息后追加文件树文本。`skillRegistry` 已 import（顶部）。
- `/skill list`（L1146-1147 注释、L1154 文案）：当前说"loaded from .rivet/skills + project/global .claude/skills"/"Scanned: .claude/skills"——与新模型矛盾，需改为只说 `.rivet/skills/`。

**实现：**
```typescript
// 顶部 import 补 listSkillFiles
import { skillRegistry, listSkillFiles } from '../skills/skill-loader.js'

// /skill list 空态文案（L1154）改为：
'No skills found in .rivet/skills/.\nCopy a skill in with: cp -r ~/.claude/skills/<name> .rivet/skills/<name>'

// /skill <name> 分支，addUserMessage 内容前构造 payload：
      let payload = `[Skill loaded: ${skill.name}]\n<skill name="${skill.name}">\n${skill.body}\n</skill>`
      if (skill.skillDir) {
        const files = listSkillFiles(skill.skillDir)
        if (files.length > 0) {
          payload += `\n<skill-files dir="${skill.skillDir}">\n${files.map(f => '  ' + f.path).join('\n')}\n</skill-files>`
        }
      }
      ctx.session.addUserMessage(payload)
```
`docs/skills-guide.md` 新增一节，覆盖：运行时单一来源 `.rivet/skills/`、目录技能结构（SKILL.md + references/scripts/assets）、SKILL.md 应写成短"路由"、L3 由模型按需 read_file、外部技能用 `cp -r` 或 `importFromClaude` 复制进 `.rivet/skills/`、`<skill-files>` 清单含义。

**验证：**
```bash
npx tsc --noEmit
npm run build   # 确认 TUI 编译通过
```

**提交：**
```bash
git add src/tui/slash-commands.ts docs/skills-guide.md
git commit -m "docs(skills): /skill 附文件树 + 复制式装载文案与文档（任务 5/5）"
```

---

## 收尾验证（全部任务后）
```bash
npm run typecheck
npm test   # 期望无新增失败；新增 skill 相关测试全绿
```

## 范围说明（本计划不含，留待后续）
- **Phase 2**：`loadPolicy`（inline/lazy/fork）+ 超重技能子代理隔离 + scripts 审批沙箱 + `search_skills`。
- **Phase 3**：语义相关性 / 技能包 scope，数据驱动可选。
- fork 因有损摘要、违背保真第一优先级，本 Phase **刻意不做**。
- 跨 workspace 读授权（旧 `grantSkillDirReads`）**作废**——技能复制进 workspace 内，天然可读。

## 自检
1. **规格覆盖**：设计 Phase 1（目录技能/skill 工具文件树/单一来源复制导入/发现层规模安全网）→ 任务 1/2、2、3、4 全覆盖；文档+命令对齐 → 任务 5。✅
2. **占位符扫描**：无 TODO/TBD；每个函数体已给出。✅
3. **类型一致性**：`SkillFileEntry`、`skillDir`、`listSkillFiles`、`importSkillsIntoRivet` 在任务间签名一致。✅
4. **调研背书**：所有修改点附调用者与现有行为锚点（含须保持通过的保真测试）。✅
5. **模型一致性**：运行时不扫外部、外部技能复制进 `.rivet/skills/`、无跨界授权——与设计文档「装载模型（定稿）」一致。✅
