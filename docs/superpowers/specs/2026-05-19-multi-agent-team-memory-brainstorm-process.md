# Multi-Agent Team Memory — Deep Brainstorm Process Record

> Date: 2026-05-18 ~ 2026-05-19
> Participants: Claude Code (design lead) + 11 cross-domain scouts
> Output: Genome-Immune Team Architecture design spec
> Status: Complete — ready for Opus 4.6 + Rivet review

---

## Session Overview

Two rounds of deep brainstorm exploring how Rivet's memory architecture should evolve to support multi-agent team collaboration facing the world.

**Round 1** (Memory Architecture): 9 scouts across biology, physics, ecology, neuroscience, distributed systems, culture, chaos theory, semiotics, and competitive products.

**Round 2** (Team Collaboration): 2 scouts — Symphony/multi-agent frameworks + cross-domain team memory systems.

**Final Output**: 3-round evolution producing Genome-Immune Team Architecture.

---

## Round 1: Cross-Domain Memory Inspirations

### Scout Dispatch (9 scouts)

| Scout | Domain | Key Findings |
|-------|--------|-------------|
| Biology | Immune memory, hippocampus, mycorrhizal, bee dance | Layered memory, offline replay, affinity maturation, multi-dimensional encoding |
| Physics | Decoherence, SOC, entanglement, dissipative structures | Forgetting = access loss, sandpile criticality, associative recall, continuous metabolism |
| Ecology | Ant pheromones, wolf territory, oral tradition, coral reef | Optimal evaporation rate, threat-based refresh, formulaic skeleton, seed bank diversity |
| Neuro+ML | Sleep spindles, EWC, RAG advances, neurogenesis | Explicit activation tags, weight protection, gain-adaptive memory, pattern separation |
| Distributed | Git delta, HGT, Wikipedia, island model, BGP | Local "good enough", transfer without understanding, stagnation-triggered migration, history-based loop detection |
| Culture | Printing press, creolization, Book of Dead, guilds, junk DNA | Collective error correction, forced emergence, modular spells, trust hierarchy, retention zone |
| Chaos | Game of Life, jazz, fractals, emergence, wabi-sabi | Critical mass waiting, constraint-driven creativity, self-similarity, rule design not behavior design, imperfect memory as feature |
| Semiotics | Saussure, Peirce, Lakoff, Grice, Bakhtin, Barthes | Difference vectors, triadic reasoning, embodied metaphor, relation maxim violation, dialogue traces, maintainer-first evaluation |
| Products | Claude Code, Cursor, Aider, Continue, OpenHands | ALL competitors lack: cross-session memory, behavioral feedback, error pattern memory, team knowledge sharing |

### Counter-Evidence Scout

Found that "memory is dead" was overstated. Real issues: data sparsity (3 entries), existing decay mechanism already present, narrow consumption paths. Bio-ecology analogy risks over-engineering.

### 6 Themes Synthesized

1. **Memory is alive** — needs evaporation, competition, consolidation, active hunting
2. **Transfer without understanding** — pattern reuse at non-reasoning level
3. **Organize by difference** — store as difference vectors, not absolute facts
4. **Communication quality** — Grice's maxims, minimal relevant injection
5. **Trust hierarchy** — knowledge access levels based on interaction history
6. **Competitive blindspot** — Rivet already ahead of ALL competitors on memory

### 7 Inspiration Bubbles

1. Collective error correction network (printing press + HGT)
2. Difference vector memory (Saussure + fractals)
3. Trigger cue injection instead of full lessons (Grice)
4. Trust-layered knowledge access (guilds)
5. Stagnation-triggered migration (island model + BGP)
6. Pidgin→Creole emergence (creolization)
7. Retention zone instead of deletion (junk DNA + wabi-sabi)

---

## Round 2: Multi-Agent Team Collaboration

### New Insight

The question shifted from "fix single-agent memory" to "design multi-agent team workflow where memory doesn't get confused, evolving toward Symphony-like team design."

### Scout Dispatch (2 scouts)

**Scout: Symphony + Multi-Agent Frameworks**

Key findings:
- OpenAI Symphony is NOT multi-agent — it's single-agent orchestration per issue with extreme workspace isolation
- GradientHQ Symphony: Beacon-Selection Protocol (agents self-score and bid) + Weighted CoT Voting
- LangGraph: 4-layer memory with explicit checkpoints and reducers
- Governed Memory paper (arXiv 2603.17787): 5-layer model, 99.6% recall, zero cross-entity leakage
- Industry blindspots: pollution auto-repair, dynamic boundary negotiation, memory evolution, semantic versioning

**Scout: Cross-Domain Team Memory**

Key findings:
- Surgery: "minimal safety subset" — sync only critical info at sync points
- Orchestra: "score translation" — interface layer IS the memory layer
- Bee colony: "role clearing" — active forgetting on role switch is protection
- Military C2: "active compression" — upstream compresses for downstream
- CODEOWNERS: "territory + gradient" — conflicts by decision weight, not ownership

