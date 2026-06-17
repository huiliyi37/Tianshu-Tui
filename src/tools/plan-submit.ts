/**
 * plan_submit tool — Agent 在 Plan Mode 下提交计划供用户审阅
 *
 * 用法：
 * 1. Agent 在 plan mode 探索代码后调用此工具
 * 2. 计划写入 .rivet/plans/{slug}.md
 * 3. 用户用 /plan-approve 或 /plan-reject 审阅
 * 4. 批准后 plan mode 退出，计划内容注入为执行上下文
 */

import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { writePlan, slugify } from '../plan/plan-store.js'

/**
 * Slugs that have already been warned once for a missing diagram. The soft gate
 * nudges at most once per slug — a resubmit of the same slug always passes
 * through, so the agent can never get stuck if a diagram is genuinely
 * unnecessary. Module-level (process-lived) is intentional: one nudge per plan.
 */
const warnedSlugs = new Set<string>()

const MERMAID_FENCE = /```\s*mermaid/i

const MISSING_DIAGRAM_SKELETON = `\`\`\`mermaid
flowchart TD
    U(用户输入) --> R[[入口/路由]]
    R --> L{{LLM/核心逻辑}}
    R --> S[(存储/状态)]
    L --产出--> OUT([结果])
\`\`\``

export const PLAN_SUBMIT_TOOL: Tool = {
  definition: {
    name: 'plan_submit',
    description: `Submit a completed implementation plan for user approval.

**Note:** The plan content is persisted to \`.rivet/plans/<slug>.md\`. In the message history, only a file pointer is retained — use \`read_file\` to review the full plan in later turns.

### When to call
Call this tool once you have fully explored the codebase and designed a solution.

### Plan quality — your plan should be a polished design document:

Use Mermaid diagrams for architecture/flow. **Use the semantic shape vocabulary below**
(renderer-portable core syntax — works on GitHub/VSCode/Obsidian, verified 2026-06-07):

Shapes carry meaning — pick by role, don't default everything to [rect]:
- \`{{hexagon}}\` = LLM / model    \`[[subroutine]]\` = agent / processor
- \`[(cylinder)]\` = data store / DB    \`{rhombus}\` = decision / branch
- \`(rounded)\` = external input / user    \`([stadium])\` = entry / terminal    \`[rect]\` = plain module

Edges: \`-->\` sync/read · \`==>\` write/strong · \`-.->\` async/event · \`--label-->\` labeled

Color by class (pure classDef — portable baseline; do NOT rely on \`%%{init}%%\`, GitHub strips it):
\`\`\`mermaid
flowchart TD
    U(用户输入) --> R[[意图路由]]
    R --> LLM{{LLM 分类器}}
    R --> DB[(上下文存储)]
    LLM --富化--> OUT([结果])
    classDef model fill:#1e293b,stroke:#38bdf8,color:#e0f2fe,stroke-width:2px
    classDef agent fill:#0f172a,stroke:#818cf8,color:#e0e7ff
    classDef store fill:#1e1b4b,stroke:#a78bfa,color:#ede9fe
    classDef io fill:#022c22,stroke:#34d399,color:#d1fae5
    class LLM model
    class R agent
    class DB store
    class U,OUT io
\`\`\`
(Full template library + skeletons: docs/superpowers/plans/2026-06-07-mermaid-diagram-template-library.md)

Include these sections:
1. **Problem description** — what's broken or missing, with concrete examples
2. **Root cause analysis** — why it happens (Mermaid flowchart recommended)
3. **Spec/dataflow closure** — for complex specs, include:
   - fact-flow map: spec field/constraint → producer → intermediate structure → consumer/write target → assertion
   - condition matrix: cross-product branches such as source × severity × apply, with expected behavior per cell
   - counterexample test table: which test fails if an implementer only does the checklist/happy path, forgets a call contract, declares a type without consuming it, or uses truthy/falsy sentinels
4. **Proposed changes** — each file with diff/pseudocode, file paths, line references
5. **Competitive/design comparison** — how alternatives solve this (table format)
6. **Verification plan** — test cases + manual verification steps; include RED→GREEN or counterexample coverage for every high-risk spec clause
7. **Risk & mitigation** — what could go wrong

Reference files with full paths: \`src/agent/loop.ts:123\`

### Diagram soft gate
A plan with no Mermaid diagram is not saved on first submit — you'll be asked once to add an architecture/data-flow diagram. Resubmitting the same title (with or without a diagram) always saves it, so this never blocks you for more than one extra round.

### Required fields
- title: Short descriptive plan title
- plan: Complete plan Markdown (can be long — include code snippets and Mermaid diagrams)`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short descriptive plan title (used for file slug)' },
        plan: { type: 'string', description: 'Full plan in Markdown. Use Mermaid diagrams, code snippets, tables. See tool description for quality guidelines.' },
      },
      required: ['title', 'plan'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const title = params.input.title
    const planContent = params.input.plan

    if (typeof title !== 'string' || !title.trim()) {
      return { content: 'Error: title is required', isError: true }
    }
    if (typeof planContent !== 'string' || !planContent.trim()) {
      return { content: 'Error: plan is required', isError: true }
    }

    const slug = slugify(title)

    // One-shot soft gate: if the plan has no Mermaid diagram, nudge once (do
    // NOT write), then let any resubmit of the same slug through. Never blocks
    // more than a single extra round-trip, so it cannot cause a doom loop.
    if (!MERMAID_FENCE.test(planContent) && !warnedSlugs.has(slug)) {
      warnedSlugs.add(slug)
      return {
        content: [
          `⚠️ Plan not yet saved — it has no Mermaid diagram.`,
          '',
          `A good plan visualizes architecture or data flow. Add one diagram (even just the core 3-5 nodes) and resubmit. Copy this skeleton and replace the node text:`,
          '',
          MISSING_DIAGRAM_SKELETON,
          '',
          `Shapes: (rounded)=input/user · [[subroutine]]=agent · {{hexagon}}=LLM · [(cylinder)]=store · {rhombus}=decision. Edges: --> read · ==> write · -.-> async/event.`,
          '',
          `If a diagram is genuinely unnecessary for this task, resubmit \`plan_submit\` as-is (same title) and it will be saved.`,
        ].join('\n'),
        isError: true,
      }
    }

    const fullContent = `# ${title.trim()}

${planContent.trim()}
`

    try {
      const relativePath = await writePlan(params.cwd, slug, fullContent)
      return {
        content: [
          `✅ Plan submitted: **${title.trim()}**`,
          `File: \`${relativePath}\``,
          `Slug: \`${slug}\``,
          '',
          `The user will review and respond with:`,
          `- \`/plan-approve ${slug}\` — approve and start execution`,
          `- \`/plan-reject ${slug}\` — reject with feedback`,
          `- \`/plan-list\` — list all plans`,
          '',
          `**Wait here — do not proceed until the user approves.**`,
        ].join('\n'),
      }
    } catch (err) {
      return {
        content: `Error writing plan: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
  requiresApproval: () => false,
}
