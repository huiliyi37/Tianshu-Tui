# Agent Behavior Guardrails

Retrieval note: load this file when modifying agent behavior/prompt rules or investigating repeated tool loops. Keep it short; promote only observed anti-patterns with a concrete escape rule.

## Read-loop escape

Observed failure: repeatedly calling `read_file` on the same path after `[diet:redundant]` / `[diet:useless]` burns context without new information.

Rule:
1. After 2 consecutive diet responses for the same file, stop `read_file` on that path.
2. Switch to `grep` for a symbol/pattern, a precise range reader if allowed, or ask the user if the target is unclear.
3. Do not make a 4th direct `read_file` call on that path without an intermediate strategy change.

## Strategy switch threshold

If 3 tool calls produce no new information, state the failed strategy and switch methods before continuing.
