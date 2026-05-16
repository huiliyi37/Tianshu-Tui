# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-15

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** opencode-tui
- **Description:** A terminal coding agent powered by DeepSeek V4, with prefix cache optimization for the 1M context window. Ink 6 + React TUI, streaming responses, tool execution loop.
- **Strategic goal:** Promote open source and raise open/open-source model capability in terminal coding agents, aiming for developer capability and high availability comparable to Claude Code and opencode.

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->
- [2026-05-15] Do not paste real API keys or credential fragments into handoff docs, bug logs, memory logs, or summaries; always use placeholders and verify with secret-pattern search after sanitizing.

## Key Learnings

- **ACF (Adaptive Context Fabric):** 4-phase implementation covering zero-overflow safety, structural anchors, provider-aware assembly, and recall+injection. Percentage-based thresholds enable 8K-1M window scaling. Compaction policy is the sole decision source (removed legacy AND gate with shouldAutoCompact). Ceiling fallback preserves first 2 cache-anchor messages to keep DeepSeek 99% prefix cache hit rate.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
- [2026-05-16] ACF: Chose ratio-based compact policy (0.6/0.78/0.88/0.95) over absolute token thresholds to support 8K–1M provider scaling without per-model constants.
- [2026-05-16] ACF: Last-resort ceiling uses checkpoint-resume with cache-anchor preservation rather than aggressive truncation — preserves DeepSeek prefix cache at the cost of lost mid-session context, which is recoverable via recall tool.
- [2026-05-16] ACF: Provider profiles as a lookup table rather than a plugin architecture — 6 providers is a manageable static set; plugins add complexity without evidence of need.
