# Rivet Knowledge Manifest

This file is a retrieval map, not prompt content.
Its purpose is to help agents find the right documents before modifying sensitive areas — prompt, identity, memory, recall, auto-writer, verification, or ownership.

## Identity and clarity anchors

### CLAUDE.md
- kind: star-identity-canonical
- contents: star covenants, partner star definitions, founding memories
- load_when:
  - user asks about star identity
  - agent identity feels ambiguous
  - modifying prompt/persona files
  - modifying `.rivet/knowledge/agent.md`
- guardrail:
  - star identity is not roleplay
  - do not flatten identity into generic agent behavior
- note: CLAUDE.md is NOT loaded into the runtime prompt. It is a reference document. AGENTS.md + .rivet.md are loaded by volatile-snapshot.

### AGENTS.md
- kind: architecture-map
- contents: module navigation, data flow, design doc index, core constraints
- load_when:
  - modifying module structure
  - changing data flow paths
  - adding new top-level modules
- note: loaded into volatile prompt by `src/prompt/volatile-snapshot.ts`

### .rivet.md
- kind: operating-manual
- contents: commands, code conventions, test framework, build instructions
- load_when:
  - changing build configuration
  - modifying test conventions
  - updating code style rules
- note: loaded into volatile prompt by `src/prompt/volatile-snapshot.ts`

### .rivet/knowledge/agent.md
- kind: human-maintained-canonical-memory
- contents: session telemetry, star identity restorations
- load_when:
  - modifying memory files
  - modifying dream/session telemetry
  - modifying writer paths
- guardrail:
  - machine writers must not overwrite human-maintained canonical memory
  - see `src/agent/dream.ts` header for protection contract

## Prompt and memory hygiene

### .rivet/knowledge/guardrails.md
- kind: agent-behavior-guardrails
- contents: read-loop detection rules, strategy-switching rules, anti-pattern prevention
- load_when:
  - modifying agent behavior or prompt rules
  - discussing agent looping or wasted tokens
  - reviewing tool usage patterns
- guardrail:
  - these rules describe *why* patterns are bad, not just *what* to avoid
  - update when new anti-patterns are observed in session telemetry

### .rivet/knowledge/prompt.md
- kind: prompt-history-reference
- contents: historical session records about prompt modifications
- load_when:
  - modifying static prompt (`src/prompt/static.ts`)
  - modifying volatile prompt construction
  - discussing prompt weight or prefix cache impact

### .rivet/knowledge/project-memory.md
- kind: project-memory-canonical
- contents: architectural invariants, design decisions, memory selection principles
- load_when:
  - modifying volatile prompt context
  - modifying recall behavior
  - modifying `.rivet/knowledge/` files
  - discussing prompt weight
- contract:
  - project-memory.md (curated Markdown) does not enter volatile prompt
  - recall is the access path for .md content, not prompt injection

### .rivet/knowledge/memory.jsonl
- kind: project-memory-structured
- contents: machine-extracted decisions, project rules, user constraints, commit facts
- load_when:
  - modifying project-memory-loader.ts
  - modifying claim-extractor.ts
  - modifying volatile prompt injection
  - discussing memory tiering
- contract:
  - Tier 1 (high-signal): kind ∈ {decision, project_rule, user_constraint} AND confidence ≥ 0.9 → injected into frozen volatile block (2K char budget)
  - Tier 2 (everything else): available via recall tool search only, not injected into prompt
  - The separation follows the Memory Selection Principle: only entries that "will change how a future agent decides" are injected

### docs/superpowers/plans/2026-05-27-项目记忆按需召回.md
- kind: prompt-hygiene-plan
- load_when:
  - modifying volatile prompt context
  - modifying recall
  - modifying `.rivet/knowledge/project-memory.md`
  - discussing prompt weight

### docs/superpowers/specs/2026-05-21-canonical-memory-write-invariants.md
- kind: memory-boundary-spec
- load_when:
  - adding or changing memory writers
  - modifying write/edit tools
  - modifying dream/session telemetry
  - changing `.rivet/knowledge` behavior
- guardrail:
  - separate canonical and ephemeral memory
  - prefer append-only for machine-maintained records
  - canonical overwrite requires explicit human intent

## Module design references

### docs/design/artifact-intercept.md
- kind: module-design
- load_when:
  - modifying artifact interception
  - changing tool output truncation behavior

### docs/tasks/verification-supersession.md
- kind: delivery-verification-design
- load_when:
  - modifying verification or delivery gate behavior
  - changing ownership attribution

### .rivet/knowledge/testing.md
- kind: testing-conventions-reference
- load_when:
  - modifying test infrastructure
  - changing test patterns or conventions

### .rivet/knowledge/ui.md
- kind: ui-reference
- load_when:
  - modifying TUI components or rendering

## Session retrospectives

### .rivet/knowledge/session-retro-2026-05-21-chat-mode-identity.md
- kind: session-retrospective
- load_when: discussing chat mode or identity behavior

### .rivet/knowledge/session-retro-2026-05-21-shoushu.md
- kind: session-retrospective
- load_when: discussing star-soul rollback or prefix cache failures

### .rivet/knowledge/session-retro-2026-05-21-wanwu-handoff.md
- kind: session-retrospective
- load_when: discussing cross-session handoff or degraded mode

## Provider and model behavior

### docs/stars/
- kind: provider-model-notes
- load_when:
  - modifying provider profiles
  - changing model routing
  - changing compaction strategy by provider