**Cross-domain convergence**: All successful team systems AVOID full memory sharing. They use selective translation + active dimensionality reduction + time-point synchronization.

---

## Three-Round Evolution

### Round 1: Variation (5 candidates)

| ID | Name | Core Choice |
|----|------|-------------|
| V1 | Hierarchical + Blackboard | Static roles, shared blackboard, conductor decides |
| V2 | Score Translation + Surgical Pause | Zero sharing, conductor translates, merge-time check |
| V3 | Immune Genome | Role-level persistent memory with immune protection |
| V4 | Decentralized Bidding + Pheromones | No conductor, self-scoring, indirect coordination |
| V5 | Split/Merge | Dynamic role emergence through pressure-driven fission/fusion |

### Round 2: Selection

**Extinct:**
- V1 — CrewAI-level ceiling, too low for Rivet's ambition
- V5 — Three-way merge on unstructured knowledge has broken causal chain

**Survived:**
- V2 (Score + Pause) — strongest zero-pollution guarantee
- V3 (Immune Genome) — highest capability ceiling
- V4 (Decentralized) — most elegant self-organization

**Key discovery**: V2, V3, V4 are not mutually exclusive — they can be layered:
- V2's communication layer + V3's memory layer + V4's scheduling strategy

### Round 3: Adaptation

**Final Architecture: Genome-Immune Team Architecture**

Combines:
- V2's score translation + surgical pause (communication)
- V3's immune genome (memory protection + evolution)
- V4's self-scoring bid (scheduling)
- V5's role emergence (long-term evolution)

**Implementation Phases:**
1. Role genome + score generation
2. Immune check + surgical pause
3. Self-scoring bid + pheromone network
4. Role emergence + fusion

---

## Discarded Traits (Preserved for Future Use)

| From | Trait | Potential Future Use |
|------|-------|-------------------|
| V1 | Structured blackboard exchange | WorkerResult.findings as cross-agent visible info |
| V5 | Role emergence from pressure | When task type appears >5 times with no expert, suggest new role |
| V5 | Three-way merge | May work for structured data (not free-text lessons) |
| Counter-evidence | "Data sparsity is the real issue" | Phase 1 should focus on generating enough genome entries |

---

## Cross-Domain Inspiration Sources

### Biology (Round 1)
- PMC immunological memory
- Physiological Reviews sleep consolidation
- Copernicus mycorrhizal networks
- Science bee waggle dance

### Physics (Round 1)
- Wikipedia quantum decoherence
- American Scientist sandpile model
- Frontiers associative memory
- ScienceDirect dissipative systems

### Ecology (Round 1)
- arXiv ant pheromone oscillation
- Ecology and Evolution wolf territory
- ScienceDirect oral storytelling
- NOAA coral reef restoration

### Neuroscience+ML (Round 1)
- News-Medical sleep memory selection
- arXiv continual learning (CSQN, Fisher)
- arXiv GAM-RAG, MacRAG, LAnR, SAGE
- ScienceDirect adult neurogenesis

### Distributed Systems (Round 1)
- StackOverflow git packfile heuristics
- eLife bacterial HGT
- Wikipedia dispute resolution
- ScienceDirect island model GA
- HPE BGP path vector

### Culture (Round 1)
- Monash memory code
- ScienceDirect oral tradition
- Mongabay coral cryobank
- Baidu Baike dissipative structures

### Products (Round 1)
- TunerLabs Claude Code memory guide
- Juejin Cursor indexing
- Aider repo map docs
- Continue.dev context providers
- Viblo OpenHands deep dive

### Multi-Agent Frameworks (Round 2)
- GitHub openai/symphony
- GitHub GradientHQ/symphony
- arXiv 2603.17787 Governed Memory
- arXiv 2605.04264 Collaborative Memory as Artificial Selection
- FutureAGI agent frameworks comparison 2026

---

## Decision Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|----------------------|
| Genome per role, not per instance | Roles accumulate expertise; instances are ephemeral | Per-instance (too fragile), global (pollution risk) |
| Immune check before genome write | Prevent contamination without blocking evolution | No check (pollution), strict check (blocks learning) |
| Score translation, not raw sharing | Grice's relation maxim + military C2 compression | Full context sharing (overload), no sharing (isolation) |
| Surgical pause at merge time | Surgery time-out + BGP history detection | Real-time sync (pollution), no check (conflicts) |
| Self-scoring with 10% exploration | Bee dance quality + island model stagnation trigger | Fixed routing (no evolution), pure bidding (unstable) |
| Pheromone space for indirect coordination | Ant stigmergy + CODEOWNERS territory | Direct messaging (coupling), blackboard (pollution) |
